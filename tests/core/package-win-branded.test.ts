// scripts/package-win-branded.ts의 경계: 합성 입력(가짜 저장소/가짜 Electron 폴더/합성 zip, 모두 임시 폴더)으로만 검사한다.
// 실제 packager·Electron zip·원고·설정은 쓰지 않고, 아무것도 설치·다운로드하지 않는다. 거절 검사는 임시 루트가 만들어지기 전에(=부작용 전에) 실패함을 본다.
// 이 테스트는 파일을 삭제하지 않는다 (삭제 방어는 별도 자식 프로세스에서 실제 fs 호출을 가로채는지 본다).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBranded, checkBrandedOutput, scanZipEntries, verifyBrandedTree, verifyZip } from '../../scripts/package-win-branded.ts';
import { PackageError } from '../../scripts/package-win.ts';
import { evaluateRmTarget } from '../../scripts/rm-guard.ts';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `loreweave-brtest-${prefix}-`));
const put = (path: string, text = 'x') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const rejects = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PackageError && pattern.test(e.message));

/** 최소 zip(저장 방식) 만들기. unixMode를 주면 유닉스 모드 비트를 외부 속성에 넣는다 (0o120000 = 심볼릭 링크) */
function makeZip(entries: { name: string; data?: string; unixMode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data ?? '');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.unixMode === undefined ? 0 : (e.unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ZIP_NAME = 'electron-v44.9.3-win32-x64.zip';

/** 가짜 저장소 + 가짜 Electron dist + checksums.json(합성 zip의 해시) + 합성 zip 폴더 */
function fixture(zipBytes: Buffer = makeZip([{ name: 'electron.exe', data: 'E' }])) {
  const base = tmp('fx');
  const root = join(base, 'repo');
  const electronDist = join(root, 'node_modules', 'electron', 'dist');
  put(join(root, 'package.json'), JSON.stringify({ name: 'loreweave', version: '0.1.0', main: 'out/main/index.js', devDependencies: { electron: '44.9.3', '@electron/packager': '20.3.0' } }));
  put(join(root, 'out', 'main', 'index.js'));
  put(join(root, 'out', 'preload', 'index.js'));
  put(join(root, 'out', 'renderer', 'index.html'));
  put(join(root, 'resources', 'app-icon.ico'));
  put(join(root, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 tester\n');
  put(join(root, 'THIRD_PARTY_NOTICES.md'));
  const real = join(root, 'node_modules', '.pnpm', 'openai@7.43.0', 'node_modules', 'openai');
  put(join(real, 'package.json'), '{"name":"openai"}');
  put(join(real, 'index.js'));
  symlinkSync(real, join(root, 'node_modules', 'openai'), 'junction');
  put(join(electronDist, 'electron.exe'));
  put(join(electronDist, 'version'), '44.9.3\n');
  put(join(electronDist, 'LICENSE'));
  put(join(electronDist, 'LICENSES.chromium.html'));
  put(join(electronDist, 'resources', 'default_app.asar'));
  put(join(electronDist, 'locales', 'ko.pak'));
  const zipDir = join(base, 'zip');
  mkdirSync(zipDir);
  writeFileSync(join(zipDir, ZIP_NAME), zipBytes);
  put(join(root, 'node_modules', 'electron', 'checksums.json'), JSON.stringify({ [ZIP_NAME]: sha(zipBytes) }));
  const tmpBase = join(base, 'tmpbase');
  mkdirSync(tmpBase);
  return { base, root, zipDir, tmpBase, layout: { root, electronDist } };
}

/** 거절은 임시 루트·최종 출력이 만들어지기 전에 일어난다 */
const noSideEffects = (f: ReturnType<typeof fixture>, out: string) => {
  assert.deepEqual(readdirSync(f.tmpBase), [], '독점 임시 루트가 만들어지지 않았다');
  assert.equal(existsSync(out), false, '최종 출력이 만들어지지 않았다');
};

test('출력: 이미 있는 폴더(비어 있어도)·비어 있지 않은 폴더·저장소 안/상위·링크로 저장소 안을 가리키는 경로는 임시 루트를 만들기 전에 거절한다', () => {
  const f = fixture();
  const opts = { tmpBase: f.tmpBase, zipDir: f.zipDir };
  const empty = join(f.base, 'existing-empty');
  mkdirSync(empty);
  rejects(() => buildBranded(f.layout, empty, opts), /이미 있다/);
  const filled = join(f.base, 'existing-filled');
  put(join(filled, 'keep.txt'));
  rejects(() => buildBranded(f.layout, filled, opts), /비어 있지 않다/);
  rejects(() => buildBranded(f.layout, join(f.root, 'dist-out'), opts), /저장소 안/);
  rejects(() => buildBranded(f.layout, f.base, opts), /상위 폴더/);
  const alias = join(f.base, 'alias');
  symlinkSync(join(f.root, 'out'), alias, 'junction');
  rejects(() => buildBranded(f.layout, join(alias, 'sub'), opts), /저장소 안|상위/);
  rejects(() => buildBranded(f.layout, join(f.base, 'no-parent', 'child'), opts), /상위 폴더가 없다/);
  assert.deepEqual(readdirSync(f.tmpBase), [], '독점 임시 루트가 만들어지지 않았다');
  assert.equal(readdirSync(filled).join(','), 'keep.txt', '기존 폴더 내용은 그대로다');
  assert.doesNotThrow(() => checkBrandedOutput(join(f.base, 'fresh-out'), f.layout), '새 경로는 통과한다');
});

test('허용 목록 위반(원고·실험물·로그·임의 파일): 임시 루트를 만들기 전에 거절한다', () => {
  for (const rel of ['out/main/secret.json', 'out/preload/run.log', 'out/renderer/notes.txt']) {
    const f = fixture();
    put(join(f.root, ...rel.split('/')), 'X');
    const out = join(f.base, 'out-new');
    rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: f.zipDir }), /허용 목록에 없는|예기치 않은/);
    noSideEffects(f, out);
  }
});

test('Electron zip: 없음·해시 불일치·checksums 항목 없음·링크 폴더·위험한 엔트리는 다운로드 없이 명확히 실패하고 부작용이 없다', () => {
  // 없음
  let f = fixture();
  const emptyDir = join(f.base, 'empty-zip-dir');
  mkdirSync(emptyDir);
  let out = join(f.base, 'o1');
  rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: emptyDir }), /Electron zip이 없다[\s\S]*다운로드하지 않는다/);
  noSideEffects(f, out);
  // 해시 불일치 (zip을 바꿔 둔다)
  f = fixture();
  writeFileSync(join(f.zipDir, ZIP_NAME), makeZip([{ name: 'electron.exe', data: 'TAMPERED' }]));
  out = join(f.base, 'o2');
  rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: f.zipDir }), /SHA-256이 checksums\.json과 다르다/);
  noSideEffects(f, out);
  // checksums 항목 없음
  f = fixture();
  writeFileSync(join(f.root, 'node_modules', 'electron', 'checksums.json'), '{}');
  out = join(f.base, 'o3');
  rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: f.zipDir }), /항목이 없다/);
  noSideEffects(f, out);
  // 해시가 맞아도 위험한 엔트리(경로 탈출, 심볼릭 링크 엔트리)가 있으면 거절
  for (const entries of [[{ name: '../evil.txt' }], [{ name: 'C:/evil.txt' }], [{ name: 'dir/link', unixMode: 0o120777 }]]) {
    f = fixture(makeZip(entries));
    out = join(f.base, 'o4');
    rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: f.zipDir }), /위험한 엔트리/);
    noSideEffects(f, out);
  }
  // zip 폴더 자체가 링크
  f = fixture();
  const linkDir = join(f.base, 'zip-link');
  symlinkSync(f.zipDir, linkDir, 'junction');
  out = join(f.base, 'o5');
  rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: linkDir }), /링크다/);
  noSideEffects(f, out);
});

