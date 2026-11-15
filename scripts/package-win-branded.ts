// Windows x64 미서명 브랜드 폴더형 실행본 만들기 (선택형; docs/WINDOWS-BRANDED-PREVIEW-PLAN.md 경로 B).
// 사용: corepack pnpm package:win:branded [--out <새 폴더>] [--electron-zip-dir <공식 zip이 든 폴더>]   (build 뒤 이 스크립트가 실행된다)
// 기존 `package:win`(electron.exe 그대로, 경로 A)은 그대로 쓸 수 있다. 이 명령은 실행파일 이름·아이콘·메타데이터만 `LoreWeave`로 바꾼다.
//
// 흐름: 입력·출력·허용 목록·Electron zip 검사 → 이번 빌드가 mkdtemp로 새로 만든 독점 임시 루트(저장소 밖)에 staging/temp/out/logs를 만들고 →
//   허용 목록만으로 staging 구성 → 호출 직전 재검사 → packager(정확 20.3.0)를 자식 프로세스에서 한 번 호출(삭제 방어 설치 뒤) → 산출물 검증 →
//   검증을 통과한 것만 새 최종 출력(존재하지 않는 경로를 exclusive로 만든다)에 복사 → 다시 검증.
// 삭제: 이 스크립트는 아무것도 삭제하지 않는다. packager가 호출하는 삭제(최종 경로 `rm`, `default_app` 제거)는 독점 루트 안의 이번 빌드 생성물로 한정되도록 방어한다
//   (in-process 방어이며 OS 샌드박스·모든 경합 방지가 아니다). 사용자가 준 --out·기존 폴더·저장소·공용 tmp·`electron-packager` 공용 폴더·Electron 캐시·원본 dist에는 삭제를 하지 않는다.
// 하지 않는 일: 다운로드(Electron zip은 미리 준비된 로컬 공식 zip만 읽는다; 없거나 해시가 다르면 실패), 서명, 설치 프로그램, 업데이트, asar, app.setName/userData 정책 변경.
// 실패해도 독점 임시 루트와 증거(logs)를 지우지 않는다. 성공해도 독점 루트(staging/out 복사본)가 남으므로 필요하면 직접 정리한다.
// 다른 PC·CI에서는 같은 공식 zip(electron-v<버전>-win32-x64.zip)을 사용자가 미리 준비해야 한다 (자동 확보 기능 없음).

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlatform, checkInputs, checkOutput, FORBIDDEN, isInside, type Layout, lexists, PackageError, preflight, RULES, scanAllowed, stageApp } from './package-win.ts';

const fail = (message: string): never => {
  throw new PackageError(message);
};

export const BRAND = 'LoreWeave';
export const PACKAGER_VERSION = '20.3.0';
const INTERNAL = `${BRAND}-win32-x64`;

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 폴더 안 모든 파일의 상대경로→`크기:SHA-256` (링크는 따르지 않는다: 호출 전에 링크 없음을 따로 확인한다) */
export function manifest(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (cur: string, rel: string): void => {
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) map.set(r, `${st.size}:${sha256(p)}`);
    }
  };
  walk(dir, '');
  return map;
}
const manifestHash = (m: Map<string, string>): string => createHash('sha256').update([...m].map(([k, v]) => `${k}:${v}`).sort().join('\n')).digest('hex');

/** 트리 안의 링크(symlink/junction) 경로 */
export function findLinks(dir: string): string[] {
  const links: string[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) links.push(p);
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return links;
}

/** `ReparsePoint` 속성 항목 수 (lstat이 못 보는 종류까지 PowerShell로 본다) */
function reparseCount(dir: string): number {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -Force -Attributes ReparsePoint | Measure-Object).Count`], { encoding: 'utf8' }).trim();
  const n = Number(out);
  if (!Number.isInteger(n)) fail(`ReparsePoint 검사 결과를 읽을 수 없다: ${out}`);
  return n;
}

// ---------- Electron zip ----------

/** @electron/get 5.x의 기본 캐시 위치: <LOCALAPPDATA>\electron\Cache\<sha256(다운로드 URL의 디렉터리)> (소스: Cache.ts/artifact-utils.ts) */
export function defaultZipDir(version: string): string {
  const local = process.env['LOCALAPPDATA'];
  if (!local) return fail('LOCALAPPDATA가 없어 Electron 캐시 위치를 알 수 없다 (--electron-zip-dir로 공식 zip이 든 폴더를 지정한다)');
  const dirUrl = `https://github.com/electron/electron/releases/download/v${version}`;
  return join(local, 'electron', 'Cache', createHash('sha256').update(dirUrl).digest('hex'));
}

