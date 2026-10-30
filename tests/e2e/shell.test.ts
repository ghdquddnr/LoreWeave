// IDE 셸 (P2): 배치 치수·반응형, 열린 화 탭(열기·전환·닫기·마지막 탭·빠른 전환·키보드), 충돌 중 탭 닫기 보호, 프로젝트 전환/같은 폴더 다시 열기 때 탭 초기화,
// 검색·새 화와 탭, 시작 화면의 환경설정(포커스 복귀), 활동 막대에 가짜 메뉴가 없음, AnalysisBar 컨트롤러가 한 번만 마운트됨.
// 실제 앱(Electron + Playwright). 합성 원고와 별도 userData만 쓰고 실제 API는 쓰지 않는다. 창 크기는 BrowserWindow.setContentSize로 정한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const BODY = { one: 'ALPHA_ONE_BODY', two: 'BETA_TWO_BODY', three: 'GAMMA_THREE_BODY' } as const;
const fileText = (id: keyof typeof BODY, title: string) => `${envelope(id, title)}${BODY[id]}\r\n`;

async function project(prefix: string, titles = ['ONE', 'TWO', 'THREE']): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const ids = ['one', 'two', 'three'] as const;
  for (const [i, t] of titles.entries()) await writeFile(join(dir, 'chapters', `00${i + 1}.md`), fileText(ids[i]!, t));
  return dir;
}

const editor = (page: Page) => page.locator('.ProseMirror');
const explorerChapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const tab = (page: Page, title: string) => page.getByRole('tab', { name: title, exact: true });
const closeButton = (page: Page, title: string) => page.getByRole('button', { name: `탭 닫기: ${title}`, exact: true });
const tabs = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => ({ title: t.textContent ?? '', selected: t.getAttribute('aria-selected') === 'true' })));
const setSize = (app: ElectronApplication, w: number, h: number) => app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]!.setContentSize(width!, height!), [w, h]);

async function open(app: ElectronApplication, page: Page, dir: string): Promise<void> {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
}
async function openAgain(app: ElectronApplication, page: Page, dir: string): Promise<void> {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '열기', exact: true }).click();
}
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
const typeAtEnd = async (page: Page, body: string, text: string) => {
  await editor(page).getByText(body, { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
};

test('셸 배치: 타이틀 40 · 활동 52 · 탐색기 248 · 탭 36 · 도구줄 ≥44 · 인스펙터 380 · 상태줄 26 · 원고 최대 760 (1440 기준), 활동 막대는 실제 기능만', { timeout: 60_000 }, async () => {
  const dir = await project('shell-geometry');
  const { app, page } = await launch(await tempDir('shell-geometry-ud'));
  try {
    await setSize(app, 1440, 900);
    await open(app, page, dir);
    await page.getByRole('tab', { name: 'ONE', exact: true }).waitFor();
    await page.getByRole('button', { name: '이 화 분석', exact: true }).waitFor(); // AI 상태를 읽은 뒤 AnalysisBar가 그려진다
    const box = (selector: string) =>
      page.evaluate((s) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
      }, selector);
    const title = await box('.titlebar');
    const activity = await box('.activitybar');
    const explorer = await box('.sidebar');
    const tabsBox = await box('.tabs');
    const toolbar = await box('.editor-toolbar');
    const inspector = await box('.ai-panel');
    const status = await box('.statusbar');
    const prose = await box('.ProseMirror');
    assert.equal(title.h, 40, '타이틀 바');
    assert.equal(activity.w, 52, '활동 막대');
    assert.equal(explorer.w, 248, '탐색기');
    assert.equal(tabsBox.h, 36, '탭 줄');
    assert.ok(toolbar.h >= 44 && toolbar.h <= 56, `도구줄 ${toolbar.h}`);
    assert.equal(inspector.w, 380, '인스펙터');
    assert.equal(status.h, 26, '상태줄');
    assert.ok(prose.w <= 760, `원고 폭 ${prose.w}`);
    assert.ok(inspector.x >= explorer.right, '1440에서는 인스펙터가 에디터 오른쪽');
    assert.equal(status.bottom, 900);
    // 탐색기 행의 번호·상태 기호는 장식이라 접근 가능한 이름(제목으로 시작)에 섞이지 않는다
    assert.equal(await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: /^TWO$/ }).count(), 1);
    assert.equal(await page.locator('.chapter.current').innerText(), 'ONE');
    // 활동 막대에는 실제로 동작하는 보기만 있다 (관계도·타임라인 같은 미래 메뉴 없음)
    const names = await page.getByRole('navigation', { name: '보기' }).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    assert.deepEqual(names, ['원고 화 목록', '검색 보기', '설정']);
    // AI 버튼은 컨트롤러 하나가 두 자리에 그린다: 도구줄(이 화 분석·검사), 탐색기 AI 작업(남은 화 분석)
    assert.equal(await page.getByRole('button', { name: '이 화 분석', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '이 화 검사', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: /^남은 화 분석/ }).count(), 1);
    assert.equal(await page.locator('.editor-toolbar').getByRole('button', { name: '이 화 분석', exact: true }).count(), 1);
    assert.equal(await page.locator('.editor-toolbar').getByRole('button', { name: '이 화 검사', exact: true }).count(), 1);
    assert.equal(await page.locator('.ai-work').getByRole('button', { name: /^남은 화 분석/ }).count(), 1);
    // 정확한 문구: 원고는 이 컴퓨터에 저장되고, AI는 동의·버튼 때에만 본문을 OpenAI로 보낸다
    const note = await page.locator('.local-note').innerText();
    assert.match(note, /이 컴퓨터의 폴더에 저장/);
    assert.match(note, /OpenAI로 보냅니다/);
    assert.doesNotMatch(note, /전송.{0,4}없|절대|보장/);
  } finally {
    await closeWindow(app);
  }
});

