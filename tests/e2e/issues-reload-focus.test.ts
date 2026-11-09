// 문제 가능성 패널의 저장된 검사 결과 읽기(ai:check-result) 실패 안내의 [다시 읽기]를 실제 키보드로 실행할 때 진행 중·재실패·성공에서 포커스가 BODY로 잃어지지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)와 합성 저장 검사(AiStore)·격리 userData. AI 검사 실행(ai:analyze·ai:run-check)이 아니라 저장된 검사 결과 조회(ai:check-result)만 실패/장벽 대역으로 감싼다. OpenAI·실제 AI DB·유료 호출 0.
// Tab 이동은 실제 키보드(Shift+Tab), 시작점만 DOM focus. 합성 Electron이며 수동 GUI·실제 OS IME 확인이 아니다. ai:analyze·chapter:write 진입을 이 검사 안에서 센다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nONE_BODY\r\n';

interface Hooks {
  /** ai:check-result 호출 수 */
  reads: number;
  analyzes: number;
  writes: number;
  /** fail: 거절 / ok: 정상 / hold-ok·hold-fail: 붙잡았다가 release 때 정상·거절 */
  mode: 'fail' | 'ok' | 'hold-ok' | 'hold-fail';
  release?: () => void;
}
const hooks = (app: ElectronApplication) => app.evaluate(() => { const h = (globalThis as unknown as { hooks: Hooks }).hooks; return { reads: h.reads, analyzes: h.analyzes, writes: h.writes }; });
const setMode = (app: ElectronApplication, mode: Hooks['mode']) => app.evaluate((_e, m) => void ((globalThis as unknown as { hooks: Hooks }).hooks.mode = m), mode);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.release?.());
const facts = (page: Page) => page.getByRole('region', { name: '문제 가능성' });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, connected: !!el?.isConnected, label: el?.textContent?.slice(0, 14) ?? '', inFacts: !!el?.closest('section.issues') };
  });
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const db = AiStore.open(dir);
  const createdAt = new Date().toISOString();
  const meta = { contentHash: 'synthetic', model: 'fake', modelVersion: 'fake', promptVersion: 'fake', costUsd: 0, createdAt };
  const target = { quote: 'ONE_BODY', line: 5, start: 0, end: 8 };
  db.saveCheck({ file: '001.md', ...meta, factCount: 0, dropped: 0, inputs: [], findings: [{ category: 'age' as const, claim: 'ONE_CLAIM', confidence: 0.9, key: 'ONE', target, evidence: [] }] });
  db.close();
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { reads: 0, analyzes: 0, writes: 0, mode: 'fail' };
    const analysis = map.get('ai:check-result')!;
    ipcMain.removeHandler('ai:check-result');
    ipcMain.handle('ai:check-result', async (...args: unknown[]) => {
      const h = g.hooks;
      h.reads += 1;
      if (h.mode === 'fail') throw new Error('EACCES: permission denied (synthetic)');
      if (h.mode === 'hold-ok' || h.mode === 'hold-fail') {
        await new Promise<void>((resolve) => (h.release = resolve));
        if (h.mode === 'hold-fail') throw new Error('EACCES: permission denied (synthetic, late)');
      }
      return analysis(...args);
    });
    for (const channel of ['ai:analyze', 'ai:run-check', 'chapter:write']) {
      const original = map.get(channel)!;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args: unknown[]) => {
        if (channel === 'ai:analyze' || channel === 'ai:run-check') g.hooks.analyzes += 1;
        else g.hooks.writes += 1;
        return original(...args);
      });
    }
  });
  await page.evaluate(`(() => { window.__f = []; document.addEventListener('focusin', (e) => window.__f.push('in ' + e.target.tagName + '{' + (e.target.textContent || '').slice(0, 8) + '}'), true); document.addEventListener('keydown', (e) => window.__f.push('keydown ' + e.key + ' on ' + e.target.tagName), true); })()`);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('ONE_BODY').waitFor();
  await facts(page).getByRole('button', { name: '다시 읽기', exact: true }).waitFor();
  // 시작점만 DOM focus(기술 상세), [다시 읽기]로의 이동은 실제 Shift+Tab
  await facts(page).getByRole('button', { name: '기술 상세', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal((await active(page)).label, '다시 읽기', '실제 Shift+Tab으로 다시 읽기 버튼에 도달했다');
  return { app, page, path, log: () => page.evaluate('window.__f') };
}

test('[다시 읽기]를 실제 Enter로 실행하면 진행 중·재실패에서 포커스가 BODY로 잃어지지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, path, log } = await start('irf-fail');
  try {
    const base = await hooks(app);
    await setMode(app, 'hold-fail');
    await page.keyboard.press('Enter');
    await until('붙잡은 읽기', async () => (await hooks(app)).reads === base.reads + 1);
    const inFlight = await active(page);
    assert.equal(inFlight.body, false, `진행 중 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(inFlight)} / ${JSON.stringify(await log())}`);
    assert.equal(inFlight.inFacts, true, '진행 중 포커스가 사실 패널 안의 살아있는 컨트롤에 있다');
    await release(app);
    await facts(page).getByRole('button', { name: '다시 읽기', exact: true }).waitFor();
    await frames(page);
    const failed = await active(page);
    assert.equal(failed.body, false, `재실패 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(failed)}`);
    assert.equal(failed.inFacts, true);
    assert.equal(await facts(page).locator('.tech-detail').count(), 0, '새 오류의 기술 상세는 접힌 채 시작한다');
    const end = await hooks(app);
    assert.equal(end.analyzes, base.analyzes, 'AI 검사 실행 진입 0 (저장된 검사 결과 조회만)');
    assert.equal(end.writes, base.writes, '저장 진입 0');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트(BOM·CRLF·frontmatter) 불변');
  } finally {
    await closeWindow(app);
  }
});

test('[다시 읽기]를 Space로 실행해 성공하면 포커스가 BODY로 잃어지지 않고, 대기 중 사용자가 옮긴 포커스는 늦은 응답이 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, path } = await start('irf-ok');
  try {
    const base = await hooks(app);
    await setMode(app, 'hold-ok');
    await page.keyboard.press('Space');
    await until('붙잡은 읽기', async () => (await hooks(app)).reads === base.reads + 1);
    assert.equal((await active(page)).body, false, '진행 중 포커스가 BODY가 아니다');
    await release(app);
    await facts(page).getByText('ONE_CLAIM').waitFor();
    await frames(page);
    const ok = await active(page);
    assert.equal(ok.body, false, `성공 뒤에도 포커스가 BODY가 아니다: ${JSON.stringify(ok)}`);
    assert.equal(ok.inFacts, true);
    assert.equal((await hooks(app)).analyzes, base.analyzes, 'AI 검사 실행 진입 0');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});

test('읽기 응답을 기다리는 사이 사용자가 실제 Shift+Tab으로 옮긴 포커스는 늦은 성공이 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page } = await start('irf-moved');
  try {
    const base = await hooks(app);
    await setMode(app, 'hold-ok');
    await page.keyboard.press('Enter');
    await until('붙잡은 읽기', async () => (await hooks(app)).reads === base.reads + 1);
    await page.keyboard.press('Shift+Tab'); // 사용자가 실제 키보드로 앞 컨트롤로 옮긴다
    const moved = await active(page);
    assert.equal(moved.body, false);
    await release(app);
    await facts(page).getByText('ONE_CLAIM').waitFor();
    await frames(page);
    assert.deepEqual(await active(page), moved, '늦은 성공이 사용자가 옮긴 포커스를 빼앗지 않았다');
  } finally {
    await closeWindow(app);
  }
});
