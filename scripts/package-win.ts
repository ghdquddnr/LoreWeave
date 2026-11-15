// Windows x64 미서명 폴더형(unpacked) 실행본 만들기 (docs/WINDOWS-PREVIEW-PLAN.md A안: Electron 공식 수동 배포).
// 사용: corepack pnpm package:win [--out <새 폴더>]   (build 뒤 이 스크립트가 실행된다)
//
// 하는 일: 이미 설치된 win32-x64 Electron 런타임(node_modules/electron/dist)을 복사하고, resources/app에 허용 목록의 앱 파일만 넣는다.
// 하지 않는 일: 다운로드·설치·새 의존성, 서명, 설치 프로그램, asar, exe 이름·임베디드 아이콘 변경(electron.exe 그대로), 어떤 파일도 삭제하지 않는다 (재귀 삭제 없음).
// 출력은 저장소 밖의 새 폴더다 (기본: 임시 폴더 아래 LoreWeave-win-x64-<고유값>). 존재하지 않거나 비어 있는 폴더만 받고, 그 밖은 거절한다.

import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class PackageError extends Error {}

const fail = (message: string): never => {
  throw new PackageError(message);
};

/** a가 b와 같거나 b 안에 있다 */
export const isInside = (a: string, b: string): boolean => {
  const rel = relative(resolve(b), resolve(a));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function assertPlatform(platform: string = process.platform, arch: string = process.arch): void {
  if (platform !== 'win32' || arch !== 'x64') fail(`이 스크립트는 Windows x64에서만 실행한다 (현재 ${platform}/${arch}). 설치된 Electron 런타임이 win32-x64여야 한다.`);
}

export interface Layout {
  root: string;
  electronDist: string;
}

/** 필수 입력이 모두 있는지 본다: 누락은 명시적으로 실패한다 */
export function checkInputs({ root, electronDist }: Layout): { name: string; version: string; main: string; electronVersion: string } {
  const required = [
    join(root, 'package.json'),
    join(root, 'out', 'main', 'index.js'),
    join(root, 'out', 'preload', 'index.js'),
    join(root, 'out', 'renderer', 'index.html'),
    join(root, 'resources', 'app-icon.ico'),
    join(root, 'node_modules', 'openai', 'package.json'),
    join(root, 'LICENSE'),
    join(root, 'THIRD_PARTY_NOTICES.md'),
    join(electronDist, 'electron.exe'),
    join(electronDist, 'version'),
    join(electronDist, 'resources'),
    join(electronDist, 'LICENSE'),
    join(electronDist, 'LICENSES.chromium.html'),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) fail(`필수 입력이 없다 (먼저 build 하고 pnpm install로 Electron을 설치해야 한다; 이 스크립트는 다운로드하지 않는다):\n${missing.map((p) => `  - ${p}`).join('\n')}`);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; main?: string; devDependencies?: Record<string, string> };
  if (!pkg.name || !pkg.version || !pkg.main) fail('package.json에 name/version/main이 필요하다');
  const pinned = pkg.devDependencies?.['electron'];
  const installed = readFileSync(join(electronDist, 'version'), 'utf8').trim();
  if (!pinned || pinned !== installed) fail(`설치된 Electron 런타임(${installed})이 package.json의 고정 버전(${pinned ?? '없음'})과 다르다`);
  return { name: pkg.name!, version: pkg.version!, main: pkg.main!, electronVersion: installed };
}

/** 출력 위치를 검사한다: 위험한 위치·비어 있지 않은 폴더는 거절한다 (아무것도 만들거나 지우지 않는다) */
export function checkOutput(out: string, { root, electronDist }: Layout): string {
  if (!isAbsolute(out)) fail(`출력 경로는 절대 경로여야 한다: ${out}`);
  const target = resolve(out);
  if (dirname(target) === target) fail(`출력이 드라이브/파일시스템 루트다: ${target}`);
  const protectedPaths = [root, electronDist, join(root, 'out'), join(root, 'node_modules'), join(root, 'resources'), join(root, 'src'), join(root, 'docs'), join(root, 'spikes'), join(root, 'tests'), join(root, 'scripts')];
  for (const p of protectedPaths) {
    if (isInside(target, p)) fail(`출력이 입력/저장소 안이다 (${p}): ${target}`);
    if (isInside(p, target)) fail(`출력이 입력/저장소의 상위 폴더이거나 같다 (${p}): ${target}`);
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) fail(`출력이 이미 있고 폴더가 아니다: ${target}`);
    if (readdirSync(target).length > 0) fail(`출력 폴더가 비어 있지 않다 (덮어쓰지 않는다): ${target}`);
  } else if (!existsSync(dirname(target))) {
    fail(`출력의 상위 폴더가 없다 (만들지 않는다): ${dirname(target)}`);
  }
  return target;
}

