// 같은 프로젝트의 AI 상태 재조회가 겹칠 때 응답 순서: 최신 조회만 배지·비용·오류에 반영하고, 늦게 끝난 이전 조회의 성공·실패가 최신 화면을 덮지 않는다.
// 실제 앱(Electron + Playwright). 명령 팔레트의 기존 [AI 분석·검사 결과 다시 읽기]로 조회를 겹친다. ai:analysis-status는 무료 대역(붙잡기·합성 응답). OpenAI 접근 0.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const FAIL = '합성 상태 조회 실패';
const COST_A = '1.1111';
const COST_B = '2.2222';

async function project(): Promise<string> {
  const dir = await tempDir('ai-status-order');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# ONE\n\nONE_BODY\n');
  return dir;
}

type Late = 'ok' | 'fail';
/** 초기 조회 뒤의 두 조회: 1번째(A)는 붙잡았다가 release로 풀면 late대로 끝나고(ok: A 합성 응답), 2번째(B)는 곧바로 B 합성 응답을 낸다 */
async function script(app: ElectronApplication, late: Late) {
  await app.evaluate(
    ({ ipcMain }, { late, message }) => {
      const g = globalThis as unknown as { n: number; heldA: boolean; doneA: boolean; releaseA?: () => void };
      g.n = 0;
      g.heldA = false;
      g.doneA = false;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:analysis-status')!;
      handlers.set('ai:analysis-status', async (...args: unknown[]) => {
        const i = g.n++;
        const base = (await original(...args)) as { totalCostUsd: number; states: Record<string, string> };
        if (i === 0) {
          g.heldA = true;
          await new Promise<void>((resolve) => (g.releaseA = resolve));
          g.doneA = true;
          if (late === 'fail') throw new Error(message);
          return { ...base, totalCostUsd: 1.1111 };
        }
        return { ...base, totalCostUsd: 2.2222, states: { ...base.states, '001.md': 'fresh' } };
      });
    },
    { late, message: FAIL },
  );
}
const flag = (app: ElectronApplication, key: 'heldA' | 'doneA') => app.evaluate((_, k) => (globalThis as unknown as Record<string, boolean>)[k]!, key);
const releaseA = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { releaseA: () => void }).releaseA());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const cost = (page: Page, v: string) => page.getByText(`이 프로젝트 AI 비용 $${v}`);
const failNote = (page: Page) => page.getByText(FAIL);

/** 명령 팔레트로 [AI 분석·검사 결과 다시 읽기]를 실행한다 */
async function reread(page: Page) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '명령 팔레트' });
  await palette.getByRole('option', { name: /AI 분석·검사 결과 다시 읽기/ }).click();
  await palette.waitFor({ state: 'detached' });
}

for (const late of ['ok', 'fail'] as const) {
  test(`같은 프로젝트의 재조회가 겹칠 때 늦게 ${late === 'ok' ? '성공한' : '실패한'} 이전 조회는 최신 조회의 배지·비용·오류를 덮지 않는다`, { timeout: 90_000 }, async () => {
    const dir = await project();
    const { app, page } = await launch(await tempDir('ai-status-order-ud'));
    try {
      await stubFolderDialog(app, dir);
      await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
      await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'ONE' }).waitFor();
      await page.getByRole('button', { name: '이 화 분석', exact: true }).waitFor();
      await settled(page);
      await script(app, late);
      await reread(page); // A: 붙잡는다
      await until(() => flag(app, 'heldA'), 'A 조회를 붙잡았다');
      await reread(page); // B: 곧바로 합성 응답
      await cost(page, COST_B).waitFor();
      await releaseA(app);
      await until(() => flag(app, 'doneA'), 'A 응답이 끝났다');
      await settled(page);
      assert.equal(await cost(page, COST_B).count(), 1, '늦은 이전 조회가 최신 비용을 덮지 않는다');
      assert.equal(await cost(page, COST_A).count(), 0);
      assert.equal(await failNote(page).count(), 0, '늦은 이전 조회의 실패가 최신 성공 뒤 오류로 나타나지 않는다');
    } finally {
      await closeWindow(app);
    }
  });
}

test('최신 조회의 실패는 안내로 남고, 다시 읽어 성공하면 이 조회가 만든 오류만 거두며 다른 오류는 남긴다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('ai-status-order-recover-ud'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('button', { name: '이 화 분석', exact: true }).waitFor();
    await settled(page);
    await app.evaluate(({ ipcMain }, message) => {
      const g = globalThis as unknown as { n: number };
      g.n = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:analysis-status')!;
      handlers.set('ai:analysis-status', async (...args: unknown[]) => {
        if (g.n++ === 0) throw new Error(message);
        return original(...args);
      });
    }, FAIL);
    await reread(page);
    await failNote(page).first().waitFor();
    await reread(page);
    await until(async () => (await failNote(page).count()) === 0, '다시 읽어 성공하면 이 조회의 오류가 거두어진다');
  } finally {
    await closeWindow(app);
  }
});
