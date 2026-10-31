// 환경설정의 API 키 저장 응답을 기다리는 동안 새로 입력한 키 초안은 늦은 성공이 지우지 않고, 그대로인 제출값만 성공 때 비운다. 실패하면 입력을 보존해 다시 저장할 수 있다.
// 합성(프로젝트 없음) 첫 화면·격리 userData. ai:status·ai:set-key는 실제 handler를 부르지 않는 무료 대역(합성 상태, set-key는 호출별 장벽)이다.
// 합성 문자열만 쓰고 키 내용은 출력하지 않는다. 실제 키 저장·암호화·AI·API 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const FIRST = 'sk-test-first-draft';
const SECOND = 'sk-test-second-draft';

type Step = 'hold-ok' | 'hold-fail';
/** ai:status는 합성 상태(암호화 가능·키 없음), ai:set-key는 steps대로: hold-*는 release 전까지 붙잡고 ok면 키 있음 상태를, fail이면 거절을 돌려준다. 인자는 길이만 남긴다 */
async function script(app: ElectronApplication, steps: Step[]) {
  await app.evaluate(({ ipcMain }, steps) => {
    const g = globalThis as unknown as { calls: { len: number; same: boolean[] }; held: boolean; release?: () => void; submitted: string[] };
    g.calls = { len: 0, same: [] };
    g.submitted = [];
    g.held = false;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    let saved = false;
    handlers.set('ai:status', async () => ({ hasKey: saved, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] }));
    handlers.set('ai:set-key', async (_e: unknown, value: unknown) => {
      const n = g.calls.len++;
      g.submitted.push(String(value));
      g.held = true;
      await new Promise<void>((resolve) => (g.release = resolve));
      g.held = false;
      if (steps[n] === 'hold-fail') throw new Error('합성 키 저장 실패');
      saved = true;
      return { hasKey: true, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] };
    });
  }, steps);
}
const calls = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as { calls: { len: number }; submitted: string[] };
    return { count: g.calls.len, submitted: g.submitted };
  });
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { held: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release: () => void }).release());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const keyInput = (page: Page) => dialog(page).getByLabel('API 키');
const saveButton = (page: Page) => dialog(page).getByRole('button', { name: '저장', exact: true });

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '환경설정', exact: true }).click();
  await keyInput(page).waitFor();
}

test('저장 응답을 기다리는 동안 입력한 새 초안은 늦은 성공이 지우지 않는다 (요청은 처음 제출값 하나뿐)', { timeout: 90_000 }, async () => {
  const { app, page } = await launch(await tempDir('settings-key-draft-ud'));
  try {
    await script(app, ['hold-ok']);
    await openSettings(page);
    await keyInput(page).fill(FIRST);
    await saveButton(page).click();
    await until(() => held(app), '저장 요청이 도착해 붙잡혔다');
    assert.deepEqual(await calls(app), { count: 1, submitted: [FIRST] });
    // 기다리는 중에도 입력이 편집 가능하면 새 초안을 입력한다 (편집이 막혀 있으면 이 단계는 건너뛴다)
    const editable = await keyInput(page).isEditable();
    if (editable) await keyInput(page).fill(SECOND);
    await release(app);
    await dialog(page).getByText('키를 저장했습니다').waitFor();
    if (editable) assert.equal(await keyInput(page).inputValue(), SECOND, '늦은 성공이 새로 입력한 초안을 지우지 않는다');
    else assert.equal(await keyInput(page).inputValue(), '', '편집을 막았다면 제출값은 성공 때 비운다');
    assert.deepEqual(await calls(app), { count: 1, submitted: [FIRST] }, '요청은 처음 제출값 하나뿐이다');
  } finally {
    await closeWindow(app);
  }
});

test('입력을 바꾸지 않았다면 성공 때 제출값을 비우고, 실패하면 입력을 보존해 다시 저장할 수 있다', { timeout: 90_000 }, async () => {
  const { app, page } = await launch(await tempDir('settings-key-draft2-ud'));
  try {
    await script(app, ['hold-fail', 'hold-ok']);
    await openSettings(page);
    await keyInput(page).fill(FIRST);
    await saveButton(page).click();
    await until(() => held(app), '저장 요청이 도착해 붙잡혔다');
    await release(app);
    await dialog(page).getByText('합성 키 저장 실패').waitFor();
    assert.equal(await keyInput(page).inputValue(), FIRST, '실패하면 입력을 보존한다');
    await until(async () => await saveButton(page).isEnabled(), '실패 뒤 [저장]이 다시 활성이다');
    await saveButton(page).click();
    await until(async () => (await calls(app)).count === 2 && (await held(app)), '두 번째 저장 요청이 도착해 붙잡혔다');
    assert.deepEqual(await calls(app), { count: 2, submitted: [FIRST, FIRST] });
    await release(app);
    await dialog(page).getByText('키를 저장했습니다').waitFor();
    assert.equal(await keyInput(page).inputValue(), '', '그대로인 제출값은 성공하면 비운다');
  } finally {
    await closeWindow(app);
  }
});
