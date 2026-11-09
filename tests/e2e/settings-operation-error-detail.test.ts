// 환경설정 AI 설정 변경 실패(키 저장·모델 변경 등 run 경로의 예외): 기본 안내(경로·코드·IPC 문구 없음) + 접힌 기술 상세를 보여 주고,
// 새 실패의 상세는 접힌 채 시작하며 이전 실패의 상세가 다음 실패·성공에 남지 않는다. 사람이 쓴 한국어 안내(모델 변경 실패)도 IPC 접두가 상세로 분리돼 기본 안내에는 한국어 문장만 남는다.
// 합성 원고·격리 userData·실제 설정 UI. 실패는 main의 ai:set-key/ai:set-model 핸들러를 감싼 합성 오류이고 실제 저장은 하지 않는다(실제 키·OpenAI·Costs·외부 전송 0). 입력 값은 가짜 초안이다.
// 합성 Electron이며 수동 GUI·실제 OS 입력 확인이 아니다.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '\uFEFF---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const DRAFT = 'synthetic-draft-no-key';

interface Plan {
  setKeyCalls: number;
  setModelCalls: number;
  /** 다음 ai:set-key 호출들의 합성 결과: 오류 메시지 또는 null(성공) */
  keyOutcomes: (string | null)[];
}
const plan = (app: ElectronApplication) => app.evaluate(() => { const p = (globalThis as unknown as { plan: Plan }).plan; return { setKeyCalls: p.setKeyCalls, setModelCalls: p.setModelCalls }; });
const status = (page: Page) => page.locator('[role="dialog"][aria-label="환경설정"] p[role="status"]');
const visibleText = (page: Page) => status(page).evaluate((el) => {
  // 접힌 상세(code)를 뺀 사용자에게 보이는 기본 안내
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('code').forEach((c) => c.remove());
  return clone.textContent ?? '';
});

test('설정 변경 실패는 기본 안내와 접힌 기술 상세를 함께 보여 주고, 새 실패·성공에 이전 상세가 남지 않는다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('settings-operation-error');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const { app, page } = await launch(await tempDir('settings-operation-error-ud'));
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { plan: Plan };
      g.plan = {
        setKeyCalls: 0,
        setModelCalls: 0,
        keyOutcomes: ["EPERM: operation not permitted, open 'C:\\\\Users\\\\synthetic\\\\settings.json'", "ENOSPC: no space left on device, write 'C:\\\\Users\\\\synthetic\\\\keys.bin'", null],
      };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const statusHandler = handlers.get('ai:status')!;
      handlers.set('ai:set-key', async () => {
        g.plan.setKeyCalls++;
        const outcome = g.plan.keyOutcomes.shift();
        if (outcome) throw new Error(outcome);
        return statusHandler(); // 성공 대역: 실제 저장 없이 현재 상태를 돌려준다
      });
      handlers.set('ai:set-model', async () => {
        g.plan.setModelCalls++;
        throw new Error('알 수 없는 모델: synthetic');
      });
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();

    await page.getByRole('button', { name: '설정', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.waitFor();
    const keyInput = settings.getByLabel('API 키');
    await keyInput.fill(DRAFT);

    // 실패 1: 키 저장 → 기본 안내에 코드·경로가 없고, 접힌 기술 상세가 있다
    await settings.getByRole('button', { name: '저장', exact: true }).click();
    await status(page).waitFor();
    const first = await visibleText(page);
    assert.ok(first.includes('파일에 쓸 수 없습니다'), `기존 friendlyError 안내를 쓴다: ${first}`);
    assert.ok(!/EPERM|C:\\|Users/.test(first), `기본 안내에 코드·절대경로가 없다: ${first}`);
    const detailButton = settings.getByRole('button', { name: '기술 상세' });
    await detailButton.waitFor();
    assert.equal(await status(page).locator('code').count(), 0, '새 실패의 기술 상세는 접힌 채 시작한다');
    assert.equal(await keyInput.inputValue(), DRAFT, '실패해도 키 초안이 보존된다');
    assert.equal((await plan(app)).setKeyCalls, 1, '키 저장 호출 1회');

    // 펼치기: 원문 상세를 확인할 수 있다 (코드·경로는 여기에만)
    await detailButton.click();
    const code = status(page).locator('code');
    assert.ok((await code.textContent())?.includes('EPERM'), '펼치면 기술 상세 원문이 보인다');
    assert.ok(!(await code.textContent())?.includes(DRAFT), '입력한 키 초안은 상세에 없다');

    // 실패 2: 다른 오류 → 상세는 다시 접힌 채 시작하고 이전 실패(EPERM)의 상세가 남지 않는다
    await settings.getByRole('button', { name: '저장', exact: true }).click();
    await until(async () => (await plan(app)).setKeyCalls === 2);
    await until(async () => (await visibleText(page)).includes('저장 공간이 부족합니다'));
    assert.equal(await status(page).locator('code').count(), 0, '다음 실패의 상세는 접힌 채 시작한다');
    await settings.getByRole('button', { name: '기술 상세' }).click();
    const second = (await status(page).locator('code').textContent()) ?? '';
    assert.ok(second.includes('ENOSPC') && !second.includes('EPERM'), `이전 실패의 상세가 남지 않는다: ${second}`);

    // 성공: 이전 오류와 상세가 사라지고 성공 안내만 보인다
    await settings.getByRole('button', { name: '저장', exact: true }).click();
    await until(async () => (await plan(app)).setKeyCalls === 3);
    await until(async () => (await visibleText(page)).includes('키를 저장했습니다'));
    assert.equal(await status(page).locator('code').count(), 0, '성공에 이전 상세가 남지 않는다');
    assert.equal(await settings.getByRole('button', { name: '기술 상세' }).count(), 0, '성공에 상세 버튼이 없다');
    assert.equal(await keyInput.inputValue(), '', '성공하면 제출한 초안은 비워진다 (기존 동작)');

    // 사람이 쓴 한국어 안내(모델 변경 실패)
    const model = settings.getByLabel('모델');
    const options = await model.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    assert.ok(options.length >= 2);
    const current = await model.inputValue();
    await model.selectOption(options.find((o) => o !== current)!);
    await until(async () => (await plan(app)).setModelCalls === 1);
    await until(async () => (await visibleText(page)).includes('알 수 없는 모델'));
    const korean = await visibleText(page);
    assert.ok(!/Error invoking|remote method/.test(korean), `기본 안내에 IPC 문구가 없다: ${korean}`);
    // IPC로 던진 오류는 "Error invoking remote method" 접두가 붙어 기술 상세가 있다: 접힌 상세에서만 원문을 본다 (사람이 쓴 한국어 안내는 기본 안내로 그대로)
    assert.equal(await status(page).locator('code').count(), 0, '상세는 접힌 채 시작한다');
    await settings.getByRole('button', { name: '기술 상세' }).click();
    assert.ok(((await status(page).locator('code').textContent()) ?? '').includes('알 수 없는 모델: synthetic'), '접힌 상세에 원문이 있다');
    assert.equal((await plan(app)).setKeyCalls, 3, '모델 변경이 키 저장을 다시 부르지 않았다');
  } finally {
    await closeWindow(app);
  }
});

async function until(ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('시간 안에 기대 상태가 되지 않았다');
}
