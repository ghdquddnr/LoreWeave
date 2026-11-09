// 환경설정 [모델] select를 실제 키보드(Tab → ArrowDown)로 바꿀 때 저장 응답을 기다리는 동안 disabled가 되는 순간 포커스가 BODY로 사라지지 않고 Escape가 모달에 닿는지 본다.
// 프로젝트 없는 첫 화면·격리 userData. ai:status(hasKey=true, 합성 모델 2개)·ai:set-model은 무료 대역(첫 호출을 release까지 붙잡음, 진입·완료 계수, 선택값은 길이 아닌 합성 id만 기록). 실제 설정 저장·provider·실키·safeStorage·유료·외부 호출 0.
// 시작점(입력창 DOM focus)과 실제 키보드 경로(실제 Tab·ArrowDown·Escape)를 구분한다. 닫힌 select에서의 ArrowDown은 팝업 없이 값을 바꾸는 경로이며 열린 native 팝업의 Escape는 다루지 않는다. 응답 처리 완료는 렌더된 선택값·안내로 본다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const MODELS = [{ id: 'm-one', label: 'm-one' }, { id: 'm-two', label: 'm-two' }];
async function script(app: ElectronApplication, outcome: 'ok' | 'reject') {
  await app.evaluate(({ ipcMain }, { outcome, models }) => {
    const g = globalThis as unknown as { c: { entered: number; done: number; chosen: string[]; model: string; release?: () => void } };
    g.c = { entered: 0, done: 0, chosen: [], model: 'm-one' };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    handlers.set('ai:status', async () => ({ hasKey: true, canEncrypt: true, model: g.c.model, models }));
    handlers.set('ai:set-model', async (_e: unknown, id: unknown) => {
      g.c.entered++;
      g.c.chosen.push(String(id));
      await new Promise<void>((resolve) => (g.c.release = resolve));
      g.c.done++;
      if (outcome === 'reject') throw new Error('합성 모델 저장 거절');
      g.c.model = String(id);
      return { hasKey: true, canEncrypt: true, model: g.c.model, models };
    });
  }, { outcome, models: MODELS });
}
const c = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { c: { entered: number; done: number; chosen: string[]; model: string } }).c; return { entered: x.entered, done: x.done, chosen: x.chosen, model: x.model }; });
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
const select = (page: Page) => dialog(page).getByLabel('모델');
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', inDialog: !!el?.closest('[role="dialog"]'), tag: el?.tagName ?? '' };
  });
async function start(prefix: string, outcome: 'ok' | 'reject') {
  const { app, page } = await launch(await tempDir(prefix));
  await script(app, outcome);
  await page.getByRole('button', { name: '환경설정', exact: true }).click();
  await select(page).waitFor();
  await dialog(page).getByLabel('API 키').focus(); // 시작점만 DOM focus
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  // 실제 Tab: 빈 초안이라 [저장]은 disabled → [삭제] → 모델 select
  for (let i = 0; i < 3 && (await active(page)).label !== '모델'; i += 1) await page.keyboard.press('Tab');
  assert.equal((await active(page)).label, '모델', '실제 Tab으로 [모델]에 도달했다');
  return { app, page };
}

for (const outcome of ['ok', 'reject'] as const) {
  test(`[모델]을 실제 Tab·ArrowDown으로 바꾸면 대기 중·${outcome} 응답 뒤에도 포커스가 BODY로 사라지지 않고 Escape가 모달을 닫는다`, { timeout: 90_000 }, async () => {
    const { app, page } = await start(`settings-model-focus-${outcome}-ud`, outcome);
    try {
      await page.keyboard.press('ArrowDown');
      await until(async () => (await c(app)).entered === 1, '첫 모델 저장 요청이 붙잡혔다');
      await frames(page);
      const waiting = await active(page);
      console.log(`계측 ${outcome} 선택=${await select(page).inputValue()} 요청=${JSON.stringify((await c(app)).chosen)} 대기 중 active=${JSON.stringify(waiting)} log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.deepEqual((await c(app)).chosen, ['m-two'], '실제 ArrowDown이 다음 모델 하나를 요청했다');
      assert.equal(waiting.body, false, `대기 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(waiting)}`);
      assert.equal(waiting.inDialog, true, '대기 중 포커스가 모달 안에 있다');
      await release(app);
      await until(async () => (await c(app)).done === 1, '모델 저장 응답 완료');
      if (outcome === 'reject') await dialog(page).locator('.error').first().waitFor();
      else await until(async () => (await select(page).inputValue()) === 'm-two' && (await select(page).isEnabled()), '반환 모델 표시·busy 해제');
      await frames(page);
      const after = await active(page);
      assert.equal(after.body, false, `응답 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(after)}`);
      assert.equal(after.inDialog, true, '응답 뒤에도 모달 안');
      if (outcome === 'ok') assert.equal(await select(page).inputValue(), 'm-two', '성공: 반환 모델 표시');
      else {
        assert.equal(await select(page).inputValue(), 'm-one', '실패: 기존 모델 표시');
        await until(async () => await select(page).isEnabled(), '실패 뒤 명시 재시도가 가능하다 (busy 해제)');
      }
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      assert.equal((await c(app)).entered, 1, '자동 재변경·중복 저장 없음');
    } finally {
      await closeWindow(app);
    }
  });
}

test('[모델] 저장 대기 중 Escape로 닫아도 늦은 응답이 포커스를 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('settings-model-focus-close-ud', 'ok');
  try {
    await page.keyboard.press('ArrowDown');
    await until(async () => (await c(app)).entered === 1, '첫 모델 저장 요청이 붙잡혔다');
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

test('[모델] 저장 대기 중 사용자가 실제 Tab으로 옮긴 포커스는 늦은 응답이 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('settings-model-focus-moved-ud', 'ok');
  try {
    await page.keyboard.press('ArrowDown');
    await until(async () => (await c(app)).entered === 1, '첫 모델 저장 요청이 붙잡혔다');
    await page.keyboard.press('Tab'); // 사용자가 실제 키보드로 다른 살아 있는 컨트롤로 옮긴다
    const moved = await active(page);
    assert.equal(moved.body, false, '대기 중 Tab이 BODY로 가지 않았다');
    assert.notEqual(moved.label, '모델');
    await release(app);
    await until(async () => (await c(app)).done === 1, '응답 완료');
    await until(async () => (await select(page).inputValue()) === 'm-two', '반환 모델 표시');
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 응답이 사용자가 옮긴 포커스를 빼앗지 않았다');
  } finally {
    await closeWindow(app);
  }
});
