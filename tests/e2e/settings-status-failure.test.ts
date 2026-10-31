// 환경설정을 열 때 AI 상태 조회(ai:status)가 실패하거나 오래 걸려도, 대화상자가 사라지지 않고 안내·닫기·다시 시도가 있다.
// 실패를 키 없음/암호화 불가/모델 변경 성공으로 오인하지 않고, 닫은 뒤 이전 요청의 늦은 성공·실패가 새 대화상자를 오염하지 않으며, 조회 복구가 키 쓰기·삭제·연결 확인을 하지 않는다.
// 합성(프로젝트 없음) 첫 화면·격리 userData. main의 ai:status를 호출별 장벽(성공/거절/붙잡기)으로 감싼다. 실제 연결·유료 호출 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

interface Hooks {
  auto: 'ok' | 'fail' | 'hold';
  /** ai:status 호출 수 / 붙잡은 호출의 [성공, 거절] */
  statusCalls: number;
  held: [() => void, (e: Error) => void][];
  /** 키 쓰기·삭제·연결 확인·모델 변경 호출 수 */
  mutations: number;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { auto: 'ok', statusCalls: 0, held: [], mutations: 0 };
    const status = map.get('ai:status')!;
    ipcMain.removeHandler('ai:status');
    ipcMain.handle('ai:status', async (...args: unknown[]) => {
      const h = g.hooks;
      h.statusCalls += 1;
      if (h.auto === 'fail') throw new Error('EACCES: permission denied (synthetic status)');
      // 이 함수는 앱 안에서 실행된다: 이름이 붙는 함수 값을 만들지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없다)
      if (h.auto === 'hold') await new Promise<void>((resolve, reject) => h.held.push([resolve, reject]));
      return status(...args);
    });
    for (const channel of ['ai:set-key', 'ai:delete-key', 'ai:check', 'ai:set-model']) {
      const original = map.get(channel)!;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args: unknown[]) => {
        g.hooks.mutations += 1;
        return original(...args);
      });
    }
  });
const setAuto = (app: ElectronApplication, auto: Hooks['auto']) => app.evaluate((_e, a) => void ((globalThis as unknown as { hooks: Hooks }).hooks.auto = a), auto);
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.statusCalls);
const mutations = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.mutations);
const settle = (app: ElectronApplication, i: number, ok: boolean) =>
  app.evaluate((_e, a) => void ((globalThis as unknown as { hooks: Hooks }).hooks.held[a.i]![a.ok ? 0 : 1](new Error('EACCES: permission denied (synthetic late status)'))), { i, ok });
const untilCalls = async (app: ElectronApplication, n: number) => {
  const deadline = Date.now() + 15_000;
  while ((await hooks(app)) < n) {
    if (Date.now() > deadline) throw new Error(`ai:status 호출 ${n}개 대기 시간 초과`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const open = (page: Page) => page.getByRole('button', { name: '환경설정', exact: true }).click();
const closeButton = (page: Page) => dialog(page).getByRole('button', { name: '닫기', exact: true });

async function start(prefix: string) {
  const { app, page } = await launch(await tempDir(prefix));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
  await hook(app);
  return { app, page, errors };
}

test('상태 조회가 실패해도 환경설정이 사라지지 않고 안내·닫기·다시 시도가 있으며, 실패를 키 없음으로 오인하지 않고, 복구하면 실제 상태가 보인다', { timeout: 90_000 }, async () => {
  const { app, page, errors } = await start('ssf-fail');
  try {
    await setAuto(app, 'fail');
    await open(page);
    await dialog(page).waitFor({ timeout: 10_000 });
    const note = dialog(page).locator('.error-note');
    await note.waitFor();
    assert.match(await note.innerText(), /AI 설정.*읽지 못했습니다/);
    assert.equal(await dialog(page).getByText('저장됨', { exact: false }).count(), 0);
    assert.equal(await dialog(page).getByText('없음', { exact: true }).count(), 0, '조회 실패를 키 없음으로 오인하지 않는다');
    assert.equal(await dialog(page).getByText(/암호화해 저장할 수 없어/).count(), 0, '조회 실패를 암호화 불가로 오인하지 않는다');
    assert.ok((await dialog(page).getByText(/테마/).count()) > 0, '외관 설정은 그대로 쓸 수 있다');
    // 다시 시도: 반복 실패는 안내 유지, 복구되면 실제 상태
    await note.getByRole('button', { name: '다시 시도' }).click();
    await note.waitFor();
    assert.equal(await hooks(app), 2);
    await setAuto(app, 'ok');
    await note.getByRole('button', { name: '다시 시도' }).click();
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).waitFor();
    assert.equal(await dialog(page).locator('.error-note').count(), 0);
    assert.equal(await mutations(app), 0, '조회 복구가 키 쓰기·삭제·연결 확인·모델 변경을 하지 않는다');
    // 닫기·재열기
    await closeButton(page).click();
    await dialog(page).waitFor({ state: 'detached' });
    await open(page);
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).waitFor();
    assert.deepEqual(errors, [], '처리되지 않은 예외(pageerror) 0');
  } finally {
    await closeWindow(app);
  }
});

test('상태 조회를 기다리는 동안 읽는 중임을 보이고 닫을 수 있으며, 닫은 뒤의 늦은 성공·실패가 새 대화상자를 오염하지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, errors } = await start('ssf-hold');
  try {
    await setAuto(app, 'hold');
    await open(page);
    await untilCalls(app, 1);
    await dialog(page).getByText(/읽는 중/).waitFor();
    await closeButton(page).click(); // 대기 중에도 닫을 수 있다
    await dialog(page).waitFor({ state: 'detached' });
    // 새 대화상자는 정상 응답: 첫 요청의 늦은 실패·성공이 이를 건드리지 않는다
    await setAuto(app, 'ok');
    await open(page);
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).waitFor();
    await settle(app, 0, false);
    await frames(page);
    assert.equal(await dialog(page).locator('.error-note').count(), 0, '늦은 실패가 새 대화상자에 오류를 남기지 않는다');
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).waitFor();
    // 대기 중 닫기 → 늦은 성공: 닫힌 상태 유지
    await closeButton(page).click();
    await dialog(page).waitFor({ state: 'detached' });
    await setAuto(app, 'hold');
    await open(page);
    await untilCalls(app, 3);
    await closeButton(page).click();
    await dialog(page).waitFor({ state: 'detached' });
    await settle(app, 1, true);
    await frames(page);
    assert.equal(await dialog(page).count(), 0, '늦은 성공이 닫힌 대화상자를 다시 열지 않는다');
    assert.equal(await mutations(app), 0);
    assert.deepEqual(errors, [], '처리되지 않은 예외(pageerror) 0');
  } finally {
    await closeWindow(app);
  }
});
