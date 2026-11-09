// AI 취소 요청의 늦은 실패 응답이 다음 작업·다른 프로젝트의 화면에 붙지 않는다 (PR193의 activeRun 가드 회귀검증).
// 합성 원고 두 프로젝트·격리 userData. ai:status(키 있음)·ai:estimate·ai:set-consent는 무료 대역이고, ai:analyze는 실제 실행에 들어가지 않는 합성 응답 장벽(호출 수·순번 해제), ai:cancel은 호출 수와 순번 대기(HOLD-FAIL)/성공 대역이다.
// 실행 IPC 진입은 합성 대역 호출 수이며 실제 외부 전송이 아니다. 실제 키 저장·실제 AI DB·유료 호출 0. 정상 앱의 프로젝트 전환·실행 확인·명시 동의 경로를 그대로 쓴다. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.
// 프로젝트 전환 중 main이 실행을 abort하는 동작은 합성 analyze 대역이 관측하지 않는다: A의 합성 analyze를 "풀어" 그 종료를 대신한다(아래에서 구분해 적는다).

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

interface G {
  analyzes: number;
  cancels: number;
  writes: number;
  /** i번째 ai:analyze를 푸는 함수들 (순번) */
  analyzeRelease: (() => void)[];
  /** i번째 ai:cancel을 푸는 함수들 (순번) */
  cancelRelease: (() => void)[];
  /** 다음 ai:cancel 호출들의 결과: 'HOLD-FAIL'(붙잡았다가 거절), 'OK' */
  cancelOutcomes: string[];
}
const g = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { g: G }).g; return { analyzes: x.analyzes, cancels: x.cancels, writes: x.writes }; });
const releaseAnalyze = (app: ElectronApplication, i: number) => app.evaluate((_e, i) => (globalThis as unknown as { g: G }).g.analyzeRelease[i]?.(), i);
const releaseCancel = (app: ElectronApplication, i: number) => app.evaluate((_e, i) => (globalThis as unknown as { g: G }).g.cancelRelease[i]?.(), i);
const slot = (page: Page) => page.locator('.analysis');
const cancelButton = (page: Page) => slot(page).getByRole('button', { name: '취소', exact: true });
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function project(prefix: string, marker: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, `# 1화\n\n${marker}\n`);
  return { dir, path, text: `# 1화\n\n${marker}\n` };
}

async function start(prefix: string, cancelOutcomes: string[]) {
  const a = await project(`${prefix}-a`, 'A_BODY');
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await app.evaluate(({ ipcMain }, outcomes) => {
    const x = globalThis as unknown as { g: G };
    x.g = { analyzes: 0, cancels: 0, writes: 0, analyzeRelease: [], cancelRelease: [], cancelOutcomes: outcomes };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const status = handlers.get('ai:status')!;
    handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
    handlers.set('ai:set-consent', async () => undefined);
    handlers.set('ai:estimate', async () => ({ chars: 100, costUsd: 0.01 }));
    handlers.set('ai:analyze', async () => {
      x.g.analyzes++;
      await new Promise<void>((resolve) => x.g.analyzeRelease.push(resolve));
      return { total: 1, done: 1, failed: [], costUsd: 0.01, stopped: null };
    });
    handlers.set('ai:cancel', async () => {
      x.g.cancels++;
      const outcome = x.g.cancelOutcomes.shift() ?? 'OK';
      if (outcome === 'HOLD-FAIL') {
        await new Promise<void>((resolve) => x.g.cancelRelease.push(resolve));
        throw new Error('EACCES: permission denied (synthetic late cancel failure)');
      }
    });
    const write = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      x.g.writes++;
      return write(...args);
    });
  }, cancelOutcomes);
  await stubFolderDialog(app, a.dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('A_BODY', { exact: true }).waitFor();
  return { app, page, a, pageErrors };
}
/** 이 화 분석을 실제 확인 창(명시 동의)을 거쳐 시작한다: 합성 analyze가 n번째로 들어올 때까지 */
async function begin(app: ElectronApplication, page: Page, n: number) {
  await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
  await page.getByRole('dialog', { name: 'AI 실행 확인' }).locator('button.primary').click();
  await until(`합성 실행 진입 ${n}`, async () => (await g(app)).analyzes === n);
  await cancelButton(page).waitFor();
}
const noLateMarks = async (page: Page, what: string) => {
  assert.equal(await slot(page).getByRole('alert').count(), 0, `${what}: 오류 안내가 붙지 않았다`);
  assert.equal(await slot(page).getByText(/취소 요청을 보내지 못했습니다|취소를 요청했습니다|취소 요청을 보내는 중/).count(), 0, `${what}: 취소 안내가 붙지 않았다`);
};

