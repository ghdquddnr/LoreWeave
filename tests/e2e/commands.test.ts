// 명령 팔레트(Ctrl+K)와 AI 실행 확인 통합 (P4): 실제 있는 명령만, 키보드(↑↓·Enter·Esc)·포커스 복귀·선택 보존, 검색 입력 중 안전, 한글 조합 중 Enter 무시(합성),
// 도구줄·탐색기·팔레트가 같은 AI 컨트롤러(확인 창 하나)를 거치고, 동의는 처음 필요한 실행에서만, 비용 확인은 매 실행, 취소하면 전송 0·동의 보존.
// 실제 앱(Electron + Playwright). 가짜 OpenAI 서버만 쓰고 유료 호출은 없다. 합성 원고와 별도 userData.

import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const TWO = `${envelope('two', 'TWO')}FIRST_LINE\r\n\r\nSECOND_LINE_CARET_HERE\r\n`;
let fake: FakeOpenAi;

before(async () => {
  fake = await startFakeOpenAi(() => ({ summary: '요약', entities: [], facts: [] }));
});
after(async () => {
  await fake.close();
});

async function project(): Promise<string> {
  const dir = await tempDir('commands');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `${envelope('one', 'ONE')}ONLY_LINE\r\n`);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const palette = (page: Page) => page.getByRole('dialog', { name: '명령 팔레트' });
const options = (page: Page) => palette(page).getByRole('option');
const labels = (page: Page) => options(page).evaluateAll((els) => els.map((e) => e.querySelector('.palette-label')?.textContent ?? ''));
const tabsOf = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent));

async function start(prefix: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; dir: string; userData: string }> {
  const dir = await project();
  const userData = await tempDir(prefix);
  const { app, page } = await launch(userData, env);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'TWO' }).click();
  await editor(page).getByText('FIRST_LINE', { exact: true }).waitFor();
  await page.getByRole('button', { name: '이 화 분석', exact: true }).waitFor();
  return { app, page, dir, userData };
}

