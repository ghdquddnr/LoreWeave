// 검색의 늦은 응답·취소 보호: Esc나 탐색기 복귀로 목록에 돌아간 뒤 늦게 온 검색 응답이 결과를 다시 켜거나, 오래된 요청이 최신 요청의 결과·오류·찾는 중 표시를 건드리지 않는다.
// 합성 원고·격리 userData. main의 chapters:search / chapter:write를 명시적 장벽(요청별 hold → release/fail)으로 감싼다. sleep에 기대지 않고 도착·응답 기록으로 맞춘다. 유료·외부 호출 없음.

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
  /** 도착한 검색어 순서 */
  arrived: string[];
  /** 응답을 마친 검색어 */
  answered: string[];
  /** 저장 요청 도착 수 */
  writes: number;
  holdWrite: boolean;
  /** 검색어별 hold: 'ok'면 풀면 정상 응답, 'fail'이면 풀면 거절 */
  holds: Record<string, { mode: 'ok' | 'fail'; release?: () => void }>;
  releaseWrite?: () => void;
}

const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], writes: 0, holdWrite: false, holds: {} };
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
      if (b.holdWrite) await new Promise<void>((resolve) => (b.releaseWrite = resolve));
      return write(...args);
    });
  });
const setHold = (app: ElectronApplication, q: string, mode: 'ok' | 'fail') =>
  app.evaluate((_e, a) => void ((globalThis as unknown as { barrier: Barrier }).barrier.holds[a.q] = { mode: a.mode }), { q, mode });
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => (globalThis as unknown as { barrier: Barrier }).barrier.holds[q]?.release?.(), q);
const barrier = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier);
const until = async (app: ElectronApplication, what: (b: Barrier) => boolean, label: string) => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const b = await barrier(app);
    if (what(b)) return b;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${label} ${JSON.stringify(b)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
/** 응답 처리가 화면에 반영될 기회를 준다 (renderer가 두 프레임을 그릴 때까지) */
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const summary = (page: Page) => page.locator('.search-summary');

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').waitFor();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'ONE' }).waitFor();
  // 색인이 준비될 때까지 정상 검색을 한 번 한다 (장벽을 걸기 전)
  await submit(page, '알파');
  await summary(page).filter({ hasText: /찾음|없음/ }).waitFor();
  await page.getByRole('button', { name: '목록으로' }).click();
  await hook(app);
  return { app, page, dir };
}
const listVisible = (page: Page) => page.getByRole('navigation', { name: '화 목록' }).isVisible();

test('Esc로 목록에 돌아간 뒤 늦게 온 검색 응답이 결과를 다시 켜지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('search-late-esc');
  try {
    await setHold(app, '베타', 'ok');
    await submit(page, '베타');
    await until(app, (b) => b.arrived.includes('베타'), '베타 도착');
    await summary(page).getByText('찾는 중…').waitFor();
    await box(page).press('Escape');
    assert.equal(await listVisible(page), true, 'Esc: 목록 복귀');
    assert.equal(await summary(page).count(), 0, '찾는 중 표시도 사라진다');
    await release(app, '베타');
    await until(app, (b) => b.answered.includes('베타'), '베타 응답');
    await settled(page);
    assert.equal(await resultsList(page).count(), 0, '늦은 성공이 검색 결과를 다시 켜지 않는다');
    assert.equal(await listVisible(page), true, '목록이 유지된다');
    assert.equal(await summary(page).count(), 0);
    // 새 정상 검색은 복구된다
    await submit(page, '감마');
    await resultsList(page).waitFor();
    assert.match(await summary(page).first().innerText(), /찾음/);
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), TWO, '원고 바이트 보존');
  } finally {
    await closeWindow(app);
  }
});

