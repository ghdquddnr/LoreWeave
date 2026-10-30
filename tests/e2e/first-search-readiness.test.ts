// 앱을 다시 실행한 직후 첫 검색의 단계별 증거와, 편집기 준비(비동기 chapter read)가 검색 입력/Enter와 어떤 순서로 끼는지를 결정적으로 강제하는 회귀.
// 배경: 감독 격리 실행에서 search.test.ts '2글자 검색어…'의 첫 '민수' 검색이 요약을 30초 기다리다 timeout 났다(원인 불명, PR108 본문). 이 테스트는 그 원인을 확정하려는 것이 아니다.
// 장벽 설치의 준비 경합 제거: launch()는 domcontentloaded 뒤에 반환하므로 그 뒤에 장벽을 설치하면 빠른 자동 재열기의 chapter:read를 놓칠 수 있다.
//   그래서 얇은 시작 파일(hooks/main-hold-entry.cjs)이 hooks/main-hold.cjs를 먼저 불러 ipcMain.handle을 감싼 뒤 제품 main(out/main/index.js)을 불러온다 (제품 src 변경 없음).
//   (NODE_OPTIONS=--require는 Electron이 적용하지 않아 쓰지 못했다: 첫 시도에서 훅 상태가 비어 있었다.)
//   훅은 renderer·연결 속도와 무관하게 첫 chapter:read 요청보다 먼저 존재한다. (느린 테스트 연결이어도 장벽은 이미 있다; 빠른 renderer여도 요청은 훅을 거친다.)
// 단계는 섞지 않는다: (1) 검색 입력 값 (2) 포커스(activeElement) (3) form submit (4) beforeSearch 완료 + search IPC 도달 (5) IPC 응답 (6) 화면 요약 (7) 원고 DOM/바이트.
// 진단용 page.evaluate(리스너 설치·값 읽기)는 renderer 작업 사이에 끼어 순서를 바꿀 수 있다. 특히 Enter는 page.keyboard(현재 activeElement로 간다)로 누르고,
//   원하는 결과에 맞추려고 locator로 다시 포커스를 주지 않는다 (locator.press는 대상에 포커스를 주므로 실제 Enter 경로를 가린다).
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter), 별도 userData. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', '1화. 입학', '민수는 운동장에 앉아 있었다');
const TWO = doc('two', '2화. 설명회', '설명회에서 민수가 손을 들었다');
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const ENTRY = join(__dirname, 'hooks', 'main-hold-entry.cjs');

const editor = (page: Page) => page.locator('.ProseMirror');
const searchbox = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });

type Hold = { armed: boolean; held: boolean; readCalls: number; searchCalls: number; searchDone: number; release?: () => void };
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __hold: Hold }).__hold.release?.());
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const h = (globalThis as unknown as { __hold: Hold }).__hold;
    return { held: h.held, readCalls: h.readCalls, searchCalls: h.searchCalls, searchDone: h.searchDone };
  });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}
