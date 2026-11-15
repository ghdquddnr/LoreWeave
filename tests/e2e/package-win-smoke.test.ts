// [패키지 실행본 smoke] `package:win`이 만든 Windows x64 폴더형 실행본을 *electron.exe 자체*로 실행해 기본 동작을 확인한다.
// 이 파일만 패키지 실행본을 대상으로 한다 (다른 e2e는 launch.ts로 개발 앱 '.'을 띄운다). 앱 경로 인자 없이 `<출력>/electron.exe --user-data-dir=<격리>`만 쓰고, cwd는 저장소 밖이다.
// 입력 전제: 먼저 build 되어 있어야 한다 (test:e2e가 build한다). 출력은 저장소 밖 임시 폴더의 새 폴더이며 이 테스트가 삭제하지 않는다.
// 격리: 별도 userData + 이 테스트가 새로 만든 합성 원고 프로젝트(BOM+CRLF+frontmatter) 둘 다 쓴다. 실제 프로젝트·설정·키·기존 AI DB를 열지 않고, AI/API/Costs 호출 0.
// 네트워크: 빌드 준비(pnpm install의 Electron 다운로드)와 실행은 구분한다 — 실행 중에는 main의 http/https/fetch/net 요청을 기록하고(설치 뒤 시점부터), Chromium 호스트 해석을 localhost 외에는 실패시켜(--host-resolver-rules) 외부 요청이 새면 실패로 드러나게 한다.
//   관측 범위: renderer·main의 JS 수준 요청과 Chromium 해석. 설치 이전 시작 구간과 네이티브 구성요소의 요청, OS 수준 트래픽은 관측하지 못한다 (main 포함 외부 요청 0이라고 단정하지 않는다).
// 캡처는 자동 스크린샷(page.screenshot)이며 수동 GUI 확인이 아니다. 창 아이콘·작업표시줄·exe 임베디드 아이콘·SmartScreen은 이 검사로 확인하지 못한다.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { THEMES } from '../../src/core/appearance.ts';
import { closeWindow, stubFolderDialog, tempDir } from './launch.ts';
import { aiCalls, chapterButton, editor, launchPackaged, netLog, ONE, TWO } from './package-launch.ts';

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

/** 첫 검사가 만든 실행본 (두 번째 검사가 같은 실행본을 쓴다: 다시 패키징하지 않는다) */
const packaged: { out: string; exe: string } = { out: '', exe: '' };

