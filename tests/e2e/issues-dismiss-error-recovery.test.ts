// 문제 가능성 패널: [무시]가 한 번 실패해 오류를 보인 뒤 같은 결과의 재시도가 성공하면, 이전 실패를 현재 오류로 남기지 않는다.
// 화를 거치거나 새로 읽은 뒤 이전 요청의 늦은 실패·성공이 현재 결과의 안내를 바꾸지 않는다. 합성 원고·합성 검사 결과·격리 userData, ai:dismiss는 무료 대역 (OpenAI 접근 0).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const FAIL = '합성 무시 실패';

async function project(): Promise<string> {
  const dir = await tempDir('issues-dismiss-recovery');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# ONE\n\nONE_BODY\n');
  await writeFile(join(dir, 'chapters', '002.md'), '# TWO\n\nTWO_BODY\n');
  const db = AiStore.open(dir);
  db.saveCheck({
    file: '001.md',
    contentHash: 'synthetic',
    model: 'fake',
    modelVersion: 'fake',
    promptVersion: 'fake',
    factCount: 0,
    dropped: 0,
    costUsd: 0,
    createdAt: new Date().toISOString(),
    inputs: [],
    findings: [{ category: 'age', claim: 'ONE_CLAIM', confidence: 0.9, key: 'one', target: { quote: 'ONE_BODY', line: 3, start: 0, end: 8 }, evidence: [] }],
  });
  db.close();
  return dir;
}
function dismissed(dir: string): boolean[] {
  const db = AiStore.open(dir);
  try {
    return db.check('001.md')!.findings.map((f) => f.dismissed);
  } finally {
    db.close();
  }
}
const issues = (page: Page) => page.getByRole('region', { name: '문제 가능성' });
const dismissButton = (page: Page) => issues(page).getByRole('button', { name: '무시', exact: true });
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const editor = (page: Page) => page.locator('.ProseMirror');
const failNote = (page: Page) => issues(page).getByText(new RegExp(FAIL));

test('무시 실패 뒤 같은 결과의 재시도가 성공하면 이전 실패 안내가 사라지고, 반복 실패는 안내와 재시도를 유지한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('issues-dismiss-recovery-ud'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
    // 앞의 두 번만 처리기 앞에서 거절한다(저장 없음), 그 뒤는 실제 처리기
    await app.evaluate(({ ipcMain }, message) => {
      const g = globalThis as unknown as { dismissCalls: number };
      g.dismissCalls = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:dismiss')!;
      handlers.set('ai:dismiss', async (...args: unknown[]) => {
        if (++g.dismissCalls <= 2) throw new Error(message);
        return original(...args);
      });
    }, FAIL);

    await dismissButton(page).click();
    await failNote(page).waitFor();
    // 반복 실패: 오류와 재시도 가능성이 남는다
    await dismissButton(page).click();
    assert.equal(await app.evaluate(() => (globalThis as unknown as { dismissCalls: number }).dismissCalls), 2);
    await failNote(page).waitFor();
    assert.equal(await dismissButton(page).isEnabled(), true);

    // 세 번째 시도는 성공한다: 재조회로 결과가 무시됨 상태가 되고, 옛 실패 안내는 남지 않는다
    await dismissButton(page).click();
    await issues(page).getByText('찾은 문제 가능성이 없습니다.').waitFor();
    await issues(page).getByRole('button', { name: /무시한 결과 1개 보기/ }).waitFor();
    assert.equal(await failNote(page).count(), 0, '성공한 뒤에는 이전 무시 실패를 현재 오류로 남기지 않는다');
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir), [true]);
});

