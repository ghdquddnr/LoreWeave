// AI 분석·검사를 시작하는 동안(키 확인 응답을 기다리는 사이) 프로젝트를 바꾸면, 이전 화면의 요청이 새 프로젝트 원고를 보내지 않는다.
// 실제 앱(Electron + Playwright)과 가짜 OpenAI 서버. main의 ai:status 처리기는 끝까지 실행하고 응답만 붙잡는다. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { STALE_PROJECT } from '../../src/preload/api.ts';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

let fake: FakeOpenAi;
before(async () => {
  fake = await startFakeOpenAi(() => ({ summary: '요약', entities: [], facts: [] }));
});
after(async () => {
  await fake.close();
});

async function project(prefix: string, marker: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `# 1화\n\n${marker}\n`);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const aiDb = (dir: string) => existsSync(join(dir, '.loreweave', 'ai.db'));
const responses = () => fake.requests.filter((r) => r.path.endsWith('/responses'));
const sent = (marker: string) => responses().filter((r) => JSON.stringify(r.body).includes(marker)).length;

async function open(app: ElectronApplication, page: Page, dir: string, first = false) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: first ? '원고 폴더 열기' : '열기', exact: true }).click();
}

/** ai:status 응답을 붙잡고, 분석·검사 계획·검사 실행 처리기의 결과(ok 또는 오류 문구)를 남긴다 */
async function instrument(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { held: boolean; release?: () => void; outcomes: Record<string, string[]> };
    g.held = false;
    g.outcomes = { 'ai:analyze': [], 'ai:plan-check': [], 'ai:run-check': [] };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const status = handlers.get('ai:status')!;
    handlers.set('ai:status', async (...args: unknown[]) => {
      const result = await status(...args);
      g.held = true;
      await new Promise<void>((resolve) => (g.release = resolve));
      handlers.set('ai:status', status);
      return result;
    });
    for (const channel of Object.keys(g.outcomes)) {
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        try {
          const r = await original(...args);
          g.outcomes[channel]!.push('ok');
          return r;
        } catch (e) {
          g.outcomes[channel]!.push(e instanceof Error ? e.message : String(e));
          throw e;
        }
      });
    }
  });
}
const outcomes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { outcomes: Record<string, string[]> }).outcomes);
async function waitFor(page: Page, cond: () => Promise<boolean>, what: string) {
  for (let n = 0; n < 300 && !(await cond()); n++) await page.waitForTimeout(10);
  assert.ok(await cond(), what);
}

/** 키와 전송 동의를 넣고, 화면의 동의 상태를 새로 읽도록 같은 폴더를 다시 연다 */
async function readyAi(app: ElectronApplication, page: Page, dir: string, marker: string) {
  await open(app, page, dir, true);
  await editor(page).getByText(marker).waitFor();
  await page.evaluate(async () => {
    await window.loreweave.ai.setKey('sk-e2e-fake-key');
    await window.loreweave.ai.setConsent(true);
  });
  await open(app, page, dir);
  await page.getByRole('button', { name: '이 화 분석', exact: true }).waitFor();
}

for (const [name, button, channel] of [
  ['분석', '이 화 분석', 'ai:analyze'],
  ['검사', '이 화 검사', 'ai:plan-check'],
] as const) {
  test(`${name} 시작 중 다른 프로젝트 열기 (감독 재현): 이전 화면의 요청은 거절되고, B 원고는 보내지 않으며 ai.db도 만들지 않는다. 그 뒤 B에서 분석하면 B만 보낸다`, { timeout: 90_000 }, async () => {
    const A = await project('ai-switch-A', 'AAA_ONLY');
    const B = await project('ai-switch-B', 'BBB_ONLY');
    // 가짜 서버는 이 파일의 테스트가 함께 쓰므로, 이 테스트 전의 수를 기준으로 센다
    const before = responses().length;
    const sentB = sent('BBB_ONLY');
    const sentA = sent('AAA_ONLY');
    const { app, page } = await launch(await tempDir('ai-switch-userdata'), { OPENAI_BASE_URL: fake.baseUrl });
    try {
      await readyAi(app, page, A, 'AAA_ONLY');
      await instrument(app);
      await page.getByRole('button', { name: button, exact: true }).click();
      await waitFor(page, () => app.evaluate(() => (globalThis as unknown as { held: boolean }).held), 'ai:status를 붙잡지 못했다');
      await open(app, page, B);
      await editor(page).getByText('BBB_ONLY').waitFor();
      await app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
      // 이전 화면의 다음 요청(분석 또는 검사 계획)이 main에 도착해 거절된 것을 확인한다 (장벽)
      await waitFor(page, async () => (await outcomes(app))[channel]!.length === 1, `${channel} 요청이 오지 않았다`);
      assert.deepEqual((await outcomes(app))[channel], [STALE_PROJECT]);
      assert.deepEqual((await outcomes(app))['ai:run-check'], []);
      assert.equal(responses().length, before);
      assert.equal(aiDb(B), false);
      assert.equal(aiDb(A), false);
      // B 화면에는 이전 화면의 거절 문구가 보이지 않는다
      assert.equal(await page.getByText(STALE_PROJECT).count(), 0);
      // B에서 다시 분석하면 B 원고만 보낸다
      await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
      await page.getByText(/화 1개 분석/).waitFor({ timeout: 10_000 });
      assert.equal(sent('BBB_ONLY') - sentB, 1);
      assert.equal(sent('AAA_ONLY') - sentA, 0);
      assert.equal(aiDb(B), true);
      assert.equal(aiDb(A), false);
    } finally {
      await app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.()).catch(() => {});
      await closeWindow(app);
    }
  });
}

test('분석 시작 중 같은 폴더 다시 열기: 이전 화면의 요청은 거절되고 보내지 않으며, 다시 누르면 정상 분석된다', { timeout: 90_000 }, async () => {
  const A = await project('ai-reopen-A', 'AAA_REOPEN');
  const before = responses().length;
  const { app, page } = await launch(await tempDir('ai-reopen-userdata'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await readyAi(app, page, A, 'AAA_REOPEN');
    await instrument(app);
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await waitFor(page, () => app.evaluate(() => (globalThis as unknown as { held: boolean }).held), 'ai:status를 붙잡지 못했다');
    await open(app, page, A);
    await editor(page).getByText('AAA_REOPEN').waitFor();
    await app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
    await waitFor(page, async () => (await outcomes(app))['ai:analyze']!.length === 1, 'ai:analyze 요청이 오지 않았다');
    assert.deepEqual((await outcomes(app))['ai:analyze'], [STALE_PROJECT]);
    assert.equal(responses().length, before);
    assert.equal(aiDb(A), false);
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await page.getByText(/화 1개 분석/).waitFor({ timeout: 10_000 });
    assert.equal(sent('AAA_REOPEN'), 1);
    assert.equal(aiDb(A), true);
  } finally {
    await app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.()).catch(() => {});
    await closeWindow(app);
  }
});
