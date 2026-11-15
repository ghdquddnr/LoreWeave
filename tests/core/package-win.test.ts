// scripts/package-win.ts의 중요한 경계: 필수 입력 누락·플랫폼 불일치·위험한 출력 위치의 명시적 거절, 허용 목록만 복사, pnpm 링크를 실체 파일로 복사(복사본 독립), 금지 이름 제외.
// 가짜 저장소/가짜 Electron 폴더(임시 폴더)로 실행한다: 실제 Electron 런타임을 복사하지 않고, 아무것도 설치·다운로드하지 않으며, 실제 저장소·원고·키·DB를 건드리지 않는다.

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPlatform, build, checkInputs, checkOutput, PackageError, verify } from '../../scripts/package-win.ts';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `loreweave-pkgtest-${prefix}-`));
const put = (path: string, text = 'x') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/** 가짜 저장소 + 가짜 Electron dist. openai는 .pnpm 안의 실제 폴더로 두고 node_modules/openai는 링크(junction)로 건다 */
function fixture() {
  const base = tmp('fx');
  const root = join(base, 'repo');
  const electronDist = join(root, 'node_modules', 'electron', 'dist');
  put(join(root, 'package.json'), JSON.stringify({ name: 'loreweave', version: '0.1.0', main: 'out/main/index.js', devDependencies: { electron: '44.9.3' } }));
  put(join(root, 'out', 'main', 'index.js'));
  put(join(root, 'out', 'preload', 'index.js'));
  put(join(root, 'out', 'renderer', 'index.html'));
  put(join(root, 'out', 'renderer', 'assets', 'a.woff2'));
  put(join(root, 'out', 'm5-work', 'secret-experiment.json'), 'EXPERIMENT');
  put(join(root, 'out', 'm6-run.log'), 'LOG');
  put(join(root, 'resources', 'app-icon.ico'));
  put(join(root, 'LICENSE'));
  put(join(root, 'THIRD_PARTY_NOTICES.md'));
  put(join(root, '.env'), 'OPENAI_API_KEY=SHOULD_NOT_BE_COPIED');
  put(join(root, 'spikes', 'm0a', 'raw', 'x.json'), 'RAW');
  put(join(root, 'docs', 'secret-plan.md'));
  const real = join(root, 'node_modules', '.pnpm', 'openai@7.43.0', 'node_modules', 'openai');
  put(join(real, 'package.json'), '{"name":"openai"}');
  put(join(real, 'LICENSE'), 'openai license');
  put(join(real, 'index.js'));
  symlinkSync(real, join(root, 'node_modules', 'openai'), 'junction');
  put(join(electronDist, 'electron.exe'));
  put(join(electronDist, 'version'), '44.9.3\n');
  put(join(electronDist, 'LICENSE'), 'electron license');
  put(join(electronDist, 'LICENSES.chromium.html'), 'chromium licenses');
  put(join(electronDist, 'debug.log'), 'DEBUG');
  put(join(electronDist, 'resources', 'default_app.asar'));
  put(join(electronDist, 'locales', 'ko.pak'));
  return { base, root, layout: { root, electronDist } };
}
const rejects = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof PackageError && pattern.test(e.message));

test('플랫폼·arch: win32/x64가 아니면 명시적으로 실패한다', () => {
  assert.doesNotThrow(() => assertPlatform('win32', 'x64'));
  rejects(() => assertPlatform('linux', 'x64'), /Windows x64/);
  rejects(() => assertPlatform('win32', 'arm64'), /Windows x64/);
  rejects(() => assertPlatform('darwin', 'arm64'), /Windows x64/);
});

