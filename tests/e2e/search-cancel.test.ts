// 검색 대기 중 [검색 취소]: 지금 검색의 결과 게시를 무효화하고 화 목록으로 돌아가되 입력한 검색어는 남긴다. 이미 시작된 저장 flush·main 검색을 중단했다고 주장하지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapters:search를 요청별 장벽(도착·응답 기록, hold → release로 정상 응답 또는 거절)으로, chapter:write를 호출 수·hold 장벽으로 감싼다.
// 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 저장되는 경합을 없앤다. 조합은 CDP Input.imeSetComposition이다. 합성 Electron/CDP이며 실제 IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

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
  holdWrite: boolean;
  writeHeld: boolean;
  releaseWrite?: () => void;
  holds: Record<string, { mode: 'ok' | 'fail'; release?: () => void }>;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], writes: 0, holdWrite: false, writeHeld: false, holds: {} };
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
      if (b.holdWrite) {
        b.holdWrite = false;
        b.writeHeld = true;
        await new Promise<void>((resolve) => (b.releaseWrite = resolve));
        b.writeHeld = false;
      }
      return write(...args);
    });
  });
const setHold = (app: ElectronApplication, q: string, mode: 'ok' | 'fail') =>
  app.evaluate((_e, a) => void ((globalThis as unknown as { barrier: Barrier }).barrier.holds[a.q] = { mode: a.mode }), { q, mode });
const clearHold = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => void delete (globalThis as unknown as { barrier: Barrier }).barrier.holds[q], q);
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => (globalThis as unknown as { barrier: Barrier }).barrier.holds[q]?.release?.(), q);
const armWrite = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as { barrier: Barrier }).barrier.holdWrite = true));
const releaseWrite = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier.releaseWrite?.());
const barrier = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier);
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
const cancelButton = (page: Page) => page.locator('.search').getByRole('button', { name: '검색 취소', exact: true });
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const chapterButton = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};
/** 취소 뒤 화면: 찾는 중·오류·결과 없이 화 목록 */
async function assertBackToList(page: Page, label: string) {
  assert.equal(await page.getByText('찾는 중…').count(), 0, `${label}: 찾는 중이 남지 않는다`);
  assert.equal(await cancelButton(page).count(), 0, `${label}: 취소 버튼이 남지 않는다`);
  assert.equal(await page.locator('.error.search-summary').count(), 0, `${label}: 오류가 없다`);
  assert.equal(await resultsList(page).count(), 0, `${label}: 결과가 없다`);
  await chapterButton(page, 'ONE').waitFor();
}

