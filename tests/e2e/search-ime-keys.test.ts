// 원고 검색창의 한글 조합 중 키: 조합 중 Escape는 앱의 clear()(검색어·결과·진행 요청 지우기)가 아니고, 조합을 확정하는 Enter는 검색(저장 전 flush·검색 IPC)을 시작하지 않으며,
// 조합이 끝난 뒤의 일반 Escape/Enter는 기존처럼 지우기/검색이다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapters:search를 요청별 장벽(도착 기록·hold/release)으로 감싸고 chapter:write 호출 수를 센다.
// 조합은 Playwright의 CDP `Input.imeSetComposition`(Chromium 입력 경로)으로 만든다: 합성 DOM 이벤트(dispatchEvent)가 아니라 실제 SearchPanel handler가 받는 조합 상태다.
// 실제 OS IME(한글 입력기)·수동 GUI 확인이 아니다. 유료·외부 호출 없음. 원고 Buffer는 그대로여야 한다.

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
  holds: Record<string, { release?: () => void }>;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], writes: 0, holds: {} };
    const search = map.get('chapters:search')!;
    ipcMain.removeHandler('chapters:search');
    ipcMain.handle('chapters:search', async (...args: unknown[]) => {
      const q = args[1] as string;
      const b = g.barrier;
      b.arrived.push(q);
      const hold = b.holds[q];
      if (hold) await new Promise<void>((resolve) => (hold.release = resolve));
      try {
        return await search(...args);
      } finally {
        b.answered.push(q);
      }
    });
    const write = map.get('chapter:write')!;
    ipcMain.removeHandler('chapter:write');
    ipcMain.handle('chapter:write', async (...args: unknown[]) => {
      g.barrier.writes += 1;
      return write(...args);
    });
  });
const setHold = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => void ((globalThis as unknown as { barrier: Barrier }).barrier.holds[q] = {}), q);
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => (globalThis as unknown as { barrier: Barrier }).barrier.holds[q]?.release?.(), q);
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
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const chapterButton = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
test('조합 중 Escape·Enter는 검색어·결과·진행 요청을 지우거나 검색을 시작하지 않고, 조합이 끝난 뒤 일반 Escape/Enter는 기존대로 동작한다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('search-ime');
  await mkdir(join(dir, 'chapters'));
  const files = ['001.md', '002.md'];
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const originals = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('search-ime-ud'));
  try {
    const cdp = await page.context().newCDPSession(page);
    const ime = (text: string) => cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await chapterButton(page, 'ONE').waitFor();

    // 1) 검색 요청을 붙잡아 진행 중으로 두고, 조합 중 Escape: 검색어·진행 요청이 그대로다
    await setHold(app, '알파');
    await box(page).fill('알파');
    await box(page).press('Enter');
    await until(app, '첫 검색 도착', (b) => b.arrived.length === 1);
    await ime('감');
    await page.keyboard.press('Escape');
    await settled(page);
    assert.ok((await box(page).inputValue()).startsWith('알파'), '조합 중 Escape가 확정한 검색어를 지우지 않았다 (type=search의 기본 Escape 전체 삭제도 없다)');
    await release(app, '알파');
    await until(app, '첫 검색 응답', (b) => b.answered.length === 1);
    await resultsList(page).waitFor({ timeout: 5000 }); // 앱의 clear()가 진행 요청을 무효화하지 않아 결과가 게시된다
    assert.equal((await barrier(app)).arrived.length, 1);

    // 2) 결과가 있는 상태에서 조합 중 Escape: 결과·검색어가 그대로이고 화 목록으로 돌아가지 않는다
    await box(page).fill('알파');
    await ime('감');
    await page.keyboard.press('Escape');
    await settled(page);
    assert.equal(await resultsList(page).count(), 1, '조합 중 Escape가 결과를 지우지 않았다');
    assert.ok((await box(page).inputValue()).startsWith('알파'), '검색어 보존');
    assert.equal(await page.getByText('목록으로').count(), 1, '결과 화면에서 화 목록으로 돌아가지 않았다');

    // 3) 조합 중 Enter: 검색(저장 전 flush·검색 IPC)을 시작하지 않는다
    await ime('감');
    await page.keyboard.press('Enter');
    await settled(page);
    const afterComposedEnter = await barrier(app);
    assert.equal(afterComposedEnter.arrived.length, 1, '조합 중 Enter가 검색 요청을 만들지 않았다');
    assert.equal(afterComposedEnter.writes, 0, '조합 중 Enter가 저장 요청을 만들지 않았다');

    // 4) 조합이 끝난 뒤 일반 Enter: 정상 검색 (영구 차단되지 않는다)
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); // 남은 조합을 끝낸다
    await box(page).fill('감마');
    await box(page).press('Enter');
    await until(app, '조합 뒤 검색 응답', (b) => b.answered.includes('감마'));
    await resultsList(page).waitFor();
    assert.ok((await resultsList(page).innerText()).includes('감마 둘'), '조합이 끝난 뒤 일반 Enter의 검색 결과');
    assert.equal((await barrier(app)).arrived.filter((q) => q === '감마').length, 1);

    // 5) 조합이 끝난 뒤 일반 Escape: 검색어·결과를 지우고 화 목록으로 돌아간다
    await box(page).press('Escape');
    await settled(page);
    assert.equal(await box(page).inputValue(), '', '일반 Escape는 검색어를 지운다');
    assert.equal(await resultsList(page).count(), 0, '일반 Escape는 결과를 지운다');
    await chapterButton(page, 'ONE').waitFor();

    const after = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await release(app, '알파').catch(() => undefined);
    await closeWindow(app);
  }
});