/** zip 중앙 디렉터리의 엔트리를 읽어 경로 탈출·절대 경로·심볼릭 링크 엔트리를 찾는다 (zip64는 처리하지 않고 거절한다) */
export function scanZipEntries(zipPath: string): { count: number; bad: { name: string; why: string }[] } {
  const size = statSync(zipPath).size;
  const fd = openSync(zipPath, 'r');
  try {
    const tailLen = Math.min(size, 70_000);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return fail(`zip 형식이 아니다(끝 디렉터리 없음): ${zipPath}`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail('zip64 형식은 검사하지 못해 거절한다');
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    const bad: { name: string; why: string }[] = [];
    let p = 0;
    let n = 0;
    while (p < cd.length) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return fail('zip 중앙 디렉터리 형식이 올바르지 않다');
      const madeBy = cd.readUInt16LE(p + 4);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..') || name.includes('\0')) bad.push({ name, why: '경로 탈출/절대 경로' });
      if (madeBy >> 8 === 3 && ((external >>> 16) & 0xf000) === 0xa000) bad.push({ name, why: '심볼릭 링크 엔트리' });
      n += 1;
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (n !== count) return fail(`zip 엔트리 수가 맞지 않는다 (선언 ${count}, 읽음 ${n})`);
    return { count, bad };
  } finally {
    closeSync(fd);
  }
}

export interface ZipInfo {
  dir: string;
  path: string;
  bytes: number;
  sha256: string;
  entries: number;
}

/** 로컬 공식 zip을 읽기만 한다: 없거나 링크이거나 해시가 설치된 electron의 checksums.json과 다르거나 엔트리가 위험하면 실패한다 (다운로드로 폴백하지 않는다) */
export function verifyZip(zipDir: string, electronVersion: string, checksumsPath: string): ZipInfo {
  const name = `electron-v${electronVersion}-win32-x64.zip`;
  const zip = join(zipDir, name);
  if (!existsSync(zip)) return fail(`Electron zip이 없다: ${zip}\n  이 명령은 다운로드하지 않는다. 같은 공식 zip(${name})을 미리 준비해 --electron-zip-dir로 지정하거나 기본 캐시 위치에 두어야 한다.`);
  if (lstatSync(zipDir).isSymbolicLink() || lstatSync(zip).isSymbolicLink()) return fail(`zip 폴더/파일이 링크다: ${zip}`);
  if (!existsSync(checksumsPath)) return fail(`설치된 electron의 checksums.json이 없다: ${checksumsPath}`);
  const expected = (JSON.parse(readFileSync(checksumsPath, 'utf8')) as Record<string, string>)[name];
  if (!expected) return fail(`checksums.json에 ${name} 항목이 없다`);
  const actual = sha256(zip);
  if (actual !== expected) return fail(`Electron zip의 SHA-256이 checksums.json과 다르다 (다운로드로 우회하지 않는다):\n  기대 ${expected}\n  실제 ${actual}`);
  const { count, bad } = scanZipEntries(zip);
  if (bad.length > 0) return fail(`Electron zip에 위험한 엔트리가 있다: ${bad.slice(0, 5).map((b) => `${b.name}(${b.why})`).join(', ')}`);
  return { dir: zipDir, path: zip, bytes: statSync(zip).size, sha256: actual, entries: count };
}

// ---------- 입력·출력 검사 ----------

/** packager가 package.json에 정확 20.3.0으로 고정되고 설치된 것이 같은 버전인지 본다. 설치된 dist 경로와 resedit 해석 기준 파일을 돌려준다 */
export function checkPackager({ root }: Layout): { entry: string } {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
  const pinned = pkg.devDependencies?.['@electron/packager'];
  if (pinned !== PACKAGER_VERSION) return fail(`package.json의 @electron/packager가 정확 ${PACKAGER_VERSION}로 고정되어 있어야 한다 (현재 ${pinned ?? '없음'})`);
  const entry = createRequire(import.meta.url).resolve('@electron/packager'); // exports의 default 조건으로 dist/index.js를 가리킨다 (tsx는 import.meta.resolve를 지원하지 않는다)
  const installed = (JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as { version?: string }).version;
  if (installed !== PACKAGER_VERSION) return fail(`설치된 @electron/packager(${installed})가 ${PACKAGER_VERSION}과 다르다 (pnpm install이 필요하다)`);
  return { entry };
}

/** 최종 출력: package:win과 같은 검사(lexical+realpath, 상위·하위 보호, 링크, 폴더 아님) + 이미 존재하면 거절 (exclusive 생성) */
export function checkBrandedOutput(out: string, layout: Layout): string {
  const target = checkOutput(out, layout);
  if (lexists(target)) return fail(`최종 출력은 아직 없는 새 경로여야 한다 (이미 있다; 덮어쓰지 않는다): ${target}`);
  return target;
}

/** 독점 루트 안의 아홉 가지 경계 (호출 직전에 다시 실행한다) */
function checkRoot(root: string, dirs: { staging: string; temp: string; out: string; logs: string }, layout: Layout, zipDir: string, target: string, tmpBase: string): void {
  const problems: string[] = [];
  const real = realpathSync.native(root);
  if (resolve(real).toLowerCase() !== resolve(root).toLowerCase()) problems.push(`루트 경로가 별칭이다: ${root} → ${real}`);
  if (!isInside(real, realpathSync.native(tmpBase)) || resolve(real).toLowerCase() === resolve(tmpBase).toLowerCase()) problems.push('루트가 임시 폴더 안의 새 폴더가 아니다');
  const others: [string, string][] = [['저장소', layout.root], ['Electron dist', layout.electronDist], ['Electron zip 폴더', zipDir], ['최종 출력', target], ['공용 electron-packager 임시', join(tmpBase, 'electron-packager')]];
  for (const [label, other] of others) {
    const o = existsSync(other) ? realpathSync.native(other) : resolve(other);
    if (isInside(real, o) || isInside(o, real)) problems.push(`루트가 ${label}와 겹친다`);
  }
  for (const [k, d] of Object.entries(dirs)) {
    if (!isInside(d, root)) problems.push(`루트 밖: ${k}`);
    if (lstatSync(d).isSymbolicLink() || resolve(realpathSync.native(d)).toLowerCase() !== resolve(d).toLowerCase()) problems.push(`링크/별칭: ${k}`);
  }
  if (readdirSync(dirs.out).length > 0) problems.push('out이 비어 있지 않다');
  if (lexists(join(dirs.out, INTERNAL))) problems.push('packager 최종 경로가 이미 있다');
  if (isInside(dirs.staging, dirs.out) || isInside(dirs.out, dirs.staging)) problems.push('staging과 out이 겹친다');
  const links = findLinks(root);
  if (links.length > 0) problems.push(`링크 ${links.length}개: ${links.slice(0, 3).join(', ')}`);
  const reparse = reparseCount(root);
  if (reparse !== 0) problems.push(`ReparsePoint 속성 항목 ${reparse}개`);
  if (problems.length > 0) fail(`독점 루트 재검사 실패 (packager를 호출하지 않는다):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

// ---------- 산출물 검증 ----------

interface Resedit {
  NtExecutable: { from(data: Buffer): unknown };
  NtExecutableResource: { from(exe: unknown): { entries: { type: number | string; id: number | string; bin: ArrayBuffer }[] } };
  Resource: {
    VersionInfo: { fromEntries(entries: unknown): { getAllLanguagesForStringValues(): { lang: number; codepage: number }[]; getStringValues(lang: { lang: number; codepage: number }): Record<string, string> }[] };
    IconGroupEntry: { fromEntries(entries: unknown): { icons: { width: number; height: number; iconID: number }[] }[] };
  };
}

/** ICO 파일의 프레임 바이트 해시 (키: 너비x높이, 0은 256) */
function icoFrames(ico: Buffer): Record<string, string> {
  const frames: Record<string, string> = {};
  const n = ico.readUInt16LE(4);
  for (let i = 0; i < n; i += 1) {
    const o = 6 + i * 16;
    const size = ico.readUInt32LE(o + 8);
    const offset = ico.readUInt32LE(o + 12);
    frames[`${ico[o]! || 256}x${ico[o + 1]! || 256}`] = createHash('sha256').update(ico.subarray(offset, offset + size)).digest('hex');
  }
  return frames;
}

export interface PeFacts {
  strings: Record<string, string>;
  iconFrames: Record<string, string>;
}

/** 실제 PE 리소스를 읽어(resedit, packager가 쓰는 같은 라이브러리) 문자열과 아이콘 프레임이 기대와 같은지 본다 */
export function verifyPe(exe: string, packagerEntry: string, expected: { version: string; copyright: string }, icoPath: string): PeFacts {
  const resedit = createRequire(packagerEntry)('resedit') as Resedit;
  const resource = resedit.NtExecutableResource.from(resedit.NtExecutable.from(readFileSync(exe)));
  const info = resedit.Resource.VersionInfo.fromEntries(resource.entries);
  if (info.length !== 1) return fail(`버전 정보 리소스가 정확히 1개여야 한다 (${info.length})`);
  const langs = info[0]!.getAllLanguagesForStringValues();
  if (langs.length !== 1) return fail(`버전 정보 언어가 정확히 1개여야 한다 (${langs.length})`);
  const strings = info[0]!.getStringValues(langs[0]!);
  const want: Record<string, string> = { ProductName: BRAND, FileDescription: BRAND, InternalName: BRAND, CompanyName: BRAND, OriginalFilename: `${BRAND}.exe`, ProductVersion: expected.version, FileVersion: expected.version, LegalCopyright: expected.copyright };
  for (const [k, v] of Object.entries(want)) if (strings[k] !== v) fail(`실행파일 문자열 ${k}가 기대와 다르다: 기대 '${v}', 실제 '${strings[k] ?? '없음'}'`);
  const groups = resedit.Resource.IconGroupEntry.fromEntries(resource.entries);
  if (groups.length !== 1) return fail(`아이콘 그룹이 정확히 1개여야 한다 (${groups.length})`);
  const iconFrames: Record<string, string> = {};
  for (const icon of groups[0]!.icons) {
    const entry = resource.entries.find((e) => e.type === 3 && e.id === icon.iconID);
    if (!entry) return fail(`아이콘 프레임 리소스가 없다: ${icon.iconID}`);
    iconFrames[`${icon.width || 256}x${icon.height || 256}`] = createHash('sha256').update(Buffer.from(entry.bin)).digest('hex');
  }
  const original = icoFrames(readFileSync(icoPath));
  if (JSON.stringify(Object.entries(iconFrames).sort()) !== JSON.stringify(Object.entries(original).sort())) fail(`실행파일의 아이콘 프레임이 app-icon.ico와 다르다: 실행파일 ${Object.keys(iconFrames).join(',')} / ICO ${Object.keys(original).join(',')}`);
  return { strings, iconFrames };
}

/** Electron 구성 파일 규칙: package:win의 허용 목록에서 exe 이름만 바꾸고 packager가 제거하는 default_app.asar는 허용하지 않는다 */
const BRANDED_ELECTRON_RULES: readonly RegExp[] = [
  new RegExp(RULES.electron[0].source.replace('electron\\.exe', `${BRAND}\\.exe`)),
  RULES.electron[1],
];

export interface TreeFacts {
  files: number;
  bytes: number;
}

/** 브랜드 산출물(실행파일을 바로 포함하는 루트) 검증. staging이 있으면 resources/app이 staging과 파일 단위로 같은지도 본다 */
export function verifyBrandedTree(app: string, info: { name: string; version: string; main: string }, staging?: string): TreeFacts {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) fail(`산출물에 링크가 있다 (복사본이 독립적이지 않다): ${p}`);
      if (FORBIDDEN.some((re) => re.test(name))) fail(`산출물에 금지된 이름이 있다: ${p}`);
      if (st.isDirectory()) walk(p);
      else {
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk(app);
  for (const must of [`${BRAND}.exe`, 'LICENSE', 'LICENSES.chromium.html', 'resources/app/package.json', 'resources/app/out/main/index.js', 'resources/app/out/preload/index.js', 'resources/app/out/renderer/index.html', 'resources/app/resources/app-icon.ico', 'resources/app/node_modules/openai/package.json', 'resources/app/LICENSE', 'resources/app/THIRD_PARTY_NOTICES.md'])
    if (!existsSync(join(app, ...must.split('/')))) fail(`산출물에 필수 파일이 없다: ${must}`);
  for (const mustNot of ['electron.exe', 'resources/app.asar', 'resources/default_app.asar', 'resources/default_app'])
    if (lexists(join(app, ...mustNot.split('/')))) fail(`산출물에 있으면 안 되는 항목이 있다: ${mustNot}`);
  const resources = readdirSync(join(app, 'resources'));
  if (resources.length !== 1 || resources[0] !== 'app') fail(`resources에는 app만 있어야 한다: ${resources.join(', ')}`);
  const unexpected = scanAllowed(app, BRANDED_ELECTRON_RULES, ['resources/app']);
  if (unexpected.length > 0) fail(`허용 목록에 없는 Electron 구성 파일이 있다: ${unexpected.slice(0, 10).join(', ')}`);
  const nm = readdirSync(join(app, 'resources', 'app', 'node_modules'));
  if (nm.length !== 1 || nm[0] !== 'openai') fail(`resources/app/node_modules에는 openai만 있어야 한다: ${nm.join(', ')}`);
  const outEntries = readdirSync(join(app, 'resources', 'app', 'out')).sort().join(',');
  if (outEntries !== 'main,preload,renderer') fail(`resources/app/out에는 main,preload,renderer만 있어야 한다: ${outEntries}`);
  const appPkg = JSON.parse(readFileSync(join(app, 'resources', 'app', 'package.json'), 'utf8')) as Record<string, string>;
  if (JSON.stringify(appPkg) !== JSON.stringify({ name: info.name, version: info.version, main: info.main })) fail(`resources/app/package.json의 identity가 package:win과 다르다: ${JSON.stringify(appPkg)}`);
  if (staging) {
    const a = manifest(join(app, 'resources', 'app'));
    const b = manifest(staging);
    const diff = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
    if (diff.length > 0) fail(`resources/app이 staging과 다르다 (packager가 파일을 더하거나 빼거나 바꿨다): ${diff.slice(0, 10).join(', ')}`);
  }
  return { files, bytes };
}

// ---------- 빌드 ----------

export interface BrandedOptions {
  /** 독점 임시 루트를 만들 상위 폴더 (기본: 운영체제 임시 폴더). 테스트가 합성 폴더를 지정한다 */
  tmpBase?: string;
  /** 공식 Electron zip이 든 폴더 (기본: @electron/get 기본 캐시 위치) */
  zipDir?: string;
}

export interface BrandedResult {
  out: string;
  root: string;
  files: number;
  bytes: number;
  electronVersion: string;
  strings: Record<string, string>;
  iconFrames: number;
  zip: ZipInfo;
  rmCalls: number;
  hashesUnchanged: boolean;
}

/** 검사는 모두 임시 루트를 만들기 전에 끝낸다: 거절하면 아무것도 만들지 않는다 */
export function buildBranded(layout: Layout, out: string, options: BrandedOptions = {}): BrandedResult {
  const info = checkInputs(layout);
  const { entry } = checkPackager(layout);
  const target = checkBrandedOutput(out, layout);
  preflight(layout); // 허용 목록 밖의 파일이 있으면 아무것도 만들지 않고 실패
  const checksumsPath = join(dirname(layout.electronDist), 'checksums.json');
  const zipDir = options.zipDir ? resolve(options.zipDir) : defaultZipDir(info.electronVersion);
  const zip = verifyZip(zipDir, info.electronVersion, checksumsPath);
  const copyright = readFileSync(join(layout.root, 'LICENSE'), 'utf8').split(/\r?\n/).find((l) => /^Copyright /.test(l));
  if (!copyright) return fail('LICENSE에서 Copyright 줄을 찾지 못했다');
  const icoPath = join(layout.root, 'resources', 'app-icon.ico');
  const tmpBase = realpathSync.native(options.tmpBase ?? tmpdir());

  // 독점 임시 루트 (이번 빌드가 새로 만든다)
  const root = mkdtempSync(join(tmpBase, `${BRAND}-branded-`));
  const dirs = { staging: join(root, 'staging'), temp: join(root, 'temp'), out: join(root, 'out'), logs: join(root, 'logs') };
  for (const d of Object.values(dirs)) mkdirSync(d);
  const log = (event: string, extra: Record<string, unknown> = {}): void => appendFileSync(join(dirs.logs, 'build.log'), `${JSON.stringify({ t: new Date().toISOString(), event, ...extra })}\n`);
  const here = (message: string): never => fail(`${message}\n  (증거와 독점 임시 루트를 남겼다: ${root})`);
  try {
    log('root', { root, zip: { path: zip.path, bytes: zip.bytes, sha256: zip.sha256, entries: zip.entries } });
    const before = { zip: zip.sha256, dist: manifestHash(manifest(layout.electronDist)), ico: sha256(icoPath) };
    log('hash-before', before);
    stageApp(layout, info, dirs.staging);
    verifyStaging(dirs.staging);
    checkRoot(root, dirs, layout, zipDir, target, tmpBase);
    log('pre-call-check-ok');

    const packagerOptions = {
      dir: dirs.staging,
      out: dirs.out,
      platform: 'win32',
      arch: 'x64',
      electronVersion: info.electronVersion,
      electronZipDir: zipDir,
      name: BRAND,
      executableName: BRAND,
      icon: icoPath,
      appVersion: info.version,
      appCopyright: copyright,
      win32metadata: { CompanyName: BRAND, FileDescription: BRAND, ProductName: BRAND, InternalName: BRAND, OriginalFilename: `${BRAND}.exe` },
      asar: false,
      prune: false,
      tmpdir: false,
      overwrite: false,
      quiet: true,
    };
    const rmLog = join(dirs.logs, 'rm-calls.jsonl');
    const configPath = join(dirs.logs, 'packager-config.json');
    writeFileSync(configPath, JSON.stringify({ options: packagerOptions, allowedRm: [dirs.out, dirs.temp], rmLog }, null, 2));
    log('packager-call', { options: { ...packagerOptions, electronZipDir: '<zip 폴더>' } });
    const child = spawnSync(process.execPath, [join(layout.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), fileURLToPath(new URL('./package-win-packager-child.ts', import.meta.url)), configPath], {
      cwd: dirs.temp,
      env: { ...process.env, TEMP: dirs.temp, TMP: dirs.temp },
      encoding: 'utf8',
      timeout: 20 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(join(dirs.logs, 'packager-child.stdout.log'), child.stdout ?? '');
    writeFileSync(join(dirs.logs, 'packager-child.stderr.log'), child.stderr ?? '');
    const last = (child.stdout ?? '').split('\n').filter(Boolean).pop();
    const stderrLine = (child.stderr ?? '').split('\n').find((l) => /error/i.test(l)) ?? '';
    let reported: { ok: boolean; error?: string } = { ok: false, error: `자식 프로세스 결과를 읽지 못했다 (exit ${child.status}, ${child.error?.message ?? ''}) ${stderrLine.trim()}` };
    try {
      if (last) reported = JSON.parse(last) as { ok: boolean; error?: string };
    } catch {
      // 위 기본 메시지를 쓴다
    }
    if (child.status !== 0 || !reported.ok) return fail(`packager 실행이 실패했다 (exit ${child.status}): ${(reported.error ?? '').split('\n')[0]}`);
    const rmCalls = (existsSync(rmLog) ? readFileSync(rmLog, 'utf8').split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as { allowed: boolean });
    if (rmCalls.some((c) => !c.allowed)) return fail('허용 밖 삭제 호출이 기록되어 있다');
    log('packager-ok', { rmCalls: rmCalls.length });

    const built = join(dirs.out, INTERNAL);
    const tree = verifyBrandedTree(built, info, dirs.staging);
    const pe = verifyPe(join(built, `${BRAND}.exe`), entry, { version: info.version, copyright }, icoPath);
    log('packager-output-verified', { ...tree, strings: pe.strings });

    // 검증을 통과한 것만 새 최종 출력으로 복사한다 (exclusive 생성: 이미 있으면 실패)
    const target2 = checkBrandedOutput(target, layout);
    try {
      mkdirSync(target2); // 상위 폴더는 만들지 않는다; 경합으로 생겼다면 EEXIST로 실패
    } catch (e) {
      return fail(`최종 출력을 새로 만들 수 없다 (이미 생겼을 수 있다; 덮어쓰지 않는다): ${(e as Error).message}`);
    }
    cpSync(built, target2, { recursive: true, dereference: false, errorOnExist: true, force: false });
    const finalTree = verifyBrandedTree(target2, info, undefined);
    const a = manifest(built);
    const b = manifest(target2);
    if (a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)) return fail('최종 출력이 검증한 packager 산출물과 다르다');
    verifyPe(join(target2, `${BRAND}.exe`), entry, { version: info.version, copyright }, icoPath);
    if (findLinks(target2).length > 0) return fail('최종 출력에 링크가 있다');

    const after = { zip: sha256(zip.path), dist: manifestHash(manifest(layout.electronDist)), ico: sha256(icoPath) };
    const hashesUnchanged = after.zip === before.zip && after.dist === before.dist && after.ico === before.ico;
    log('hash-after', { hashesUnchanged });
    if (!hashesUnchanged) return fail('입력(zip/Electron dist/ICO)의 해시가 실행 전후로 달라졌다');
    const result: BrandedResult = { out: target2, root, files: finalTree.files, bytes: finalTree.bytes, electronVersion: info.electronVersion, strings: pe.strings, iconFrames: Object.keys(pe.iconFrames).length, zip, rmCalls: rmCalls.length, hashesUnchanged };
    writeFileSync(join(dirs.logs, 'build.json'), JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    if (e instanceof PackageError && !e.message.includes(root)) log('failed', { message: e.message });
    throw e instanceof PackageError && !e.message.includes(root) ? new PackageError(`${e.message}\n  (증거와 독점 임시 루트를 남겼다: ${root})`) : e;
  }
}

/** staging 점검: 허용된 최상위 항목만 있고 금지 이름·링크가 없다 */
function verifyStaging(staging: string): void {
  const top = readdirSync(staging).sort().join(',');
  if (top !== 'LICENSE,THIRD_PARTY_NOTICES.md,node_modules,out,package.json,resources') fail(`staging 최상위 항목이 기대와 다르다: ${top}`);
  if (readdirSync(join(staging, 'node_modules')).join(',') !== 'openai') fail('staging의 node_modules에는 openai만 있어야 한다');
  if (findLinks(staging).length > 0) fail('staging에 링크가 있다');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (FORBIDDEN.some((re) => re.test(name))) fail(`staging에 금지된 이름이 있다: ${join(dir, name)}`);
      const p = join(dir, name);
      if (lstatSync(p).isDirectory()) walk(p);
    }
  };
  walk(staging);
}

function main(): void {
  const args = process.argv.slice(2);
  let out: string | undefined;
  let zipDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i];
    else if (args[i] === '--electron-zip-dir') zipDir = args[++i];
    else fail(`알 수 없는 인자: ${args[i]} (사용: --out <새 폴더> [--electron-zip-dir <폴더>])`);
  }
  assertPlatform();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const layout = { root, electronDist: join(root, 'node_modules', 'electron', 'dist') };
  const target = out ? resolve(out) : join(tmpdir(), `LoreWeave-branded-win-x64-${Date.now().toString(36)}`);
  const result = buildBranded(layout, target, zipDir ? { zipDir } : {});
  console.log(`Windows x64 브랜드 폴더형 실행본을 만들었다 (미서명, asar 없음, Electron ${result.electronVersion}).`);
  console.log(`  위치: ${result.out}`);
  console.log(`  파일 ${result.files}개, ${(result.bytes / 1024 / 1024).toFixed(1)} MB; 실행파일 ${BRAND}.exe (PE 문자열·아이콘 ${result.iconFrames}프레임 검증됨)`);
  console.log(`  독점 임시 루트(삭제하지 않았다; 필요하면 직접 정리): ${result.root}`);
  console.log(`  실행: "${join(result.out, `${BRAND}.exe`)}" --user-data-dir=<격리 폴더>   (검증은 새로 만든 합성 원고 프로젝트 폴더와 별도 userData를 모두 써야 한다)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    if (e instanceof PackageError) {
      console.error(`package:win:branded 실패: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

