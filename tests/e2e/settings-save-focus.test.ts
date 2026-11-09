// API 키 [저장] 버튼을 실제 키보드(Tab으로 선택 → Enter/Space)로 실행해 저장 응답을 기다리는 동안 disabled가 되는 순간, 포커스가 BODY로 사라지지 않고 Escape가 모달에 닿는지 본다.
// 프로젝트 없는 첫 화면·격리 userData. ai:status·ai:set-key는 무료 대역(첫 set-key 호출을 release까지 붙잡음, 진입·완료 계수). 합성 키 문자열은 출력하지 않는다(길이만).
// 시작점(입력창 DOM focus)과 실제 키보드 경로(실제 Tab·Enter/Space·Escape)를 구분한다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. 실키·safeStorage·유료·외부 호출 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

async function script(app: ElectronApplication, outcome: 'ok' | 'fail') {
  await app.evaluate(({ ipcMain }, outcome) => {
    const g = globalThis as unknown as { c: { entered: number; done: number; saved: boolean; release?: () => void } };
    g.c = { entered: 0, done: 0, saved: false };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    handlers.set('ai:status', async () => ({ hasKey: g.c.saved, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] }));
    handlers.set('ai:set-key', async () => {
      g.c.entered++;
      await new Promise<void>((resolve) => (g.c.release = resolve));
      g.c.done++;
      if (outcome === 'fail') throw new Error('합성 키 저장 실패');
      g.c.saved = true;
      return { hasKey: true, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] };
    });
  }, outcome);
}
const c = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { c: { entered: number; done: number } }).c; return { entered: x.entered, done: x.done }; });
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { release: () => void } }).c.release());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', inDialog: !!el?.closest('[role="dialog"]'), tag: el?.tagName ?? '' };
  });

for (const [outcome, press] of [['ok', 'Enter'], ['fail', 'Space']] as const) {
  test(`[저장]을 실제 Tab·${press}로 실행하면 대기 중에도 포커스가 BODY로 사라지지 않고 Escape가 닫으며, ${outcome === 'ok' ? '성공' : '실패'} 해제 뒤에도 모달 안에 있다`, { timeout: 90_000 }, async () => {
    const { app, page } = await launch(await tempDir(`settings-save-focus-${outcome}-ud`));
    try {
      await script(app, outcome);
      await page.getByRole('button', { name: '환경설정', exact: true }).click();
      await dialog(page).getByLabel('API 키').fill('sk-test-focus-draft');
      await dialog(page).getByLabel('API 키').focus(); // 시작점만 DOM focus
      await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 6) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
      await page.keyboard.press('Tab'); // 실제 Tab으로 [저장] 선택
      assert.equal((await active(page)).label, '저장', '실제 Tab으로 [저장]에 도달했다');
      await page.keyboard.press(press);
      await until(async () => (await c(app)).entered === 1, '첫 저장 요청이 붙잡혔다');
      await frames(page);
      const waiting = await active(page);
      console.log(`계측 ${outcome} 대기 중 active=${JSON.stringify(waiting)} log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(waiting.body, false, `대기 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(waiting)}`);
      assert.equal(waiting.inDialog, true, '대기 중 포커스가 모달 안에 있다');
      // Escape가 모달에 닿아 닫는다
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      await release(app);
      await until(async () => (await c(app)).done === 1, '저장 응답 완료');
      await frames(page);
      assert.equal((await active(page)).body, false, '닫힌 뒤 늦은 응답이 있어도 포커스가 BODY로 사라지지 않는다(연 버튼으로 복귀)');
      assert.equal((await c(app)).entered, 1, '추가 set-key 호출 없음');
    } finally {
      await closeWindow(app);
    }
  });
}

test('대기 중 사용자가 실제 Shift+Tab으로 옮긴 포커스는 늦은 저장 응답(성공)이 빼앗지 않고, 응답 뒤 입력창 Enter 재저장이 정상이다', { timeout: 90_000 }, async () => {
  const { app, page } = await launch(await tempDir('settings-save-focus-moved-ud'));
  try {
    await script(app, 'ok');
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).getByLabel('API 키').fill('sk-test-focus-draft');
    await dialog(page).getByLabel('API 키').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await until(async () => (await c(app)).entered === 1, '첫 저장 요청이 붙잡혔다');
    assert.equal((await active(page)).label, 'API 키');
    await page.keyboard.press('Shift+Tab'); // 사용자가 실제 키보드로 입력창 앞 컨트롤로 옮긴다
    const moved = await active(page);
    assert.equal(moved.body, false);
    assert.notEqual(moved.label, 'API 키');
    await release(app);
    await until(async () => (await c(app)).done === 1, '저장 응답 완료');
    await dialog(page).getByText('키를 저장했습니다').waitFor();
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 응답이 사용자가 옮긴 포커스를 빼앗지 않았다');
    // 응답 뒤 새 초안 입력창 Enter 재저장 1회 (이전 저장과 별개의 명시 저장)
    await dialog(page).getByLabel('API 키').fill('sk-test-second');
    await dialog(page).getByLabel('API 키').focus();
    await page.keyboard.press('Enter');
    await until(async () => (await c(app)).entered === 2, '명시 재저장 1회');
    await release(app);
    assert.equal((await c(app)).entered, 2);
  } finally {
    await closeWindow(app);
  }
});