test('반응형: 1180px 미만은 인스펙터가 에디터 아래로, 760px 미만은 한 열이고 활동 막대가 사라진다', { timeout: 60_000 }, async () => {
  const dir = await project('shell-responsive');
  const { app, page } = await launch(await tempDir('shell-responsive-ud'));
  try {
    await open(app, page, dir);
    type Box = { shown: boolean; x: number; y: number; right: number; bottom: number; w: number };
    const layout = () =>
      page.evaluate(() => {
        const out: Record<string, Box> = {};
        const parts: [string, string][] = [['activity', '.activitybar'], ['explorer', '.sidebar'], ['work', '.workspace'], ['insp', '.ai-panel']];
        for (const [key, selector] of parts) {
          const el = document.querySelector(selector) as HTMLElement | null;
          const b = el?.getBoundingClientRect();
          out[key] = { shown: !!el && getComputedStyle(el).display !== 'none', x: Math.round(b?.x ?? 0), y: Math.round(b?.y ?? 0), right: Math.round(b?.right ?? 0), bottom: Math.round(b?.bottom ?? 0), w: Math.round(b?.width ?? 0) };
        }
        return out as Record<'activity' | 'explorer' | 'work' | 'insp', Box>;
      });
    await setSize(app, 1300, 800);
    await page.waitForFunction(() => window.innerWidth === 1300);
    let l = await layout();
    assert.ok(l.insp.x >= l.work.right - 1, `1300: 인스펙터는 에디터 오른쪽 ${JSON.stringify(l)}`);

    await setSize(app, 1100, 800);
    await page.waitForFunction(() => window.innerWidth === 1100);
    l = await layout();
    assert.equal(l.activity.shown, true);
    assert.ok(l.insp.y >= l.work.bottom - 1, `1100: 인스펙터는 에디터 아래 ${JSON.stringify(l)}`);
    assert.ok(Math.abs(l.insp.x - l.work.x) <= 1, '에디터와 같은 열');

    await setSize(app, 700, 800);
    await page.waitForFunction(() => window.innerWidth === 700);
    l = await layout();
    assert.equal(l.activity.shown, false, '700: 활동 막대 숨김');
    assert.ok(l.work.y >= l.explorer.bottom - 1, `700: 탐색기 아래 에디터 ${JSON.stringify(l)}`);
    assert.ok(l.explorer.w >= 690 && l.work.w >= 690, '한 열');
    // 좁아도 화 목록이 AI 작업 영역에 눌려 사라지지 않고 누를 수 있다 (탐색기 전체가 스크롤된다)
    const chapterButton = page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: /^TWO$/ });
    await chapterButton.scrollIntoViewIfNeeded();
    assert.ok((await chapterButton.boundingBox())!.height >= 28, '화 목록 행이 보인다');
    // 좁아도 원고 입력은 된다
    await typeAtEnd(page, BODY.one, ' NARROW');
    await editor(page).getByText(`${BODY.one} NARROW`, { exact: true }).waitFor();
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('탭: 열기·전환(저장 뒤)·현재가 아닌 탭 닫기·현재 탭 닫기(저장하고 이웃으로)·마지막 탭 닫기·다시 열기·키보드', { timeout: 120_000 }, async () => {
  const dir = await project('shell-tabs');
  const { app, page } = await launch(await tempDir('shell-tabs-ud'));
  try {
    await open(app, page, dir);
    const file = (n: number) => join(dir, 'chapters', `00${n}.md`);
    assert.deepEqual(await tabs(page), [{ title: 'ONE', selected: true }], '프로젝트를 열면 첫 화 탭 하나');

    await explorerChapter(page, 'TWO').click();
    await editor(page).getByText(BODY.two, { exact: true }).waitFor();
    await explorerChapter(page, 'THREE').click();
    await editor(page).getByText(BODY.three, { exact: true }).waitFor();
    assert.deepEqual(await tabs(page), [{ title: 'ONE', selected: false }, { title: 'TWO', selected: false }, { title: 'THREE', selected: true }]);
    // 같은 화를 다시 누르면 탭이 늘지 않는다
    await explorerChapter(page, 'THREE').click();
    assert.equal((await tabs(page)).length, 3);

    // 탭으로 전환: 지금 화의 미저장 입력이 먼저 저장된다
    await typeAtEnd(page, BODY.three, ' T3');
    await tab(page, 'TWO').click();
    await editor(page).getByText(BODY.two, { exact: true }).waitFor();
    assert.equal(await readFile(file(3), 'utf8'), `${envelope('three', 'THREE')}${BODY.three} T3\r\n`, '전환 전에 저장됐다 (BOM·CRLF·frontmatter 보존)');
    assert.deepEqual((await tabs(page)).map((t) => t.selected), [false, true, false]);

    // 현재가 아닌 탭 닫기: 편집기는 그대로 (같은 DOM 노드, 입력 유지)
    await typeAtEnd(page, BODY.two, ' T2');
    await page.evaluate(() => void ((document.querySelector('.ProseMirror') as unknown as { __marker: number }).__marker = 9));
    await closeButton(page, 'ONE').click();
    assert.deepEqual((await tabs(page)).map((t) => t.title), ['TWO', 'THREE']);
    assert.equal(await page.evaluate(() => (document.querySelector('.ProseMirror') as unknown as { __marker?: number }).__marker), 9, '편집기가 다시 만들어지지 않았다');
    await editor(page).getByText(`${BODY.two} T2`, { exact: true }).waitFor();
    assert.equal(await readFile(file(1), 'utf8'), fileText('one', 'ONE'), '닫은 탭의 화는 바뀌지 않았다');

    // 현재 탭 닫기: 저장하고 오른쪽 이웃(THREE)으로
    await closeButton(page, 'TWO').click();
    await editor(page).getByText(BODY.three + ' T3', { exact: true }).waitFor();
    assert.deepEqual(await tabs(page), [{ title: 'THREE', selected: true }]);
    assert.equal(await readFile(file(2), 'utf8'), `${envelope('two', 'TWO')}${BODY.two} T2\r\n`, '닫기 전에 저장됐다');

    // 마지막 탭 닫기: 화 없음 안내, 상태는 저장됨, 탐색기에서 다시 열면 탭이 생긴다
    await closeButton(page, 'THREE').click();
    await page.getByText('왼쪽에서 화를 고르거나 새 화를 만드세요.').waitFor();
    assert.equal(await page.getByRole('tab').count(), 0);
    assert.equal(await page.locator('.ProseMirror').count(), 0);
    await saved(page);
    await explorerChapter(page, 'ONE').click();
    await editor(page).getByText(BODY.one, { exact: true }).waitFor();
    assert.deepEqual(await tabs(page), [{ title: 'ONE', selected: true }]);

    // 키보드: 방향키는 포커스만 옮기고, Enter가 전환한다
    await explorerChapter(page, 'TWO').click();
    await editor(page).getByText(`${BODY.two} T2`, { exact: true }).waitFor();
    await tab(page, 'TWO').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'ONE');
    assert.deepEqual((await tabs(page)).map((t) => t.selected), [false, true], '방향키만으로는 전환하지 않는다');
    await page.keyboard.press('Enter');
    await editor(page).getByText(BODY.one, { exact: true }).waitFor();
    assert.deepEqual((await tabs(page)).map((t) => t.selected), [true, false]);
    // 가운데 클릭으로도 닫힌다 (현재가 아닌 탭)
    await tab(page, 'TWO').click({ button: 'middle' });
    assert.deepEqual((await tabs(page)).map((t) => t.title), ['ONE']);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('빠른 전환: 탭을 연달아 눌러도 마지막으로 누른 화가 열리고, 다른 화 원고는 바뀌지 않으며 탭 목록이 유지된다', { timeout: 60_000 }, async () => {
  const dir = await project('shell-quick');
  const { app, page } = await launch(await tempDir('shell-quick-ud'));
  try {
    await open(app, page, dir);
    await explorerChapter(page, 'TWO').click();
    await explorerChapter(page, 'THREE').click();
    await editor(page).getByText(BODY.three, { exact: true }).waitFor();
    await tab(page, 'ONE').click();
    await tab(page, 'THREE').click();
    await tab(page, 'TWO').click();
    await editor(page).getByText(BODY.two, { exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(await tabs(page), [{ title: 'ONE', selected: false }, { title: 'TWO', selected: true }, { title: 'THREE', selected: false }]);
    for (const [n, id, title] of [[1, 'one', 'ONE'], [2, 'two', 'TWO'], [3, 'three', 'THREE']] as const) {
      assert.equal(await readFile(join(dir, 'chapters', `00${n}.md`), 'utf8'), fileText(id, title));
    }
  } finally {
    await closeWindow(app);
  }
});

test('충돌 중 탭 닫기: 저장할 수 없는 상태에서 현재 탭을 닫으려 하면 확인을 묻고, 거절하면 탭·입력·충돌 안내가 그대로이며, 승인하면 닫힌다', { timeout: 90_000 }, async () => {
  const dir = await project('shell-conflict');
  const { app, page } = await launch(await tempDir('shell-conflict-ud'));
  try {
    await open(app, page, dir);
    await explorerChapter(page, 'TWO').click();
    await editor(page).getByText(BODY.two, { exact: true }).waitFor();
    await typeAtEnd(page, BODY.two, ' MINE');
    const outside = `${envelope('two', 'TWO')}OUTSIDE_EDIT\r\n`;
    await writeFile(join(dir, 'chapters', '002.md'), outside);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });

    const messages: string[] = [];
    page.once('dialog', (d) => {
      messages.push(d.message());
      void d.dismiss();
    });
    await closeButton(page, 'TWO').click();
    await page.waitForTimeout(500);
    assert.equal(messages.length, 1, '확인을 물었다');
    assert.match(messages[0]!, /저장되지 않은 변경/);
    assert.deepEqual((await tabs(page)).map((t) => t.title), ['ONE', 'TWO'], '거절하면 탭이 그대로');
    await editor(page).getByText(`${BODY.two} MINE`, { exact: true }).waitFor();
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor();
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), outside, '디스크는 바깥에서 고친 그대로');

    page.once('dialog', (d) => void d.accept());
    await closeButton(page, 'TWO').click();
    await editor(page).getByText(BODY.one, { exact: true }).waitFor();
    assert.deepEqual(await tabs(page), [{ title: 'ONE', selected: true }], '승인하면 닫히고 이웃 화가 열린다');
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), outside, '승인해도 디스크의 다른 프로그램 변경을 덮지 않는다');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('프로젝트 전환·같은 폴더 다시 열기: 탭이 새로 시작되고, 검색 결과·새 화는 탭으로 열린다', { timeout: 120_000 }, async () => {
  const a = await project('shell-proj-a');
  const b = await project('shell-proj-b', ['ALPHA', 'BETA', 'GAMMA']);
  const { app, page } = await launch(await tempDir('shell-proj-ud'));
  try {
    await open(app, page, a);
    await explorerChapter(page, 'TWO').click();
    await explorerChapter(page, 'THREE').click();
    await editor(page).getByText(BODY.three, { exact: true }).waitFor();
    assert.equal((await tabs(page)).length, 3);

    // 다른 프로젝트: 이전 프로젝트의 탭이 남지 않는다
    await openAgain(app, page, b);
    await tab(page, 'ALPHA').waitFor();
    assert.deepEqual(await tabs(page), [{ title: 'ALPHA', selected: true }]);
    await explorerChapter(page, 'BETA').click();
    assert.equal((await tabs(page)).length, 2);

    // 같은 폴더 다시 열기: 탭은 첫 화 하나로 돌아간다
    await openAgain(app, page, b);
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 1);
    assert.deepEqual(await tabs(page), [{ title: 'ALPHA', selected: true }]);

    // 검색 결과를 누르면 그 화가 탭으로 열린다
    await page.getByRole('searchbox', { name: '원고 검색' }).fill(BODY.three);
    await page.getByRole('searchbox', { name: '원고 검색' }).press('Enter');
    await page.getByRole('list', { name: '검색 결과' }).waitFor();
    await page.getByRole('list', { name: '검색 결과' }).getByRole('button').first().click();
    await page.getByRole('tab', { name: 'GAMMA', exact: true }).waitFor();
    assert.deepEqual((await tabs(page)).map((t) => `${t.title}:${t.selected}`), ['ALPHA:false', 'GAMMA:true']);

    // 새 화는 새 탭으로 열리고 활성이 된다
    await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3);
    assert.equal((await tabs(page)).filter((t) => t.selected).length, 1);
    assert.equal((await tabs(page))[2]!.selected, true);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('시작 화면과 환경설정: 프로젝트 없이도 환경설정을 열어 테마를 바꾸고, Esc로 닫으면 연 버튼으로 포커스가 돌아온다. 프로젝트 화면에서도 같다', { timeout: 90_000 }, async () => {
  const dir = await project('shell-welcome');
  const userData = await tempDir('shell-welcome-ud');
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'midnight', followSystem: false } }));
  const { app, page } = await launch(userData);
  try {
    const opener = page.getByRole('button', { name: '환경설정', exact: true });
    await opener.focus();
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '환경설정' });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '환경설정', '열면 대화상자로 포커스가 들어온다');
    await dialog.getByRole('radio', { name: /^등잔불/ }).check();
    await page.waitForFunction(() => document.documentElement.dataset['theme'] === 'lamplight');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '환경설정', '닫으면 연 버튼으로 돌아온다');
    // 시작 화면에서 바꾼 테마가 프로젝트를 연 뒤에도 그대로다
    await open(app, page, dir);
    assert.equal(await page.evaluate(() => document.documentElement.dataset['theme']), 'lamplight');

    // 프로젝트 화면: 활동 막대의 설정 → Esc → 활동 막대 설정으로 포커스 복귀
    const activity = page.getByRole('button', { name: '설정', exact: true });
    await activity.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    // Tab이 대화상자 밖으로 새지 않는다
    for (let i = 0; i < 60; i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true, 'Tab 순환이 대화상자 안에 머문다');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '설정');
  } finally {
    await closeWindow(app);
  }
});