test('같은 프로젝트: A의 취소 응답을 붙잡은 채 A가 끝나고 B가 시작된 뒤 A의 늦은 취소 실패가 와도 B에는 아무것도 붙지 않고, B 자신의 취소는 동작한다', { timeout: 120_000 }, async () => {
  const { app, page, a, pageErrors } = await start('aclo-same', ['HOLD-FAIL', 'OK']);
  try {
    await begin(app, page, 1); // A 작업
    await cancelButton(page).focus();
    await page.keyboard.press('Enter');
    await until('A의 취소 요청 대기', async () => (await g(app)).cancels === 1);
    await slot(page).getByText(/취소 요청을 보내는 중/).waitFor();
    // A 작업이 먼저 끝난다 (취소 응답은 아직 대기 중)
    await releaseAnalyze(app, 0);
    await slot(page).getByText(/화 1개 분석/).waitFor();
    await noLateMarks(page, 'A 종료 직후');
    // 같은 프로젝트에서 B 작업을 명시 확인 후 시작
    await begin(app, page, 2);
    await noLateMarks(page, 'B 시작 직후');
    // 이제 A의 늦은 취소 실패 응답을 푼다: B에는 아무것도 붙지 않고, B는 종료되지 않으며, 새 요청도 생기지 않는다
    await releaseCancel(app, 0);
    await frames(page);
    await noLateMarks(page, 'A의 늦은 실패 해제 뒤');
    assert.equal(await cancelButton(page).count(), 1, 'B는 계속 실행 중이다');
    assert.equal((await g(app)).cancels, 1, '늦은 응답이 새 취소 요청을 만들지 않았다');
    assert.equal(await slot(page).getByText(/화 1개 분석/).count(), 0, 'B가 종료된 것처럼 표시되지 않는다 (A의 이전 결과도 B 실행 중에는 보이지 않는다)');
    // B 자신의 취소는 이전 pending에 막히지 않고 동작한다 (요청 수락과 작업 종료는 구별)
    await cancelButton(page).focus();
    await page.keyboard.press('Space');
    await until('B의 취소 요청', async () => (await g(app)).cancels === 2);
    await slot(page).getByText(/취소를 요청했습니다/).waitFor();
    assert.equal(await cancelButton(page).count(), 1, '요청이 수락돼도 B 작업은 끝날 때까지 실행 중이다');
    await releaseAnalyze(app, 1);
    await slot(page).getByText(/화 1개 분석/).waitFor();
    await frames(page);
    assert.equal(await slot(page).getByText(/취소를 요청했습니다|취소 요청/).count(), 0, 'B가 끝나면 취소 안내도 사라진다');
    assert.deepEqual(pageErrors, [], 'pageerror 0');
    const end = await g(app);
    assert.deepEqual({ analyzes: end.analyzes, cancels: end.cancels, writes: end.writes }, { analyzes: 2, cancels: 2, writes: 0 }, '합성 실행 진입 2·취소 요청 2·저장 진입 0');
    assert.ok((await readFile(a.path, 'utf8')) === a.text, 'A 원고 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});

test('프로젝트 전환: A의 취소 응답을 붙잡은 채 프로젝트 B로 전환하고 B의 새 작업을 시작한 뒤 A의 늦은 취소 실패가 와도 B 화면에 섞이지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, a, pageErrors } = await start('aclo-switch', ['HOLD-FAIL', 'OK']);
  const b = await project('aclo-switch-b', 'B_BODY');
  try {
    await begin(app, page, 1); // 프로젝트 A의 작업
    await cancelButton(page).focus();
    await page.keyboard.press('Enter');
    await until('A의 취소 요청 대기', async () => (await g(app)).cancels === 1);
    // 프로젝트 B로 전환 (정상 앱의 열기 경로). 전환 중 main의 abort는 합성 analyze 대역이 관측하지 않으므로, A의 합성 analyze를 풀어 그 종료를 대신한다
    await stubFolderDialog(app, b.dir);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.locator('.ProseMirror').getByText('B_BODY', { exact: true }).waitFor();
    await releaseAnalyze(app, 0);
    await until('A 작업 종료 반영', async () => (await cancelButton(page).count()) === 0);
    await noLateMarks(page, 'B 프로젝트 전환 직후');
    // B에서 새 작업을 명시 확인 후 시작
    await begin(app, page, 2);
    await noLateMarks(page, 'B 작업 시작 직후');
    // A의 늦은 취소 실패를 푼다
    await releaseCancel(app, 0);
    await frames(page);
    await noLateMarks(page, 'A의 늦은 실패 해제 뒤(프로젝트 B)');
    assert.equal(await cancelButton(page).count(), 1, 'B 작업은 계속 실행 중이다');
    assert.equal((await g(app)).cancels, 1, '새 취소 요청이 생기지 않았다');
    // B 작업이 끝난 뒤 재사용: 다시 시작할 수 있고 취소 안내가 남지 않는다
    await releaseAnalyze(app, 1);
    await slot(page).getByText(/화 1개 분석/).waitFor();
    await frames(page);
    await noLateMarks(page, 'B 작업 종료 뒤');
    assert.equal(await page.getByRole('button', { name: '이 화 분석', exact: true }).isEnabled(), true, '새 작업 완료 뒤 재사용 가능');
    assert.deepEqual(pageErrors, [], 'pageerror 0');
    const end = await g(app);
    assert.deepEqual({ analyzes: end.analyzes, cancels: end.cancels, writes: end.writes }, { analyzes: 2, cancels: 1, writes: 0 }, '합성 실행 진입 2·취소 요청 1·저장 진입 0');
    assert.ok((await readFile(a.path, 'utf8')) === a.text && (await readFile(b.path, 'utf8')) === b.text, '두 프로젝트 원고 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});
