// 검색 요청(chapters:search) 실패 안내: 짧은 한국어 기본 안내(읽기 실패이므로 쓰기·저장 실패로 설명하지 않는다)와 기본 접힘 기술 상세(원문 보존). 상세 열기/닫기는 IPC를 만들지 않고, 새 실패·취소·늦은 실패가 상세를 되살리거나 승계하지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapters:search를 요청별 장벽(다음 도착 요청 하나만 붙잡고 resolvers에 쌓아 명시 해제, 거절 종류 선택)으로, chapter:write를 호출 수 대역으로 감싼다.
// 합성 Electron 검사이며 수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `\uFEFF---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const ONE = `${envelope('one', 'ONE')}알파 하나\r\n\r\n베타 하나\r\n`;
const TWO = `${envelope('two', 'TWO')}알파 둘\r\n\r\n감마 둘\r\n`;

type Mode = 'ok' | 'fail-path' | 'fail-ko';
interface Barrier {
  arrived: string[];
  answered: string[];
  writes: number;
  /** 다음에 도착하는 q 요청 하나만 붙잡는다 */
  holds: Record<string, { mode: Mode }>;
  resolvers: Record<string, (() => void)[]>;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { barrier: Barrier };
    g.barrier = { arrived: [], answered: [], writes: 0, holds: {}, resolvers: {} };
    const search = map.get('chapters:search')!;
    ipcMain.removeHandler('chapters:search');
    ipcMain.handle('chapters:search', async (...args: unknown[]) => {
      const q = args[1] as string;
      const b = g.barrier;
      b.arrived.push(q);
      const hold = b.holds[q];
      if (hold) {
        delete b.holds[q];
        await new Promise<void>((resolve) => (b.resolvers[q] ??= []).push(resolve));
      }
      try {
        if (hold?.mode === 'fail-path') throw new Error("EACCES: permission denied, open 'C:/Users/synthetic/index/search.db'");
        if (hold?.mode === 'fail-ko') throw new Error('색인을 읽을 수 없습니다');
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
const setHold = (app: ElectronApplication, q: string, mode: Mode) =>
  app.evaluate((_e, a) => void ((globalThis as unknown as { barrier: Barrier }).barrier.holds[a.q] = { mode: a.mode }), { q, mode });
/** 붙잡힌 q 요청을 모두 푼다 */
const release = (app: ElectronApplication, q: string) => app.evaluate((_e, q) => void ((globalThis as unknown as { barrier: Barrier }).barrier.resolvers[q] ?? []).splice(0).forEach((r) => r()), q);
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
const errorNote = (page: Page) => page.locator('.error.search-summary');
const detailButton = (page: Page) => errorNote(page).getByRole('button', { name: /^(기술 상세|상세 닫기)$/ });
const retryButton = (page: Page) => page.locator('.search').getByRole('button', { name: '다시 검색', exact: true });
const cancelButton = (page: Page) => page.locator('.search').getByRole('button', { name: '검색 취소', exact: true });
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const submit = async (page: Page, q: string) => {
  await box(page).fill(q);
  await box(page).press('Enter');
};

test('검색 요청 실패: 읽기 실패로 안내하고 원문은 접힌 기술 상세에만 있으며, 상세 조작은 IPC가 없고, 새 실패·성공·취소·늦은 실패가 상세를 승계하거나 되살리지 않는다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('search-error-detail');
  await mkdir(join(dir, 'chapters'));
  const files = ['001.md', '002.md'];
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const originals = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('search-error-detail-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').waitFor();

    // 1) 경로 포함 EACCES 검색 실패: 기본 안내는 읽기 실패, 기술 문구 없음, 상세는 접힘
    await setHold(app, '감마', 'fail-path');
    await submit(page, '감마');
    await until(app, '첫 검색 도착', (b) => count(b.arrived, '감마') === 1);
    await release(app, '감마');
    await until(app, '첫 실패 응답', (b) => count(b.answered, '감마') === 1);
    await retryButton(page).waitFor();
    const text = await errorNote(page).innerText();
    assert.match(text, /검색하지 못했습니다: .*읽을 수 없습니다/, '읽기 실패로 안내한다');
    for (const raw of ['Error invoking', 'EACCES', 'permission denied', 'C:/Users', 'synthetic', 'search.db']) assert.ok(!text.includes(raw), `기본 안내에 기술 문구(${raw})가 없다`);
    for (const wrong of ['쓸 수 없습니다', '저장', '쓰기']) assert.ok(!text.includes(wrong), `읽기 실패를 쓰기·저장 실패(${wrong})로 설명하지 않는다`);
    assert.equal(await page.locator('.tech-detail').count(), 0, '기술 상세는 기본으로 접혀 있다');

    // 2) 상세 열기/닫기: 원문 보존, flush·검색·읽기·쓰기 IPC 0
    const before = await barrier(app);
    await detailButton(page).click();
    const detail = await page.locator('.tech-detail').innerText();
    for (const raw of ['Error invoking', 'EACCES', 'permission denied', "C:/Users/synthetic/index/search.db"]) assert.ok(detail.includes(raw), `기술 상세에 원문(${raw})이 보존된다`);
    await detailButton(page).click();
    assert.equal(await page.locator('.tech-detail').count(), 0);
    await detailButton(page).click(); // 열린 채로 다음 단계로 간다
    await settled(page);
    const afterToggle = await barrier(app);
    assert.equal(afterToggle.arrived.length, before.arrived.length, '상세 열기·닫기는 검색 IPC를 만들지 않는다');
    assert.equal(afterToggle.writes, before.writes, '상세 열기·닫기는 저장(flush) IPC를 만들지 않는다');

    // 3) 상세를 연 채 [다시 검색]이 다시 실패: 새 실패의 상세는 접힌 채 시작한다
    await setHold(app, '감마', 'fail-path');
    await retryButton(page).click();
    await until(app, '재시도 도착', (b) => count(b.arrived, '감마') === 2);
    await release(app, '감마');
    await until(app, '재시도 실패 응답', (b) => count(b.answered, '감마') === 2);
    await retryButton(page).waitFor();
    assert.equal(await page.locator('.tech-detail').count(), 0, '새 실패의 기술 상세는 접힌 채 시작한다');

    // 4) 상세를 다시 연 채 새 검색이 성공: 안내·상세가 모두 사라지고 그 결과만 보인다
    await detailButton(page).click();
    assert.equal(await page.locator('.tech-detail').count(), 1);
    await submit(page, '알파');
    await resultsList(page).waitFor();
    assert.equal(await errorNote(page).count(), 0, '성공하면 실패 안내가 사라진다');
    assert.equal(await page.locator('.tech-detail').count(), 0, '성공하면 기술 상세도 사라진다');

    // 5) 취소·늦은 실패: 취소한 검색의 늦은 실패가 안내·상세를 되살리지 않는다
    await box(page).press('Escape');
    await setHold(app, '감마', 'fail-path');
    await submit(page, '감마');
    await until(app, '세 번째 도착', (b) => count(b.arrived, '감마') === 3);
    await cancelButton(page).click();
    await release(app, '감마'); // 늦은 실패
    await until(app, '늦은 실패 응답', (b) => count(b.answered, '감마') === 3);
    await settled(page);
    assert.equal(await errorNote(page).count(), 0, '취소한 검색의 늦은 실패가 안내를 되살리지 않는다');
    assert.equal(await page.locator('.tech-detail').count(), 0, '상세도 되살리지 않는다');
    await box(page).press('Escape');

    // 6) 한국어로 충분한 오류: 기본 안내가 그 의미를 그대로 보이고, 상세가 있다면 비어 있지 않다
    await setHold(app, '베타', 'fail-ko');
    await submit(page, '베타');
    await until(app, '베타 도착', (b) => count(b.arrived, '베타') === 1);
    await release(app, '베타');
    await retryButton(page).waitFor();
    assert.match(await errorNote(page).innerText(), /검색하지 못했습니다: 색인을 읽을 수 없습니다/);
    // IPC로 도착한 오류는 Electron 접두사가 붙은 원문이 있어 기술 상세가 생긴다 (기본 안내는 한국어 의미 그대로). 상세 버튼이 있다면 비어 있지 않아야 한다
    if ((await detailButton(page).count()) > 0) {
      await detailButton(page).click();
      assert.ok((await page.locator('.tech-detail').innerText()).includes('색인을 읽을 수 없습니다'), '상세는 비어 있지 않고 원문을 보존한다');
      await detailButton(page).click();
    }

    // 모든 지연 요청이 풀렸고, 읽기만 하는 시나리오라 저장 0·원고 불변
    const done = await barrier(app);
    assert.equal(Object.values(done.resolvers).flat().length, 0, '붙잡힌 요청이 남지 않았다');
    assert.equal(done.arrived.length, done.answered.length, '도착한 모든 검색이 응답을 마쳤다');
    assert.equal(done.writes, 0, '검색은 chapter:write를 만들지 않았다');
    const after = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    for (const q of ['감마', '베타']) await release(app, q).catch(() => undefined);
    await closeWindow(app);
  }
});
