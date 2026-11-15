// [브랜드 실행본 smoke] `package:win:branded`가 만든 LoreWeave.exe(미서명 폴더형)를 *그 실행파일 자체*로 실행해 최소 시나리오를 확인한다. 합성 Electron/Playwright 자동화이며 수동 GUI·실제 IME가 아니다.
// 격리: 매번 새 --user-data-dir(절대경로, 임시 폴더) + 이 테스트가 새로 만든 합성 원고 프로젝트(BOM+CRLF+frontmatter). 실제 프로젝트·설정·키·기존 AI DB를 열지 않고 AI/API/Costs 호출 0.
// 시작 장벽: 실행 전에 argv 검사(userData가 절대경로·새 임시 폴더·실제 기본 프로필과 무관)를 하고, 실행 중에는 --inspect-brk로 *제품 main 실행 전에* 멈춰 실제 userData·argv가 기대 경로일 때만 재개한다(packaged-barrier.ts).
//   장벽 보장 범위는 제품 main 실행 경계까지이며 Electron/Chromium 자체의 초기화는 막지 못한다. --user-data-dir 없는 실행(실제 기본 프로필)은 하지 않는다.
// 빌드: 먼저 build 되어 있어야 한다 (test:e2e가 build한다). 산출물과 독점 임시 루트는 저장소 밖 임시 폴더에 남기고 이 테스트가 삭제하지 않는다.
// 한계: OS 탐색기·작업표시줄 아이콘, SmartScreen, 다른 PC, 외부 네트워크 전체 0은 이 검사로 확인하지 못한다 (관측은 main/renderer의 JS 수준 요청과 Chromium 해석 차단 설정 범위).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './launch.ts';
import { chapterButton, editor, ONE, TWO } from './package-launch.ts';
import { launchBarriered } from './packaged-barrier.ts';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string; version: string; main: string };
const PHASES = ['paused-before-product-main', 'userData-and-argv-verified', 'tools-installed', 'resumed'];

/** 실행 전 argv 검사: userData는 절대경로이고 이 테스트가 방금 만든 임시 폴더이며 실제 기본 프로필(%APPDATA%\<name>)과 무관하다 */
function assertIsolatedUserData(userData: string): void {
  assert.ok(isAbsolute(userData), 'userData는 절대경로다');
  const real = realpathSync.native(userData);
  const tmp = realpathSync.native(tmpdir());
  const rel = relative(tmp.toLowerCase(), real.toLowerCase());
  assert.ok(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'userData는 임시 폴더 안의 새 폴더다');
  assert.ok(process.env['APPDATA'], 'APPDATA가 있어야 실제 기본 경로와 비교한다');
  const realDefault = join(process.env['APPDATA']!, pkg.name).toLowerCase();
  assert.ok(real.toLowerCase() !== realDefault && !real.toLowerCase().startsWith(`${realDefault}\\`), '실제 기본 프로필 경로가 아니다');
}

const built: { out: string; exe: string; root: string } = { out: '', exe: '', root: '' };

