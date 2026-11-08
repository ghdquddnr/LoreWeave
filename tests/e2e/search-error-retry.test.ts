// 검색 요청(chapters:search)이 실패했을 때의 [다시 검색]: 검색어·실패 안내·화 목록과 함께 버튼을 보이고, 누르면 그 순간 입력창의 검색어로 기존 search()(저장 전 flush → 검색) 경로를 다시 지난다.
// 저장 단계 실패(저장 거절)에는 이 버튼을 붙이지 않는다. 자동 재시도·실패를 0건 성공으로 표시하는 일은 없다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapters:search를 요청별 장벽(도착 기록, hold → release로 정상 응답 또는 거절)으로, chapter:write를 호출 수·실패 대역으로 감싼다.
// 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 저장되는 경합을 없앤다. 합성 Electron 검사이며 실제 IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const ONE = `${envelope('one', 'ONE')}알파 하나\r\n\r\n베타 하나\r\n`;
const TWO = `${envelope('two', 'TWO')}알파 둘\r\n\r\n감마 둘\r\n`;

interface Barrier {
  arrived: string[];
  answered: string[];
  writes: number;
  failWrites: boolean;
  holds: Record<string, { mode: 'ok' | 'fail'; release?: () => void }>;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], writes: 0, failWrites: false, holds: {} };
    const search = map.get('chapters:search')!;
    ipcMain.removeHandler('chapters:search');
    ipcMain.handle('chapters:search', async (...args: unknown[]) => {
      const q = args[1] as string;
      const b = g.barrier;
      b.arrived.push(q);
      const hold = b.holds[q];
      if (hold) await new Promise<void>((resolve) => (hold.release = resolve));
      try {
        if (hold?.mode === 'fail') throw new Error(`SEARCH_FAIL_${q}`);
        return await search(...args);
      } finally {
        b.answered.push(q);
      }
    });
    const write = map.get('chapter:write')!;
    ipcMain.removeHandler('chapter:write');
    ipcMain.handle('chapter:write', async (...args: unknown[]) => {
      const b = g.barrier;
      b.writes += 1;
      if (b.failWrites) throw new Error('EACCES: permission denied (synthetic)');
      return write(...args);
    });
  });
const setHold = (app: ElectronApplication, q: string, mode: 'ok' | 'fail') =>
  app.evaluate((_e, a) => void ((globalThis as unknown as { barrier: Barrier }).barrier.holds[a.q] = { mode: a.mode }), { q, mode });
