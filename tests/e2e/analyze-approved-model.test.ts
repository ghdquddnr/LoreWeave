// 분석 실행 확인에서 승인한 모델과 실제 분석 요청 모델의 일치. 실제 renderer의 확인 창 → 실제 등록된 main 분석 handler(ai:analyze) 흐름을 쓴다.
// 장벽: 실제 handler를 그대로 부르되 그 시작(= 설정을 다시 읽기 전)을 붙잡는다 (결과를 만들어 내는 대역 없음). 붙잡힌 동안 이 테스트의 격리 userData 설정만 다른 모델로 바꾼다.
// 가짜 OpenAI 서버(localhost)와 명백한 가짜 키만 쓴다. 키·설정은 이 테스트의 독점 새 userData에만 저장된다. 실제 API·실원고·실 AI DB는 쓰지 않는다.
// 격리: hooks/main-isolated-userdata-entry.cjs가 제품 main을 불러오기 전에 독점 새 userData를 강제하고 증거를 남긴다 (setup이 그 증거를 확인한다).
// 합성 원고(BOM + CRLF + frontmatter). 원고 바이트는 합성 파일 두 개(001.md, 002.md)만 Buffer로 비교한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ENTRY = join(__dirname, 'hooks', 'main-isolated-userdata-entry.cjs');
const KEY = 'sk-e2e-fake-key';
const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
let fake: FakeOpenAi;

before(async () => {
  fake = await startFakeOpenAi(() => ({ summary: '가짜 요약', entities: [], facts: [] }));
});
after(async () => {
  await fake.close();
});
const responses = () => fake.requests.filter((r) => r.path.endsWith('/responses'));
const modelOf = (r: { body: unknown }) => (r.body as { model?: string }).model;

type G = { entered: number; held: boolean; release?: () => void };
async function holdAnalyze(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g: G = ((globalThis as unknown as { __g?: G }).__g = { entered: 0, held: false });
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('ai:analyze')!;
    handlers.set('ai:analyze', async (...args: unknown[]) => {
      g.entered++;
      g.held = true;
      await new Promise<void>((resolve) => (g.release = resolve));
      g.held = false;
      return original(...args); // 실제 handler: 이 뒤에 설정을 다시 읽는다
    });
  });
}
const gs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __g: G }).__g);
const releaseHold = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __g?: G }).__g?.release?.());
async function until(what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(await ok(), true, what);
}

async function setup() {
  fake.requests.length = 0;
  const dir = await tempDir('apm');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), doc('m1', 'One', 'alpha one'));
  await writeFile(join(dir, 'chapters', '002.md'), doc('m2', 'Two', 'alpha two'));
  const userData = await tempDir('apm-userdata');
  const { app, page } = await launch(userData, { LW_TEST_USERDATA: userData, OPENAI_BASE_URL: fake.baseUrl }, ENTRY);
  const evidence = JSON.parse(await readFile(join(userData, '.isolated-entry-evidence.json'), 'utf8')) as { stage: string; userData: string; entriesBefore: string[] };
  assert.equal(evidence.stage, 'before-product-main');
  assert.deepEqual(evidence.entriesBefore, []);
  assert.equal(evidence.userData, await app.evaluate(({ app: a }) => a.getPath('userData')));
  assert.equal((await realpath(userData)).toLowerCase(), evidence.userData.toLowerCase());
  // 이 독점 새 userData에만 가짜 키·동의·모델 A를 저장한다
  const status = await page.evaluate(() => window.loreweave.ai.status());
  const [A, B] = status.models.map((m) => m.id);
  assert.ok(A && B && A !== B, '모델이 둘 이상 있어야 한다');
  await page.evaluate((key) => window.loreweave.ai.setKey(key), KEY);
  await page.evaluate(() => window.loreweave.ai.setConsent(true));
  await page.evaluate((m) => window.loreweave.ai.setModel(m), A);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('alpha two').or(page.locator('.ProseMirror')).first().waitFor();
  return { dir, app, page, A: A!, B: B! };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await releaseHold(app).catch(() => {});
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};
const bytes = async (dir: string) => [await readFile(join(dir, 'chapters', '001.md')), await readFile(join(dir, 'chapters', '002.md'))];
const dialog = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });

test('최종 확인 뒤 실행 handler가 설정을 읽기 전에 모델이 바뀌면, 승인하지 않은 모델로 보내지 않고 오류를 보이며 입력이 풀린다', { timeout: 120_000 }, async () => {
  const { dir, app, page, A, B } = await setup();
  try {
    const before = await bytes(dir);
    await holdAnalyze(app);
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).locator('button.primary').click(); // 승인한 모델은 A
    await until('실제 분석 handler가 붙잡히지 않았다', async () => (await gs(app)).held);
    await page.evaluate((m) => window.loreweave.ai.setModel(m), B); // 승인 뒤 설정만 B로 바뀐다
    await releaseHold(app);
    await until('결과가 나오지 않았다', async () => responses().length > 0 || (await page.getByRole('alert').count()) > 0);
    await page.waitForTimeout(300);
    const models = responses().map(modelOf);
    assert.equal(models.includes(B), false, `승인하지 않은 모델 ${B}로 보냈다: ${JSON.stringify(models)}`);
    assert.deepEqual(models, [], '보내지 않았다');
    assert.ok((await page.getByRole('alert').count()) >= 1, '오류 안내가 보인다');
    assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true', '입력이 풀렸다');
    assert.deepEqual(await bytes(dir), before, '원고 바이트는 그대로다');
  } finally {
    await cleanup(app, page);
  }
});

test('정상: 같은 모델이면 승인한 모델 A로 분석 요청이 나간다', { timeout: 120_000 }, async () => {
  const { dir, app, page, A } = await setup();
  try {
    const before = await bytes(dir);
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).locator('button.primary').click();
    await until('분석 요청이 나가지 않았다', async () => responses().length >= 1);
    assert.ok(responses().every((r) => modelOf(r) === A), JSON.stringify(responses().map(modelOf)));
    assert.deepEqual(await bytes(dir), before);
  } finally {
    await cleanup(app, page);
  }
});