test('브랜드 실행본: 빌드(PE 문자열·아이콘·고지·비ASAR 검증 포함) → 장벽(음성) → 환영→폴더 열기→입력→저장→닫기→재열기→검색, identity·보안 설정 유지', { timeout: 600_000 }, async () => {
  // 1) 빌드: 저장소 밖의 새 폴더에 만든다 (스크립트가 PE 문자열·아이콘 6프레임·고지·허용 목록·SDK·링크 0·입력 해시 불변을 검증하고 실패하면 비정상 종료한다)
  const out = join(tmpdir(), `LoreWeave-branded-smoke-${Date.now().toString(36)}`);
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/package-win-branded.ts', '--out', out], { cwd: process.cwd(), encoding: 'utf8' });
  const root = /독점 임시 루트[^:]*: (.+)/.exec(output)?.[1]?.trim() ?? '';
  console.error('PACKAGE_BRANDED_OUTPUT', JSON.stringify({ out, root, summary: output.split('\n').filter((l) => l.includes('파일') || l.includes('위치')) }));
  const exe = join(out, 'LoreWeave.exe');
  Object.assign(built, { out, exe, root });
  assert.equal(out.startsWith(process.cwd()), false, '출력은 저장소 밖이다');
  assert.ok((await stat(exe)).isFile(), 'LoreWeave.exe');
  assert.equal(existsSync(join(out, 'electron.exe')), false, 'electron.exe는 없다');
  const buildInfo = JSON.parse(await readFile(join(root, 'logs', 'build.json'), 'utf8')) as { strings: Record<string, string>; iconFrames: number; rmCalls: number; hashesUnchanged: boolean };
  assert.deepEqual([buildInfo.strings['ProductName'], buildInfo.strings['OriginalFilename'], buildInfo.strings['ProductVersion']], ['LoreWeave', 'LoreWeave.exe', pkg.version], 'PE 문자열');
  assert.equal(buildInfo.iconFrames, 6, 'ICO 6프레임');
  assert.equal(buildInfo.hashesUnchanged, true, 'zip/Electron dist/ICO 해시 불변');
  const resourcesApp = join(out, 'resources', 'app');
  assert.deepEqual(JSON.parse(await readFile(join(resourcesApp, 'package.json'), 'utf8')), { name: pkg.name, version: pkg.version, main: pkg.main }, 'resources/app identity는 package:win과 같다');
  assert.deepEqual(await readdir(join(resourcesApp, 'node_modules')), ['openai']);
  for (const notice of ['LICENSE', 'LICENSES.chromium.html']) assert.ok((await stat(join(out, notice))).isFile(), `${notice} 보존`);
  for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.ok((await stat(join(resourcesApp, notice))).isFile(), `앱 ${notice} 보존`);

  // 2) 음성 장벽: --user-data-dir(A)와 기대 경로(B)가 다르면 제품 main을 재개하지 않고 이 테스트가 띄운 프로세스만 끝낸다 (A, B 모두 이 테스트가 만든 임시 폴더)
  const negActual = await tempDir('brsmoke-neg-actual');
  const negExpected = await tempDir('brsmoke-neg-expected');
  assertIsolatedUserData(negActual);
  assertIsolatedUserData(negExpected);
  const neg = await launchBarriered(exe, negActual, negExpected);
  const negListing = { actual: await readdir(negActual), expected: await readdir(negExpected) };
  console.error('BRANDED_BARRIER_NEGATIVE', JSON.stringify({ refused: neg.refused, reason: neg.refused ? neg.reason : null, facts: neg.facts, pageTargetsAtRefusal: neg.refused ? neg.pageTargetsAtRefusal : null, listing: negListing }));
  assert.equal(neg.refused, true, '장벽이 거절했다 (제품 main을 재개하지 않았다)');
  if (neg.refused) {
    assert.equal(neg.facts.userData.toLowerCase(), negActual.toLowerCase(), '실제 userData는 --user-data-dir로 준 임시 경로다');
    assert.ok(neg.pageTargetsAtRefusal === null || neg.pageTargetsAtRefusal === 0, '거절 시점에 제품 창(page 대상)이 없다');
  }
  for (const dir of [negActual, negExpected]) for (const productFile of ['settings.json', 'openai-key.bin', '.loreweave']) assert.equal(existsSync(join(dir, productFile)), false, `${productFile}이 ${dir}에 없다 (제품 main이 실행되지 않았다)`);

  // 3) 양성: 새 합성 원고 프로젝트 + 새 userData
  const project = await tempDir('brsmoke-project');
  await mkdir(join(project, 'chapters'));
  await writeFile(join(project, 'chapters', '001.md'), ONE);
  await writeFile(join(project, 'chapters', '002.md'), TWO);
  const userData = await tempDir('brsmoke-userdata');
  assertIsolatedUserData(userData);
  const first = await launchBarriered(exe, userData, userData);
  assert.equal(first.refused, false, '장벽을 통과해야 한다');
  if (first.refused) return;
  try {
    const { page } = first;
    assert.deepEqual(first.phases, PHASES, '제품 main 실행 전에 멈춰 실제 userData·argv를 확인한 뒤 재개했다');
    assert.equal(first.facts.userData.toLowerCase(), userData.toLowerCase());
    const runtime = JSON.parse((await first.evalMain("(() => { const win = globalThis.__lw.BrowserWindow.getAllWindows()[0]; const p = win.webContents.getLastWebPreferences(); return JSON.stringify({ appPath: globalThis.__lw.app.getAppPath(), execPath: process.execPath, userData: globalThis.__lw.app.getPath('userData'), sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity }); })()")) as string) as { appPath: string; execPath: string; userData: string; sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; webSecurity: boolean };
    console.error('BRANDED_FACTS', JSON.stringify({ ...first.facts, ...runtime }));
    assert.equal(first.facts.name, pkg.name, 'app.getName은 package:win과 같은 identity(package.json name)다 (productName/setName 변경 없음)');
    assert.equal(runtime.appPath.toLowerCase(), resourcesApp.toLowerCase());
    assert.ok(runtime.execPath.toLowerCase().endsWith('\\loreweave.exe'), '실행 파일은 LoreWeave.exe다');
    assert.equal(first.facts.isPackaged, true, '이름이 바뀐 실행파일은 isPackaged가 true로 관측된다');
    assert.equal(first.facts.defaultApp, null, 'process.defaultApp은 undefined다');
    assert.equal(runtime.userData.toLowerCase(), userData.toLowerCase(), '격리 userData를 쓴다');
    assert.deepEqual([runtime.sandbox, runtime.contextIsolation, runtime.nodeIntegration, runtime.webSecurity], [true, true, false, true], 'sandbox/contextIsolation/nodeIntegration/webSecurity 유지');
    assert.match((await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ?? '', /default-src 'self'/, 'CSP 유지');
    assert.match(page.url(), /^file:.*renderer[\\/]index\.html$/i, 'file: renderer로 부팅');

    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
    await first.stubFolderDialog(project);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapterButton(page, '첫째 화').click();
    await editor(page).getByText('포장 검사 본문 하나', { exact: true }).waitFor();
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' 추가 입력');
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.deepEqual(await readFile(join(project, 'chapters', '001.md')), Buffer.from(ONE.replace('포장 검사 본문 하나', '포장 검사 본문 하나 추가 입력')), '원래 id·BOM·CRLF·frontmatter 그대로 저장');
    assert.deepEqual(await readFile(join(project, 'chapters', '002.md')), Buffer.from(TWO), '이웃 불변');
    assert.deepEqual(await readdir(join(project, 'chapters')), ['001.md', '002.md'], '화 파일 수·이름 불변');
    const box = page.getByRole('searchbox', { name: '원고 검색' });
    await box.fill('이웃');
    await box.press('Enter');
    await page.locator('.search-summary').filter({ hasText: /찾음/ }).waitFor();
    assert.ok((await page.getByRole('list', { name: '검색 결과' }).getByRole('button').count()) >= 1, '검색 결과가 있다');
    assert.deepEqual(await first.netLog(), [], '관측된 외부 요청이 없다 (관측 범위는 파일 머리말)');
    assert.equal(await first.aiCalls(), 0, 'AI 호출 0');
  } finally {
    console.error('BRANDED_FIRST_CLOSE', JSON.stringify(await first.close()));
  }

  // 4) 닫기 → 같은 실행본을 다시 띄워 재열기 (새 프로세스, 같은 격리 userData, 장벽 다시)
  const second = await launchBarriered(exe, userData, userData);
  assert.equal(second.refused, false);
  if (second.refused) return;
  try {
    const { page } = second;
    assert.deepEqual(second.phases, PHASES);
    await second.stubFolderDialog(project);
    const welcome = page.getByRole('button', { name: '원고 폴더 열기', exact: true });
    const reopenedAutomatically = await Promise.race([chapterButton(page, '첫째 화').waitFor().then(() => true), welcome.waitFor().then(() => false)]);
    console.error('BRANDED_REOPEN', JSON.stringify({ reopenedAutomatically }));
    if (!reopenedAutomatically) await welcome.click();
    await chapterButton(page, '첫째 화').click();
    await editor(page).getByText('포장 검사 본문 하나 추가 입력', { exact: true }).waitFor();
    assert.deepEqual(await readFile(join(project, 'chapters', '002.md')), Buffer.from(TWO), '이웃 불변');
    assert.deepEqual(await second.netLog(), [], '재실행에서도 관측된 외부 요청이 없다');
  } finally {
    console.error('BRANDED_SECOND_CLOSE', JSON.stringify(await second.close()));
  }
});

