// '이 화 검사' 계획을 기다리는 사이 다른 화로 옮기면, 늦게 온 이전 화의 계획이 지금 화의 확인 창으로 열리지 않는다 (A→B, A→B→A 모두).
// 실제 앱(Electron + Playwright). 합성 001/002 원고·격리 userData. ai:status(키 있음)·ai:plan-check(합성 계획, 첫 요청은 붙잡기)는 무료 대역이고,
// ai:analyze·ai:run-check는 호출 수만 세고 무료로 거절해 실제 API 전송을 막는다. 실행 확인 버튼은 누르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(): Promise<string> {
  const dir = await tempDir('check-plan-owner');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# ONE\n\nONE_BODY\n');
  await writeFile(join(dir, 'chapters', '002.md'), '# TWO\n\nTWO_BODY\n');
  return dir;
}
/** plan-check의 첫 요청(A)은 붙잡았다가 release로 풀고, 그 뒤 요청은 곧바로 합성 계획을 돌려준다 */
async function script(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { plans: string[]; sends: number; heldA: boolean; doneA: boolean; releaseA?: () => void };
    g.plans = [];
    g.sends = 0;
    g.heldA = false;
    g.doneA = false;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const status = handlers.get('ai:status')!;
    handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
    const plan = { analyze: [], priors: 1, batches: 1, costUsd: 0.01 };
    handlers.set('ai:plan-check', async (_e: unknown, file: unknown) => {
      g.plans.push(String(file));
      if (g.plans.length === 1) {
        g.heldA = true;
        await new Promise<void>((resolve) => (g.releaseA = resolve));
        g.doneA = true;
      }
      return plan;
    });
    for (const channel of ['ai:analyze', 'ai:run-check']) {
      handlers.set(channel, async () => {
        g.sends++;
        throw new Error('합성 대역: 전송하지 않는다');
      });
    }
  });
}
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as { plans: string[]; sends: number; heldA: boolean; doneA: boolean };
    return { plans: g.plans, sends: g.sends, heldA: g.heldA, doneA: g.doneA };
  });
const releaseA = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { releaseA: () => void }).releaseA());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const confirm = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });
const checkButton = (page: Page) => page.getByRole('button', { name: '이 화 검사', exact: true });

async function openAndStartCheckOnA(app: ElectronApplication, page: Page, dir: string) {
  await script(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).getByText('ONE_BODY', { exact: true }).waitFor();
  await until(async () => await checkButton(page).isEnabled(), '[이 화 검사]가 활성이다');
  await checkButton(page).click();
  await until(async () => (await state(app)).heldA, 'A의 계획 요청이 도착해 붙잡혔다');
}
async function goTo(page: Page, title: string, marker: string) {
  await list(page).getByRole('button', { name: title }).click();
  await editor(page).getByText(marker, { exact: true }).waitFor();
}
async function releaseAndExpectNoDialog(app: ElectronApplication, page: Page, dir: string) {
  await releaseA(app);
  await until(async () => (await state(app)).doneA, 'A 응답이 끝났다');
  await settled(page);
  assert.equal(await confirm(page).count(), 0, '늦게 온 이전 화의 계획이 확인 창을 열지 않는다');
  assert.equal((await state(app)).sends, 0, '전송 요청 0');
  await until(async () => await checkButton(page).isEnabled(), '옛 계획이 정리된 뒤 [이 화 검사]가 다시 활성이다');
  assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), '# ONE\n\nONE_BODY\n');
  assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), '# TWO\n\nTWO_BODY\n');
}

test('A에서 [이 화 검사]를 누르고 계획을 기다리는 사이 B로 옮기면, 늦게 온 A의 계획은 확인 창을 열지 않고 B의 새 검사는 정상으로 시작·취소된다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('check-plan-owner-ud'));
  try {
    await openAndStartCheckOnA(app, page, dir);
    await goTo(page, 'TWO', 'TWO_BODY');
    await releaseAndExpectNoDialog(app, page, dir);
    // B의 새 검사: 계획 요청이 B 대상으로 가고 확인 창이 열리며, 취소하면 아무것도 보내지 않는다
    await checkButton(page).click();
    await confirm(page).waitFor();
    assert.deepEqual((await state(app)).plans, ['001.md', '002.md']);
    await confirm(page).getByRole('button', { name: '취소' }).click();
    await confirm(page).waitFor({ state: 'detached' });
    assert.equal((await state(app)).sends, 0);
  } finally {
    await closeWindow(app);
  }
});

test('A→B→A로 돌아온 뒤 풀린 옛 A 계획도 새 의도로 취급하지 않아 확인 창을 열지 않는다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('check-plan-owner-aba-ud'));
  try {
    await openAndStartCheckOnA(app, page, dir);
    await goTo(page, 'TWO', 'TWO_BODY');
    await goTo(page, 'ONE', 'ONE_BODY');
    await releaseAndExpectNoDialog(app, page, dir);
  } finally {
    await closeWindow(app);
  }
});

test('같은 화에서 기다린 유효한 계획은 그대로 확인 창을 연다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('check-plan-owner-same-ud'));
  try {
    await openAndStartCheckOnA(app, page, dir);
    await releaseA(app);
    await confirm(page).waitFor();
    await confirm(page).getByRole('button', { name: '취소' }).click();
    await confirm(page).waitFor({ state: 'detached' });
    assert.equal((await state(app)).sends, 0);
  } finally {
    await closeWindow(app);
  }
});

test('계획을 기다리는 사이 화를 옮기면 옛 계획을 기다리지 않고 B에서 바로 검사를 시작할 수 있다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('check-plan-owner-b-ud'));
  try {
    await openAndStartCheckOnA(app, page, dir);
    await goTo(page, 'TWO', 'TWO_BODY');
    await until(async () => await checkButton(page).isEnabled(), '옛 A 응답을 기다리지 않고 B에서 [이 화 검사]가 활성이다');
    await checkButton(page).click();
    await confirm(page).waitFor();
    assert.deepEqual((await state(app)).plans, ['001.md', '002.md']);
    await confirm(page).getByRole('button', { name: '취소' }).click();
    // 그 뒤 풀린 옛 A 응답은 B의 진행·잠금 상태를 건드리지 않는다
    await releaseA(app);
    await until(async () => (await state(app)).doneA, 'A 응답이 끝났다');
    await settled(page);
    assert.equal(await confirm(page).count(), 0);
    assert.equal(await checkButton(page).isEnabled(), true);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
    assert.equal((await state(app)).sends, 0);
  } finally {
    await closeWindow(app);
  }
});
