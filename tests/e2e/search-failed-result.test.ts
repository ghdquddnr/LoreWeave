// 새 검색(B)이 최신 요청으로 실패했을 때, 앞의 성공 검색(A)의 카드·개수·"없음" 안내가 B의 결과처럼 되살아나지 않는다.
// 정책: 최신 검색 요청이 실패하면 이전 결과를 지우고 화 목록으로 돌아가며, 입력한 검색어와 실패 안내는 남긴다. 같은 검색어로 Enter를 다시 누르면 새 요청이 나가고 성공하면 그 결과만 보인다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapters:search를 요청별 장벽(hold → release로 정상 응답 또는 거절)으로 감싼다. 대기 시간이 아니라 도착·응답 기록과 두 프레임 렌더 barrier로 맞춘다.
// 합성 Electron 검사이며 수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음 (AI 서버·키를 설정하지 않는다).
// 관측 범위: onResultShown(성공 게시 통지)은 renderer 내부 신호라 직접 관측하지 않고, 실패 뒤 결과·안내·목록 화면으로만 판정한다.

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
  holds: Record<string, { mode: 'ok' | 'fail'; release?: () => void }>;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], holds: {} };
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
  });
const setHold = (app: ElectronApplication, q: string, mode: 'ok' | 'fail') =>
  app.evaluate((_e, a) => void ((globalThis as unknown as { barrier: Barrier }).barrier.holds[a.q] = { mode: a.mode }), { q, mode });
const clearHold = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => void delete (globalThis as unknown as { barrier: Barrier }).barrier.holds[q], q);
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => (globalThis as unknown as { barrier: Barrier }).barrier.holds[q]?.release?.(), q);
const barrier = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { barrier: Barrier }).barrier);
const count = (list: string[], q: string) => list.filter((x) => x === q).length;
async function until(app: ElectronApplication, ok: (b: Barrier) => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const b = await barrier(app);
    if (ok(b)) return b;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const summary = (page: Page) => page.locator('.search-summary');
const errorNote = (page: Page) => page.locator('.error.search-summary');
const chapterButton = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

test('새 검색이 실패하면 앞의 검색 결과(찾음·없음)를 되살리지 않고 화 목록·검색어·실패 안내를 보이며, 같은 검색어로 다시 검색하면 그 결과만 보인다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('search-failed-result');
  await mkdir(join(dir, 'chapters'));
  const files = ['001.md', '002.md'];
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const originals = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('search-failed-result-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();
    await chapterButton(page, 'ONE').waitFor();

    // 1) A(찾음) 성공
    await submit(page, '알파');
    await resultsList(page).waitFor();
    await summary(page).getByText('줄에서 찾음', { exact: false }).waitFor();
    assert.equal(await errorNote(page).count(), 0);

    // 2) B 검색이 최신 요청으로 실패한다 (요청을 붙잡았다가 거절)
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, (b) => count(b.arrived, '감마') === 1, 'B 도착');
    await release(app, '감마');
    await until(app, (b) => count(b.answered, '감마') === 1, 'B 응답');
    await errorNote(page).waitFor();
    await settled(page);
    assert.equal(await resultsList(page).count(), 0, 'A의 카드가 B 입력 아래 다시 나타나지 않는다');
    assert.equal(await page.getByText('줄에서 찾음', { exact: false }).count(), 0, 'A의 개수 안내가 남지 않는다');
    assert.equal(await page.getByText('목록으로').count(), 0, '결과 화면이 아니다');
    await chapterButton(page, 'ONE').waitFor(); // 화 목록으로 돌아왔다
    assert.equal(await box(page).inputValue(), '감마', '입력한 검색어는 남는다');
    assert.equal(await page.getByText('없음', { exact: false }).count(), 0, '실패를 0건 성공으로 표현하지 않는다');

    // 3) 같은 검색어로 Enter 재시도 → B 결과만 보이고 오류는 사라진다
    await clearHold(app, '감마');
    await box(page).press('Enter');
    await until(app, (b) => count(b.answered, '감마') === 2, 'B 재시도 응답');
    await resultsList(page).waitFor();
    assert.equal(await errorNote(page).count(), 0, '성공하면 이전 오류가 사라진다');
    const text = await resultsList(page).innerText();
    assert.ok(text.includes('감마 둘'), 'B의 결과');
    assert.ok(!text.includes('알파') && !text.includes('베타'), 'A의 결과가 섞이지 않는다');

    // 4) A가 0건("없음")이었던 경계: 그 안내가 B의 실패 결과로 남지 않는다
    await submit(page, '없는말');
    await summary(page).getByText('"없는말" 없음', { exact: false }).waitFor();
    await setHold(app, '감마', 'fail');
    await submit(page, '감마');
    await until(app, (b) => count(b.arrived, '감마') === 3, '두 번째 B 도착');
    await release(app, '감마');
    await until(app, (b) => count(b.answered, '감마') === 3, '두 번째 B 응답');
    await errorNote(page).waitFor();
    await settled(page);
    assert.equal(await page.getByText('"없는말" 없음', { exact: false }).count(), 0, '과거 없음 안내가 B 실패 뒤에 남지 않는다');
    assert.equal(await resultsList(page).count(), 0);
    assert.equal(await box(page).inputValue(), '감마');
    await chapterButton(page, 'ONE').waitFor();

    // 원고는 그대로다 (검색은 읽기 전용)
    const after = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await release(app, '감마').catch(() => undefined);
    await closeWindow(app);
  }
});