test('브랜드 실행본도 상속된 ELECTRON_RENDERER_URL이 있어도 그 서버를 읽지 않고 file: renderer로 부팅한다 (production 시작 경계, isPackaged true)', { timeout: 200_000 }, async () => {
  assert.ok(built.exe, '첫 검사가 실행본을 만들어 두어야 한다');
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>SYNTHETIC DEV SERVER</title><body>SYNTHETIC DEV SERVER</body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/index.html`;
  assert.equal((await fetch(url)).status, 200, '서버 준비 장벽: 앱 실행 전에 서버가 응답한다');
  requests.length = 0;
  const userData = await tempDir('brsmoke-guard-userdata');
  const project = await tempDir('brsmoke-guard-project');
  await mkdir(join(project, 'chapters'));
  await writeFile(join(project, 'chapters', '001.md'), ONE);
  assertIsolatedUserData(userData);
  const launched = await launchBarriered(built.exe, userData, userData, { ELECTRON_RENDERER_URL: url });
  assert.equal(launched.refused, false);
  if (launched.refused) return;
  const { page } = launched;
  try {
    assert.deepEqual(launched.phases, PHASES);
    const facts = JSON.parse((await launched.evalMain("JSON.stringify({ defaultApp: process.defaultApp ?? null, isPackaged: globalThis.__lw.app.isPackaged, envUrl: process.env['ELECTRON_RENDERER_URL'] ?? null })")) as string) as { defaultApp: boolean | null; isPackaged: boolean; envUrl: string | null };
    console.error('BRANDED_GUARD_FACTS', JSON.stringify(facts));
    assert.equal(facts.envUrl, url, '실행본 프로세스가 개발 서버 변수를 실제로 상속했다');
    await page.waitForLoadState('load');
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
    assert.match(page.url(), /^file:.*renderer[\\/]index\.html$/i);
    assert.equal(await page.getByText('SYNTHETIC DEV SERVER').count(), 0);
    assert.deepEqual(requests, [], '상속된 개발 서버 주소로 요청이 0이다');
    await launched.stubFolderDialog(project);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapterButton(page, '첫째 화').click();
    await editor(page).getByText('포장 검사 본문 하나', { exact: true }).waitFor();
    assert.deepEqual(requests, [], '이후에도 요청 0');
  } finally {
    await launched.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