test('좁은 창(700px)에서도 설정에 들어갈 수 있다: 활동 막대가 숨어도 헤더의 설정 버튼 하나, 클릭·키보드로 열고 Esc로 닫으면 연 버튼으로 포커스가 돌아오며 미저장 입력·선택·undo가 그대로다 (빈 프로젝트 포함)', { timeout: 90_000 }, async () => {
  const dir = await project('shell-narrow-settings');
  const emptyDir = await tempDir('shell-narrow-empty');
  await mkdir(join(emptyDir, 'chapters'));
  const { app, page } = await launch(await tempDir('shell-narrow-settings-ud'));
  try {
    await setSize(app, 700, 800);
    await page.waitForFunction(() => window.innerWidth === 700);
    await open(app, page, dir);
    const settings = page.getByRole('button', { name: '설정', exact: true });
    const dialog = page.getByRole('dialog', { name: '환경설정' });
    assert.equal(await settings.count(), 1, '700px: 설정 진입점은 보이는 버튼 하나');
    assert.equal(await settings.isVisible(), true);
    assert.equal(await page.locator('.activitybar').evaluate((el) => getComputedStyle(el).display), 'none', '활동 막대는 숨겨져 있다');

    // 미저장 입력·선택·undo 가능 여부·편집기 노드를 기록한다
    await typeAtEnd(page, BODY.one, ' UNSAVED');
    await page.evaluate(() => void ((document.querySelector('.ProseMirror') as unknown as { __marker: number }).__marker = 5));
    const snapshot = () =>
      page.evaluate(() => {
        const pm = document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { toJSON(): unknown }; selection: { from: number; to: number } }; can(): { undo(): boolean } }; __marker?: number };
        return { marker: pm.__marker ?? null, doc: JSON.stringify(pm.editor.state.doc.toJSON()), from: pm.editor.state.selection.from, to: pm.editor.state.selection.to, canUndo: pm.editor.can().undo() };
      });
    const before = await snapshot();

    // 클릭으로 열고 Esc로 닫는다: 대화상자는 하나, 닫으면 연 버튼으로 포커스
    await settings.click();
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '설정');
    // 키보드로 연다
    await settings.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.equal(await dialog.count(), 1);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '설정');
    // 닫기 버튼으로도
    await settings.click();
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });

    assert.deepEqual(await snapshot(), before, '설정을 열고 닫아도 편집기 노드·문서·선택·undo가 그대로');
    // 실제 undo가 입력 한 단계만 되돌린다
    await editor(page).getByText(`${BODY.one} UNSAVED`, { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+z');
    await editor(page).getByText(BODY.one, { exact: true }).waitFor();
    await page.keyboard.press('Control+Shift+z');
    await editor(page).getByText(`${BODY.one} UNSAVED`, { exact: true }).waitFor();
    await page.keyboard.press('Control+s');
    await saved(page);
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), `${envelope('one', 'ONE')}${BODY.one} UNSAVED\r\n`, '원고 바이트(BOM·CRLF·frontmatter)');

    // 넓은 창에서는 활동 막대의 설정만 보인다 (설정 진입점이 둘로 겹치지 않는다)
    await setSize(app, 1300, 800);
    await page.waitForFunction(() => window.innerWidth === 1300);
    assert.equal(await settings.count(), 1);
    assert.equal(await page.locator('.activitybar').getByRole('button', { name: '설정', exact: true }).count(), 1);

    // 빈 프로젝트(700px): 화가 없어도 설정에 들어갈 수 있다
    await setSize(app, 700, 800);
    await page.waitForFunction(() => window.innerWidth === 700);
    await stubFolderDialog(app, emptyDir);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.getByText('아직 화가 없습니다. 왼쪽 위의 [+ 새 화]로 첫 화를 만드세요.').waitFor();
    assert.equal(await settings.count(), 1);
    await settings.click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '설정');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