test('필수 입력 누락: 빌드 산출물·런타임·고지·아이콘·openai가 없으면 어떤 파일이 없는지 알리며 실패하고, Electron 버전 불일치도 실패한다', () => {
  const missingPaths = [
    ['out/main/index.js', /out[\\/]main[\\/]index\.js/],
    ['resources/app-icon.ico', /app-icon\.ico/],
    ['node_modules/electron/dist/electron.exe', /electron\.exe/],
    ['node_modules/electron/dist/LICENSES.chromium.html', /LICENSES\.chromium\.html/],
    ['THIRD_PARTY_NOTICES.md', /THIRD_PARTY_NOTICES/],
  ] as const;
  for (const [rel, re] of missingPaths) {
    const f = fixture();
    const target = join(f.root, ...rel.split('/'));
    // 지우는 대신 이름을 바꿔 없앤다 (테스트도 삭제하지 않는다)
    renameSync(target, `${target}.gone`);
    rejects(() => checkInputs(f.layout), re);
  }
  const f = fixture();
  writeFileSync(join(f.layout.electronDist, 'version'), '43.0.0\n');
  rejects(() => checkInputs(f.layout), /Electron 런타임\(43\.0\.0\).*44\.9\.3/);
});

test('위험한 출력은 거절한다: 저장소/입력 안·상위·같음, 루트, 비어 있지 않은 폴더, 폴더가 아닌 것, 상위 폴더 없음 — 아무것도 만들거나 지우지 않는다', () => {
  const f = fixture();
  const before = readdirSync(f.base).join(',');
  rejects(() => checkOutput(f.root, f.layout), /입력\/저장소/);
  rejects(() => checkOutput(join(f.root, 'dist-out'), f.layout), /저장소 안/);
  rejects(() => checkOutput(join(f.root, 'out'), f.layout), /입력\/저장소/);
  rejects(() => checkOutput(join(f.root, 'out', 'sub'), f.layout), /저장소 안/);
  rejects(() => checkOutput(f.layout.electronDist, f.layout), /입력\/저장소/);
  rejects(() => checkOutput(f.base, f.layout), /상위 폴더이거나 같다/);
  rejects(() => checkOutput(join(f.base, '..'), f.layout), /상위 폴더이거나 같다/);
  rejects(() => checkOutput('relative/out', f.layout), /절대 경로/);
  const nonEmpty = tmp('nonempty');
  writeFileSync(join(nonEmpty, 'keep.txt'), 'USER FILE');
  rejects(() => checkOutput(nonEmpty, f.layout), /비어 있지 않다/);
  assert.equal(readFileSync(join(nonEmpty, 'keep.txt'), 'utf8'), 'USER FILE', '거절해도 기존 파일은 그대로다');
  const aFile = join(tmp('file'), 'a.txt');
  writeFileSync(aFile, 'x');
  rejects(() => checkOutput(aFile, f.layout), /폴더가 아니다/);
  rejects(() => checkOutput(join(tmp('parent'), 'missing', 'out'), f.layout), /상위 폴더가 없다/);
  assert.equal(readdirSync(f.base).join(','), before, '거절 검사가 저장소 옆에 아무것도 만들지 않았다');
  // 정상: 새 폴더와 비어 있는 기존 폴더는 받는다
  assert.doesNotThrow(() => checkOutput(join(tmp('ok'), 'new'), f.layout));
  assert.doesNotThrow(() => checkOutput(tmp('empty'), f.layout));
});

