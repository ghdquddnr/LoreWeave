// 한 프로젝트에서 '이 화 검사' 계획이 실패해 오류·다시 시도가 보인 뒤 같은 이름(001.md)의 화를 가진 다른 프로젝트로 옮기면, 이전 오류·다시 시도가 남지 않는다.
// 프로젝트를 바꾸면 AnalysisBar가 언마운트되어(App: ai=null·switching 동안 그리지 않음) 이전 상태가 남지 않는 구조를 보호하는 회귀 검사다 (발견한 결함의 수정이 아니다).
// 합성 A/B 프로젝트·격리 userData. ai:status(키 있음)·ai:plan-check(첫 요청만 거절)는 무료 대역이고 ai:analyze·ai:run-check는 호출 수만 세고 거절한다. 확인 버튼은 누르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const FAIL = '합성 계획 실패';
async function project(prefix: string, marker: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `# ${marker}\n\n${marker}_BODY\n`);
  return dir;
}
const checkButton = (page: Page) => page.getByRole('button', { name: '이 화 검사', exact: true });
const confirm = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('A의 계획 실패 오류·다시 시도는 같은 이름의 화를 가진 B로 옮기면 남지 않고, B의 새 계획은 정상으로 시작·취소된다', { timeout: 90_000 }, async () => {
  const A = await project('plan-scope-A', 'AAA');
  const B = await project('plan-scope-B', 'BBB');
  const { app, page } = await launch(await tempDir('plan-scope-ud'));
  try {
    await app.evaluate(({ ipcMain }, message) => {
      const g = globalThis as unknown as { plans: number; sends: number };
      g.plans = 0;
      g.sends = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const status = handlers.get('ai:status')!;
      handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
      handlers.set('ai:plan-check', async () => {
        if (g.plans++ === 0) throw new Error(message);
        return { analyze: [], priors: 1, batches: 1, costUsd: 0.01 };
      });
      for (const channel of ['ai:analyze', 'ai:run-check']) {
        handlers.set(channel, async () => {
          g.sends++;
          throw new Error('합성 대역: 전송하지 않는다');
        });
      }
    }, FAIL);
    await stubFolderDialog(app, A);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').getByText('AAA_BODY', { exact: true }).waitFor();
    await checkButton(page).waitFor();
    await until(async () => await checkButton(page).isEnabled(), 'A에서 [이 화 검사]가 활성이다');
    await checkButton(page).click();
    await page.getByText(FAIL).first().waitFor();
    await page.getByRole('button', { name: '다시 시도' }).first().waitFor();
    // B로 옮긴다
    await stubFolderDialog(app, B);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.locator('.ProseMirror').getByText('BBB_BODY', { exact: true }).waitFor();
    await until(async () => await checkButton(page).isEnabled(), 'B에서 [이 화 검사]가 활성이다');
    await settled(page);
    assert.equal(await page.getByText(FAIL).count(), 0, 'A의 계획 오류가 B에 남지 않는다');
    assert.equal(await page.getByRole('button', { name: '다시 시도' }).count(), 0, 'A의 다시 시도가 B에 남지 않는다');
    // B의 새 계획은 정상이고 취소할 수 있다
    await checkButton(page).click();
    await confirm(page).waitFor();
    await confirm(page).getByRole('button', { name: '취소' }).click();
    await confirm(page).waitFor({ state: 'detached' });
    assert.equal(await app.evaluate(() => (globalThis as unknown as { sends: number }).sends), 0, '실행 IPC 0');
    assert.equal(await readFile(join(A, 'chapters', '001.md'), 'utf8'), '# AAA\n\nAAA_BODY\n');
    assert.equal(await readFile(join(B, 'chapters', '001.md'), 'utf8'), '# BBB\n\nBBB_BODY\n');
  } finally {
    await closeWindow(app);
  }
});