test('scanZipEntries/verifyZip: 정상 zip은 통과하고 엔트리 수를 센다', () => {
  const f = fixture(makeZip([{ name: 'electron.exe' }, { name: 'locales/ko.pak' }, { name: 'resources/' }]));
  const info = verifyZip(f.zipDir, '44.9.3', join(f.root, 'node_modules', 'electron', 'checksums.json'));
  assert.equal(info.entries, 3);
  assert.equal(info.sha256, sha(makeZip([{ name: 'electron.exe' }, { name: 'locales/ko.pak' }, { name: 'resources/' }])));
  assert.deepEqual(scanZipEntries(join(f.zipDir, ZIP_NAME)).bad, []);
});

test('packager가 package.json에 정확 20.3.0으로 고정되어 있지 않으면 임시 루트를 만들기 전에 실패한다', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'loreweave', version: '0.1.0', main: 'out/main/index.js', devDependencies: { electron: '44.9.3', '@electron/packager': '^20.3.0' } }));
  const out = join(f.base, 'o');
  rejects(() => buildBranded(f.layout, out, { tmpBase: f.tmpBase, zipDir: f.zipDir }), /정확 20\.3\.0/);
  noSideEffects(f, out);
});

test('삭제 대상 평가: 허용 하위트리 안만 허용하고, 같은 루트·밖·링크로 밖으로 나가는 대상·링크 항목은 거절한다', () => {
  const base = tmp('rm');
  const allowed = join(base, 'allowed');
  const outside = join(base, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  put(join(allowed, 'child', 'f.txt'));
  put(join(outside, 'victim.txt'));
  symlinkSync(outside, join(allowed, 'jn'), 'junction');
  assert.equal(evaluateRmTarget('rm', join(allowed, 'child'), { recursive: true }, [allowed]).allowed, true, '허용 하위트리 안');
  assert.equal(evaluateRmTarget('rm', join(allowed, 'not-yet', 'x'), { recursive: true, force: true }, [allowed]).allowed, true, '아직 없는 하위 경로도 안쪽이면 허용(삭제할 것이 없다)');
  assert.equal(evaluateRmTarget('rm', allowed, { recursive: true }, [allowed]).allowed, false, '허용 루트 자체는 거절');
  assert.equal(evaluateRmTarget('rm', outside, { recursive: true }, [allowed]).allowed, false, '밖');
  assert.equal(evaluateRmTarget('rm', join(allowed, '..', 'outside', 'victim.txt'), null, [allowed]).allowed, false, '.. 탈출');
  assert.equal(evaluateRmTarget('rm', join(allowed, 'jn', 'victim.txt'), null, [allowed]).allowed, false, 'junction으로 밖을 가리키는 경로');
  assert.equal(evaluateRmTarget('rmdir', join(allowed, 'jn'), null, [allowed]).allowed, false, '링크 항목 자체');
  assert.equal(existsSync(join(outside, 'victim.txt')), true);
});

test('삭제 방어 설치(자식 프로세스): 허용 밖·junction 경유 삭제는 실제 삭제 전에 거절되고 파일이 그대로 남으며, 허용 안 호출은 기록된다', () => {
  const base = tmp('rmchild');
  const allowed = join(base, 'allowed');
  const outside = join(base, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  put(join(outside, 'victim.txt'));
  put(join(allowed, 'mine.txt'));
  symlinkSync(outside, join(allowed, 'jn'), 'junction');
  const script = `
    import fs from 'node:fs';
    import { installRmGuard } from './scripts/rm-guard.ts';
    const calls = [];
    installRmGuard([${JSON.stringify(allowed)}], (c) => calls.push(c));
    const results = {};
    const attempt = async (label, fn) => { try { await fn(); results[label] = 'ok'; } catch (e) { results[label] = String(e.message).split(' (')[0]; } };
    await attempt('outsideSync', () => fs.rmSync(${JSON.stringify(join(outside, 'victim.txt'))}));
    await attempt('outsidePromise', () => fs.promises.rm(${JSON.stringify(join(outside, 'victim.txt'))}, { force: true }));
    await attempt('viaJunction', () => fs.promises.rm(${JSON.stringify(join(allowed, 'jn', 'victim.txt'))}, { recursive: true, force: true }));
    await attempt('unlinkOutside', () => fs.promises.unlink(${JSON.stringify(join(outside, 'victim.txt'))}));
    console.log(JSON.stringify({ results, calls: calls.map((c) => [c.api, c.allowed]) }));
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { results, calls } = JSON.parse(run.stdout.trim().split('\n').pop()!) as { results: Record<string, string>; calls: [string, boolean][] };
  for (const label of ['outsideSync', 'outsidePromise', 'viaJunction', 'unlinkOutside']) assert.match(results[label]!, /rm 방어/, `${label} 거절`);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([, allowed]) => allowed === false), '모든 호출이 기록되고 허용 밖으로 판정');
  assert.equal(existsSync(join(outside, 'victim.txt')), true, '파일이 삭제되지 않았다');
});

test('브랜드 산출물 검증: 올바른 구조는 통과하고 electron.exe·app.asar·default_app·링크·허용 밖 파일·다른 identity는 거절한다', () => {
  const info = { name: 'loreweave', version: '0.1.0', main: 'out/main/index.js' };
  const make = () => {
    const app = join(tmp('tree'), 'LoreWeave');
    for (const f of ['LoreWeave.exe', 'LICENSE', 'LICENSES.chromium.html', 'icudtl.dat', 'locales/ko.pak', 'resources/app/out/main/index.js', 'resources/app/out/preload/index.js', 'resources/app/out/renderer/index.html', 'resources/app/resources/app-icon.ico', 'resources/app/node_modules/openai/package.json', 'resources/app/LICENSE', 'resources/app/THIRD_PARTY_NOTICES.md']) put(join(app, ...f.split('/')));
    put(join(app, 'resources', 'app', 'package.json'), `${JSON.stringify(info, null, 2)}\n`);
    return app;
  };
  assert.doesNotThrow(() => verifyBrandedTree(make(), info));
  const cases: [string, (app: string) => void, RegExp][] = [
    ['electron.exe 잔존', (a) => put(join(a, 'electron.exe')), /있으면 안 되는|허용 목록/],
    ['app.asar', (a) => put(join(a, 'resources', 'app.asar')), /있으면 안 되는/],
    ['default_app.asar', (a) => put(join(a, 'resources', 'default_app.asar')), /있으면 안 되는/],
    ['허용 밖 파일', (a) => put(join(a, 'notes.txt')), /허용 목록에 없는/],
    ['금지 이름', (a) => put(join(a, 'resources', 'app', 'settings.json')), /금지된 이름/],
    ['다른 node_modules', (a) => put(join(a, 'resources', 'app', 'node_modules', 'other', 'x.js')), /openai만/],
    ['링크', (a) => symlinkSync(join(a, 'resources'), join(a, 'resources', 'app', 'jn'), 'junction'), /링크/],
    ['다른 identity', (a) => put(join(a, 'resources', 'app', 'package.json'), JSON.stringify({ name: 'LoreWeave', version: '0.1.0', main: 'out/main/index.js' })), /identity/],
  ];
  for (const [label, mutate, pattern] of cases) {
    const app = make();
    mutate(app);
    assert.throws(() => verifyBrandedTree(app, info), (e: unknown) => e instanceof PackageError && pattern.test(e.message), label);
  }
});

test('최종 출력은 Electron zip 폴더(읽기 전용 입력/캐시) 안·같음·상위·junction 별칭 경유 동등 경로면 packager·독점 루트·최종 출력 생성 전에 거절하고 zip 폴더·zip 바이트는 그대로다', () => {
  const f = fixture();
  const opts = { tmpBase: f.tmpBase, zipDir: f.zipDir };
  const zipBefore = createHash('sha256').update(readFileSync(join(f.zipDir, ZIP_NAME))).digest('hex');
  const listingBefore = readdirSync(f.zipDir).join(',');
  const outsideAlias = join(f.base, 'alias-to-zip');
  symlinkSync(f.zipDir, outsideAlias, 'junction'); // 외부 junction이 zip 폴더를 가리킨다
  const cases: [string, string, RegExp][] = [
    ['zip 폴더의 자식 새 경로', join(f.zipDir, 'new-output'), /zip 폴더 안/],
    ['zip 폴더와 같음', f.zipDir, /zip 폴더 안이거나 같다|비어 있지 않다/],
    ['zip 폴더의 상위(= 테스트 base)', f.base, /상위 폴더|zip 폴더의 상위/],
    ['외부 junction을 거친 동등 경로', join(outsideAlias, 'new-output'), /zip 폴더 안/],
  ];
  for (const [label, out, pattern] of cases) {
    assert.throws(() => buildBranded(f.layout, out, opts), (e: unknown) => e instanceof PackageError && pattern.test(e.message), label);
    assert.equal(existsSync(join(f.zipDir, 'new-output')), false, `${label}: zip 폴더에 아무것도 만들어지지 않았다`);
  }
  assert.deepEqual(readdirSync(f.tmpBase), [], '독점 임시 루트가 만들어지지 않았다');
  assert.equal(readdirSync(f.zipDir).join(','), listingBefore, 'zip 폴더 내용 불변');
  assert.equal(createHash('sha256').update(readFileSync(join(f.zipDir, ZIP_NAME))).digest('hex'), zipBefore, 'zip 바이트 불변');
  // 정상 외부 새 출력은 유지된다 (검사 함수 수준; 실제 빌드는 하지 않는다)
  assert.doesNotThrow(() => checkBrandedOutput(join(f.base, 'fresh-out'), f.layout, f.zipDir));
});
