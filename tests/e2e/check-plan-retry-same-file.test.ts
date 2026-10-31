// 같은 프로젝트·같은 화에 머물 때 '이 화 검사' 계획이 실패하면, 사용자의 명시적 [다시 시도]만 다시 요청하고 (자동 재시도 없음),
// 반복 실패 뒤 성공하면 그 계획으로 확인 창이 열리고 이전 오류·다시 시도는 사라진다. 화 이동 때의 오류 정리(PR #138)가 유효한 같은 화 재시도를 지우지 않음을 직접 확인한다.
// 합성 원고·격리 userData. ai:status(키 있음)·ai:plan-check는 무료 대역이고 ai:analyze·ai:run-check는 호출 수만 세고 거절해 실제 전송을 막는다. 실행 확인 버튼은 누르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BODY = '# ONE\n\nONE_BODY\n';
const failText = (n: number) => `합성 계획 실패 ${n}`;

async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const checkButton = (page: Page) => page.getByRole('button', { name: '이 화 검사', exact: true });
const retryButton = (page: Page) => page.getByRole('button', { name: '다시 시도' });
const confirm = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });

test('같은 화에서 계획 실패 → [다시 시도] 실패 → [다시 시도] 성공: 호출은 눌린 만큼만, 성공 계획으로 확인 창이 열리고 이전 오류·재시도는 사라진다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('check-plan-retry');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), BODY);
  const { app, page } = await launch(await tempDir('check-plan-retry-ud'));
  const state = () => app.evaluate(() => {
    const g = globalThis as unknown as { plans: unknown[]; sends: number };
    return { plans: g.plans, sends: g.sends };
  });
  try {
    await app.evaluate(({ ipcMain }, messages) => {
      const g = globalThis as unknown as { plans: unknown[]; sends: number };
      g.plans = [];
      g.sends = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const status = handlers.get('ai:status')!;
      handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
      handlers.set('ai:plan-check', async (_e: unknown, file: unknown) => {
        const n = g.plans.push(file);
        if (n <= messages.length) throw new Error(messages[n - 1]);
        return { analyze: [], priors: 3, batches: 1, costUsd: 0.0234 };
      });
      for (const channel of ['ai:analyze', 'ai:run-check']) {
        handlers.set(channel, async () => {
          g.sends++;
          throw new Error('합성 대역: 전송하지 않는다');
        });
      }
    }, [failText(1), failText(2)]);

    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').getByText('ONE_BODY', { exact: true }).waitFor();
    await until(async () => await checkButton(page).isEnabled(), '[이 화 검사]가 활성이다');

    // 1차 실패: 오류와 [다시 시도]가 보이고, 자동으로 다시 요청하지 않으며 확인 창도 없다
    await checkButton(page).click();
    await page.getByText(failText(1)).first().waitFor();
    await retryButton(page).first().waitFor();
    await settled(page);
    assert.deepEqual((await state()).plans, ['001.md']);
    assert.equal(await confirm(page).count(), 0);

    // 2차 실패: 사용자가 [다시 시도]를 눌렀을 때만 두 번째 요청이 가고, 새 오류와 [다시 시도]가 남는다
    await retryButton(page).first().click();
    await page.getByText(failText(2)).first().waitFor();
    await retryButton(page).first().waitFor();
    await settled(page);
    assert.deepEqual((await state()).plans, ['001.md', '001.md']);
    assert.equal(await page.getByText(failText(1)).count(), 0, '이전 오류는 새 시도의 오류로 바뀐다');
    assert.equal(await confirm(page).count(), 0);

    // 3차 성공: 성공한 계획(앞 화 3개, 최대 $0.0234)으로 확인 창이 열리고 지난 오류·다시 시도는 사라진다
    await retryButton(page).first().click();
    await confirm(page).waitFor();
    assert.deepEqual((await state()).plans, ['001.md', '001.md', '001.md']);
    await confirm(page).getByText('이 화를 앞 화 3개와 비교할까요?').waitFor();
    await confirm(page).getByText(/최대 \$0\.0234/).waitFor();
    assert.equal(await page.getByText(/합성 계획 실패/).count(), 0);
    assert.equal(await retryButton(page).count(), 0);

    // 취소하면 아무것도 보내지 않고 닫히며, [이 화 검사]가 다시 활성이다
    await confirm(page).getByRole('button', { name: '취소' }).click();
    await confirm(page).waitFor({ state: 'detached' });
    await until(async () => await checkButton(page).isEnabled(), '취소 뒤 [이 화 검사]가 다시 활성이다');
    await settled(page);
    assert.deepEqual(await state(), { plans: ['001.md', '001.md', '001.md'], sends: 0 });
    assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true');
  } finally {
    await closeWindow(app);
  }
  assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), BODY);
});