test('패키지 실행본(electron.exe 직접 실행, 개발 경로 없음): 환영→폴더 열기→입력→저장→닫기→재열기→검색, 4테마, 로컬 글꼴·고지, 보안 설정, 외부 요청 0 관측', { timeout: 300_000 }, async () => {
  // 1) 패키징: 저장소 밖의 새 폴더에 만든다
  const out = join(tmpdir(), `LoreWeave-win-x64-smoke-${Date.now().toString(36)}`);
  const packaging = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/package-win.ts', '--out', out], { cwd: process.cwd(), encoding: 'utf8' });
  console.error('PACKAGE_WIN_OUTPUT', JSON.stringify({ out, summary: packaging.split('\n').filter((l) => l.includes('파일') || l.includes('위치')) }));
  const exe = join(out, 'electron.exe');
  packaged.out = out;
  packaged.exe = exe;
  const resourcesApp = join(out, 'resources', 'app');
  assert.ok((await stat(exe)).isFile());
  assert.equal(out.startsWith(process.cwd()), false, '출력은 저장소 밖이다');
  const bundled = await readdir(join(resourcesApp, 'node_modules'));
  assert.deepEqual(bundled, ['openai']);
  for (const notice of ['LICENSE', 'LICENSES.chromium.html']) assert.ok((await stat(join(out, notice))).isFile(), `${notice} 보존`);

  // 2) 새 합성 원고 프로젝트 + 별도 userData (실제 프로젝트·설정·키·AI DB를 열지 않는다)
  const project = await tempDir('pkgwin-project');
  await mkdir(join(project, 'chapters'));
  await writeFile(join(project, 'chapters', '001.md'), ONE);
  await writeFile(join(project, 'chapters', '002.md'), TWO);
  const userData = await tempDir('pkgwin-userdata');
  const captures = await tempDir('pkgwin-captures');
  const shot = (page: Page, name: string) => page.screenshot({ path: join(captures, `${name}.png`) });

  const first = await launchPackaged(exe, userData);
  try {
    const { app, page } = first;
    // 실행본이 자기 폴더의 리소스로 뜬다: 개발 저장소를 쓰지 않는다
    const facts = await app.evaluate(({ app: electronApp, BrowserWindow, nativeImage }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const prefs = (win.webContents as unknown as { getLastWebPreferences(): { sandbox?: boolean; contextIsolation?: boolean; nodeIntegration?: boolean; webSecurity?: boolean } }).getLastWebPreferences();
      const modulePkg = process.getBuiltinModule('module');
      const path = process.getBuiltinModule('path');
      const req = modulePkg.createRequire(path.join(electronApp.getAppPath(), 'package.json'));
      return {
        appPath: electronApp.getAppPath(),
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        isPackaged: electronApp.isPackaged,
        openaiResolved: req.resolve('openai'),
        iconLoaded: !nativeImage.createFromPath(path.join(electronApp.getAppPath(), 'resources', 'app-icon.ico')).isEmpty(),
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
        webSecurity: prefs.webSecurity,
        userData: electronApp.getPath('userData'),
      };
    });
    console.error('PACKAGED_FACTS', JSON.stringify(facts));
    assert.equal(facts.appPath.toLowerCase(), resourcesApp.toLowerCase(), '앱 경로는 실행본의 resources/app이다');
    assert.ok(facts.execPath.toLowerCase().startsWith(out.toLowerCase()), '실행 파일은 실행본 폴더의 electron.exe다');
    assert.ok(facts.openaiResolved.toLowerCase().startsWith(resourcesApp.toLowerCase()), `openai는 실행본 안의 복사본에서 해석된다: ${facts.openaiResolved}`);
    assert.equal(facts.userData.toLowerCase(), userData.toLowerCase(), '격리 userData를 쓴다');
    assert.equal(facts.iconLoaded, true, '실행본 안의 app-icon.ico를 읽을 수 있다 (창 아이콘 표시 자체는 이 검사로 확인하지 못한다)');
    assert.deepEqual([facts.sandbox, facts.contextIsolation, facts.nodeIntegration, facts.webSecurity], [true, true, false, true], 'sandbox/contextIsolation/nodeIntegration/webSecurity 유지');
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content') ?? '', /default-src 'self'/, 'CSP 유지');
    assert.equal(await page.title(), 'LoreWeave');

    // 환영 화면 → 폴더 열기 (원고 폴더 선택은 합성 프로젝트로 대체)
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
    await shot(page, '01-welcome');
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapterButton(page, '첫째 화').click();
    await editor(page).getByText('포장 검사 본문 하나', { exact: true }).waitFor();
    await shot(page, '02-editor-midnight');

    // 로컬 글꼴: 외부 요청 없이 로드됐다 (CSP default-src 'self' + 호스트 해석 차단 아래)
    const fonts = await page.evaluate(() => ({ loaded: [...document.fonts].filter((f) => f.status === 'loaded').length }));
    assert.ok(fonts.loaded > 0, '로컬 글꼴이 로드됐다');

    // 입력 → 저장 (Ctrl+S와 자동 저장을 구분하지 않는다) → 바이트 확인
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' 추가 입력');
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    const expected = ONE.replace('포장 검사 본문 하나', '포장 검사 본문 하나 추가 입력');
    assert.deepEqual(await readFile(join(project, 'chapters', '001.md')), Buffer.from(expected), '원래 id·BOM·CRLF·frontmatter 그대로 저장');
    assert.deepEqual(await readFile(join(project, 'chapters', '002.md')), Buffer.from(TWO), '이웃 불변');
    assert.deepEqual(await readdir(join(project, 'chapters')), ['001.md', '002.md'], '화 파일 수·이름 불변');

    // 4테마 대표 화면: 설정에서 각 테마를 고르고 본문 배경이 테마와 일치함을 확인한다
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '환경설정' });
    const backgrounds = new Set<string>();
    for (const t of THEMES) {
      await dialog.getByRole('radio', { name: new RegExp(`^${t.label}`) }).check();
      await page.waitForFunction((bg) => getComputedStyle(document.body).backgroundColor === bg, rgb(t.background));
      backgrounds.add(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
      await shot(page, `03-theme-${t.id}`);
    }
    assert.equal(backgrounds.size, 4, '네 테마가 서로 다른 화면이다');
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();

    // 검색 (AI 없이)
    const box = page.getByRole('searchbox', { name: '원고 검색' });
    await box.fill('이웃');
    await box.press('Enter');
    await page.locator('.search-summary').filter({ hasText: /찾음/ }).waitFor();
    assert.ok((await page.getByRole('list', { name: '검색 결과' }).getByRole('button').count()) >= 1, '검색 결과가 있다');
    await shot(page, '04-search');

    // 외부 요청 0 관측 (관측 범위는 파일 머리말) + AI 호출 0
    assert.deepEqual(await netLog(app), [], '관측된 외부 요청이 없다');
    assert.equal(await aiCalls(app), 0, 'AI 호출 0');
  } finally {
    await closeWindow(first.app);
  }

  // 3) 닫기 → 같은 실행본을 다시 띄워 재열기 (새 프로세스, 같은 격리 userData)
  const second = await launchPackaged(exe, userData);
  try {
    const { app, page } = second;
    // 마지막으로 연 프로젝트는 격리 userData에 기억되어 자동으로 다시 열린다 (제품 동작). 환영 화면이 먼저 보이면 폴더를 다시 고른다
    await stubFolderDialog(app, project);
    const welcome = page.getByRole('button', { name: '원고 폴더 열기', exact: true });
    const reopenedAutomatically = await Promise.race([chapterButton(page, '첫째 화').waitFor().then(() => true), welcome.waitFor().then(() => false)]);
    console.error('PACKAGE_WIN_REOPEN', JSON.stringify({ reopenedAutomatically }));
    if (!reopenedAutomatically) await welcome.click();
    await chapterButton(page, '첫째 화').click();
    await editor(page).getByText('포장 검사 본문 하나 추가 입력', { exact: true }).waitFor();
    assert.deepEqual(await readFile(join(project, 'chapters', '002.md')), Buffer.from(TWO), '이웃 불변');
    assert.deepEqual(await netLog(app), [], '재실행에서도 관측된 외부 요청이 없다');
    await shot(second.page, '05-reopened');
    console.error('PACKAGE_WIN_SMOKE_CAPTURES', captures);
  } finally {
    await closeWindow(second.app);
  }
});

