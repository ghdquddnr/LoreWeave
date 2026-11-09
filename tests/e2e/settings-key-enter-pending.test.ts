// 환경설정 API 키 저장 응답을 기다리는 동안 암호 입력창에서 실제 Enter(연속 Enter 포함)를 눌러도 중복 저장 요청이 나가지 않는다 (브라우저의 implicit submit은 disabled 제출 버튼이면 막힌다).
// 대기 중 새 초안은 실제 키보드로 입력하고, 응답이 풀린 뒤에는 새 초안이 보존되고 busy가 풀려 사용자의 새 명시 저장 1회가 가능하다. 자동 재시도 0.
// 격리 userData·프로젝트 없는 첫 화면. ai:status·ai:set-key는 실제 handler를 부르지 않는 무료 대역(합성 상태, set-key는 호출별 장벽)이다. 합성 키 문자열은 출력하지 않고 호출 수·길이만 기록한다. requestSubmit·dispatchEvent는 쓰지 않는다.
// 실제 safeStorage·키 저장·AI·유료·외부 호출 0. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const FIRST = 'sk-test-first-draft'; // 길이 19
const SECOND = 'sk-test-second-draft-longer'; // 길이 27 (첫 값과 길이가 달라 길이만으로 구분한다)

async function script(app: ElectronApplication, firstOutcome: 'ok' | 'fail') {
  await app.evaluate(({ ipcMain }, firstOutcome) => {
    const g = globalThis as unknown as { lens: number[]; held: boolean; release?: () => void; hold: boolean };
    g.lens = [];
    g.held = false;
    g.hold = true;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    let saved = false;
    handlers.set('ai:status', async () => ({ hasKey: saved, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] }));
    handlers.set('ai:set-key', async (_e: unknown, value: unknown) => {
      g.lens.push(String(value).length);
      if (g.hold) {
        g.hold = false;
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        if (firstOutcome === 'fail') throw new Error('합성 키 저장 실패'); // 첫 요청만 실패시킨다 (이후 요청은 성공)
      }
      saved = true;
      return { hasKey: true, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] };
    });
  }, firstOutcome);
}
const lens = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { lens: number[] }).lens);
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { held: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release: () => void }).release());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const keyInput = (page: Page) => dialog(page).getByLabel('API 키');
const saveButton = (page: Page) => dialog(page).getByRole('button', { name: '저장', exact: true });

for (const outcome of ['ok', 'fail'] as const) {
  test(`저장 응답 대기 중 암호 입력창의 실제 Enter(연속)는 중복 저장 요청을 만들지 않고, 응답(${outcome === 'ok' ? '성공' : '실패'}) 뒤 새 초안은 보존되며 새 명시 저장 1회가 가능하다`, { timeout: 90_000 }, async () => {
    const { app, page } = await launch(await tempDir(`settings-key-enter-${outcome}-ud`));
    try {
      await script(app, outcome);
      await page.getByRole('button', { name: '환경설정', exact: true }).click();
      await keyInput(page).waitFor();
      await keyInput(page).fill(FIRST);
      await saveButton(page).click();
      await until(() => held(app), '첫 저장 요청이 도착해 붙잡혔다');
      assert.deepEqual(await lens(app), [FIRST.length], '첫 응답 전에는 요청이 하나뿐이다');

      // 대기 중 실제 키보드로 새 초안을 입력하고(전체 선택 후 입력) 실제 Enter를 연속으로 누른다
      const state = await page.evaluate(() => ({ editable: !(document.querySelector('input[aria-label="API 키"]') as HTMLInputElement).readOnly && !(document.querySelector('input[aria-label="API 키"]') as HTMLInputElement).disabled, saveDisabled: (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '저장') as HTMLButtonElement).disabled }));
      assert.equal(state.saveDisabled, true, '대기 중 저장 버튼은 disabled다 (implicit submit 차단의 전제)');
      assert.equal(state.editable, true, '대기 중에도 입력창은 편집 가능하다');
      await keyInput(page).focus();
      await page.keyboard.press('Control+A');
      await page.keyboard.type(SECOND);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await frames(page); // 렌더 관측 (IPC 요청 도착은 main 쪽 호출 수로 따로 본다)
      assert.deepEqual(await lens(app), [FIRST.length], '대기 중 실제 Enter(연속)로 set-key 요청이 추가되지 않았다');
      assert.equal(await keyInput(page).inputValue(), SECOND, '대기 중 입력한 새 초안이 그대로다');

      // 응답을 푼다: 성공이면 성공 안내, 실패면 오류 안내(렌더 완료 관측) — 어느 쪽이든 새 초안 보존, busy 해제
      await release(app);
      if (outcome === 'ok') await dialog(page).getByText('키를 저장했습니다').waitFor();
      else {
        await dialog(page).getByText('합성 키 저장 실패').waitFor();
        assert.equal(await dialog(page).getByText('키를 저장했습니다').count(), 0, '실패를 성공으로 표시하지 않는다');
      }
      assert.equal(await keyInput(page).inputValue(), SECOND, `${outcome === 'ok' ? '늦은 성공' : '실패'}가 새 초안을 지우지 않는다`);
      await until(async () => await saveButton(page).isEnabled(), '응답 뒤 [저장]이 다시 활성이다 (busy 해제)');
      assert.deepEqual(await lens(app), [FIRST.length], '풀린 뒤에도 자동 재시도·추가 요청이 없다');

      // 사용자의 새 명시 저장 1회: 실제 Enter 한 번이 정확히 새 초안으로 한 요청을 만든다
      await keyInput(page).focus();
      await page.keyboard.press('Enter');
      await until(async () => (await lens(app)).length === 2, '새 명시 저장 요청 1회');
      await frames(page);
      assert.deepEqual(await lens(app), [FIRST.length, SECOND.length], '새 명시 저장은 정확히 한 번, 새 초안(길이로 구분)으로 나갔다');
      if (outcome === 'fail') {
        // 실패 뒤 재사용 가능: 이 두 번째 요청은 성공하고 성공 안내가 보이며 이전 오류는 사라진다
        await dialog(page).getByText('키를 저장했습니다').waitFor();
        assert.equal(await dialog(page).getByText('합성 키 저장 실패').count(), 0, '성공하면 이전 오류가 사라진다');
        assert.deepEqual(await lens(app), [FIRST.length, SECOND.length], '성공 뒤에도 추가 요청이 없다');
      }
    } finally {
      await closeWindow(app);
    }
  });
}
