// AI 실행 전 계획 조회(ai:plan-check) 실패 안내의 [다시 시도]를 실제 키보드로 실행할 때 진행 중·재실패·성공(확인 창)에서 포커스가 BODY로 잃어지지 않는다.
// 합성 원고(BOM 없음 한 줄, 격리 userData). ai:status(키 있음)·ai:plan-check는 무료 대역(호출 수·요청 장벽·실패)이고, ai:analyze·ai:run-check는 호출 수만 세고 거절해 실제 전송을 막는다. 실행 확인 버튼은 누르지 않는다.
// Tab 이동은 실제 키보드(Shift+Tab), 시작점만 DOM focus. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. 유료·외부 호출 0.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BODY = '# ONE\n\nONE_BODY\n';

interface Plan {
  plans: number;
  sends: number;
  writes: number;
  /** 다음 ai:plan-check 호출들의 결과: 오류 메시지, 'OK', 'HOLD-FAIL'(붙잡았다가 거절), 'HOLD-OK'(붙잡았다가 성공) */
  outcomes: string[];
  release?: () => void;
}
const st = (app: ElectronApplication) => app.evaluate(() => { const g = (globalThis as unknown as { p: Plan }).p; return { plans: g.plans, sends: g.sends, writes: g.writes }; });
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { p: Plan }).p.release?.());
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.textContent?.slice(0, 14) ?? '', inAnalysis: !!el?.closest('.analysis'), inDialog: !!el?.closest('[role="dialog"]') };
  });
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const checkButton = (page: Page) => page.getByRole('button', { name: '이 화 검사', exact: true });
const retryButton = (page: Page) => page.getByRole('button', { name: '다시 시도', exact: true });
const confirm = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function start(prefix: string, outcomes: string[]) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, BODY);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await app.evaluate(({ ipcMain }, list) => {
    const g = globalThis as unknown as { p: Plan };
    g.p = { plans: 0, sends: 0, writes: 0, outcomes: list };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const status = handlers.get('ai:status')!;
    handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
    handlers.set('ai:plan-check', async () => {
      g.p.plans += 1;
      const outcome = g.p.outcomes.shift() ?? 'OK';
      if (outcome === 'HOLD-FAIL' || outcome === 'HOLD-OK') {
        await new Promise<void>((resolve) => (g.p.release = resolve));
        if (outcome === 'HOLD-FAIL') throw new Error('합성 계획 실패 (late)');
      } else if (outcome !== 'OK') throw new Error(outcome);
      return { analyze: [], priors: 3, batches: 1, costUsd: 0.0234 };
    });
    for (const channel of ['ai:analyze', 'ai:run-check']) {
      handlers.set(channel, async () => {
        g.p.sends++;
        throw new Error('합성 대역: 전송하지 않는다');
      });
    }
    const write = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.p.writes++;
      return write(...args);
    });
  }, outcomes);
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 8) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('ONE_BODY', { exact: true }).waitFor();
  await until('[이 화 검사] 활성', async () => await checkButton(page).isEnabled());
  // 첫 계획 실패 → 안내와 [다시 시도]
  await checkButton(page).click();
  await retryButton(page).waitFor();
  // 시작점만 DOM focus(기술 상세), [다시 시도]로의 이동은 실제 Shift+Tab
  await page.getByRole('button', { name: '기술 상세', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal((await active(page)).label, '다시 시도', '실제 Shift+Tab으로 다시 시도 버튼에 도달했다');
  return { app, page, path, log: () => page.evaluate('window.__f') };
}

test('계획 조회 [다시 시도]를 실제 Enter로 실행하면 진행 중·재실패에서 포커스가 BODY로 잃어지지 않고 새 오류의 상세는 접힌 채 시작한다', { timeout: 120_000 }, async () => {
  const { app, page, path, log } = await start('apr-fail', ['합성 계획 실패 1', 'HOLD-FAIL']);
  try {
    const base = await st(app);
    await page.keyboard.press('Enter');
    await until('붙잡은 계획 조회', async () => (await st(app)).plans === base.plans + 1);
    const inFlight = await active(page);
    assert.equal(inFlight.body, false, `진행 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(inFlight)} / ${JSON.stringify(await log())}`);
    assert.equal(inFlight.inAnalysis, true, '진행 중 포커스가 분석 영역 안에 있다');
    await release(app);
    await retryButton(page).waitFor();
    await frames(page);
    const failed = await active(page);
    assert.equal(failed.body, false, `재실패 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(failed)}`);
    assert.equal(failed.label, '다시 시도', '새 다시 시도 버튼으로 돌아온다');
    assert.equal(await page.locator('.analysis .tech-detail').count(), 0, '새 오류의 기술 상세는 접힌 채 시작한다');
    const end = await st(app);
    assert.equal(end.plans, base.plans + 1, '조회는 눌린 만큼만');
    assert.equal(end.sends, 0, 'AI 실행(ai:analyze·ai:run-check) 진입 0');
    assert.equal(end.writes, 0, '저장 진입 0');
    assert.ok((await readFile(path, 'utf8')) === BODY, '원고 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});

test('계획 조회 [다시 시도]를 Space로 실행해 성공하면 확인 창이 포커스를 받고, 취소(Escape)로 닫으면 포커스가 BODY로 잃어지지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, path } = await start('apr-ok', ['합성 계획 실패 1', 'HOLD-OK']);
  try {
    const base = await st(app);
    await page.keyboard.press('Space');
    await until('붙잡은 계획 조회', async () => (await st(app)).plans === base.plans + 1);
    assert.equal((await active(page)).body, false, '진행 중 포커스가 BODY가 아니다');
    await release(app);
    await confirm(page).waitFor();
    await frames(page);
    const opened = await active(page);
    assert.equal(opened.inDialog, true, '정상 확인 창이 포커스를 받는다');
    await confirm(page).getByText(/최대 \$0\.0234/).waitFor();
    await page.keyboard.press('Escape');
    await confirm(page).waitFor({ state: 'detached' });
    await frames(page);
    const closed = await active(page);
    assert.equal(closed.body, false, `확인 창을 닫은 뒤에도 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(closed)}`);
    assert.equal(closed.connected, true);
    const end = await st(app);
    assert.equal(end.sends, 0, 'AI 실행 진입 0');
    assert.equal(end.writes, 0, '저장 진입 0');
    assert.ok((await readFile(path, 'utf8')) === BODY, '원고 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});

test('대기 중 사용자가 실제 Shift+Tab으로 옮긴 포커스는 늦은 실패가 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page } = await start('apr-moved', ['합성 계획 실패 1', 'HOLD-FAIL']);
  try {
    const base = await st(app);
    await page.keyboard.press('Enter');
    await until('붙잡은 계획 조회', async () => (await st(app)).plans === base.plans + 1);
    await page.keyboard.press('Shift+Tab'); // 사용자가 실제 키보드로 옮긴다
    const moved = await active(page);
    assert.equal(moved.body, false);
    await release(app);
    await retryButton(page).waitFor();
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 실패가 사용자가 옮긴 포커스를 빼앗지 않았다');
    assert.equal((await st(app)).sends, 0);
  } finally {
    await closeWindow(app);
  }
});
