// API 키 [삭제]를 실제 키보드(Tab → Enter/Space)로 실행해 삭제 응답을 기다리는 동안 disabled가 되고(성공이면 버튼이 사라지는) 순간 포커스가 BODY로 사라지지 않고 Escape가 모달에 닿는지 본다.
// 프로젝트 없는 첫 화면·격리 userData. ai:status(hasKey=true 합성)·ai:delete-key는 무료 대역(첫 호출을 release까지 붙잡음, 진입·완료 계수, 성공이면 합성 키 없음). 실제 키 삭제·safeStorage·유료·외부 호출 0.
// 시작점(입력창 DOM focus)과 실제 키보드 경로(Tab·Enter/Space·Escape)를 구분한다. 응답 처리 완료는 렌더된 결과(오류 안내·삭제 버튼 제거)로 본다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

async function script(app: ElectronApplication, outcome: 'ok' | 'fail') {
  await app.evaluate(({ ipcMain }, outcome) => {
    const g = globalThis as unknown as { c: { entered: number; done: number; has: boolean; release?: () => void } };
    g.c = { entered: 0, done: 0, has: true };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    handlers.set('ai:status', async () => ({ hasKey: g.c.has, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] }));
    handlers.set('ai:delete-key', async () => {
      g.c.entered++;
      await new Promise<void>((resolve) => (g.c.release = resolve));
      g.c.done++;
      if (outcome === 'fail') throw new Error('합성 키 삭제 실패');
      g.c.has = false;
      return { hasKey: false, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] };
    });
  }, outcome);
}
const c = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { c: { entered: number; done: number; has: boolean } }).c; return { entered: x.entered, done: x.done, has: x.has }; });
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
const del = (page: Page) => dialog(page).getByRole('button', { name: '삭제', exact: true });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 12) ?? '', inDialog: !!el?.closest('[role="dialog"]'), tag: el?.tagName ?? '' };
  });
async function start(prefix: string, outcome: 'ok' | 'fail') {
  const { app, page } = await launch(await tempDir(prefix));
  await script(app, outcome);
  await page.getByRole('button', { name: '환경설정', exact: true }).click();
  await del(page).waitFor();
  await dialog(page).getByLabel('API 키').focus(); // 시작점만 DOM focus
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 6) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  await page.keyboard.press('Tab'); // 빈 초안이라 [저장]은 disabled: 실제 Tab으로 [삭제]에 도달
  assert.equal((await active(page)).label, '삭제', '실제 Tab으로 [삭제]에 도달했다');
  return { app, page };
}

for (const [outcome, press] of [['ok', 'Enter'], ['fail', 'Space']] as const) {
  test(`[삭제]를 실제 Tab·${press}로 실행하면 대기 중·${outcome === 'ok' ? '성공' : '실패'} 응답 뒤에도 포커스가 BODY로 사라지지 않고 Escape가 모달을 닫는다`, { timeout: 90_000 }, async () => {
    const { app, page } = await start(`settings-delete-focus-${outcome}-ud`, outcome);
    try {
      await page.keyboard.press(press);
      await until(async () => (await c(app)).entered === 1, '첫 삭제 요청이 붙잡혔다');
      await frames(page);
      const waiting = await active(page);
      console.log(`계측 ${outcome} 대기 중 active=${JSON.stringify(waiting)} log=${JSON.stringify(await page.evaluate('window.__f'))}`);
      assert.equal(waiting.body, false, `대기 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(waiting)}`);
      assert.equal(waiting.inDialog, true, '대기 중 포커스가 모달 안에 있다');
      await release(app);
      if (outcome === 'ok') await del(page).waitFor({ state: 'detached' }); // 렌더 완료: 삭제 버튼이 사라졌다
      else await dialog(page).getByText('키를 삭제하지 못했습니다').or(dialog(page).locator('.error')).first().waitFor();
      await frames(page);
      const after = await active(page);
      assert.equal(after.body, false, `응답 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(after)}`);
      assert.equal(after.inDialog, true, '응답 뒤에도 모달 안');
      if (outcome === 'ok') assert.equal(await dialog(page).getByText('없음', { exact: true }).count(), 1, '성공: 키 없음');
      else {
        assert.equal(await del(page).count(), 1, '실패: 키 있음(삭제 버튼 남음)');
        assert.equal(await dialog(page).locator('.error').count(), 1, '실패 안내가 보인다');
      }
      // 열린 모달에서 Escape가 닫는다 (응답 뒤)
      await page.keyboard.press('Escape');
      await dialog(page).waitFor({ state: 'detached' });
      assert.equal((await c(app)).entered, 1, '자동 재삭제·추가 호출 없음');
    } finally {
      await closeWindow(app);
    }
  });
}

test('[삭제] 대기 중 Escape로 닫아도, 늦은 응답이 포커스를 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('settings-delete-focus-close-ud', 'ok');
  try {
    await page.keyboard.press('Enter');
    await until(async () => (await c(app)).entered === 1, '첫 삭제 요청이 붙잡혔다');
    await page.keyboard.press('Escape'); // 대기 중 Escape가 모달에 닿는다
    await dialog(page).waitFor({ state: 'detached' });
    const opener = await active(page);
    assert.equal(opener.body, false, '닫으면 연 버튼으로 돌아온다');
    await release(app);
    await until(async () => (await c(app)).done === 1, '삭제 응답 완료');
    await frames(page);
    assert.deepEqual(await active(page), opener, '닫힌 뒤 늦은 응답이 포커스를 옮기지 않았다');
  } finally {
    await closeWindow(app);
  }
});

test('[삭제] 대기 중 사용자가 실제 Tab으로 옮긴 포커스는 늦은 응답이 빼앗지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('settings-delete-focus-moved-ud', 'ok');
  try {
    await page.keyboard.press('Enter');
    await until(async () => (await c(app)).entered === 1, '첫 삭제 요청이 붙잡혔다');
    await page.keyboard.press('Tab'); // 사용자가 실제 키보드로 다른 살아 있는 컨트롤로 옮긴다 (포커스가 이미 모달 안일 때만 의미가 있다)
    const moved = await active(page);
    assert.equal(moved.body, false, '대기 중 Tab이 BODY로 가지 않았다');
    assert.notEqual(moved.label, '삭제');
    await release(app);
    await del(page).waitFor({ state: 'detached' });
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 응답이 사용자가 옮긴 포커스를 빼앗지 않았다');
  } finally {
    await closeWindow(app);
  }
});