type Step = 'hold-fail' | 'hold-ok' | 'fail';
/** ai:dismiss의 n번째 호출을 steps[n]대로 처리한다. hold-*는 처리기를 부르기 전에 붙잡고(release로 풀면 fail은 거절, ok는 실제 처리기), fail은 곧바로 거절한다 */
async function script(app: ElectronApplication, steps: Step[]) {
  await app.evaluate(
    ({ ipcMain }, { steps, message }) => {
      const g = globalThis as unknown as { calls: number; rejected: boolean; release: Record<number, () => void> };
      g.calls = 0;
      g.rejected = false;
      g.release = {};
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:dismiss')!;
      handlers.set('ai:dismiss', async (...args: unknown[]) => {
        const n = g.calls++;
        const step = steps[n] ?? 'ok';
        if (step === 'fail') throw new Error(message);
        if (step === 'hold-fail' || step === 'hold-ok') await new Promise<void>((resolve) => (g.release[n] = resolve));
        if (step === 'hold-fail') {
          g.rejected = true;
          throw new Error(message);
        }
        return original(...args);
      });
    },
    { steps, message: FAIL },
  );
}
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { calls: number }).calls);
const released = (app: ElectronApplication, n: number) => app.evaluate((_, i) => (globalThis as unknown as { release: Record<number, () => void> }).release[i] !== undefined, n);
const release = (app: ElectronApplication, n: number) => app.evaluate((_, i) => (globalThis as unknown as { release: Record<number, () => void> }).release[i]!(), n);
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function openAndAwayAndBack(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
}
async function awayAndBack(page: Page) {
  await list(page).getByRole('button', { name: 'TWO' }).click();
  await editor(page).getByText('TWO_BODY', { exact: true }).waitFor();
  await issues(page).getByText(/아직 검사하지 않은 화입니다/).waitFor();
  await list(page).getByRole('button', { name: 'ONE' }).click();
  await editor(page).getByText('ONE_BODY', { exact: true }).waitFor();
  await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
  await until(() => dismissButton(page).isEnabled(), '새 조회 뒤 [무시]가 다시 눌린다');
}

test('다른 화를 거쳐 새로 읽은 뒤 이전 무시 요청이 늦게 실패해도 현재 결과에 안내가 나타나지 않고, 현재 결과의 무시는 그대로 동작한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('issues-dismiss-late-fail-ud'));
  try {
    await openAndAwayAndBack(app, page, dir);
    await script(app, ['hold-fail']);
    await dismissButton(page).click();
    await until(async () => (await calls(app)) === 1 && (await released(app, 0)), '첫 무시 응답을 붙잡았다');
    await awayAndBack(page);
    await release(app, 0);
    // main이 거절했음을 확인하고, 그 거절이 renderer에 도착해 처리되도록 프레임을 양보한 뒤 확인한다
    await until(() => app.evaluate(() => (globalThis as unknown as { rejected: boolean }).rejected), '붙잡은 요청이 거절됐다');
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    assert.equal(await failNote(page).count(), 0, '이전 문맥의 늦은 무시 실패가 현재 결과에 나타나지 않는다');
    // 현재 결과의 무시는 정상이다
    await dismissButton(page).click();
    await issues(page).getByText('찾은 문제 가능성이 없습니다.').waitFor();
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir), [true]);
});

test('같은 결과의 최신 무시 실패 안내는 이전 요청의 늦은 성공이 지우지 않는다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('issues-dismiss-late-ok-ud'));
  try {
    await openAndAwayAndBack(app, page, dir);
    // 첫 요청은 붙잡고, 같은 결과에서 다시 누른 두 번째 요청은 실패한다. 그 뒤 첫 요청이 성공(저장)으로 끝난다
    await script(app, ['hold-ok', 'fail']);
    await dismissButton(page).click();
    await until(async () => (await calls(app)) === 1 && (await released(app, 0)), '첫 무시 응답을 붙잡았다');
    await dismissButton(page).click();
    await failNote(page).waitFor();
    await release(app, 0);
    await issues(page).getByRole('button', { name: /무시한 결과 1개 보기/ }).waitFor();
    // 저장은 성공했고 다시 읽었다. 같은 결과의 최신 실패 안내는 이전 요청의 성공이 지우지 않는다
    assert.equal(await failNote(page).count(), 1, '최신 요청의 실패 안내는 이전 요청의 늦은 성공이 지우지 않는다');
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir), [true]);
});
