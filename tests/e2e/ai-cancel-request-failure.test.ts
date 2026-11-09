// 실행 중 AI 작업의 [취소] 요청(ai:cancel IPC)이 거절될 때: 조용히 실패하거나 처리되지 않은 Promise 거절로 남지 않고, 사용자용 요약 + 접힌 기술 상세로 알리며,
// 작업은 응답이 올 때까지 실행 중으로 남고(취소 완료·분석 실패로 표시하지 않음), 명시적 수동 재시도만 허용한다. 성공 응답은 "요청을 보냈다"일 뿐 작업 종료가 아니다.
// 합성 원고·격리 userData. ai:status(키 있음)·ai:estimate·ai:set-consent는 무료 대역이고, ai:analyze는 실제 실행에 들어가지 않는 합성 응답 장벽(호출 수만 센다), ai:cancel은 순번 실패/대기/성공 대역이다.
// 실행 IPC 진입은 합성 대역 호출 수이며 실제 외부 전송이 아니다. 실제 키 저장·실제 AI DB·유료 호출 0. Enter/Space는 실제 키보드. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BODY = '# ONE\n\nONE_BODY\n';

interface G {
  analyzes: number;
  cancels: number;
  writes: number;
  /** 다음 ai:cancel 호출들의 결과: 오류 메시지, 'OK', 'HOLD-OK'(붙잡았다가 성공) */
  cancelOutcomes: string[];
  cancelRelease?: () => void;
  analyzeRelease?: () => void;
}
const g = (app: ElectronApplication) => app.evaluate(() => { const x = (globalThis as unknown as { g: G }).g; return { analyzes: x.analyzes, cancels: x.cancels, writes: x.writes }; });
const releaseAnalyze = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { g: G }).g.analyzeRelease?.());
const releaseCancel = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { g: G }).g.cancelRelease?.());
const slot = (page: Page) => page.locator('.analysis');
const cancelButton = (page: Page) => slot(page).getByRole('button', { name: '취소', exact: true });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, label: el?.textContent?.slice(0, 14) ?? '', inAnalysis: !!el?.closest('.analysis') };
  });
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function start(prefix: string, cancelOutcomes: string[]) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, BODY);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await app.evaluate(({ ipcMain }, outcomes) => {
    const x = globalThis as unknown as { g: G };
    x.g = { analyzes: 0, cancels: 0, writes: 0, cancelOutcomes: outcomes };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const status = handlers.get('ai:status')!;
    handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
    handlers.set('ai:set-consent', async () => undefined);
    handlers.set('ai:estimate', async () => ({ chars: 100, costUsd: 0.01 }));
    handlers.set('ai:analyze', async () => {
      x.g.analyzes++;
      await new Promise<void>((resolve) => (x.g.analyzeRelease = resolve));
      return { total: 1, done: 1, failed: [], costUsd: 0.01, stopped: null };
    });
    handlers.set('ai:cancel', async () => {
      x.g.cancels++;
      const outcome = x.g.cancelOutcomes.shift() ?? 'OK';
      if (outcome === 'HOLD-OK') await new Promise<void>((resolve) => (x.g.cancelRelease = resolve));
      else if (outcome !== 'OK') throw new Error(outcome);
    });
    const write = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      x.g.writes++;
      return write(...args);
    });
  }, cancelOutcomes);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('ONE_BODY', { exact: true }).waitFor();
  // 합성 계획·동의로 실행 상태(running)를 만든다: 실제 실행(ai:analyze)은 합성 응답 장벽에서 대기한다
  await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
  await page.getByRole('dialog', { name: 'AI 실행 확인' }).getByRole('button', { name: '동의하고 실행' }).click();
  await until('합성 실행 진입', async () => (await g(app)).analyzes === 1);
  await cancelButton(page).waitFor();
  return { app, page, path, pageErrors };
}