/** 포커스가 있는 요소를 보기 좋게 요약한다 (진단용 evaluate) */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName.toLowerCase()}${el.classList.contains('ProseMirror') ? '.ProseMirror' : ''}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}` : 'none';
  });
const submitsInstalled = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { submits: number }).submits = 0;
    document.addEventListener('submit', () => void ((window as unknown as { submits: number }).submits += 1), true);
  });
const submits = (page: Page) => page.evaluate(() => (window as unknown as { submits: number }).submits);

/** 합성 프로젝트를 만들고, 앱 1이 열어 마지막 프로젝트로 기억시킨 뒤 닫는다. 앱 2는 훅을 먼저 불러오는 시작 파일로 실행되어 자동으로 다시 연다 */
async function relaunch(): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = await tempDir('first-search');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const userData = await tempDir('first-search-userdata');
  const first = await launch(userData);
  try {
    await stubFolderDialog(first.app, dir);
    await first.page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await first.page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '1화. 입학' }).waitFor();
  } finally {
    await closeWindow(first.app);
  }
  const { app, page } = await launch(userData, {}, ENTRY);
  // 훅은 앱 시작 전에 설치됐다: 자동 재열기의 첫 chapter:read는 이미 장벽을 거친다 (각 테스트가 held로 확인한다)
  return { app, page, dir };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('(훅 확인) 장벽은 자동 재열기의 첫 chapter:read보다 먼저 있어, 그 읽기가 반드시 붙잡힌다', { timeout: 120_000 }, async () => {
  const { app, page } = await relaunch();
  try {
    await waitUntil(page, '첫 chapter:read가 붙잡히지 않았다 (훅이 적용되지 않았다)', async () => (await state(app)).held, app);
    assert.equal((await state(app)).readCalls, 1, '붙잡힌 것이 자동 재열기의 첫 읽기다');
    assert.equal(await editor(page).count(), 0, '편집기는 아직 준비되지 않았다');
  } finally {
    await cleanup(app, page);
  }
});

test('편집기 준비가 늦은 채로 첫 검색: 입력·submit·beforeSearch·IPC·요약이 정상이고 편집기 준비 뒤에도 결과가 유지되며, 원고 바이트와 수락한 입력은 보존된다 (searchbox.press 경로)', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await relaunch();
  try {
    await waitUntil(page, '첫 chapter:read가 붙잡히지 않았다', async () => (await state(app)).held, app);
    await searchbox(page).waitFor();
    assert.equal(await editor(page).count(), 0, '편집기는 아직 준비되지 않았다 (본문 읽기가 붙잡혀 있다)');
    await searchbox(page).fill('민수');
    await submitsInstalled(page);
    const value = await searchbox(page).inputValue();
    await searchbox(page).press('Enter'); // locator.press: 검색창에 포커스를 주고 누른다 (아래 별도 테스트가 포커스를 주지 않는 실제 Enter를 본다)
    assert.equal(value, '민수', '(1) 검색 입력 값이 있다');
    assert.equal(await submits(page), 1, '(3) Enter로 form submit이 1회 일어났다');
    await waitUntil(page, '(4) search IPC가 main에 도달하지 않았다', async () => (await state(app)).searchCalls === 1, app);
    await waitUntil(page, '(5) search IPC 응답이 끝나지 않았다', async () => (await state(app)).searchDone === 1, app);
    assert.equal((await state(app)).held, true, '편집기 읽기는 아직 붙잡혀 있다');
    await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).waitFor({ timeout: 10_000 });
    assert.equal(await editor(page).count(), 0, '요약이 나온 시점에도 편집기는 아직 준비되지 않았다');
    await release(app);
    await editor(page).waitFor();
    await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).waitFor();
    assert.ok((await page.getByRole('list', { name: '검색 결과' }).getByRole('button').count()) >= 1, '편집기가 준비된 뒤에도 검색 결과 목록이 남아 있다');
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE, '검색만 했을 때 원고 바이트는 그대로다');
    await page.getByRole('list', { name: '검색 결과' }).getByRole('button').first().click();
    await editor(page).getByText('민수').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 추가');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(sha(await readFile(join(dir, 'chapters', '001.md'), 'utf8')), sha(doc('one', '1화. 입학', '민수는 운동장에 앉아 있었다 추가')), '수락한 입력이 정확한 바이트로 저장됐다');
  } finally {
    await cleanup(app, page);
  }
});

test('검색 입력 뒤, 실제 keyboard Enter 전에 편집기 준비가 끼는 순서: 포커스가 검색창에 남고 Enter가 검색으로 가며 원고는 바뀌지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await relaunch();
  try {
    await waitUntil(page, '첫 chapter:read가 붙잡히지 않았다', async () => (await state(app)).held, app);
    await searchbox(page).waitFor();
    // (1) 검색 입력: 검색창에 쓴다 (fill이 검색창에 포커스를 준다). 편집기는 아직 없다
    await searchbox(page).fill('민수');
    await submitsInstalled(page);
    const valueBefore = await searchbox(page).inputValue();
    const focusAtInput = await focusOf(page);
    // 편집기 준비가 Enter보다 먼저 끼도록 읽기를 푼다. 편집기가 만들어지고(autofocus가 있다면 그 포커스 이동도) 나서야 Enter를 누른다
    await release(app);
    await editor(page).waitFor();
    const paragraphsBefore = await editor(page).locator('p').count();
    // (2) 포커스: 진단 관측. autofocus가 포커스를 옮겼다면 짧은 조건 대기 안에 일어난다 (부재 확인이므로 시간 한도가 있는 관측이다)
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 3000 }).catch(() => {});
    const focusBeforeEnter = await focusOf(page);
    const valueAtEnter = await searchbox(page).inputValue();
    // 실제 Enter: 현재 activeElement로 간다 (locator로 다시 포커스를 주지 않는다)
    await page.keyboard.press('Enter');
    // (3) submit 발생 여부
    const submitCount = await submits(page);
    // (4)(5) 검색 IPC가 main에 도달했는지/응답했는지는 submit이 있었을 때만 기다린다. 없었다면 도달 안 한 채로 관측한다
    if (submitCount === 1) {
      await waitUntil(page, '(4) search IPC가 main에 도달하지 않았다', async () => (await state(app)).searchCalls === 1, app);
      await waitUntil(page, '(5) search IPC 응답이 끝나지 않았다', async () => (await state(app)).searchDone === 1, app);
      // (6) 응답이 화면에 반영되는 것은 별도 단계다: IPC가 응답한 뒤 요약이 나타날 때까지 기다린다 (submit이 없었다면 기다리지 않고 없는 채로 관측한다)
      await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).waitFor({ timeout: 10_000 }).catch(() => {});
    }
    const stage = await state(app);
    const summary = await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).count();
    const paragraphsAfter = await editor(page).locator('p').count();
    const problems: string[] = [];
    if (focusAtInput !== 'input[원고 검색]') problems.push(`(2) 입력 시점 포커스가 검색창이 아니다: ${focusAtInput}`);
    if (valueBefore !== '민수' || valueAtEnter !== '민수') problems.push(`(1) 검색 입력 값이 바뀌었다: ${valueBefore} → ${valueAtEnter}`);
    if (focusBeforeEnter !== 'input[원고 검색]') problems.push(`(2) 편집기 준비 뒤 Enter 직전 포커스가 검색창에서 옮겨졌다: ${focusBeforeEnter}`);
    if (submitCount !== 1) problems.push(`(3) Enter로 form submit이 일어나지 않았다 (submit=${submitCount})`);
    if (stage.searchCalls !== 1) problems.push(`(4) search IPC가 main에 도달하지 않았다 (searchCalls=${stage.searchCalls})`);
    if (summary < 1) problems.push('(6) 화면에 검색 요약이 없다');
    if (paragraphsAfter !== paragraphsBefore) problems.push(`(7) Enter가 원고에 들어갔다: 문단 ${paragraphsBefore} → ${paragraphsAfter}`);
    assert.deepEqual(problems, [], `단계별 관측: focusAtInput=${focusAtInput} focusBeforeEnter=${focusBeforeEnter} submit=${submitCount} ${JSON.stringify(stage)}`);
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE, '원고 바이트는 그대로다');
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 편집기가 먼저 준비된 뒤 검색해도 같은 단계가 정상이다 (빠른 준비)', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await relaunch();
  try {
    await waitUntil(page, '첫 chapter:read가 붙잡히지 않았다', async () => (await state(app)).held, app);
    await release(app);
    await editor(page).waitFor();
    // 편집기의 시작 포커스(autofocus)가 끝난 것을 확인한 뒤에 검색창을 쓴다: 사용자가 편집기가 자리 잡은 뒤 검색창을 누르는 순서
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 });
    await searchbox(page).fill('민수');
    await submitsInstalled(page);
    assert.equal(await focusOf(page), 'input[원고 검색]', '검색 입력 시점 포커스는 검색창이다');
    await page.keyboard.press('Enter');
    assert.equal(await submits(page), 1);
    await waitUntil(page, '검색 IPC가 끝나지 않았다', async () => (await state(app)).searchDone === 1, app);
    await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE);
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 화 목록의 버튼으로 화를 열면 전처럼 편집기가 시작 포커스를 받고 입력이 원고로 들어간다 (글쓰기 경험 보존)', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await relaunch();
  try {
    await waitUntil(page, '첫 chapter:read가 붙잡히지 않았다', async () => (await state(app)).held, app);
    await release(app);
    await editor(page).waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 });
    // 2화를 버튼으로 연다: 포커스가 버튼에 있는 채로 새 편집기가 만들어진다 (입력란이 아니므로 시작 포커스를 받아야 한다)
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '2화. 설명회' }).click();
    await editor(page).getByText('설명회에서').waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 });
    await page.keyboard.type('X'); // 시작 위치에 들어간다 (포커스를 따로 주지 않는다)
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), doc('two', '2화. 설명회', 'X' + '설명회에서 민수가 손을 들었다'), '입력이 시작 위치에 정확한 바이트로 저장됐다');
  } finally {
    await cleanup(app, page);
  }
});