// form submit 조합 가드: Chromium이 조합 확정 Enter에서 submit을 만들지 않으면 위 Enter 사례만으로는 onSubmit 가드가 검증되지 않는다.
// 그래서 실제 form.requestSubmit()으로 submit 이벤트를 명시 발생시키고, 조합 상태(실제 CDP 조합 → compositionstart~end, 또는 keyCode 229 keydown)가 실제 SearchPanel handler에 전달된 뒤의 결과를 본다.
// beforeSearch(저장 전 flush) 진입은 편집기를 미저장으로 두고(이 검사 안에서만 1500ms 자동 저장 타이머를 가로챔) chapter:write 호출 수로 관측한다: 진입했다면 미저장 본문이 쓰여 1이 된다.
// 합성 submit·합성 229 keydown이며 실제 OS IME의 Enter 조기 검색은 확인하지 않았다.
test('조합 상태에서 form submit이 오면 저장 전 flush·검색 IPC를 시작하지 않고, 조합이 끝나 일반 키 뒤에는 정상 검색한다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('search-ime-submit');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir('search-ime-submit-ud'));
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
    // 편집기를 미저장으로 둔다: 저장 전 flush에 진입하면 이 본문이 쓰인다
    await page.locator('.ProseMirror').getByText('알파 하나').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    const cdp = await page.context().newCDPSession(page);
    const submit = () => page.evaluate(() => (document.querySelector('form[role="search"]') as HTMLFormElement).requestSubmit());

    // A) 실제 조합 중(compositionstart~end)의 submit
    await box(page).fill('알파');
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    await submit();
    await settled(page);
    let b = await barrier(app);
    assert.equal(b.arrived.length, 0, '조합 중 submit이 검색 IPC를 시작하지 않았다');
    assert.equal(b.writes, 0, '조합 중 submit이 저장 전 flush(미저장 본문 쓰기)에 들어가지 않았다');
    await page.keyboard.insertText('마'); // 조합 확정 (compositionend)

    // B) 조합은 끝났지만 IME가 처리한 키(keyCode 229) 직후의 submit
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Process', code: 'Enter' });
    await submit();
    await settled(page);
    b = await barrier(app);
    assert.equal(b.arrived.length, 0, '229 키 직후 submit이 검색 IPC를 시작하지 않았다');
    assert.equal(b.writes, 0, '229 키 직후 submit이 저장 전 flush에 들어가지 않았다');

    // C) 일반 키 뒤의 submit: 정상 검색 (영구 차단되지 않는다). 저장 전 flush가 미저장 본문을 쓴다
    await box(page).fill('알파');
    await box(page).press('End');
    await submit();
    await until(app, '정상 검색 응답', (x) => x.answered.length === 1);
    await resultsList(page).waitFor();
    b = await barrier(app);
    assert.equal(b.arrived.length, 1, '조합이 끝난 뒤 일반 submit은 검색한다');
    assert.equal(b.writes, 1, '정상 검색은 저장 전 flush로 미저장 본문을 먼저 저장한다 (위의 0과 구분되는 관측)');
  } finally {
    await closeWindow(app);
  }
});