test('취소 요청이 거절되면 사용자용 요약과 접힌 기술 상세로 알리고 작업은 실행 중으로 남으며, 수동 재시도만 취소를 다시 요청한다', { timeout: 120_000 }, async () => {
  const { app, page, path, pageErrors } = await start('acrf-fail', ['EACCES: permission denied (synthetic cancel 1)', 'EACCES: permission denied (synthetic cancel 2)', 'OK']);
  try {
    // 실제 Enter로 취소 요청 → 거절
    await cancelButton(page).focus();
    await page.keyboard.press('Enter');
    await until('취소 요청 1회', async () => (await g(app)).cancels === 1);
    const note = slot(page).getByRole('alert');
    await note.waitFor({ timeout: 10_000 });
    assert.match(await note.innerText(), /취소 요청을 보내지 못했습니다/, '요약 안내');
    assert.doesNotMatch(await note.innerText(), /EACCES|Error invoking/, '기본 안내에 코드·IPC 문구가 없다');
    assert.equal(await note.locator('.tech-detail').count(), 0, '기술 상세는 접힌 채 시작한다');
    await note.getByRole('button', { name: '기술 상세' }).click();
    assert.ok(((await note.locator('.tech-detail').textContent()) ?? '').includes('synthetic cancel 1'), '펼치면 원문 상세');
    // 작업은 계속 실행 중이다: 분석 실패·취소 완료로 표시하지 않는다
    assert.equal(await cancelButton(page).count(), 1, '취소 버튼이 남아 실행 중이다');
    assert.equal(await slot(page).getByText(/분석 중|검사 중/).count(), 1, '실행 중 표시가 남아 있다');
    assert.equal(await slot(page).getByText(/멈춤|실패|취소됨/).count(), 0, '분석 실패·취소 완료로 표시하지 않는다');
    // 수동 재시도(실제 Space): 새 요청, 또 거절 → 새 오류의 상세는 접힌 채 시작하고 포커스는 BODY로 잃어지지 않는다
    await note.getByRole('button', { name: '다시 취소' }).focus();
    await page.keyboard.press('Space');
    await until('취소 요청 2회', async () => (await g(app)).cancels === 2);
    await note.locator('.tech-detail').waitFor({ state: 'detached' });
    const afterRetry = await active(page);
    assert.equal(afterRetry.body, false, `재시도 중·재실패 뒤 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(afterRetry)}`);
    await note.getByRole('button', { name: '기술 상세' }).click();
    const second = (await note.locator('.tech-detail').textContent()) ?? '';
    assert.ok(second.includes('synthetic cancel 2') && !second.includes('synthetic cancel 1'), '이전 실패의 상세가 남지 않는다');
    // 세 번째는 성공: 요청이 받아들여졌을 뿐 작업 종료가 아니다(작업은 아직 실행 중)
    await note.getByRole('button', { name: '다시 취소' }).focus();
    await page.keyboard.press('Enter');
    await until('취소 요청 3회', async () => (await g(app)).cancels === 3);
    await slot(page).getByText(/취소를 요청했습니다/).waitFor();
    assert.equal(await cancelButton(page).count(), 1, '요청이 수락돼도 실제 작업이 끝날 때까지 실행 중이다');
    assert.equal(await slot(page).getByRole('alert').count(), 0, '성공하면 이전 오류가 사라진다');
    // 작업이 끝나면 취소 안내도 사라지고(다음 작업에 남지 않음) 결과가 보인다
    await releaseAnalyze(app);
    await slot(page).getByText(/화 1개 분석/).waitFor();
    assert.equal(await slot(page).getByText(/취소를 요청했습니다|취소 요청/).count(), 0, '끝난 작업의 취소 안내가 남지 않는다');
    assert.deepEqual(pageErrors, [], '처리되지 않은 Promise 거절(pageerror) 0');
    const end = await g(app);
    assert.equal(end.cancels, 3, '취소 요청은 사용자가 누른 횟수만큼 (자동 재시도 없음)');
    assert.equal(end.analyzes, 1, '분석 재실행·새 계획 동의 우회 0 (합성 실행 진입은 한 번)');
    assert.equal(end.writes, 0, '저장 진입 0');
    assert.ok((await readFile(path, 'utf8')) === BODY, '원고 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});

test('취소 요청 대기 중에는 중복 취소 요청이 나가지 않고, 늦게 온 취소 응답이 이미 끝난 작업에 표시되지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, pageErrors } = await start('acrf-hold', ['HOLD-OK']);
  try {
    await cancelButton(page).focus();
    await page.keyboard.press('Enter');
    await until('붙잡은 취소 요청', async () => (await g(app)).cancels === 1);
    await slot(page).getByText(/취소 요청을 보내는 중/).waitFor();
    // 대기 중 다시 눌러도 새 요청이 나가지 않는다 (포커스는 같은 버튼에 남는다)
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    assert.equal((await g(app)).cancels, 1, '대기 중 중복 취소 요청 0');
    assert.equal((await active(page)).body, false, '대기 중에도 포커스가 BODY가 아니다');
    // 작업이 먼저 끝난 뒤 늦은 취소 응답이 와도 끝난 작업(결과)에 취소 안내를 붙이지 않는다
    await releaseAnalyze(app);
    await slot(page).getByText(/화 1개 분석/).waitFor();
    await releaseCancel(app);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r()))))); // 늦은 응답이 처리될 프레임
    assert.equal(await slot(page).getByText(/취소를 요청했습니다|취소 요청/).count(), 0, '늦은 취소 응답이 끝난 작업에 표시되지 않는다');
    assert.deepEqual(pageErrors, [], '처리되지 않은 Promise 거절 0');
  } finally {
    await closeWindow(app);
  }
});
