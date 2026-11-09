// 검색 진행 중 [검색 취소] 버튼을 실제 Tab으로 선택한 채 응답이 완료될 때의 포커스 (성공·실패) — 선택해 둔 취소 버튼이 완료로 사라져도 포커스가 BODY로 잃어지지 않는다. (원래 주석: 검색어·실패 안내·화 목록과 함께 버튼을 보이고, 누르면 그 순간 입력창의 검색어로 기존 search()(저장 전 flush → 검색) 경로를 다시 지난다.
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
  for (let i = 0; i < 100; i += 1) {
    if (ok(await barrier(app))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${what} 상태가 되지 않았다`);
}
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '' };
  });
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

async function start(prefix: string, mode: 'ok' | 'fail') {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await hook(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('알파 하나').waitFor();
  await page.evaluate(`(() => { window.__f = []; const nm = (e) => e.tagName + (e.getAttribute && e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : '') + (e.tagName === 'BUTTON' && e.textContent ? '{' + e.textContent.slice(0, 8) + '}' : ''); document.addEventListener('focusin', (e) => window.__f.push('in ' + nm(e.target)), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + nm(e.target)), true); })()`);
  const box = page.getByRole('searchbox', { name: '원고 검색' });
  await setHold(app, '알파', mode);
  await box.fill('알파');
  await box.press('Enter'); // 실제 Enter로 검색 시작 (응답은 장벽에서 대기)
  await until(app, '검색 도착', (b) => count(b.arrived, '알파') === 1);
  await page.getByRole('button', { name: '검색 취소', exact: true }).waitFor();
  // 실제 Tab으로 검색 취소 버튼을 고른다 (검색창 포커스는 시작점 설정에만 쓴다)
  await box.focus();
  for (let i = 0; i < 6 && (await active(page)).label !== '검색 취소'; i += 1) await page.keyboard.press('Tab');
  assert.equal((await active(page)).label, '검색 취소', '실제 Tab으로 검색 취소 버튼에 도달했다');
  return { app, page, dir };
}

for (const mode of ['ok', 'fail'] as const) {
  test(`검색 진행 중 실제 Tab으로 [검색 취소]를 선택한 채 응답이 ${mode === 'ok' ? '성공' : '실패'}로 완료돼도 포커스가 BODY로 잃어지지 않고 검색창으로 옮겨진다`, { timeout: 120_000 }, async () => {
    const { app, page, dir } = await start(`scf-${mode}`, mode);
    try {
      const base = await barrier(app);
      await release(app, '알파');
      await until(app, '검색 응답 완료', (b) => count(b.answered, '알파') === 1);
      if (mode === 'ok') await page.getByRole('list', { name: '검색 결과' }).getByRole('button').first().waitFor();
      else await page.getByRole('button', { name: '다시 검색', exact: true }).waitFor();
      await frames(page);
      const after = await active(page);
      assert.equal(after.body, false, `완료 뒤 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(after)} / ${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(after.connected, true);
      assert.equal(after.label, '원고 검색', '선택해 둔 취소 버튼이 사라지면 연결된 검색창에 포커스가 있다');
      const end = await barrier(app);
      assert.equal(end.writes, base.writes, '포커스·검색만의 경로에 저장 진입 0');
      assert.ok((await readFile(join(dir, 'chapters', '001.md'), 'utf8')) === ONE && (await readFile(join(dir, 'chapters', '002.md'), 'utf8')) === TWO, '두 파일 바이트(BOM·CRLF·frontmatter) 불변');
    } finally {
      await closeWindow(app);
    }
  });
}
