// 명령 팔레트(Ctrl+K)와 AI 실행 확인 통합 (P4): 실제 있는 명령만, 키보드(↑↓·Enter·Esc)·포커스 복귀·선택 보존, 검색 입력 중 안전, 한글 조합 중 Enter 무시(합성),
// 도구줄·탐색기·팔레트가 같은 AI 컨트롤러(확인 창 하나)를 거치고, 동의는 처음 필요한 실행에서만, 비용 확인은 매 실행, 취소하면 전송 0·동의 보존.
// 실제 앱(Electron + Playwright). 가짜 OpenAI 서버만 쓰고 유료 호출은 없다. 합성 원고와 별도 userData.

import assert from 'node:assert/strict';
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
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as { appearance: { theme: string; followSystem: boolean } };
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
