// 환경설정 외관의 [기본값으로]를 실제 키보드(Tab → Enter/Space)로 실행하면 즉시 기본값이 적용되며 버튼이 disabled가 된다. 그 순간 포커스가 BODY로 사라지지 않고 같은 모달 안에 남아 Escape로 닫을 수 있어야 한다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData(비기본 외관 settings.json). main의 appearance:update를 호출 수·지연(HOLD)·거절 대역으로 감싼다(성공은 원래 핸들러, 격리 userData라 실제 설정 미변경). chapter:write·ai:analyze 진입을 센다.
// 시작점(DOM focus)과 실제 키보드 경로(실제 Tab·Enter/Space·Escape)를 구분한다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. 실원고·실키·AI·유료·외부 호출 0.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

interface G { updates: number; writes: number; analyzes: number; mode: 'ok' | 'hold-ok' | 'hold-reject'; entered: number; release?: () => void }
async function hook(app: ElectronApplication, mode: G['mode']) {
  await app.evaluate(({ ipcMain }, mode) => {
    const g = globalThis as unknown as { g: G };
    g.g = { updates: 0, writes: 0, analyzes: 0, mode, entered: 0 };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const update = handlers.get('appearance:update')!;
    handlers.set('appearance:update', async (...args: unknown[]) => {
      g.g.updates++;
      if (g.g.mode !== 'ok') {
        g.g.entered++;
        await new Promise<void>((resolve) => (g.g.release = resolve));
        if (g.g.mode === 'hold-reject') throw new Error('합성 외관 저장 거절');
      }
      return update(...args);
    });
    for (const [channel, key] of [['chapter:write', 'writes'], ['ai:analyze', 'analyzes']] as const) {
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        g.g[key]++;
        return original(...args);
      });
    }
  }, mode);
}
const st = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { g: G }).g; return { updates: x.updates, writes: x.writes, analyzes: x.analyzes, entered: x.entered }; });
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { g: G }).g.release?.());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', inDialog: !!el?.closest('[role="dialog"]'), tag: el?.tagName ?? '' };
  });

async function start(prefix: string, mode: G['mode']) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const userData = await tempDir(`${prefix}-ud`);
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'daylight', followSystem: false } }));
  const { app, page } = await launch(userData);
  await hook(app, mode);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
  await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await dialog(page).waitFor();
  const reset = dialog(page).getByRole('button', { name: '기본값으로', exact: true });
  assert.equal(await reset.isEnabled(), true, '비기본 외관이라 [기본값으로]가 활성이다');
  // 시작점만 DOM focus(글자 크기 슬라이더), [기본값으로]까지는 실제 Tab
  await dialog(page).getByRole('slider', { name: '줄 간격' }).focus();
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 6) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  for (let i = 0; i < 12 && (await active(page)).label !== '기본값으로'; i += 1) await page.keyboard.press('Tab');
  assert.equal((await active(page)).label, '기본값으로', '실제 Tab으로 [기본값으로]에 도달했다');
  return { app, page, path };
}

for (const press of ['Enter', 'Space'] as const) {
  test(`[기본값으로]를 실제 Tab·${press}로 실행해도 즉시 disabled되는 순간 포커스가 BODY로 사라지지 않고 Escape가 모달을 닫는다`, { timeout: 90_000 }, async () => {
    const { app, page, path } = await start(`appearance-reset-focus-${press}`, 'ok');
    try {
      await page.keyboard.press(press);
      await until(async () => (await st(app)).updates === 1, '외관 저장 호출 1회');
      await dialog(page).getByRole('button', { name: '기본값으로', exact: true }).and(page.locator(':disabled')).waitFor();
      await frames(page);
      const after = await active(page);
      console.log(`계측 ${press} 기본값 적용 뒤 active=${JSON.stringify(after)} log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(after.body, false, `포커스가 BODY로 사라지지 않았다: ${JSON.stringify(after)}`);
      assert.equal(after.inDialog, true, '포커스가 모달 안에 있다');
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      const end = await st(app);
      assert.equal(end.updates, 1, '외관 저장은 한 번');
      assert.equal(end.writes, 0, '불필요한 chapter:write 0');
      assert.equal(end.analyzes, 0, 'AI 실행 진입 0');
      assert.ok((await readFile(path, 'utf8')) === ONE, '합성 원고 바이트 불변');
    } finally {
      await closeWindow(app);
    }
  });
}

test('저장 응답을 기다리는 동안(지연·거절)에도 포커스가 모달 안에 있고, 거절 안내 뒤에도 Escape로 닫는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('appearance-reset-focus-reject', 'hold-reject');
  try {
    await page.keyboard.press('Enter');
    await until(async () => (await st(app)).entered === 1, '저장 호출이 붙잡혔다');
    await frames(page);
    const waiting = await active(page);
    assert.equal(waiting.body, false, `대기 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(waiting)}`);
    assert.equal(waiting.inDialog, true);
    await release(app);
    await dialog(page).getByRole('alert').waitFor(); // 거절 안내 렌더
    await frames(page);
    const failed = await active(page);
    assert.equal(failed.body, false, `거절 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(failed)}`);
    assert.equal(failed.inDialog, true);
    assert.equal((await st(app)).updates, 1, '자동 재저장 없음 (명시 재시도만)');
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
  } finally {
    await closeWindow(app);
  }
});

test('저장 대기 중 Escape로 닫은 뒤 늦은 응답이 포커스를 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('appearance-reset-focus-close', 'hold-ok');
  try {
    await page.keyboard.press('Enter');
    await until(async () => (await st(app)).entered === 1, '저장 호출이 붙잡혔다');
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
    const opener = await active(page);
    assert.equal(opener.body, false, '닫으면 연 버튼으로 돌아온다');
    await release(app);
    await frames(page);
    assert.deepEqual(await active(page), opener, '닫힌 뒤 늦은 응답이 포커스를 옮기지 않았다');
  } finally {
    await closeWindow(app);
  }
});
