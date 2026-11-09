// 충돌 비교 오류 안의 [다시 비교]를 실제 키보드로 실행할 때 진행 중·재실패·성공에서 포커스가 BODY로 잃어지지 않는다. (원래 주석: 충돌 비교의 [다시 비교]는 읽는 동안 대기를 알리고, 이전 비교를 최신 확인으로 오해하게 두지 않으며, 가장 최근 요청의 결과만 반영한다.
// 비교는 읽기 전용이다: 디스크 바이트·미저장 본문·충돌 상태는 그대로다. 합성 원고·격리 userData. main의 chapter:read(002.md)를 호출별 장벽(성공/거절/붙잡기)으로 감싼다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const TWO = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B')}`;
const OUTSIDE = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME BY_DISK', '', 'KEEP_B', 'DISK_LINE')}`;

interface Hooks {
  auto: 'ok' | 'hold';
  calls: [() => void, (e: Error) => void][];
  held: number;
  writes: number;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { auto: 'ok', calls: [], held: 0, writes: 0 };
    const write = map.get('chapter:write')!;
    ipcMain.removeHandler('chapter:write');
    ipcMain.handle('chapter:write', (...a: unknown[]) => {
      g.hooks.writes += 1;
      return write(...a);
    });
    const read = map.get('chapter:read')!;
    ipcMain.removeHandler('chapter:read');
    ipcMain.handle('chapter:read', async (...args: unknown[]) => {
      const h = g.hooks;
      if (!String(args[1]).endsWith('002.md') || h.auto === 'ok') return read(...args);
      h.held += 1;
      // 이 함수는 앱 안에서 실행된다: 이름이 붙는 함수 값을 만들지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없다)
      await new Promise<void>((resolve, reject) => h.calls.push([resolve, reject]));
      return read(...args);
    });
  });
const setAuto = (app: ElectronApplication, auto: Hooks['auto']) => app.evaluate((_e, a) => void ((globalThis as unknown as { hooks: Hooks }).hooks.auto = a), auto);
const heldCount = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.held);
const settle = (app: ElectronApplication, i: number, ok: boolean) => app.evaluate((_e, a) => void ((globalThis as unknown as { hooks: Hooks }).hooks.calls[a.i]![a.ok ? 0 : 1](new Error('EACCES: permission denied (synthetic read)'))), { i, ok });
const untilHeld = async (app: ElectronApplication, n: number) => {
  const deadline = Date.now() + 15_000;
  while ((await heldCount(app)) < n) {
    if (Date.now() > deadline) throw new Error(`읽기 요청 ${n}개 대기 시간 초과`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const editor = (page: Page) => page.locator('.ProseMirror');
const compare = (page: Page) => page.getByRole('region', { name: '내 화면과 디스크의 차이' });
const reloadButton = (page: Page) => compare(page).getByRole('button', { name: '다시 비교' }).first();
const reading = (page: Page) => compare(page).getByText(/디스크 내용을 (다시 )?읽는 중/);
const stats = (page: Page) => compare(page).getByText(/내 화면에만 \d+줄 · 디스크에만 \d+줄/);

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `${envelope('one', 'ONE')}${lines('ONLY_LINE')}`);
  const two = join(dir, 'chapters', '002.md');
  await writeFile(two, TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'TWO' }).click();
  await editor(page).getByText('CHANGE_ME', { exact: true }).waitFor();
  await editor(page).getByText('KEEP_A', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' MINE');
  await writeFile(two, OUTSIDE);
  await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
  await hook(app);
  await page.getByRole('button', { name: '차이 보기' }).click();
  await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
  return { app, page, two };
}
async function assertReadOnly(page: Page, two: string) {
  assert.equal(await readFile(two, 'utf8'), OUTSIDE, '디스크 바이트 그대로');
  assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 1, '충돌 상태 유지');
  assert.match(await editor(page).innerText(), /KEEP_A MINE/, '미저장 본문 유지');
}

const writes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.writes);
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', inCompare: !!el?.closest('.compare'), inAlert: !!el?.closest('.compare [role="alert"]') };
  });

