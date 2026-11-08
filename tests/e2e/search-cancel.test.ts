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
  /** 다음에 도착하는 q 요청 하나만 붙잡는다 (붙잡힌 요청은 풀기 전까지 resolvers[q]에 쌓인다) */
  holds: Record<string, { mode: 'ok' | 'fail' }>;
  resolvers: Record<string, (() => void)[]>;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], writes: 0, holdWrite: false, writeHeld: false, holds: {}, resolvers: {} };
    const search = map.get('chapters:search')!;
    ipcMain.removeHandler('chapters:search');
    ipcMain.handle('chapters:search', async (...args: unknown[]) => {
      const q = args[1] as string;
      const b = g.barrier;
      b.arrived.push(q);
      const hold = b.holds[q];
      if (hold) {
        delete b.holds[q]; // 이 요청 하나만 붙잡는다 (뒤의 같은 검색어 요청은 붙잡지 않는다)
        await new Promise<void>((resolve) => (b.resolvers[q] ??= []).push(resolve));
      }
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
/** 붙잡힌 q 요청을 모두 푼다 (붙잡힌 요청이 없으면 아무 일도 없다) */
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => void ((globalThis as unknown as { barrier: Barrier }).barrier.resolvers[q] ?? []).splice(0).forEach((r) => r()), q);
const armWrite = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as { barrier: Barrier }).barrier.holdWrite = true));
const releaseWrite = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier.releaseWrite?.());
const count = (list: string[], q: string) => list.filter((x) => x === q).length;
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
async function assertBackToList(page: Page, label: string, app?: ElectronApplication) {
  // 취소 UI 반영(찾는 중 안내 제거)을 실제로 관측할 때까지 기다린다. 끝내 남아 있으면 도착 기록을 함께 보여 취소가 안 먹은 것인지 새 검색이 다시 시작된 것인지 구분한다
  try {
    await page.getByText('찾는 중…').waitFor({ state: 'detached', timeout: 5000 });
  } catch (e) {
    const b = app ? await barrier(app) : null;
    throw new Error(`${label}: 찾는 중이 5초 안에 사라지지 않았다 (도착 ${JSON.stringify(b?.arrived)}, 응답 ${JSON.stringify(b?.answered)}): ${(e as Error).message.slice(0, 120)}`);
  }
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
    await assertBackToList(page, '취소 직후', app);
    assert.equal(await box(page).inputValue(), '알파', '입력한 검색어는 남는다');
    await release(app, '알파'); // 늦은 성공
    await until(app, '늦은 응답', (b) => b.answered.length === 1);
    await settled(page);
    await assertBackToList(page, '늦은 성공 뒤', app);
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
    await assertBackToList(page, '늦은 실패 뒤', app);
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
    await assertBackToList(page, '중복 클릭 뒤', app);
    // 실제 조합 중 form submit은 검색을 시작하지 않는다 (PR157 보호가 취소 뒤에도 그대로다)
    await box(page).fill('감');
    await cdp.send('Input.imeSetComposition', { text: '마', selectionStart: 1, selectionEnd: 1 });
    await page.evaluate(() => (document.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit());
    await settled(page);
    assert.equal((await barrier(app)).arrived.length, 3, '조합 중 submit이 검색을 시작하지 않았다');
    await page.keyboard.insertText('마');
    await box(page).fill('감마');
    await box(page).press('Enter'); // 일반 Enter 재검색: 입력 검색어로 새 검색
    await until(app, '새 검색 응답', (b) => count(b.answered, '감마') === 2); // (a')의 응답과 구분되는 이번 응답
    await resultsList(page).waitFor();
    assert.ok((await resultsList(page).innerText()).includes('감마 둘'));
    await release(app, '알파'); // 취소한 옛 검색이 늦게 도착
    await until(app, '옛 응답', (b) => count(b.answered, '알파') === 2); // (a)의 응답과 구분되는 이번 응답
    await settled(page);
    assert.ok((await page.locator('.search-summary').first().innerText()).includes('"감마"'), '옛 응답이 최신 검색의 결과·요약을 덮지 않았다');
    assert.ok(!(await resultsList(page).innerText()).includes('알파 하나'));
    await box(page).press('Escape'); // 기존 Escape 전체 clear는 그대로다
    assert.equal(await box(page).inputValue(), '');
    await assertBackToList(page, 'Escape 뒤', app);

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
    await assertBackToList(page, 'flush 대기 취소 뒤', app);
    assert.equal(await box(page).inputValue(), '알파');
    await releaseWrite(app);
    await until(app, '저장 완료', (b) => !b.writeHeld && b.writes === before.writes + 1);
    await settled(page);
    const after = await barrier(app);
    assert.equal(after.arrived.length, before.arrived.length, 'flush가 끝나도 취소한 요청의 검색 IPC를 보내지 않는다');
    await assertBackToList(page, 'flush 완료 뒤', app);
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

// 키보드로 취소한 뒤 포커스가 검색 입력창으로 돌아와 바로 고쳐 재검색할 수 있어야 한다 (취소 버튼은 곧 사라진다). 늦은 응답은 포커스를 가져오지 않는다.
// 실제 Tab/Enter/Space 키 입력(Playwright keyboard)과 실제 SearchPanel UI. 합성 Electron이며 실제 OS IME·수동 GUI가 아니다.
test('[검색 취소]를 Tab→Enter/Space로 누르면 포커스가 검색 입력창으로 돌아와 입력을 고쳐 재검색할 수 있고, 늦은 응답은 포커스를 가져오지 않는다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('search-cancel-focus');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const originals = await Promise.all(['001.md', '002.md'].map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('search-cancel-focus-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await chapterButton(page, 'ONE').waitFor();
    const active = () =>
      page.evaluate(() => {
        const el = document.activeElement as HTMLInputElement | null;
        return { label: el?.getAttribute('aria-label') ?? el?.textContent ?? el?.tagName ?? '', inEditor: !!el?.closest?.('.ProseMirror'), start: el?.selectionStart ?? -1, end: el?.selectionEnd ?? -1, len: el?.value?.length ?? -1 };
      });

    // 1) Enter: 입력 → Tab으로 취소 버튼 → Enter
    await setHold(app, '알파', 'ok');
    await submit(page, '알파');
    await until(app, '검색 도착', (b) => count(b.arrived, '알파') === 1);
    await page.keyboard.press('Tab');
    assert.equal((await active()).label, '검색 취소', 'Tab으로 취소 버튼에 포커스가 간다');
    await page.keyboard.press('Enter');
    await assertBackToList(page, 'Enter 취소 뒤', app);
    const afterEnter = await active();
    assert.equal(afterEnter.label, '원고 검색', '취소 뒤 포커스가 검색 입력창으로 돌아온다');
    assert.equal(await box(page).inputValue(), '알파', '입력한 검색어 보존');
    assert.deepEqual([afterEnter.start, afterEnter.end], [afterEnter.len, afterEnter.len], '캐럿은 입력 끝이다');
    assert.equal((await barrier(app)).arrived.length, 1, '취소만으로 자동 검색·새 검색을 시작하지 않는다');
    // 바로 고쳐 재검색: 실제 키 입력
    await page.keyboard.type(' 하');
    assert.equal(await box(page).inputValue(), '알파 하');
    await page.keyboard.press('Enter');
    await until(app, '재검색 응답', (b) => count(b.answered, '알파 하') === 1);
    await resultsList(page).waitFor();
    await release(app, '알파');
    await until(app, '옛 응답', (b) => count(b.answered, '알파') === 1);
    await settled(page);
    assert.ok((await page.locator('.search-summary').first().innerText()).includes('"알파 하"'), '늦은 옛 응답이 새 결과를 덮지 않았다');
    await box(page).press('Escape');

    // 2) Space: 붙잡힌 감마 요청을 취소한 뒤 풀어 응답까지 확인한다
    await setHold(app, '감마', 'ok');
    await submit(page, '감마');
    await until(app, '감마 도착', (b) => count(b.arrived, '감마') === 1);
    await page.keyboard.press('Tab');
    assert.equal((await active()).label, '검색 취소');
    await page.keyboard.press('Space');
    await assertBackToList(page, 'Space 취소 뒤', app);
    assert.equal((await active()).label, '원고 검색', 'Space 취소 뒤에도 포커스가 검색 입력창이다');
    assert.equal(await box(page).inputValue(), '감마');
    await release(app, '감마');
    await until(app, '감마 응답', (b) => count(b.answered, '감마') === 1);
    await settled(page);
    await assertBackToList(page, 'Space 취소 후 늦은 응답 뒤', app);
    assert.equal((await active()).label, '원고 검색', '늦은 응답이 포커스를 바꾸지 않았다');

    // 3) 포인터 취소도 검색 입력창으로 돌아온다
    await setHold(app, '베타', 'ok');
    await submit(page, '베타');
    await until(app, '베타 도착', (b) => count(b.arrived, '베타') === 1);
    await cancelButton(page).click();
    await assertBackToList(page, '포인터 취소 뒤', app);
    assert.equal((await active()).label, '원고 검색', '포인터 취소 뒤에도 검색 입력창으로 돌아온다');
    await release(app, '베타');
    await until(app, '베타 응답', (b) => count(b.answered, '베타') === 1);
    await settled(page);
    await assertBackToList(page, '포인터 취소 후 늦은 응답 뒤', app);

    // 4) 취소 뒤 편집기로 옮겼다면 늦은 응답이 포커스를 검색창으로 가져가지 않는다
    await setHold(app, '알파', 'ok');
    await submit(page, '알파');
    await until(app, '알파 재도착', (b) => count(b.arrived, '알파') === 2);
    await cancelButton(page).click();
    await assertBackToList(page, '편집기 이동 전 취소 뒤', app);
    await page.locator('.ProseMirror').getByText('알파 하나').click(); // 사용자가 편집기로 옮겼다
    assert.equal((await active()).inEditor, true);
    await release(app, '알파');
    await until(app, '늦은 알파 응답', (b) => count(b.answered, '알파') === 2);
    await settled(page);
    assert.equal((await active()).inEditor, true, '늦은 응답이 포커스를 검색 입력창으로 가져가지 않았다');

    // 모든 지연 요청이 풀리고 응답됐다
    const done = await barrier(app);
    assert.equal(Object.values(done.resolvers).flat().length, 0, '붙잡힌 요청이 남지 않았다');
    assert.equal(done.arrived.length, done.answered.length, '도착한 모든 검색이 응답을 마쳤다');

    // 읽기만 하는 시나리오: 저장 요청 0, 원고 바이트 불변
    assert.equal((await barrier(app)).writes, 0, '읽기 전용 시나리오에서 chapter:write는 0이었다');
    const after = await Promise.all(['001.md', '002.md'].map((f) => readFile(join(dir, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await release(app, '알파').catch(() => undefined);
    await release(app, '감마').catch(() => undefined);
    await release(app, '베타').catch(() => undefined);
    await closeWindow(app);
  }
});
