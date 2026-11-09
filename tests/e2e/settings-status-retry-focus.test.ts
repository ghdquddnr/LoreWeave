// 환경설정 AI 상태 조회 실패의 다시 시도 경로에서 키보드 포커스가 모달 안에 남는다: 읽는 중·재실패·성공 각 경계에서 BODY로 잃지 않고, 실제 Escape/Tab/Shift+Tab이 동작하며, Escape는 연 버튼으로 돌아온다.
// 응답을 기다리는 사이 사용자가 다른 컨트롤로 옮긴 포커스는 늦은 응답이 빼앗지 않는다. ai:status 조회 계수와 키 쓰기·삭제·연결 확인·모델 변경 계수(0)를 구분한다.
// 합성(프로젝트 없음) 첫 화면·격리 userData. main의 ai:status를 호출별 장벽(성공/거절/붙잡기)으로 감싼다(기존 settings-status-failure 방식). 실제 연결·유료 호출·키 쓰기 0. Playwright 실제 키. 수동 GUI·실제 OS 입력 확인이 아니다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

interface Hooks {
  auto: 'ok' | 'fail' | 'hold';
  statusCalls: number;
  held: [() => void, (e: Error) => void][];
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
const counts = (app: ElectronApplication) => app.evaluate(() => { const h = (globalThis as unknown as { hooks: Hooks }).hooks; return { status: h.statusCalls, mutations: h.mutations }; });
const release = (app: ElectronApplication, i: number) => app.evaluate((_e, a) => (globalThis as unknown as { hooks: Hooks }).hooks.held[a][0](), i);
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const focus = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, inDialog: !!el?.closest('[role="dialog"]'), label: el?.getAttribute('aria-label') ?? el?.textContent ?? '' };
  });

async function start(prefix: string) {
  const { app, page } = await launch(await tempDir(prefix));
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
  await hook(app);
  await setAuto(app, 'fail');
  const opener = page.getByRole('button', { name: '환경설정', exact: true });
  await opener.focus();
  await opener.click();
  await dialog(page).waitFor();
  await dialog(page).locator('.error-note').waitFor();
  return { app, page, note: dialog(page).locator('.error-note') };
}

test('다시 시도: 읽는 중·재실패·성공에서 포커스가 모달 안에 남고 Tab/Shift+Tab/Escape가 동작하며 Escape는 연 버튼으로 돌아온다', { timeout: 120_000 }, async () => {
  const { app, page, note } = await start('ssrf-keys');
  try {
    // 재실패: 새 다시 시도 버튼으로 포커스가 돌아온다
    await note.getByRole('button', { name: '다시 시도' }).focus();
    await page.keyboard.press('Enter');
    await until('재실패 조회', async () => (await counts(app)).status === 2);
    await note.getByRole('button', { name: '다시 시도' }).waitFor();
    const failed = await focus(page);
    assert.equal(failed.inDialog, true, `재실패 뒤 포커스가 모달 안에 있다: ${JSON.stringify(failed)}`);
    assert.equal(failed.label, '다시 시도', '새 다시 시도 버튼으로 돌아온다');
    // 실제 Tab/Shift+Tab은 모달 안에서 돈다
    await page.keyboard.press('Tab');
    assert.equal((await focus(page)).inDialog, true, 'Tab이 모달 안에 머문다');
    await page.keyboard.press('Shift+Tab');
    assert.equal((await focus(page)).inDialog, true, 'Shift+Tab이 모달 안에 머문다');

    // 성공: 실제 AI 설정이 나타나도 포커스를 BODY로 잃지 않는다
    await setAuto(app, 'ok');
    await note.getByRole('button', { name: '다시 시도' }).focus();
    await page.keyboard.press('Enter');
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).waitFor();
    const ok = await focus(page);
    assert.equal(ok.body, false, `성공 뒤 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(ok)}`);
    assert.equal(ok.inDialog, true);
    await page.keyboard.press('Tab');
    assert.equal((await focus(page)).inDialog, true);
    // 실제 Escape: 닫히고 연 버튼으로 돌아온다
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
    assert.equal((await focus(page)).label, '환경설정', '닫으면 연 버튼으로 돌아온다');
    const end = await counts(app);
    assert.equal(end.mutations, 0, '키 쓰기·삭제·연결 확인·모델 변경 0');
    assert.equal(end.status, 3, 'ai:status 조회는 열기 1 + 다시 시도 2');
  } finally {
    await closeWindow(app);
  }
});

test('읽는 중 Escape는 닫고 연 버튼으로 돌아오며, 늦은 응답은 옮긴 포커스를 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, note } = await start('ssrf-hold');
  try {
    // 읽는 중(붙잡음) 포커스는 모달 안: 실제 Escape로 닫힌다
    await setAuto(app, 'hold');
    await note.getByRole('button', { name: '다시 시도' }).focus();
    await page.keyboard.press('Enter');
    await until('붙잡은 조회', async () => (await counts(app)).status === 2);
    await dialog(page).getByText(/읽는 중/).waitFor();
    const reading = await focus(page);
    assert.equal(reading.body, false, `읽는 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(reading)}`);
    assert.equal(reading.inDialog, true);
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'detached' });
    assert.equal((await focus(page)).label, '환경설정', '읽는 중 닫아도 연 버튼으로 돌아온다');
    await release(app, 0); // 닫은 뒤 늦은 성공: 새 대화상자가 아직 없다

    // 비탈취: 다시 열어 실패 → 다시 시도(붙잡음) → 사용자가 닫기 버튼으로 옮김 → 늦은 성공이 포커스를 빼앗지 않는다
    await setAuto(app, 'fail');
    const opener = page.getByRole('button', { name: '환경설정', exact: true });
    await opener.click();
    await dialog(page).locator('.error-note').waitFor();
    await setAuto(app, 'hold');
    await dialog(page).locator('.error-note').getByRole('button', { name: '다시 시도' }).focus();
    await page.keyboard.press('Enter');
    await until('두 번째 붙잡은 조회', async () => (await counts(app)).status >= 4);
    await dialog(page).getByRole('button', { name: '닫기', exact: true }).focus(); // 사용자가 다른 컨트롤로 옮긴다
    await release(app, 1);
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).waitFor();
    assert.equal((await focus(page)).label, '닫기', '늦은 성공 응답이 사용자가 옮긴 포커스를 빼앗지 않았다');
    assert.equal((await counts(app)).mutations, 0, '키 쓰기·삭제·연결 확인·모델 변경 0');
  } finally {
    await closeWindow(app);
  }
});