/** 충돌을 만들고 비교 읽기 실패를 만든 뒤 실제 Shift+Tab으로 오류 안의 [다시 비교]에 도달한다 (시작점 기술 상세만 DOM focus) */
async function toErrorRetry(prefix: string) {
  const { app, page, two } = await start(prefix);
  await page.evaluate(`(() => { window.__f = []; const nm = (e) => e.tagName + (e.getAttribute && e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : '') + (e.tagName === 'BUTTON' && e.textContent ? '{' + e.textContent.slice(0, 8) + '}' : ''); document.addEventListener('focusin', (e) => window.__f.push('in ' + nm(e.target)), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + nm(e.target)), true); })()`);
  await setAuto(app, 'hold');
  await reloadButton(page).click();
  await untilHeld(app, 1);
  await settle(app, 0, false);
  const alert = compare(page).getByRole('alert');
  await alert.waitFor({ timeout: 10_000 });
  await alert.getByRole('button', { name: '기술 상세' }).focus();
  await page.keyboard.press('Shift+Tab');
  const reached = await active(page);
  assert.equal(reached.label, '다시 비교');
  assert.equal(reached.inAlert, true, '오류 안내 안의 다시 비교(상단 같은 이름 버튼이 아니다)에 실제 Shift+Tab으로 도달했다');
  return { app, page, two, alert, log: () => page.evaluate('window.__f') };
}

for (const [key, outcome] of [['Enter', 'fail'], ['Space', 'ok']] as const) {
  test(`오류 안 [다시 비교]를 ${key}로 실행하면 진행 중·${outcome === 'ok' ? '성공' : '재실패'}에서 포커스가 BODY로 잃어지지 않는다`, { timeout: 120_000 }, async () => {
    const { app, page, two, log } = await toErrorRetry(`ccrf-${key}`);
    try {
      const base = await writes(app);
      await page.keyboard.press(key);
      await untilHeld(app, 2);
      const inFlight = await active(page);
      assert.equal(inFlight.body, false, `진행 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(inFlight)} / ${JSON.stringify(await log())}`);
      assert.equal(inFlight.inCompare, true, '진행 중 포커스가 비교 영역 안의 살아있는 컨트롤에 있다');
      await settle(app, 1, outcome === 'ok');
      if (outcome === 'ok') await stats(page).waitFor({ timeout: 10_000 });
      else await compare(page).getByRole('alert').waitFor();
      await frames(page);
      const after = await active(page);
      assert.equal(after.body, false, `완료 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(after)}`);
      assert.equal(after.connected, true);
      assert.equal(after.inCompare, true, '비교 영역 안의 컨트롤에 있다');
      if (outcome === 'fail') assert.equal(await compare(page).locator('.tech-detail').count(), 0, '새 오류의 기술 상세는 접힌 채 시작한다');
      assert.equal(await writes(app), base, '비교 조작만의 경로에 저장 진입 0');
      await assertReadOnly(page, two);
    } finally {
      page.on('dialog', (d) => void d.accept());
      await closeWindow(app);
    }
  });
}

for (const outcome of ['fail', 'ok'] as const) {
  test(`대기 중 사용자가 실제 Shift+Tab으로 옮긴 포커스는 늦은 ${outcome === 'ok' ? '성공' : '실패'} 응답이 빼앗지 않는다`, { timeout: 120_000 }, async () => {
    const { app, page, two } = await toErrorRetry(`ccrf-moved-${outcome}`);
    try {
      const base = await writes(app);
      await page.keyboard.press('Enter');
      await untilHeld(app, 2);
      await page.keyboard.press('Shift+Tab'); // 사용자가 실제 키보드로 옮긴다
      const moved = await active(page);
      assert.equal(moved.body, false);
      await settle(app, 1, outcome === 'ok');
      if (outcome === 'ok') await stats(page).waitFor({ timeout: 10_000 });
      else await compare(page).getByRole('alert').waitFor();
      await frames(page);
      assert.deepEqual(await active(page), moved, `늦은 ${outcome === 'ok' ? '성공' : '실패'} 응답이 사용자가 옮긴 포커스를 빼앗지 않았다`);
      assert.equal(await writes(app), base, '저장 진입 0');
      await assertReadOnly(page, two);
    } finally {
      page.on('dialog', (d) => void d.accept());
      await closeWindow(app);
    }
  });
}