test('실행본은 상속된 ELECTRON_RENDERER_URL이 있어도 그 서버를 읽지 않고 file: renderer로 정상 부팅한다 (production 시작 경계)', { timeout: 200_000 }, async () => {
  assert.ok(packaged.exe, '첫 검사가 실행본을 만들어 두어야 한다');
  // 합성 loopback 서버: 앱 실행 전부터 준비·기록한다 (127.0.0.1만, 실제 외부 URL 없음). 요청이 오면 기록하고 식별 가능한 HTML을 돌려준다
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>SYNTHETIC DEV SERVER</title><body>SYNTHETIC DEV SERVER</body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/index.html`;
  const probe = await fetch(url);
  assert.equal(probe.status, 200, '서버 준비 장벽: 앱 실행 전에 서버가 응답한다');
  requests.length = 0; // 준비 확인 요청은 세지 않는다
  const userData = await tempDir('pkgwin-guard-userdata');
  const project = await tempDir('pkgwin-guard-project');
  await mkdir(join(project, 'chapters'));
  await writeFile(join(project, 'chapters', '001.md'), ONE);
  const { app, page } = await launchPackaged(packaged.exe, userData, { ELECTRON_RENDERER_URL: url });
  try {
    const facts = await app.evaluate(({ app: electronApp }) => ({ defaultApp: process.defaultApp, isPackaged: electronApp.isPackaged, envUrl: process.env['ELECTRON_RENDERER_URL'] ?? null }));
    console.error('PRODUCTION_GUARD_FACTS', JSON.stringify(facts));
    assert.equal(facts.envUrl, url, '실행본 프로세스가 개발 서버 변수를 실제로 상속했다');
    await page.waitForLoadState('load');
    console.error('PRODUCTION_GUARD_LOADED', JSON.stringify({ url: page.url(), requests: [...requests] }));
    // 창·renderer 준비 완료를 기준으로 본다: 환영 화면이 보이면 renderer가 부팅을 마쳤다
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
    const loaded = page.url();
    console.error('PRODUCTION_GUARD_URL', JSON.stringify({ loaded, requests }));
    assert.match(loaded, /^file:.*renderer[\/]index\.html$/i, `file: renderer가 열렸다: ${loaded}`);
    assert.equal(await page.getByText('SYNTHETIC DEV SERVER').count(), 0, '합성 서버의 페이지가 아니다');
    assert.deepEqual(requests, [], '상속된 개발 서버 주소로 요청이 0이다');
    // 앱이 정상 동작한다: 새 합성 프로젝트를 열어 본문이 보인다
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapterButton(page, '첫째 화').click();
    await editor(page).getByText('포장 검사 본문 하나', { exact: true }).waitFor();
    assert.deepEqual(requests, [], '이후에도 요청 0');
  } finally {
    await closeWindow(app);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
