// 프로젝트 범위 '남은 화 분석'의 계획을 기다리는 사이 다른 화로 옮겨도, 그 계획은 취소·축소되지 않는다 (현재 화 대상 계획만 화 이동으로 버린다: AnalysisBar planOwner).
// 실제 앱(Electron + Playwright). 합성 001/002 원고·격리 userData. ai:status(키 있음)·ai:estimate(응답 붙잡기·합성 chars/비용)는 무료 대역이고,
// ai:analyze·ai:run-check는 호출 수만 세고 거절해 실제 전송을 막는다. 실행 확인 버튼은 누르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const FILES = { '001.md': '# ONE\n\nONE_BODY\n', '002.md': '# TWO\n\nTWO_BODY\n' };

async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const pendingButton = (page: Page) => page.getByRole('button', { name: /^남은 화 분석 \(2\)$/ });
const confirm = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });

test('남은 화 분석의 estimate를 기다리는 사이 B화로 옮겨도 A·B 두 화 범위의 확인 창이 반환된 chars·비용 그대로 열리고, 재요청 없이 취소된다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('pending-move');
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(FILES)) await writeFile(join(dir, 'chapters', name), text);
  const { app, page } = await launch(await tempDir('pending-move-ud'));
  const state = () =>
    app.evaluate(() => {
      const g = globalThis as unknown as { estimates: { files: unknown; token: unknown }[]; sends: number; held: boolean };
      return { estimates: g.estimates, sends: g.sends, held: g.held };
    });
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { estimates: { files: unknown; token: unknown }[]; sends: number; held: boolean; release?: () => void };
      g.estimates = [];
      g.sends = 0;
      g.held = false;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const status = handlers.get('ai:status')!;
      handlers.set('ai:status', async (...args: unknown[]) => ({ ...((await status(...args)) as object), hasKey: true }));
      handlers.set('ai:estimate', async (_e: unknown, files: unknown, token: unknown) => {
        g.estimates.push({ files, token });
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        return { chars: 12345, costUsd: 0.0345 };
      });
      for (const channel of ['ai:analyze', 'ai:run-check']) {
        handlers.set(channel, async () => {
          g.sends++;
          throw new Error('합성 대역: 전송하지 않는다');
        });
      }
    });

    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').getByText('ONE_BODY', { exact: true }).waitFor();
    await until(async () => await pendingButton(page).isEnabled(), '[남은 화 분석 (2)]가 활성이다');
    await pendingButton(page).click();
    await until(async () => (await state()).held, 'estimate 요청이 도착해 붙잡혔다');
    const first = (await state()).estimates;
    assert.equal(first.length, 1, 'estimate 요청 1회');
    assert.deepEqual(first[0]!.files, ['001.md', '002.md'], '범위는 프로젝트의 남은 두 화다');
    assert.equal(typeof first[0]!.token, 'number');

    // 기다리는 사이 탐색기에서 B화로 이동한다
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'TWO' }).click();
    await page.locator('.ProseMirror').getByText('TWO_BODY', { exact: true }).waitFor();
    await settled(page);
    assert.equal(await confirm(page).count(), 0, '응답 전에는 확인 창이 없다');
    await app.evaluate(() => (globalThis as unknown as { release: () => void }).release());

    // 이동은 범위를 현재 화(B)만으로 줄이거나 계획을 버리지 않는다
    await confirm(page).waitFor();
    await confirm(page).getByText('화 2개를 분석할까요?').waitFor();
    await confirm(page).getByText(/화 2개의 본문 12,345자/).waitFor();
    await confirm(page).getByText(/001\.md, 002\.md/).waitFor();
    await confirm(page).getByText(/최대 \$0\.0345/).waitFor();
    assert.deepEqual((await state()).estimates, first, '화 이동으로 estimate를 다시 요청하지 않았다');

    // 취소하면 닫히고 버튼이 다시 활성이며 아무것도 보내지 않는다
    await confirm(page).getByRole('button', { name: '취소' }).click();
    await confirm(page).waitFor({ state: 'detached' });
    await until(async () => await pendingButton(page).isEnabled(), '취소 뒤 [남은 화 분석]이 다시 활성이다');
    await settled(page);
    const end = await state();
    assert.equal(end.sends, 0, '실행 IPC 0');
    assert.deepEqual(end.estimates, first);
  } finally {
    await closeWindow(app);
  }
  for (const [name, text] of Object.entries(FILES)) assert.equal(await readFile(join(dir, 'chapters', name), 'utf8'), text);
});
