// 환경설정 [연결 확인]을 실제 키보드(Tab → Enter/Space)로 실행해 응답을 기다리는 동안 disabled가 되는 순간 포커스가 BODY로 사라지지 않고 Escape가 모달에 닿는지 본다.
// 프로젝트 없는 첫 화면·격리 userData. ai:status(hasKey=true 합성)·ai:check는 무료 대역(첫 호출을 release까지 붙잡음, 진입·완료 계수). 실제 check·provider·실키·safeStorage·유료·외부 호출 0.
// 시작점(입력창 DOM focus)과 실제 키보드 경로(Tab·Enter/Space·Escape)를 구분한다. 응답 처리 완료는 렌더된 안내로 본다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

type Outcome = 'ok' | 'result-fail' | 'reject';
async function script(app: ElectronApplication, outcome: Outcome) {
  await app.evaluate(({ ipcMain }, outcome) => {
    const g = globalThis as unknown as { c: { entered: number; done: number; release?: () => void } };
    g.c = { entered: 0, done: 0 };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    handlers.set('ai:status', async () => ({ hasKey: true, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] }));
    handlers.set('ai:check', async () => {
      g.c.entered++;
      await new Promise<void>((resolve) => (g.c.release = resolve));
      g.c.done++;
      if (outcome === 'reject') throw new Error('합성 연결 확인 거절');
      if (outcome === 'result-fail') return { ok: false, message: '합성 연결 실패 안내' };
      return { ok: true };
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
async function start(prefix: string, outcome: Outcome) {
  const { app, page } = await launch(await tempDir(prefix));
  await script(app, outcome);
  await page.getByRole('button', { name: '환경설정', exact: true }).click();
  await dialog(page).getByRole('button', { name: '연결 확인', exact: true }).waitFor();
  await dialog(page).getByLabel('API 키').focus(); // 시작점만 DOM focus
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 6) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  // 실제 Tab: 빈 초안이라 [저장]은 disabled → [삭제] → 모델 → [연결 확인]
  for (let i = 0; i < 4 && (await active(page)).label !== '연결 확인'; i += 1) await page.keyboard.press('Tab');
  assert.equal((await active(page)).label, '연결 확인', '실제 Tab으로 [연결 확인]에 도달했다');
  return { app, page };
}

for (const [outcome, press] of [['ok', 'Enter'], ['result-fail', 'Space'], ['reject', 'Enter']] as const) {
  test(`[연결 확인]을 실제 Tab·${press}로 실행하면 대기 중·${outcome} 응답 뒤에도 포커스가 BODY로 사라지지 않고 Escape가 모달을 닫는다`, { timeout: 90_000 }, async () => {
    const { app, page } = await start(`settings-check-focus-${outcome}-ud`, outcome);
    try {
      await page.keyboard.press(press);
      await until(async () => (await c(app)).entered === 1, '첫 연결 확인 요청이 붙잡혔다');
      await frames(page);
      const waiting = await active(page);
      console.log(`계측 ${outcome} 대기 중 active=${JSON.stringify(waiting)} log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(waiting.body, false, `대기 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(waiting)}`);
      assert.equal(waiting.inDialog, true, '대기 중 포커스가 모달 안에 있다');
      await release(app);
      if (outcome === 'ok') await dialog(page).getByText('연결됨: 이 키로 선택한 모델을 쓸 수 있습니다').waitFor();
      else if (outcome === 'result-fail') await dialog(page).getByText('합성 연결 실패 안내').waitFor();
      else await dialog(page).locator('.error').first().waitFor();
      await frames(page);
      const after = await active(page);
      assert.equal(after.body, false, `응답 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(after)}`);
      assert.equal(after.inDialog, true, '응답 뒤에도 모달 안');
      if (outcome !== 'ok') assert.equal(await dialog(page).getByText('연결됨: 이 키로 선택한 모델을 쓸 수 있습니다').count(), 0, '실패를 연결 성공으로 표시하지 않는다');
      assert.equal(await dialog(page).getByRole('button', { name: '연결 확인', exact: true }).isEnabled(), true, '명시 재시도가 가능하다 (busy 해제)');
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      assert.equal((await c(app)).entered, 1, '자동 재확인·중복 실행 없음');
    } finally {
      await closeWindow(app);
    }
  });
}

test('[연결 확인] 대기 중 Escape로 닫아도 늦은 응답이 포커스를 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('settings-check-focus-close-ud', 'ok');
  try {
    await page.keyboard.press('Enter');
    await until(async () => (await c(app)).entered === 1, '첫 연결 확인 요청이 붙잡혔다');
    await page.keyboard.press('Escape'); // 대기 중 Escape가 모달에 닿는다
    await dialog(page).waitFor({ state: 'detached' });
    const opener = await active(page);
    assert.equal(opener.body, false, '닫으면 연 버튼으로 돌아온다');
    await release(app);
    await until(async () => (await c(app)).done === 1, '응답 완료');
    await frames(page);
    assert.deepEqual(await active(page), opener, '닫힌 뒤 늦은 응답이 포커스를 옮기지 않았다');
  } finally {
    await closeWindow(app);
  }
});

test('[연결 확인] 대기 중 사용자가 실제 Shift+Tab으로 옮긴 포커스는 늦은 응답이 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('settings-check-focus-moved-ud', 'ok');
  try {
    await page.keyboard.press('Enter');
    await until(async () => (await c(app)).entered === 1, '첫 연결 확인 요청이 붙잡혔다');
    await page.keyboard.press('Shift+Tab'); // 사용자가 실제 키보드로 다른 살아 있는 컨트롤로 옮긴다
    const moved = await active(page);
    assert.equal(moved.body, false, '대기 중 Shift+Tab이 BODY로 가지 않았다');
    assert.notEqual(moved.label, '연결 확인');
    await release(app);
    await dialog(page).getByText('연결됨: 이 키로 선택한 모델을 쓸 수 있습니다').waitFor();
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 응답이 사용자가 옮긴 포커스를 빼앗지 않았다');
  } finally {
    await closeWindow(app);
  }
});
