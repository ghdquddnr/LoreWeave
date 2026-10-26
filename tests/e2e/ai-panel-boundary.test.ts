// AI 패널(문제 가능성·AI가 찾은 사실)의 프로젝트 경계. 프로젝트를 바꾸는 동안 아직 보이는 이전 화면의 [무시]·조회가
// 새 프로젝트의 ai.db를 바꾸거나 새 화면을 덮지 않는다 (감독 재현: 전환 중 A 결과의 [무시]가 B의 같은 번호 결과를 무시함).
// 실제 앱(Electron + Playwright). 검사 결과는 합성으로 미리 저장한다. OpenAI는 부르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { STALE_PROJECT } from '../../src/preload/api.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

/** 001.md 하나와, 그 화의 합성 검사 결과(결과 번호 0)를 저장한 프로젝트 */
async function project(prefix: string, marker: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `# 1화\n\n${marker}\n`);
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
    findings: [{ category: 'age', claim: `${marker}_CLAIM`, confidence: 0.9, key: marker, target: { quote: marker, line: 3, start: 0, end: marker.length }, evidence: [] }],
  });
  db.close();
  return dir;
}
/** 저장된 무시 여부 (앱이 닫힌 뒤 읽는다) */
function dismissed(dir: string): boolean[] {
  const db = AiStore.open(dir);
  try {
    return db.check('001.md')!.findings.map((f) => f.dismissed);
  } finally {
    db.close();
  }
}
const editor = (page: Page) => page.locator('.ProseMirror');
const dismissButton = (page: Page) => page.getByRole('button', { name: '무시', exact: true });

/**
 * channel 요청 하나를 붙잡는다. after: 처리기는 끝까지 실행하고(프로젝트 열기면 main은 이미 새 프로젝트다) 응답만 붙잡는다.
 * before: 처리기를 부르기 전에 붙잡는다 (늦게 도착한 요청). 그리고 무시·분석 상태 처리기의 결과(ok 또는 오류 문구)를 남긴다
 */
async function instrument(app: ElectronApplication, channel: string, when: 'before' | 'after' = 'after') {
  await app.evaluate(({ ipcMain }, [held, at]) => {
    const g = globalThis as unknown as { held: boolean; release?: () => void; outcomes: Record<string, string[]> };
    g.held = false;
    g.outcomes = { 'ai:dismiss': [], 'ai:analysis-status': [] };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    for (const name of Object.keys(g.outcomes)) {
      const original = handlers.get(name)!;
      handlers.set(name, async (...args: unknown[]) => {
        try {
          const r = await original(...args);
          g.outcomes[name]!.push('ok');
          return r;
        } catch (e) {
          g.outcomes[name]!.push(e instanceof Error ? e.message : String(e));
          throw e;
        }
      });
    }
    const original = handlers.get(held)!;
    handlers.set(held, async (...args: unknown[]) => {
      handlers.set(held, original);
      if (at === 'before') {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        return original(...args);
      }
      // 처리기 자체가 실패해도(전환 실패) 응답만 붙잡는다
      const r = await Promise.resolve()
        .then(() => original(...args))
        .then(
          (v) => ({ v }),
          (e: unknown) => ({ e }),
        );
      g.held = true;
      await new Promise<void>((resolve) => (g.release = resolve));
      if ('e' in r) throw r.e;
      return r.v;
    });
  }, [channel, when] as const);
}
const outcomes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { outcomes: Record<string, string[]> }).outcomes);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
async function waitFor(page: Page, cond: () => Promise<boolean>, what: string) {
  for (let n = 0; n < 300 && !(await cond()); n++) await page.waitForTimeout(10);
  assert.ok(await cond(), what);
}
const waitHeld = (app: ElectronApplication, page: Page) =>
  waitFor(page, () => app.evaluate(() => (globalThis as unknown as { held: boolean }).held), '응답을 붙잡지 못했다');
/** 이전 화면의 token으로 main에 직접 무시를 보낸다 (화면 잠금을 거치지 않은 늦은 요청) */
const directDismiss = (page: Page, token: number) =>
  page.evaluate((t) => window.loreweave.ai.dismiss('001.md', 0, t).then(() => 'ok', (e: Error) => e.message), token);

async function openFirst(app: ElectronApplication, page: Page, dir: string, marker: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByText(`${marker}_CLAIM`, { exact: true }).waitFor();
}