const clearHold = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => void delete (globalThis as unknown as { barrier: Barrier }).barrier.holds[q], q);
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => (globalThis as unknown as { barrier: Barrier }).barrier.holds[q]?.release?.(), q);
const failWrites = (app: ElectronApplication, on: boolean) => app.evaluate((_e, on) => void ((globalThis as unknown as { barrier: Barrier }).barrier.failWrites = on), on);
const barrier = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier);
const count = (list: string[], q: string) => list.filter((x) => x === q).length;
async function until(app: ElectronApplication, what: string, ok: (b: Barrier) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const b = await barrier(app);
    if (ok(b)) return b;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${what} ${JSON.stringify(b)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const retryButton = (page: Page) => page.locator('.search').getByRole('button', { name: '다시 검색', exact: true });
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const errorNote = (page: Page) => page.locator('.error.search-summary');
const chapterButton = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};

test('검색 요청이 실패하면 [다시 검색]이 입력창의 현재 검색어로 기존 검색 경로를 다시 지나고, 중복 클릭은 겹치지 않으며, 저장 거절에는 버튼이 없다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('search-error-retry');
  await mkdir(join(dir, 'chapters'));
  const path1 = join(dir, 'chapters', '001.md');
  await writeFile(path1, ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir('search-error-retry-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await chapterButton(page, 'ONE').click();
    await page.locator('.ProseMirror').getByText('알파 하나').waitFor();
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);

    // 1) 검색 요청 실패: 검색어·실패 안내·화 목록·[다시 검색]. 실패를 0건 성공으로 표시하지 않는다
    assert.equal(await retryButton(page).count(), 0, '실패 전에는 버튼이 없다');
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '첫 검색 도착', (b) => count(b.arrived, '감마') === 1);
    await release(app, '감마');
    await errorNote(page).waitFor();
    await retryButton(page).waitFor();
    await settled(page);
    assert.equal(await box(page).inputValue(), '감마', '검색어 보존');
    assert.equal(await resultsList(page).count(), 0);
    assert.equal(await page.getByText('없음', { exact: false }).count(), 0, '실패를 0건 성공으로 표시하지 않는다');
    await chapterButton(page, 'ONE').waitFor();
    assert.equal(count((await barrier(app)).arrived, '감마'), 1, '자동 재시도는 없다');

    // 2) 입력을 바꾼 뒤 누르면 실패 당시 검색어가 아니라 화면의 현재 검색어를 검색한다
    await box(page).fill('알파');
    await retryButton(page).click();
    await resultsList(page).waitFor();
    const afterEdit = await barrier(app);
    assert.deepEqual(afterEdit.arrived, ['감마', '알파'], '현재 입력의 검색어로 검색했다 (실패 당시 검색어를 몰래 복원하지 않았다)');
    assert.equal(await errorNote(page).count(), 0, '성공하면 실패 안내가 사라진다');
    assert.equal(await retryButton(page).count(), 0, '성공하면 버튼이 사라진다');
    assert.ok((await resultsList(page).innerText()).includes('알파'), '그 요청의 결과만 게시된다');

    // 3) 같은 검색어로 다시 실패시킨 뒤, 같은 tick의 중복 클릭은 재시도를 겹치지 않는다
    await box(page).press('Escape'); // 지우기
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '두 번째 실패 도착', (b) => count(b.arrived, '감마') === 2);
    await release(app, '감마');
    await retryButton(page).waitFor();
    await setHold(app, '감마', 'ok');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.search button')].find((x) => x.textContent === '다시 검색') as HTMLButtonElement;
      b.click();
      b.click(); // 같은 tick의 중복 클릭
    });
    await until(app, '재시도 도착', (b) => count(b.arrived, '감마') === 3);
    await settled(page);
    assert.equal(count((await barrier(app)).arrived, '감마'), 3, '중복 클릭이 같은 재시도를 겹쳐 보내지 않았다 (관측 범위 안)');
    await release(app, '감마');
    await resultsList(page).waitFor();
    assert.ok((await resultsList(page).innerText()).includes('감마 둘'));
    await clearHold(app, '감마');

    // 4) 재시도를 붙잡은 채 Escape: 취소하고, 늦은 응답은 결과를 되살리지 않는다
    await box(page).press('Escape');
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '세 번째 도착', (b) => count(b.arrived, '감마') === 4);
    await release(app, '감마');
    await retryButton(page).waitFor();
    await setHold(app, '감마', 'ok');
    await retryButton(page).click();
    await until(app, '두 번째 재시도 도착', (b) => count(b.arrived, '감마') === 5);
    await box(page).press('Escape');
    await release(app, '감마');
    await until(app, '늦은 응답 처리', (b) => count(b.answered, '감마') === 5);
    await settled(page);
    assert.equal(await resultsList(page).count(), 0, '취소 뒤 늦은 응답이 결과를 되살리지 않는다');
    assert.equal(await errorNote(page).count(), 0);
    assert.equal(await box(page).inputValue(), '');
    await clearHold(app, '감마');

    // 5) 버튼 경로도 저장 전 flush를 지난다: 미저장 본문이 먼저 저장된 뒤 검색한다
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '다섯 번째 도착', (b) => count(b.arrived, '감마') === 6);
    await release(app, '감마');
    await retryButton(page).waitFor();
    await clearHold(app, '감마');
    await page.locator('.ProseMirror').getByText('알파 하나').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    const writesBefore = (await barrier(app)).writes;
    await retryButton(page).click();
    await resultsList(page).waitFor();
    assert.equal((await barrier(app)).writes, writesBefore + 1, '버튼 경로가 저장 전 flush로 미저장 본문을 먼저 저장했다');

    // 6) 저장이 거절되면 검색하지 않는다: 저장 문제 안내만 보이고 [다시 검색]은 없다. 입력·원고는 그대로다
    await box(page).press('Escape');
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '여섯 번째 도착', (b) => count(b.arrived, '감마') === 8);
    await release(app, '감마');
    await retryButton(page).waitFor();
    await clearHold(app, '감마');
    await page.locator('.ProseMirror').getByText('알파 하나 X').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Y');
    await failWrites(app, true);
    const before = await barrier(app);
    const bytes = await readFile(path1);
    await retryButton(page).click();
    await errorNote(page).getByText('저장', { exact: false }).waitFor();
    await settled(page);
    const after = await barrier(app);
    assert.equal(after.arrived.length, before.arrived.length, '저장이 거절되면 검색 IPC를 보내지 않는다');
    assert.ok(after.writes > before.writes, '저장을 시도했다');
    assert.equal(await retryButton(page).count(), 0, '저장 문제 안내에는 [다시 검색]을 붙이지 않는다');
    assert.equal(await box(page).inputValue(), '감마', '검색어 보존');
    assert.equal(await page.locator('.ProseMirror').getByText('알파 하나 X Y', { exact: true }).count(), 1, '입력한 글 보존');
    assert.ok(Buffer.compare(await readFile(path1), bytes) === 0, '저장이 거절된 동안 원고 파일은 그대로다');
    await failWrites(app, false);
  } finally {
    await failWrites(app, false).catch(() => undefined);
    await release(app, '감마').catch(() => undefined);
    await closeWindow(app);
  }
});

