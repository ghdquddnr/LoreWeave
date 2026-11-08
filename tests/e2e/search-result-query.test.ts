// 검색 결과 요약이 실제로 게시된 결과의 검색어(result.query)를 보이는지 본다: 입력만 바꿔도 표시된 결과의 검색어는 바뀌지 않고, 새 검색이 성공했을 때만 바뀐다. 입력창의 현재 글자를 쓰지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapters:search를 요청별 장벽(도착·응답 기록, hold/release)으로 감싸고 chapter:write 호출 수를 센다 (읽기만 하는 시나리오라 0이어야 한다).
// 합성 Electron 검사이며 수동 GUI 확인이 아니다. 유료·외부 호출 없음. 원고 Buffer는 그대로여야 한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const ONE = `${envelope('one', 'ONE')}알파 하나\r\n\r\n베타 하나\r\n`;
const TWO = `${envelope('two', 'TWO')}알파 둘\r\n\r\n감마 둘\r\n`;
// 검색 결과 상한(500줄)을 넘기는 합성 화
const MANY = `${envelope('many', 'MANY')}${Array.from({ length: 520 }, (_, i) => `많은말 ${i}`).join('\r\n\r\n')}\r\n`;

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
const summary = (page: Page) => page.locator('.search-summary').first();
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};
const summaryText = async (page: Page) => (await summary(page).innerText()).replace(/\s+/g, ' ').trim();

test('검색 요약은 게시된 결과의 검색어를 보인다: 입력만 바꿔도 그대로, 새 검색이 성공해야 바뀌고, 늦은 이전 응답이 덮지 않으며, 0건·상한·긴 검색어도 안전하다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('search-result-query');
  await mkdir(join(dir, 'chapters'));
  const files = ['001.md', '002.md', '003.md'];
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  await writeFile(join(dir, 'chapters', '003.md'), MANY);
  const originals = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('search-result-query-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();

    // 1) A 성공: 요약에 검색어와 줄 수
    await submit(page, '알파');
    await page.getByRole('list', { name: '검색 결과' }).waitFor();
    assert.match(await summaryText(page), /^"알파" 2줄에서 찾음/);

    // 2) 입력만 B로 수정: 표시된 결과의 검색어(A)는 그대로이고 자동 검색도 없다
    await box(page).fill('감마');
    await settled(page);
    assert.match(await summaryText(page), /^"알파" 2줄에서 찾음/, '입력만 바꿔도 요약의 검색어는 게시된 결과의 검색어다');
    assert.deepEqual((await barrier(app)).arrived, ['알파'], '입력 변경만으로 자동 검색하지 않는다');
    assert.ok((await page.getByRole('list', { name: '검색 결과' }).innerText()).includes('알파'), '결과는 그대로다');

    // 3) B 새 검색 성공: 요약·결과가 B
    await box(page).press('Enter');
    await until(app, 'B 응답', (b) => b.answered.includes('감마'));
    await page.getByText('"감마" 1줄에서 찾음', { exact: false }).waitFor();
    assert.ok((await page.getByRole('list', { name: '검색 결과' }).innerText()).includes('감마 둘'));

    // 4) 늦은 이전 응답: A를 붙잡은 채 B를 검색하고 B가 게시된 뒤 A가 늦게 도착해도 B의 요약이 유지된다
    await setHold(app, '베타');
    await submit(page, '베타');
    await until(app, '늦은 A 도착', (b) => b.arrived.includes('베타'));
    await submit(page, '감마');
    await until(app, '새 B 응답', (b) => b.answered.filter((q) => q === '감마').length === 2);
    await page.getByText('"감마" 1줄에서 찾음', { exact: false }).waitFor();
    await release(app, '베타'); // 늦게 도착
    await until(app, '늦은 응답 처리', (b) => b.answered.includes('베타'));
    await settled(page);
    assert.match(await summaryText(page), /^"감마" 1줄에서 찾음/, '늦은 이전 응답이 최신 검색의 요약을 덮지 않았다');
    assert.equal(await page.getByText('"베타"', { exact: false }).count(), 0);

    // 5) 0건과 상한(처음 500줄) 요약
    await submit(page, '원고에 없는 말');
    await page.getByText('"원고에 없는 말" 없음', { exact: false }).waitFor();
    await submit(page, '많은말');
    await page.getByText('"많은말" 520줄에서 찾음 (처음 500줄)', { exact: false }).waitFor();

    // 6) 긴 검색어·따옴표·특수문자: 글자 그대로 보이고 HTML로 해석되지 않으며, 좁은 사이드바에서 넘치지 않고 [목록으로]에 닿을 수 있다
    const nasty = `<b>"x"&amp;</b>${'가'.repeat(120)}`;
    await submit(page, nasty);
    await page.getByRole('button', { name: '목록으로' }).waitFor();
    const text = await summaryText(page);
    assert.ok(text.includes('<b>"x"&amp;</b>'), '특수문자는 글자 그대로 보인다');
    assert.equal(await page.locator('.search-summary b').count(), 0, '검색어가 HTML로 해석되지 않는다');
    const geometry = await page.evaluate(() => {
      const side = document.querySelector('.sidebar')!.getBoundingClientRect();
      const btn = [...document.querySelectorAll('.search-summary button')].find((b) => b.textContent === '목록으로')!.getBoundingClientRect();
      return { overflowX: document.documentElement.scrollWidth > window.innerWidth, btnInside: btn.right <= side.right + 1 && btn.left >= side.left - 1, btnVisible: btn.width > 0 && btn.height > 0 };
    });
    assert.equal(geometry.overflowX, false, '가로 스크롤이 생기지 않았다');
    assert.ok(geometry.btnInside && geometry.btnVisible, '[목록으로]가 사이드바 안에서 보인다');
    await page.getByRole('button', { name: '목록으로' }).click();
    await box(page).waitFor();

    // 읽기만 하는 시나리오: 원고는 그대로이고 저장 요청은 없다
    assert.equal((await barrier(app)).writes, 0, '검색은 chapter:write를 만들지 않았다');
    const after = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await release(app, '베타').catch(() => undefined);
    await closeWindow(app);
  }
});