test('팔레트: 실제 명령만 나열하고 필터·↑↓·Enter·Esc가 동작하며, Esc로 닫으면 편집기 선택이 그대로라 입력이 원래 자리로 들어간다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('commands-basic');
  try {
    // 캐럿을 두번째 줄 중간(CARET 앞)에 둔다
    await editor(page).getByText('SECOND_LINE_CARET_HERE', { exact: true }).click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 'SECOND_LINE_'.length; i += 1) await page.keyboard.press('ArrowRight');
    // DOM 선택으로 본다 (PM 상태는 selectionchange를 한 박자 늦게 받는다). 팔레트를 닫으면 PM 상태의 선택을 DOM에 다시 놓으므로 같아야 한다
    const caret = () => page.evaluate(() => `${window.getSelection()?.anchorNode?.textContent}:${window.getSelection()?.anchorOffset}:${window.getSelection()?.isCollapsed}`);
    await page.waitForTimeout(200);
    const before = await caret();

    // Ctrl+K로 열고 명령 목록 확인: 미래 메뉴(관계도·타임라인·간트·칸반·최근 목록)가 없다
    await page.keyboard.press('Control+k');
    await palette(page).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '명령 검색');
    assert.deepEqual(await labels(page), [
      '새 화 만들기',
      '원고 폴더 열기…',
      '현재 화 저장',
      '원고 전체 검색',
      '환경설정 열기',
      '이 화 분석',
      '남은 화 분석 (2)',
      '이 화 검사',
      'AI 분석·검사 결과 다시 읽기',
      '현재 탭 닫기',
      '테마: 심야',
      '테마: 한낮',
      '테마: 미색 종이',
      '테마: 등잔불',
    ]);
    // 단축키는 지금 실제로 있는 것만
    const shortcuts = await options(page).evaluateAll((els) => els.map((e) => e.querySelector('kbd')?.textContent ?? null).filter(Boolean));
    assert.deepEqual(shortcuts, ['Ctrl+S', 'Ctrl+Shift+F']);

    // 필터와 ↑↓: aria-activedescendant가 따라 움직이고 비활성 항목은 건너뛴다
    await page.keyboard.type('테마:');
    assert.equal(await options(page).count(), 4);
    const active = () => page.evaluate(() => document.querySelector('[role="combobox"]')?.getAttribute('aria-activedescendant'));
    assert.equal(await active(), 'palette-theme-midnight');
    await page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'palette-theme-daylight');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // 맨 위에서 위로: 끝으로 돈다
    assert.equal(await active(), 'palette-theme-lamplight');
    await page.keyboard.type('zzz-없는-명령');
    await palette(page).getByText('맞는 명령이 없습니다').waitFor();

    // Esc: 실행하지 않고 닫고, 편집기로 돌아와 선택이 그대로다
    await page.keyboard.press('Escape');
    await palette(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true);
    assert.equal(await caret(), before, '선택이 그대로');
    await page.keyboard.type('X');
    await editor(page).getByText('SECOND_LINE_XCARET_HERE', { exact: true }).waitFor();
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('팔레트 실행: 새 화·저장·설정·테마가 기존 경로로 동작하고, 검색 입력 중에도 편집기가 오염되지 않으며, 다른 대화상자가 떠 있으면 열리지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, dir, userData } = await start('commands-run');
  try {
    // 헤더 버튼으로도 열린다
    await page.getByRole('button', { name: /^명령 팔레트/ }).click();
    await palette(page).waitFor();
    await page.keyboard.press('Escape');
    await palette(page).waitFor({ state: 'detached' });

    // 새 화: 탭이 늘고 편집기가 포커스를 받는다
    assert.deepEqual(await tabsOf(page), ['ONE', 'TWO']);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('새 화');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3);
    assert.equal((await tabsOf(page)).length, 3);

    // 저장: 입력한 뒤 팔레트의 저장이 디스크에 쓴다 (Ctrl+S와 같은 flush)
    await editor(page).first().click();
    await page.keyboard.type('NEW_CHAPTER_TEXT');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('현재 화 저장');
    await page.keyboard.press('Enter');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    const files = await Promise.all(['003.md'].map((f) => readFile(join(dir, 'chapters', f), 'utf8')));
    assert.match(files[0]!, /NEW_CHAPTER_TEXT/);

    // 테마: 외관 설정 경로 (저장까지)
    await page.keyboard.press('Control+k');
    await page.keyboard.type('등잔불');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'lamplight');
    // 화면에 적용된 뒤 저장이 끝나기까지 잠깐 걸릴 수 있다: 저장될 때까지 기다린다
    const deadline = Date.now() + 5000;
    let saved = { appearance: { theme: '', followSystem: true } };
    while (Date.now() < deadline) {
      saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as typeof saved;
      if (saved.appearance.theme === 'lamplight') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual({ theme: saved.appearance.theme, followSystem: saved.appearance.followSystem }, { theme: 'lamplight', followSystem: false });

    // 설정: 대화상자 하나가 열리고, 그동안 Ctrl+K는 열리지 않는다
    await page.keyboard.press('Control+k');
    await page.keyboard.type('환경설정');
    await page.keyboard.press('Enter');
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.waitFor();
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);
    assert.equal(await palette(page).count(), 0, '다른 대화상자가 떠 있으면 팔레트는 열리지 않는다');
    assert.equal(await page.locator('[role="dialog"][aria-modal="true"]').count(), 1);
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });

    // 검색 입력 중: 입력은 검색창에, 팔레트를 열고 닫아도 편집기 문서는 그대로이고 포커스는 검색창으로 돌아온다
    const docBefore = await editor(page).innerText();
    await page.getByRole('searchbox', { name: '원고 검색' }).focus();
    await page.keyboard.type('FIRST');
    await page.keyboard.press('Control+k');
    await palette(page).waitFor();
    await page.keyboard.type('새');
    await page.keyboard.press('Escape');
    await palette(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '원고 검색', null, { timeout: 3000 });
    assert.equal(await page.getByRole('searchbox', { name: '원고 검색' }).inputValue(), 'FIRST', '검색어는 그대로, 팔레트 입력이 섞이지 않는다');
    assert.equal(await editor(page).innerText(), docBefore, '편집기 문서는 바뀌지 않았다');
    assert.equal((await tabsOf(page)).length, 3, 'Esc는 아무 명령도 실행하지 않았다');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('팔레트 한글 조합(합성 이벤트 경계): 조합 중의 Enter는 명령을 실행하지 않는다 (실제 IME 검증 아님)', { timeout: 60_000 }, async () => {
  const { app, page } = await start('commands-ime');
  try {
    await page.keyboard.press('Control+k');
    await palette(page).waitFor();
    await page.keyboard.type('새 화');
    // 조합 중으로 표시된 Enter keydown (합성)
    await page.evaluate(() => {
      const input = document.querySelector('[role="combobox"]')!;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    assert.equal(await palette(page).count(), 1, '조합 중 Enter로 팔레트가 닫히지 않는다');
    assert.deepEqual(await tabsOf(page), ['ONE', 'TWO'], '명령이 실행되지 않았다');
    await page.keyboard.press('Enter'); // 조합이 아닌 Enter는 실행한다
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('AI 실행 확인 통합: 도구줄·탐색기·팔레트가 같은 컨트롤러·확인 창 하나를 거치고, 동의는 처음 한 번만, 비용 확인은 매 실행, 취소하면 전송 0·동의 보존, 중복 실행 없음', { timeout: 120_000 }, async () => {
  const { app, page } = await start('commands-ai', { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await page.evaluate(() => window.loreweave.ai.setKey('sk-commands-test'));
    const dialog = page.getByRole('dialog', { name: 'AI 실행 확인' });
    const status = () => page.evaluate(() => window.loreweave.ai.analysisStatus(1));
    const sent = () => fake.requests.filter((r) => r.path.endsWith('/responses')).length;
    const base = sent();

    // 1) 팔레트 → 확인 창 (동의 + 비용 + 범위 + 모델이 한 창): 취소하면 아무것도 보내지 않고 동의는 저장되지 않는다
    await page.keyboard.press('Control+k');
    await page.keyboard.type('이 화 분석');
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.equal(await page.locator('[role="dialog"][aria-modal="true"]').count(), 1, '확인 창은 하나');
    await dialog.getByText('이 화를 분석할까요?').waitFor();
    await dialog.getByText('원고가 OpenAI로 전송됩니다.').waitFor();
    const dd = await dialog.locator('dd').allInnerTexts();
    assert.match(dd[0]!, /화 1개의 본문 [\d,]+자.*002\.md/s, '보낼 범위');
    assert.match(dd[1]!, /gpt-6/, '현재 모델');
    // 표시된 상한은 main이 계산한 값과 같다 (시안 숫자·임의 값 아님)
    const estimate = await page.evaluate(() => window.loreweave.ai.estimate(['002.md'], 1));
    assert.match(dd[2]!, new RegExp(`최대 \\$${estimate.costUsd.toFixed(4).replace('.', '\\.')}`));
    assert.match(dd[0]!, new RegExp(`${estimate.chars.toLocaleString().replace(',', ',?')}자`));
    await page.keyboard.press('Escape'); // Esc도 취소
    await dialog.waitFor({ state: 'detached' });
    assert.equal(sent(), base, '취소: 전송 0');
    assert.equal((await status()).consent, false, '취소: 동의가 저장되지 않는다');

    // 2) 도구줄 버튼 → 같은 확인 창. 연타해도 창 하나·실행 하나
    const analyzeButton = page.locator('.editor-toolbar').getByRole('button', { name: '이 화 분석', exact: true });
    await analyzeButton.dblclick();
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1, '중복 확인 창 없음');
    await dialog.getByRole('button', { name: '동의하고 실행' }).click();
    await page.getByText(/화 1개 분석 · \$/).waitFor({ timeout: 30_000 });
    assert.equal(sent(), base + 1, '실행 한 번 = 요청 한 번');
    assert.equal((await status()).consent, true, '실행하면 동의가 저장된다');

    // 3) 동의는 처음만: 탐색기 버튼은 같은 창이지만 동의 문구 없이 [실행], 비용 확인은 다시 한다
    await page.getByRole('button', { name: /^남은 화 분석/ }).click();
    await dialog.waitFor();
    assert.equal(await dialog.getByText('원고가 OpenAI로 전송됩니다.').count(), 0, '두 번째부터는 동의를 다시 묻지 않는다');
    await dialog.getByText(/예상 비용\s*최대 \$/).waitFor();
    await dialog.getByRole('button', { name: '취소' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(sent(), base + 1, '취소: 추가 전송 0');
    assert.equal((await status()).consent, true, '취소해도 기존 동의는 보존된다');

    // 4) 확인 창이 떠 있는 동안 팔레트는 새 실행을 시작하지 않는다
    await analyzeButton.click();
    await dialog.waitFor();
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(300);
    assert.equal(await palette(page).count(), 0);
    await dialog.getByRole('button', { name: '실행', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0);
    const deadline = Date.now() + 15_000;
    while (sent() < base + 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await page.getByRole('button', { name: /^남은 화 분석/ }).waitFor();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(sent(), base + 2, '두 번째 실행도 요청 한 번');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('분석 확인은 저장 전 입력까지 포함한 본문으로 범위·비용을 계산하고, 저장할 수 없으면(충돌) 계획·전송 없이 멈춘다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('commands-flush', { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await page.evaluate(() => window.loreweave.ai.setKey('sk-commands-flush'));
    const dialog = page.getByRole('dialog', { name: 'AI 실행 확인' });
    const sent = () => fake.requests.filter((r) => r.path.endsWith('/responses')).length;
    const base = sent();
    // 자동 저장(1.5초) 전에 큰 입력을 한 번에 넣고 바로 분석 확인을 연다
    await editor(page).getByText('SECOND_LINE_CARET_HERE', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('가'.repeat(13_000));
    await page.locator('.editor-toolbar').getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog.waitFor();
    const chars = Number((/본문 ([\d,]+)자/.exec(await dialog.locator('dd').first().innerText()) ?? [])[1]?.replace(/,/g, ''));
    assert.ok(chars >= 13_000, `확인 창의 범위는 저장 전 입력을 포함한 본문이어야 한다: ${chars}자`);
    assert.match(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), /가{13000}/, '계획 전에 저장됐다');
    await dialog.getByRole('button', { name: '취소' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(sent(), base);

    // 저장할 수 없는 상태(바깥 수정 충돌): 확인 창 없이 이유를 알리고 아무것도 보내지 않는다
    await page.keyboard.insertText('나'.repeat(50));
    await writeFile(join(dir, 'chapters', '002.md'), `${envelope('two', 'TWO')}OUTSIDE_CHANGE\r\n`);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    await page.locator('.editor-toolbar').getByRole('button', { name: '이 화 분석', exact: true }).click();
    await page.getByText(/저장하지 못해 분석을 시작하지 않았습니다/).waitFor({ timeout: 10_000 });
    assert.equal(await dialog.count(), 0, '저장할 수 없으면 확인 창을 열지 않는다');
    assert.equal(sent(), base, '전송 0');
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), `${envelope('two', 'TWO')}OUTSIDE_CHANGE\r\n`, '바깥 변경은 그대로');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('팔레트의 Tab·Shift+Tab은 모달 안(명령 검색 입력)에 머물고, Esc 뒤 편집기 선택이 돌아온다', { timeout: 60_000 }, async () => {
  const { app, page } = await start('commands-tab');
  try {
    await editor(page).getByText('SECOND_LINE_CARET_HERE', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Control+k');
    await palette(page).waitFor();
    const active = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Tab']) {
      await page.keyboard.press(key);
      assert.equal(await active(), '명령 검색', `${key} 뒤에도 포커스는 팔레트 입력`);
    }
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
    await page.keyboard.press('Escape');
    await palette(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true);
    await page.keyboard.type('Z');
    await editor(page).getByText('ZSECOND_LINE_CARET_HERE', { exact: true }).waitFor();
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

/**
 * 가짜 OpenAI 서버 앞의 로컬 프록시: fail이 켜져 있으면 본문에 marker가 든 요청에 400을 돌려준다 (재시도하지 않는 오류 = 그 화만 실패).
 * count는 프록시에 도착한 요청 수. 외부 호출 없음.
 */
async function failingProxy(upstream: FakeOpenAi, marker: string) {
  const state = { fail: true, count: 0 };
  const target = new URL(upstream.baseUrl);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      state.count += 1;
      const body = Buffer.concat(chunks);
      if (state.fail && body.includes(Buffer.from(marker))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'synthetic bad request', type: 'invalid_request_error' } }));
        return;
      }
      const forward = httpRequest({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 200, r.headers);
        r.pipe(res);
      });
      forward.on('error', () => res.destroy());
      forward.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${target.pathname.replace(/\/$/, '')}`;
  return { state, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** main의 ai:set-consent 응답을 delayMs만큼 늦춘다 (동의 저장을 기다리는 사이의 경계를 만든다) */
const delayConsent = (app: ElectronApplication, delayMs: number) =>
  app.evaluate(({ ipcMain }, ms) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const original = map.get('ai:set-consent')!;
    ipcMain.removeHandler('ai:set-consent');
    ipcMain.handle('ai:set-consent', async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, ms));
      return original(...args);
    });
  }, delayMs);

test('부분 실패 → 실패한 화만 다시 분석: 재시도 대상·매번 비용 확인·취소 전송 0·동의 저장 응답을 기다리는 동안 중복 실행 없음', { timeout: 180_000 }, async () => {
  const proxy = await failingProxy(fake, 'FAIL_MARKER_CHAPTER');
  const dir = await tempDir('commands-retry');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `${envelope('one', 'ONE')}OK_ONE\r\n`);
  await writeFile(join(dir, 'chapters', '002.md'), `${envelope('two', 'TWO')}FAIL_MARKER_CHAPTER\r\n`);
  await writeFile(join(dir, 'chapters', '003.md'), `${envelope('three', 'THREE')}OK_THREE\r\n`);
  const { app, page } = await launch(await tempDir('commands-retry-ud'), { OPENAI_BASE_URL: proxy.url });
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).waitFor();
    await page.getByRole('button', { name: /^남은 화 분석 \(3\)/ }).waitFor();
    await page.evaluate(() => window.loreweave.ai.setKey('sk-commands-retry'));
    await delayConsent(app, 1500);
    const dialog = page.getByRole('dialog', { name: 'AI 실행 확인' });
    const toolbarAnalyze = page.locator('.editor-toolbar').getByRole('button', { name: '이 화 분석', exact: true });
    const batch = page.getByRole('button', { name: /^남은 화 분석/ });

    await batch.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '동의하고 실행' }).click();
    // 동의 저장을 기다리는 동안: 모든 시작 입구가 막혀 있다 (중복 실행 0)
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await toolbarAnalyze.isDisabled(), true, '동의 저장 중 도구줄 버튼이 막혀 있다');
    assert.equal(await batch.isDisabled(), true, '동의 저장 중 탐색기 버튼이 막혀 있다');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('이 화 분석');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(await dialog.count(), 0, '동의 저장 중 팔레트 명령도 새 확인 창을 열지 못한다');
    await page.getByText(/화 3개 분석/).waitFor({ timeout: 30_000 }); // 시도한 화 3개 (그중 002 하나 실패)
    await page.getByText(/실패 002\.md/).waitFor();
    assert.equal(proxy.state.count, 3, '화 3개에 요청 3번 (중복 없음)');

    // 실패한 화만 다시: 대상은 002 하나, 매번 확인 창(비용), 취소하면 전송 0
    const retry = () => page.getByRole('button', { name: /^실패한 화 1개 다시 분석/ });
    await retry().dblclick();
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1, '연타해도 확인 창은 하나');
    await dialog.getByText('이 화를 분석할까요?').waitFor();
    assert.match(await dialog.locator('dd').first().innerText(), /002\.md/);
    await dialog.getByText(/예상 비용\s*최대 \$/).waitFor();
    assert.equal(await dialog.getByText('원고가 OpenAI로 전송됩니다.').count(), 0, '동의는 이미 저장됐다');
    await dialog.getByRole('button', { name: '취소' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(proxy.state.count, 3, '취소: 전송 0');
    await retry().waitFor();

    await retry().click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '실행', exact: true }).click();
    await page.getByText(/실패 002\.md/).waitFor({ timeout: 30_000 });
    await retry().waitFor();
    assert.equal(proxy.state.count, 4, '다시 실행하면 그 화 하나만 보낸다');

    // 원인이 사라지면 다음 시도는 성공하고 남은 화가 0이 된다 (역시 확인을 거쳐서)
    proxy.state.fail = false;
    await retry().click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '실행', exact: true }).click();
    await page.getByRole('button', { name: '남은 화 분석 (0)' }).waitFor({ timeout: 30_000 });
    assert.equal(proxy.state.count, 5);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
    await proxy.close();
  }
});

test('동의 저장 응답을 기다리는 사이 다른 프로젝트를 열면 이전 프로젝트의 분석은 전송되지 않는다', { timeout: 120_000 }, async () => {
  const proxy = await failingProxy(fake, 'NEVER_MATCHES_ANYTHING');
  const a = await project();
  const b = await project();
  const { app, page } = await launch(await tempDir('commands-switch-ud'), { OPENAI_BASE_URL: proxy.url });
  try {
    await stubFolderDialog(app, a);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).waitFor();
    await page.getByRole('button', { name: '이 화 분석', exact: true }).waitFor();
    await page.evaluate(() => window.loreweave.ai.setKey('sk-commands-switch'));
    await delayConsent(app, 1500);
    const dialog = page.getByRole('dialog', { name: 'AI 실행 확인' });
    await page.locator('.editor-toolbar').getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '동의하고 실행' }).click();
    await dialog.waitFor({ state: 'detached' });
    // 동의 저장 중에 다른 프로젝트를 연다
    await stubFolderDialog(app, b);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.waitForTimeout(2500);
    assert.equal(proxy.state.count, 0, '이전 프로젝트의 분석은 전송되지 않았다');
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByText('원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다').count(), 0, '새 프로젝트 화면에 이전 요청의 거절 문구가 보이지 않는다');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
    await proxy.close();
  }
});