export const defaultOutput = (): string => join(tmpdir(), `LoreWeave-win-x64-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);

/** 산출물에 있으면 안 되는 이름 (허용 목록으로 만들지만 한 번 더 확인한다) */
const FORBIDDEN = [/^\.env/i, /^spikes$/i, /^m5-work$/i, /^\.loreweave$/i, /^ai\.db$/i, /^index\.db$/i, /^openai-key\.bin$/i, /^settings\.json$/i, /^\.claude$/i, /^\.git$/i, /^debug\.log$/i, /^tests$/i, /^docs$/i];

export interface Result {
  out: string;
  files: number;
  bytes: number;
  electronVersion: string;
}

/** 출력 폴더를 만든다. 입력 검사와 출력 검사를 모두 통과해야 하고, 실패하면 새로 만든 것 외에는 아무것도 바꾸지 않는다 */
export function build(layout: Layout, out: string): Result {
  const info = checkInputs(layout);
  const target = checkOutput(out, layout);
  const { root, electronDist } = layout;
  if (!existsSync(target)) mkdirSync(target); // 상위 폴더는 만들지 않는다
  // 1) Electron 런타임: 고지(LICENSE, LICENSES.chromium.html)를 포함해 그대로 복사하고, 개발 부산물(debug.log)만 뺀다
  cpSync(electronDist, target, { recursive: true, dereference: false, filter: (src) => basename(src) !== 'debug.log' });
  // 2) 앱: resources/app 에 허용 목록만 (asar 없음)
  const app = join(target, 'resources', 'app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: info.name, version: info.version, main: info.main }, null, 2)}\n`);
  for (const dir of ['main', 'preload', 'renderer']) cpSync(join(root, 'out', dir), join(app, 'out', dir), { recursive: true, dereference: false });
  mkdirSync(join(app, 'resources'), { recursive: true });
  cpSync(join(root, 'resources', 'app-icon.ico'), join(app, 'resources', 'app-icon.ico'));
  // 3) openai SDK: pnpm 링크를 따라간 실제 파일로 복사한다 (복사본이 저장소를 가리키지 않게). 고지 파일도 그 안에 그대로 있다
  const openaiReal = realpathSync(join(root, 'node_modules', 'openai'));
  cpSync(openaiReal, join(app, 'node_modules', 'openai'), { recursive: true, dereference: true });
  // 4) 앱 고지
  cpSync(join(root, 'LICENSE'), join(app, 'LICENSE'));
  cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(app, 'THIRD_PARTY_NOTICES.md'));
  const result = verify(target);
  return { ...result, out: target, electronVersion: info.electronVersion };
}

/** 산출물 검증: 링크 없음(복사본이 독립적), 금지 이름 없음, 필수 파일 있음, resources/app/node_modules에는 openai뿐 */
export function verify(target: string): { files: number; bytes: number } {
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
  walk(target);
  const must = ['electron.exe', 'LICENSE', 'LICENSES.chromium.html', join('resources', 'app', 'package.json'), join('resources', 'app', 'out', 'main', 'index.js'), join('resources', 'app', 'out', 'preload', 'index.js'), join('resources', 'app', 'out', 'renderer', 'index.html'), join('resources', 'app', 'resources', 'app-icon.ico'), join('resources', 'app', 'node_modules', 'openai', 'package.json')];
  const missing = must.filter((p) => !existsSync(join(target, p)));
  if (missing.length > 0) fail(`산출물에 필수 파일이 없다: ${missing.join(', ')}`);
  const nm = readdirSync(join(target, 'resources', 'app', 'node_modules'));
  if (nm.length !== 1 || nm[0] !== 'openai') fail(`resources/app/node_modules에는 openai만 있어야 한다: ${nm.join(', ')}`);
  const outEntries = readdirSync(join(target, 'resources', 'app', 'out')).sort().join(',');
  if (outEntries !== 'main,preload,renderer') fail(`resources/app/out에는 main,preload,renderer만 있어야 한다: ${outEntries}`);
  return { files, bytes };
}

function main(): void {
  const args = process.argv.slice(2);
  let out: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i];
    else fail(`알 수 없는 인자: ${args[i]} (사용: --out <새 폴더>)`);
  }
  assertPlatform();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = build({ root, electronDist: join(root, 'node_modules', 'electron', 'dist') }, out ? resolve(out) : defaultOutput());
  console.log(`Windows x64 폴더형 실행본을 만들었다 (미서명, asar 없음, Electron ${result.electronVersion}).`);
  console.log(`  위치: ${result.out}`);
  console.log(`  파일 ${result.files}개, ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  실행: "${join(result.out, 'electron.exe')}" --user-data-dir=<격리 폴더>   (검증은 새로 만든 합성 원고 프로젝트 폴더와 별도 userData를 모두 써야 한다)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    if (e instanceof PackageError) {
      console.error(`package:win 실패: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