// 조합 키(keyCode 229)의 이력은 form submit을 거르는 용도다: 조합이 끝난 뒤의 마우스 [다시 검색]까지 영구히 막으면 안 된다.
// 실제 조합 중(compositionstart~end)의 버튼 클릭은 시작하지 않고, compositionend 뒤에는 추가 일반 키 입력 없이 버튼으로 현재 검색어를 정확히 한 번 검색한다.
// CDP 합성 조합·합성 229 keydown이며 실제 OS IME 확인이 아니다.
test('[다시 검색]: 조합 중 클릭은 flush·검색을 시작하지 않고, 조합이 끝난 뒤에는 추가 키 입력 없이 마우스 클릭으로 현재 검색어를 한 번 검색한다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('search-retry-ime');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir('search-retry-ime-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapterButton(page, 'ONE').click();
    await page.locator('.ProseMirror').getByText('알파 하나').waitFor();
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);
    const cdp = await page.context().newCDPSession(page);
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '첫 검색 도착', (b) => count(b.arrived, '감마') === 1);
    await release(app, '감마');
    await retryButton(page).waitFor();
    await clearHold(app, '감마');

    // 미저장 본문을 만들어 두고(저장 전 flush 진입은 chapter:write로 관측), 조합 시작
    await page.locator('.ProseMirror').getByText('알파 하나').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    await box(page).fill('알');
    await cdp.send('Input.imeSetComposition', { text: '파', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Process', code: 'Enter' });

    // 조합 중 클릭(포커스를 옮기지 않는 DOM 클릭): 시작하지 않는다
    const before = await barrier(app);
    await page.evaluate(() => (document.querySelector('.search .error button') as HTMLButtonElement).click());
    await settled(page);
    const during = await barrier(app);
    assert.equal(during.arrived.length, before.arrived.length, '조합 중 버튼 클릭이 검색 IPC를 시작하지 않았다');
    assert.equal(during.writes, before.writes, '조합 중 버튼 클릭이 저장 전 flush에 들어가지 않았다');

    // 조합 확정(compositionend) 뒤 추가 일반 키 입력 없이 마우스 클릭: 현재 검색어를 한 번 검색한다
    await page.keyboard.insertText('파');
    assert.equal(await box(page).inputValue(), '알파');
    await retryButton(page).click();
    await resultsList(page).waitFor();
    const after = await barrier(app);
    assert.deepEqual(after.arrived.slice(before.arrived.length), ['알파'], '조합이 끝난 뒤 마우스 클릭이 현재 검색어를 정확히 한 번 검색했다');
    assert.equal(after.writes, before.writes + 1, '버튼 경로가 저장 전 flush로 미저장 본문을 저장했다');
    assert.equal(await errorNote(page).count(), 0);

    // 일반 Enter·Escape는 그대로다
    await box(page).press('Escape');
    assert.equal(await box(page).inputValue(), '');
    await submit(page, '감마');
    await resultsList(page).waitFor();
  } finally {
    await release(app, '감마').catch(() => undefined);
    await closeWindow(app);
  }
});
