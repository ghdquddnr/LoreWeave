// 원고 검색 결과의 [목록으로]를 실제 키보드(Tab → Enter/Space)로 실행할 때, 버튼이 사라져도 포커스가 BODY로 사라지지 않고 검색입력으로 남아 바로 실제 키보드로 새 검색을 할 수 있다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. chapters:search는 호출 수만 세고 실제 검색에 위임하며, chapter:write 호출 수·원고 바이트·AI 실행(ai:analyze) 진입을 센다. 시작점(검색창 DOM focus)과 실제 키보드 경로(Tab·Enter/Space·타자)를 구분한다.
// [목록으로]가 실제 포커스를 가진 때만 검색입력으로 옮기며, 공유 clear 경로(Escape·빈 검색 등)는 포커스를 건드리지 않는다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. 실원고·실키·AI·유료·외부 호출 0.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const ONE = `${envelope('one', 'ONE')}알파 하나\r\n\r\n베타 하나\r\n`;
const TWO = `${envelope('two', 'TWO')}알파 둘\r\n\r\n감마 둘\r\n`;

interface Counts { searches: string[]; writes: number; analyzes: number }
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { cnt: Counts };
    g.cnt = { searches: [], writes: 0, analyzes: 0 };
    for (const [channel, kind] of [['chapters:search', 's'], ['chapter:write', 'w'], ['ai:analyze', 'a']] as const) {
      const original = map.get(channel)!;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args: unknown[]) => {
        if (kind === 's') g.cnt.searches.push(String(args[1]));
        else if (kind === 'w') g.cnt.writes += 1;
        else g.cnt.analyzes += 1;
        return original(...args);
      });
    }
  });
const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { cnt: Counts }).cnt);
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const resultsList = (page: Page) => page.getByRole('list', { name: '검색 결과' });
const back = (page: Page) => page.getByRole('button', { name: '목록으로', exact: true });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', tag: el?.tagName ?? '' };
  });

for (const press of ['Enter', 'Space'] as const) {
  test(`검색 결과의 [목록으로]를 실제 Tab·${press}로 실행해도 포커스가 BODY로 사라지지 않고 바로 실제 키보드로 새 검색을 할 수 있다`, { timeout: 90_000 }, async () => {
    const dir = await tempDir(`search-back-focus-${press}`);
    await mkdir(join(dir, 'chapters'));
    const p1 = join(dir, 'chapters', '001.md');
    const p2 = join(dir, 'chapters', '002.md');
    await writeFile(p1, ONE);
    await writeFile(p2, TWO);
    const { app, page } = await launch(await tempDir(`search-back-focus-${press}-ud`));
    try {
      await stubFolderDialog(app, dir);
      await hook(app);
      await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
      await box(page).waitFor();
      await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 6) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
      await box(page).fill('알파'); // 시작점만 입력 (DOM focus)
      await page.keyboard.press('Enter');
      await resultsList(page).waitFor();
      await until(async () => (await counts(app)).searches.length === 1, '검색 호출 1회');
      await box(page).focus();
      // 실제 Tab으로 [목록으로]까지 (결과 요약은 입력창 다음 컨트롤)
      for (let i = 0; i < 4 && (await active(page)).label !== '목록으로'; i += 1) await page.keyboard.press('Tab');
      assert.equal((await active(page)).label, '목록으로', '실제 Tab으로 [목록으로]에 도달했다');
      await page.keyboard.press(press);
      await resultsList(page).waitFor({ state: 'detached' });
      await frames(page);
      const after = await active(page);
      console.log(`계측 ${press} 목록복귀 뒤 active=${JSON.stringify(after)} 검색어=${(await box(page).inputValue()).length}자 log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(after.body, false, `[목록으로] 뒤 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(after)}`);
      assert.equal(after.label, '원고 검색', '포커스가 검색입력에 있다');
      assert.equal(await box(page).inputValue(), '', '검색어가 비워졌다');
      assert.equal(await back(page).count(), 0, '결과 요약이 사라졌다');
      // 바로 실제 키보드로 새 검색
      await page.keyboard.type('감마');
      await page.keyboard.press('Enter');
      await resultsList(page).waitFor();
      await until(async () => (await counts(app)).searches.length === 2, '새 검색 호출 1회');
      assert.deepEqual((await counts(app)).searches, ['알파', '감마'], '새 검색이 정확히 한 번');
      const end = await counts(app);
      assert.equal(end.writes, 0, '불필요한 chapter:write 0');
      assert.equal(end.analyzes, 0, 'AI 실행 진입 0');
      assert.ok((await readFile(p1, 'utf8')) === ONE && (await readFile(p2, 'utf8')) === TWO, '합성 원고 바이트 불변');
    } finally {
      await closeWindow(app);
    }
  });
}

test('검색입력에서 Escape로 지우는 공유 clear 경로는 포커스를 옮기지 않는다 (입력창에 그대로)', { timeout: 90_000 }, async () => {
  const dir = await tempDir('search-back-focus-esc');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const { app, page } = await launch(await tempDir('search-back-focus-esc-ud'));
  try {
    await stubFolderDialog(app, dir);
    await hook(app);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await box(page).waitFor();
    await box(page).fill('알파');
    await page.keyboard.press('Enter');
    await resultsList(page).waitFor();
    await box(page).focus();
    await page.keyboard.press('Escape');
    await resultsList(page).waitFor({ state: 'detached' });
    await frames(page);
    assert.equal((await active(page)).label, '원고 검색', 'Escape clear 뒤에도 포커스는 검색입력(이동 없음)');
    assert.equal((await counts(app)).writes, 0);
  } finally {
    await closeWindow(app);
  }
});