for (const [name, same] of [
  ['다른 프로젝트 열기 (감독 재현)', false],
  ['같은 폴더 다시 열기', true],
] as const) {
  test(`${name}: 전환 중 아직 보이는 이전 결과의 [무시]는 막히고, 이전 token의 직접 요청은 거절된다. 어느 ai.db도 바뀌지 않고, 새 화면에서 누르면 그 프로젝트만 무시한다`, { timeout: 90_000 }, async () => {
    const A = await project(`panel-A-${same}`, 'AAA_ONLY');
    const B = same ? A : await project('panel-B', 'BBB_ONLY');
    const markB = same ? 'AAA_ONLY' : 'BBB_ONLY';
    const { app, page } = await launch(await tempDir('panel-userdata'));
    try {
      await openFirst(app, page, A, 'AAA_ONLY');
      await instrument(app, 'project:choose');
      await stubFolderDialog(app, B);
      await page.getByRole('button', { name: '열기', exact: true }).click();
      await waitHeld(app, page);
      // main은 이미 새 프로젝트(token 2)다. 화면에는 아직 이전 결과가 보이지만 [무시]는 눌리지 않는다
      await page.getByText('AAA_ONLY_CLAIM', { exact: true }).waitFor();
      assert.equal(await dismissButton(page).isDisabled(), true);
      await dismissButton(page).click({ force: true });
      assert.ok((await directDismiss(page, 1)).endsWith(STALE_PROJECT));
      await release(app);
      await editor(page).getByText(markB, { exact: true }).waitFor();
      await page.getByText(`${markB}_CLAIM`, { exact: true }).waitFor();
      // 막힌 클릭은 main에 가지 않았고, 직접 요청 하나만 거절됐다. 새 화면에 거절 문구가 보이지 않는다
      assert.deepEqual((await outcomes(app))['ai:dismiss'], [STALE_PROJECT]);
      assert.equal(await page.getByText(STALE_PROJECT).count(), 0);
      assert.equal(await page.getByText('무시한 결과 1개 보기', { exact: true }).count(), 0);
      // 새 화면에서 누르면 정상으로 무시된다
      await dismissButton(page).click();
      await page.getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
      assert.deepEqual((await outcomes(app))['ai:dismiss'], [STALE_PROJECT, 'ok']);
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
    if (same) assert.deepEqual(dismissed(A), [true]);
    else {
      assert.deepEqual(dismissed(A), [false]);
      assert.deepEqual(dismissed(B), [true]);
    }
  });
}

for (const [name, outcome] of [
  ['취소', 'cancel'],
  ['실패', 'fail'],
] as const) {
  test(`전환 ${name}: 기다리는 동안 [무시]는 막히고, 끝나면 지금 프로젝트에서 정상으로 무시된다`, { timeout: 90_000 }, async () => {
    const A = await project(`panel-${outcome}`, 'AAA_ONLY');
    const { app, page } = await launch(await tempDir('panel-userdata'));
    try {
      await openFirst(app, page, A, 'AAA_ONLY');
      await instrument(app, 'project:choose');
      if (outcome === 'cancel') {
        await app.evaluate(({ dialog }) => {
          dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
        });
      } else {
        await app.evaluate(({ dialog }) => {
          dialog.showOpenDialog = (async () => {
            throw new Error('폴더 대화상자 실패 (테스트)');
          }) as typeof dialog.showOpenDialog;
        });
      }
      await page.getByRole('button', { name: '열기', exact: true }).click();
      await waitHeld(app, page);
      assert.equal(await dismissButton(page).isDisabled(), true);
      await release(app);
      await waitFor(page, async () => !(await dismissButton(page).isDisabled()), '전환이 끝난 뒤 [무시]가 다시 눌리지 않는다');
      if (outcome === 'fail') await page.getByText('폴더 대화상자 실패 (테스트)', { exact: false }).waitFor();
      await dismissButton(page).click();
      await page.getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
      assert.deepEqual((await outcomes(app))['ai:dismiss'], ['ok']);
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
    assert.deepEqual(dismissed(A), [true]);
  });
}

test('늦은 분석 상태 요청: 이전 화면이 보낸 분석 상태 읽기가 전환 뒤 main에 도착하면 거절되고, 새 화면의 오류나 상태가 되지 않는다', { timeout: 90_000 }, async () => {
  const A = await project('panel-late-A', 'AAA_ONLY');
  const B = await project('panel-late-B', 'BBB_ONLY');
  const { app, page } = await launch(await tempDir('panel-userdata'));
  try {
    await openFirst(app, page, A, 'AAA_ONLY');
    await instrument(app, 'ai:analysis-status', 'before');
    // 바깥에서 화를 고치면 화면이 분석 상태를 다시 읽는다 (그 응답을 붙잡는다)
    await writeFile(join(A, 'chapters', '001.md'), '# 1화\n\nAAA_ONLY 바깥에서 고침\n');
    await waitHeld(app, page);
    await stubFolderDialog(app, B);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.getByText('BBB_ONLY_CLAIM', { exact: true }).waitFor();
    await release(app);
    await waitFor(page, async () => (await outcomes(app))['ai:analysis-status']!.includes(STALE_PROJECT), '이전 분석 상태 응답이 거절되지 않았다');
    // B를 연 뒤의 분석 상태 읽기는 정상이고, 이전 응답의 거절은 화면에 보이지 않는다
    await waitFor(page, async () => (await outcomes(app))['ai:analysis-status']!.includes('ok'), 'B의 분석 상태를 읽지 못했다');
    assert.equal(await page.getByText(STALE_PROJECT).count(), 0);
    await dismissButton(page).click();
    await page.getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(A), [false]);
  assert.deepEqual(dismissed(B), [true]);
});