test('탐색기(화 목록) 복귀 뒤 늦게 온 검색 실패도 오류·찾는 중을 다시 켜지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('search-late-explorer');
  try {
    await setHold(app, '베타', 'fail');
    await submit(page, '베타');
    await until(app, (b) => b.arrived.includes('베타'), '베타 도착');
    await page.getByRole('button', { name: '원고 화 목록' }).click();
    assert.equal(await listVisible(page), true);
    await release(app, '베타');
    await until(app, (b) => b.answered.includes('베타'), '베타 응답(실패)');
    await settled(page);
    assert.equal(await page.locator('.search .error').count(), 0, '늦은 실패가 오류를 다시 켜지 않는다');
    assert.equal(await summary(page).count(), 0);
    await submit(page, '감마');
    await resultsList(page).waitFor();
  } finally {
    await closeWindow(app);
  }
});

test('오래된 요청 A가 새 요청 B보다 늦게 성공·실패해도 최신 B의 결과·오류·찾는 중을 건드리지 않는다', { timeout: 120_000 }, async () => {
  const { app, page } = await start('search-late-order');
  try {
    // A 성공이 늦게 도착
    await setHold(app, '베타', 'ok');
    await submit(page, '베타');
    await until(app, (b) => b.arrived.includes('베타'), 'A 도착');
    await submit(page, '감마');
    await resultsList(page).waitFor();
    const mine = await summary(page).first().innerText();
    assert.match(mine, /1줄에서 찾음/, 'B(감마)의 결과');
    await release(app, '베타');
    await until(app, (b) => b.answered.includes('베타'), 'A 응답');
    await settled(page);
    assert.match(await summary(page).first().innerText(), /1줄에서 찾음/);
    assert.match(await resultsList(page).innerText(), /감마/, 'A(베타) 결과가 B를 덮어쓰지 않는다');
    assert.doesNotMatch(await resultsList(page).innerText(), /베타 하나/);

    // A 실패가 늦게 도착 + B는 아직 진행 중: 이전 finally가 B의 찾는 중을 풀지 않는다
    await setHold(app, '알파1', 'fail');
    await setHold(app, '알파', 'ok');
    await submit(page, '알파1');
    await until(app, (b) => b.arrived.includes('알파1'), '알파1 도착');
    await submit(page, '알파');
    await until(app, (b) => b.arrived.filter((q) => q === '알파').length >= 1, '알파 도착');
    await release(app, '알파1');
    await until(app, (b) => b.answered.includes('알파1'), '알파1 실패 응답');
    await settled(page);
    await summary(page).getByText('찾는 중…').waitFor();
    assert.equal(await page.locator('.search .error').count(), 0, '이전 요청의 실패 오류가 최신 요청 진행 중에 보이지 않는다');
    await release(app, '알파');
    await resultsList(page).waitFor();
    assert.equal(await page.locator('.search .error').count(), 0);
    assert.match(await resultsList(page).innerText(), /알파/);
  } finally {
    await closeWindow(app);
  }
});

test('저장(beforeSearch) 대기 중 Esc로 취소하면 검색 요청을 보내지 않고, 새 요청이 있으면 최신만 보낸다', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('search-late-before');
  try {
    // 저장이 필요한 입력을 만든 뒤 저장 응답을 붙잡는다
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('추가');
    await app.evaluate(() => void ((globalThis as unknown as { barrier: Barrier }).barrier.holdWrite = true));
    await submit(page, '베타');
    await until(app, (b) => b.writes >= 1, '저장 도착');
    assert.deepEqual((await barrier(app)).arrived, [], '저장이 끝나기 전에는 검색 요청이 없다');
    await box(page).press('Escape');
    await app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier.releaseWrite?.());
    await app.evaluate(() => void ((globalThis as unknown as { barrier: Barrier }).barrier.holdWrite = false));
    await settled(page);
    await settled(page);
    assert.deepEqual((await barrier(app)).arrived, [], '취소된 요청은 저장이 끝나도 검색 IPC를 보내지 않는다');
    assert.equal(await resultsList(page).count(), 0);
    assert.equal(await listVisible(page), true);
    assert.equal(await summary(page).count(), 0, '찾는 중이 남지 않는다');
    // 새 정상 검색은 복구된다
    await submit(page, '감마');
    await resultsList(page).waitFor();
    assert.deepEqual((await barrier(app)).arrived, ['감마']);
    await closeWindow(app);
    assert.match(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), /추가/, '입력한 글은 저장됐다');
  } finally {
    await closeWindow(app);
  }
});
