// API 키 저장 응답을 기다리는 동안 환경설정을 닫고 다시 열었을 때, 이전 저장이 성공한 뒤 새 대화상자의 키 상태가 실제(합성) 저장 상태와 일치하는지 본다.
// 프로젝트 없는 첫 화면·격리 userData. ai:status·ai:set-key는 실제 handler를 부르지 않는 무료 대역이다: status는 합성 저장 상태(saved)를 반환하고 호출 수를 세며, set-key는 첫 호출을 release까지 붙잡는다(진입·완료 계수).
// 순서 계측: 첫 저장 HOLD → 실제 Escape로 닫기 → 같은 설정 다시 열기 → 새 창의 초기 상태 조회 완료(status 호출 2회·화면 '없음') → 이전 저장 성공 해제 → set-key 완료 계수. 합성 키 문자열은 출력하지 않는다(길이만).
// 실제 safeStorage·키 저장·AI·유료·외부 호출 0. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const FIRST = 'sk-test-first-draft';

async function script(app: ElectronApplication, outcome: 'ok' | 'fail') {
  await app.evaluate(({ ipcMain }, outcome) => {
    const g = globalThis as unknown as { c: { statuses: number; entered: number; done: number; saved: boolean; release?: () => void } };
    g.c = { statuses: 0, entered: 0, done: 0, saved: false };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    handlers.set('ai:status', async () => {
      g.c.statuses++;
      return { hasKey: g.c.saved, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] };
    });
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
const c = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { c: { statuses: number; entered: number; done: number; saved: boolean } }).c; return { statuses: x.statuses, entered: x.entered, done: x.done, saved: x.saved }; });
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

for (const outcome of ['ok', 'fail'] as const) {
  test(`저장 응답 대기 중 닫고 다시 연 뒤 이전 저장(${outcome === 'ok' ? '성공' : '실패'})이 끝나면 새 창의 키 상태는 실제 저장 상태와 일치한다`, { timeout: 90_000 }, async () => {
    const { app, page } = await launch(await tempDir(`settings-key-reopen-${outcome}-ud`));
    try {
      await script(app, outcome);
      const open = page.getByRole('button', { name: '환경설정', exact: true });
      await open.click();
      await dialog(page).getByLabel('API 키').fill(FIRST);
      await dialog(page).getByRole('button', { name: '저장', exact: true }).click();
      await until(async () => (await c(app)).entered === 1, '첫 저장 요청이 붙잡혔다');
      // 실제 Escape로 닫고 같은 설정을 다시 연다 (닫기가 막히면 아래 단언이 알려 준다)
      await dialog(page).getByLabel('API 키').focus(); // 저장 중 [저장]이 disabled가 돼 포커스를 잃을 수 있어, 입력창(편집 가능)에서 시작한다
      await page.keyboard.press('Escape');
      const closed = (await dialog(page).count()) === 0;
      console.log(`계측 저장 대기 중 Escape로 닫힘=${closed}`);
      if (!closed) return assert.fail('저장 대기 중 Escape가 대화상자를 닫지 않았다 (이 검사는 닫는 경로를 전제한다)');
      await open.click();
      await dialog(page).waitFor();
      await until(async () => (await c(app)).statuses >= 2, '새 창의 초기 상태 조회');
      await dialog(page).getByText('없음', { exact: true }).waitFor(); // 새 창이 조회 결과(아직 저장 전: 없음)를 그렸다
      const before = await c(app);
      console.log(`계측 해제 전 ${JSON.stringify(before)}`);
      assert.equal(before.done, 0, '이전 저장은 아직 끝나지 않았다');
      await release(app);
      await until(async () => (await c(app)).done === 1, '이전 저장 완료');
      await frames(page);
      const truth = (await c(app)).saved;
      assert.equal(truth, outcome === 'ok', '합성 실제 저장 상태');
      const shown = (await dialog(page).getByText('저장됨 (암호화해 이 컴퓨터에만 보관)').count()) === 1;
      console.log(`계측 해제 뒤 실제 저장됨=${truth} 새 창 표시=${shown ? '저장됨' : '없음'} 상태조회=${(await c(app)).statuses}`);
      assert.equal(shown, truth, '새 창의 키 상태가 실제 저장 상태와 일치한다');
      assert.equal(await dialog(page).getByText('키를 저장했습니다').count(), 0, '이전 창의 결과 메시지가 새 창에 나타나지 않는다');
      assert.equal(await dialog(page).getByText('합성 키 저장 실패').count(), 0, '이전 창의 실패 메시지가 새 창에 나타나지 않는다');
      assert.equal((await c(app)).entered, 1, '새 API 호출·자동 재저장 없음');
    } finally {
      await closeWindow(app);
    }
  });
}
