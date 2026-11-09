// 환경설정 API 키 입력창(type=password)에서 CDP 조합 중 실제 Enter가 키 저장(ai:set-key)을 시작하는지 계측하고, 시작하지 않는 계약을 고정한다.
// 프로젝트 없는 첫 화면·격리 userData. ai:status·ai:set-key는 실제 handler를 부르지 않는 무료 대역이며 합성 키 문자열은 출력하지 않고 호출 수·길이만 기록한다.
// 조합은 CDP Input.imeSetComposition, Enter는 Playwright 실제 키보드다. requestSubmit·dispatchEvent로 브라우저 차단을 우회하지 않는다(관찰용 capture listener만 단다).
// 계측: 조합 이벤트(compositionstart/update/end)·keydown의 isComposing/keyCode·form submit 이벤트 수. 합성 Electron이며 실제 OS IME·수동 GUI 확인이 아니다. 실키·실safeStorage·유료·외부 호출 0.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const BASE = 'sk-test-draft-base'; // 길이 18

async function script(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { lens: number[] };
    g.lens = [];
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    let saved = false;
    handlers.set('ai:status', async () => ({ hasKey: saved, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] }));
    handlers.set('ai:set-key', async (_e: unknown, value: unknown) => {
      g.lens.push(String(value).length);
      saved = true;
      return { hasKey: true, canEncrypt: true, model: 'fake', models: [{ id: 'fake', label: 'fake' }] };
    });
  });
}
const lens = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { lens: number[] }).lens);
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const keyInput = (page: Page) => dialog(page).getByLabel('API 키');

test('조합 중 실제 Enter는 키 저장을 시작하지 않고(조합 지원·submit 계측 포함), 조합이 끝난 뒤 Enter 1회·마우스 저장은 정상이다', { timeout: 90_000 }, async () => {
  const { app, page } = await launch(await tempDir('settings-key-comp-ud'));
  try {
    await script(app);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await keyInput(page).waitFor();
    await page.evaluate(`(() => { const el = document.querySelector('input[aria-label="API 키"]'); window.__e = { comp: [], keydowns: [], submits: 0 };
      for (const t of ['compositionstart','compositionupdate','compositionend']) el.addEventListener(t, () => window.__e.comp.push(t), true);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__e.keydowns.push({ composing: e.isComposing, keyCode: e.keyCode }); }, true);
      el.form.addEventListener('submit', () => window.__e.submits++, true); })()`);
    const ev = () => page.evaluate('window.__e') as Promise<{ comp: string[]; keydowns: { composing: boolean; keyCode: number }[]; submits: number }>;

    await keyInput(page).fill(BASE);
    await keyInput(page).focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    const afterComp = await ev();
    // 계측: 암호 입력창이 CDP 조합을 지원하는가 (조합 이벤트가 오는가). 조합 문자 길이만 본다
    console.log(`계측 조합 이벤트=${JSON.stringify(afterComp.comp)} 입력길이=${(await keyInput(page).inputValue()).length}`);
    await page.keyboard.press('Enter');
    await frames(page);
    const afterEnter = await ev();
    console.log(`계측 조합 Enter keydown=${JSON.stringify(afterEnter.keydowns)} submit=${afterEnter.submits} set-key=${JSON.stringify(await lens(app))}`);
    assert.deepEqual(await lens(app), [], '조합 중 Enter가 set-key를 시작하지 않았다');
    assert.equal(await dialog(page).getByText('키를 저장했습니다').count(), 0, '저장 성공 표시 없음');
    assert.ok((await keyInput(page).inputValue()).startsWith(BASE), '초안이 지워지지 않았다');

    // 조합 확정(compositionend) 뒤 마우스 [저장]: 직전 keydown이 조합 Enter였어도 영구 차단되지 않는다 (마우스 경로)
    await page.keyboard.insertText('마');
    await frames(page);
    const draftLen = (await keyInput(page).inputValue()).length;
    assert.deepEqual(await lens(app), [], '조합 확정만으로 저장 요청이 없다');
    await dialog(page).getByRole('button', { name: '저장', exact: true }).click();
    await dialog(page).getByText('키를 저장했습니다').waitFor();
    assert.deepEqual(await lens(app), [draftLen], '마우스 저장이 정확히 1회, 초안 길이로 나갔다');

    // 이어서 새 초안 + 일반 Enter 명시 저장 1회 (이전 조합이 영구 차단하지 않는다)
    await keyInput(page).fill(`${BASE}-enter`);
    await keyInput(page).focus();
    await page.keyboard.press('Enter');
    await until(async () => (await lens(app)).length === 2);
    await frames(page);
    assert.deepEqual(await lens(app), [draftLen, BASE.length + 6], '일반 Enter 명시 저장도 정확히 1회');
  } finally {
    await closeWindow(app);
  }
});
async function until(cond: () => Promise<boolean>) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, '시간 안에 조건 충족');
    await new Promise((r) => setTimeout(r, 20));
  }
}