test('생성: 허용 목록만 복사하고, 고지는 보존하며, openai는 링크가 아닌 실체 파일로 복사하고, 실험 폴더·.env·spikes·docs·debug.log는 제외한다', () => {
  const f = fixture();
  const out = join(tmp('out'), 'LoreWeave-win-x64-test');
  const result = build(f.layout, out);
  assert.equal(result.out, out);
  assert.ok(result.files > 0 && result.bytes > 0);
  const app = join(out, 'resources', 'app');
  // 포함
  for (const p of ['electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'version', join('locales', 'ko.pak'), join('resources', 'default_app.asar')]) assert.ok(existsSync(join(out, p)), `${p} 포함`);
  assert.equal(readFileSync(join(out, 'LICENSE'), 'utf8'), 'electron license', 'Electron 고지를 그대로 보존');
  assert.equal(readFileSync(join(out, 'LICENSES.chromium.html'), 'utf8'), 'chromium licenses');
  assert.deepEqual(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')), { name: 'loreweave', version: '0.1.0', main: 'out/main/index.js' }, '최소 package.json');
  for (const p of [join('out', 'main', 'index.js'), join('out', 'preload', 'index.js'), join('out', 'renderer', 'index.html'), join('out', 'renderer', 'assets', 'a.woff2'), join('resources', 'app-icon.ico'), 'LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.ok(existsSync(join(app, p)), `${p} 포함`);
  // openai: 링크가 아니라 실체, SDK 고지도 복사
  const openai = join(app, 'node_modules', 'openai');
  assert.equal(lstatSync(openai).isSymbolicLink(), false, 'openai는 링크가 아니다');
  assert.equal(lstatSync(openai).isDirectory(), true);
  assert.equal(readFileSync(join(openai, 'LICENSE'), 'utf8'), 'openai license', 'SDK 고지 보존');
  assert.deepEqual(readdirSync(join(app, 'node_modules')), ['openai'], 'node_modules에는 openai뿐');
  assert.equal(readdirSync(join(app, 'out')).sort().join(','), 'main,preload,renderer', 'out의 실험 폴더·로그는 제외');
  // 제외
  for (const p of ['debug.log', join('resources', 'app', '.env'), join('resources', 'app', 'spikes'), join('resources', 'app', 'docs'), join('resources', 'app', 'out', 'm5-work'), join('resources', 'app', 'out', 'm6-run.log')]) assert.equal(existsSync(join(out, p)), false, `${p} 제외`);
  // 입력(가짜 저장소)은 바뀌지 않았다
  assert.equal(readFileSync(join(f.root, '.env'), 'utf8'), 'OPENAI_API_KEY=SHOULD_NOT_BE_COPIED');
  assert.equal(readFileSync(join(f.layout.electronDist, 'debug.log'), 'utf8'), 'DEBUG');
  // 같은 출력에 다시 만들면 거절한다 (자기 출력을 덮어쓰거나 다시 복사하지 않는다)
  rejects(() => build(f.layout, out), /비어 있지 않다/);
});

test('검증: 산출물에 링크가 있거나 금지 이름·필수 파일 누락이 있으면 실패한다', () => {
  const f = fixture();
  const out = join(tmp('verify'), 'out');
  build(f.layout, out);
  assert.doesNotThrow(() => verify(out));
  // 금지 이름 심기 (산출물 검증이 허용 목록 위반을 잡는지)
  writeFileSync(join(out, 'resources', 'app', '.env'), 'KEY');
  rejects(() => verify(out), /금지된 이름/);
});

test('검증: 링크가 남아 있으면 복사본이 독립적이지 않다고 실패한다', () => {
  const f = fixture();
  const out = join(tmp('linkverify'), 'out');
  build(f.layout, out);
  const outside = tmp('outside');
  symlinkSync(outside, join(out, 'resources', 'app', 'node_modules', 'linked'), 'junction');
  rejects(() => verify(out), /링크가 있다/);
});

// ---- PR #219 보완: 엄격 허용 목록(예기치 않은 파일 거절, 사전 검사) / junction·symlink 별칭을 통한 출력 보호 우회 ----

test('엄격 허용 목록: 설치 런타임·빌드 산출물·SDK 안의 예기치 않은 파일(원고·로그·키·실험물)은 복사하지 않고 거절하며, 거절하면 출력 폴더를 만들지 않는다', () => {
  const cases: [string, string][] = [
    ['Electron 런타임 폴더의 원고', 'node_modules/electron/dist/private-manuscript.md'],
    ['main 산출물의 실행 로그', 'out/main/private-run.log'],
    ['preload 산출물의 소스맵', 'out/preload/index.js.map'],
    ['renderer 산출물의 메모', 'out/renderer/assets/notes.md'],
    ['renderer 최상위의 임의 파일', 'out/renderer/private-run.log'],
    ['SDK 폴더의 원고', 'node_modules/.pnpm/openai@7.43.0/node_modules/openai/private-manuscript.md'],
    ['SDK 폴더의 키 파일', 'node_modules/.pnpm/openai@7.43.0/node_modules/openai/src/.env'],
    ['Electron locales의 비 pak 파일', 'node_modules/electron/dist/locales/secret.txt'],
  ];
  for (const [label, rel] of cases) {
    const f = fixture();
    put(join(f.root, ...rel.split('/')), 'SYNTHETIC_PRIVATE_CONTENT');
    const out = join(tmp('leak'), 'out');
    rejects(() => build(f.layout, out), /예기치 않은 파일/);
    assert.equal(existsSync(out), false, `${label}: 거절하면 출력 폴더를 만들지 않는다 (민감 파일을 먼저 복사해 두지 않는다)`);
  }
  // 이미 있는 빈 출력 폴더도 거절 뒤 비어 있다
  const f = fixture();
  put(join(f.root, 'out', 'main', 'private-run.log'), 'SYNTHETIC_PRIVATE_CONTENT');
  const empty = tmp('leak-empty');
  rejects(() => build(f.layout, empty), /예기치 않은 파일/);
  assert.deepEqual(readdirSync(empty), [], '거절 뒤에도 빈 출력 폴더는 비어 있다');
  // 정상 산출물에는 허용 목록 밖 파일이 없다
  const ok = fixture();
  const out = join(tmp('allow'), 'out');
  build(ok.layout, out);
  assert.equal(existsSync(join(out, 'resources', 'app', 'out', 'main', 'private-run.log')), false);
});

test('출력 보호는 실제 경로로 본다: junction 별칭으로 저장소/입력 안·상위·같음을 우회할 수 없고, 출력 자체가 링크여도 거절하며, 정상 외부 새 폴더만 받는다 (아무것도 만들지 않는다)', () => {
  // 1) 저장소를 가리키는 외부 junction 별칭 아래의 새 출력
  const f = fixture();
  const alias = join(f.base, 'repo-alias');
  symlinkSync(f.root, alias, 'junction');
  rejects(() => checkOutput(join(alias, 'packaged-output'), f.layout), /입력\/저장소|저장소 안|링크/);
  rejects(() => build(f.layout, join(alias, 'packaged-output')), /입력\/저장소|저장소 안|링크/);
  assert.equal(existsSync(join(f.root, 'packaged-output')), false, '별칭을 통해 실제 저장소 안에 아무것도 만들지 않았다');
  // 2) 별칭 자체를 출력으로
  rejects(() => checkOutput(alias, f.layout), /입력\/저장소|저장소 안|링크|상위/);
  // 3) 기존의 빈 외부 폴더를 가리키는 junction을 출력으로: 출력 자체가 링크라 거절하고 대상은 비어 있다
  const external = tmp('ext-empty');
  const link = join(tmp('linkdir'), 'out-link');
  symlinkSync(external, link, 'junction');
  rejects(() => checkOutput(link, f.layout), /링크/);
  rejects(() => build(f.layout, link), /링크/);
  assert.deepEqual(readdirSync(external), [], '링크 대상 폴더에 아무것도 만들지 않았다');
  // 4) 저장소 안의 폴더를 가리키는 junction을 출력으로
  const inner = join(f.root, 'docs');
  const innerLink = join(tmp('linkdir2'), 'docs-link');
  symlinkSync(inner, innerLink, 'junction');
  rejects(() => checkOutput(innerLink, f.layout), /입력\/저장소|저장소 안|링크/);
  // 5) 정상: 저장소 밖의 새 폴더는 받는다
  assert.doesNotThrow(() => checkOutput(join(tmp('fine'), 'new-output'), f.layout));
});