test('검색 대기 중 [검색 취소]는 입력을 남기고 화 목록으로 돌아가며, 늦은 성공·실패·옛 flush 뒤 검색이 새 상태를 되살리거나 덮지 않는다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('search-cancel');
  await mkdir(join(dir, 'chapters'));
  const files = ['001.md', '002.md'];
  const path1 = join(dir, 'chapters', '001.md');
  await writeFile(path1, ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const originals = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('search-cancel-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await chapterButton(page, 'ONE').waitFor();
    const cdp = await page.context().newCDPSession(page);

    // (a) 검색 대기 → 취소: 입력 유지·목록 복귀. 늦은 성공이 결과를 되살리지 않는다
    await setHold(app, '알파', 'ok');
    await submit(page, '알파');
    await until(app, '검색 도착', (b) => b.arrived.length === 1);
    await page.getByText('찾는 중…').waitFor();
    await cancelButton(page).waitFor();
    await cancelButton(page).click();
    await assertBackToList(page, '취소 직후');
    assert.equal(await box(page).inputValue(), '알파', '입력한 검색어는 남는다');
    await release(app, '알파'); // 늦은 성공
    await until(app, '늦은 응답', (b) => b.answered.length === 1);
    await settled(page);
    await assertBackToList(page, '늦은 성공 뒤');
    assert.equal(await box(page).inputValue(), '알파');
    await clearHold(app, '알파');

    // (a') 늦은 실패도 오류·버튼·찾는 중을 되살리지 않는다
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, '감마 도착', (b) => b.arrived.length === 2);
    await cancelButton(page).click();
    await release(app, '감마');
    await until(app, '늦은 실패', (b) => b.answered.length === 2);
    await settled(page);
    await assertBackToList(page, '늦은 실패 뒤');
    assert.equal(await page.getByRole('button', { name: '다시 검색' }).count(), 0, '취소한 검색의 늦은 실패가 [다시 검색]을 만들지 않는다');
    await clearHold(app, '감마');

    // (b) 취소 → 새 검색 성공 뒤 옛 응답: 최신 결과가 유지된다. 중복 클릭·조합키 보호·Enter 재검색
    await setHold(app, '알파', 'ok');
    await submit(page, '알파');
    await until(app, '알파 도착', (b) => b.arrived.length === 3);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.search button')].find((x) => x.textContent === '검색 취소') as HTMLButtonElement;
      b.click();
      b.click(); // 같은 tick의 중복 클릭
    });
    await assertBackToList(page, '중복 클릭 뒤');
    // 실제 조합 중 form submit은 검색을 시작하지 않는다 (PR157 보호가 취소 뒤에도 그대로다)
    await box(page).fill('감');
    await cdp.send('Input.imeSetComposition', { text: '마', selectionStart: 1, selectionEnd: 1 });
    await page.evaluate(() => (document.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit());
    await settled(page);
    assert.equal((await barrier(app)).arrived.length, 3, '조합 중 submit이 검색을 시작하지 않았다');
    await page.keyboard.insertText('마');
    await box(page).fill('감마');
    await box(page).press('Enter'); // 일반 Enter 재검색: 입력 검색어로 새 검색
    await until(app, '새 검색 응답', (b) => b.answered.includes('감마'));
    await resultsList(page).waitFor();
    assert.ok((await resultsList(page).innerText()).includes('감마 둘'));
    await release(app, '알파'); // 취소한 옛 검색이 늦게 도착
    await until(app, '옛 응답', (b) => b.answered.includes('알파'));
    await settled(page);
    assert.ok((await page.locator('.search-summary').first().innerText()).includes('"감마"'), '옛 응답이 최신 검색의 결과·요약을 덮지 않았다');
    assert.ok(!(await resultsList(page).innerText()).includes('알파 하나'));
    await box(page).press('Escape'); // 기존 Escape 전체 clear는 그대로다
    assert.equal(await box(page).inputValue(), '');
    await assertBackToList(page, 'Escape 뒤');

    await clearHold(app, '알파');
    // (c) 저장 flush 대기 중 취소: flush가 끝나도 그 요청의 검색은 보내지 않고, 저장은 정상 완료된다
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);
    await chapterButton(page, 'ONE').click();
    await page.locator('.ProseMirror').getByText('알파 하나').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    const before = await barrier(app);
    await armWrite(app);
    await submit(page, '알파');
    await until(app, '저장 요청이 붙잡히지 않았다', (b) => b.writeHeld);
    await page.getByText('찾는 중…').waitFor(); // 저장 flush 대기 중에도 취소할 수 있다
    await cancelButton(page).click();
    await assertBackToList(page, 'flush 대기 취소 뒤');
    assert.equal(await box(page).inputValue(), '알파');
    await releaseWrite(app);
    await until(app, '저장 완료', (b) => !b.writeHeld && b.writes === before.writes + 1);
    await settled(page);
    const after = await barrier(app);
    assert.equal(after.arrived.length, before.arrived.length, 'flush가 끝나도 취소한 요청의 검색 IPC를 보내지 않는다');
    await assertBackToList(page, 'flush 완료 뒤');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.ok((await readFile(path1, 'utf8')).includes('알파 하나 X'), '취소가 정상 저장을 막거나 유실시키지 않았다 (미저장 본문이 저장됨)');

    // 읽기만 하는 구간에서는 저장이 없었고(위 (c)의 한 건만), 원고 2는 그대로다
    const other = await readFile(join(dir, 'chapters', '002.md'));
    assert.ok(Buffer.compare(other, originals[1]!) === 0, '다른 화 원본 바이트 불변');
    assert.equal(before.writes, 0, '(a)~(b) 읽기 전용 구간에서 chapter:write는 0이었다');
  } finally {
    await release(app, '알파').catch(() => undefined);
    await release(app, '감마').catch(() => undefined);
    await releaseWrite(app).catch(() => undefined);
    await closeWindow(app);
  }
});
