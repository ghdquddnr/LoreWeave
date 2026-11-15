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
      // 첫 호출만 붙잡는다 (다시 확인 뒤의 호출은 그대로 통과)
      if (++g.entered === 1) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
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
    const labelB = (await page.evaluate(() => window.loreweave.ai.status())).models.find((m) => m.id === B)!.label;
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
    // 거절 뒤 명시적 재확인 경로: [다시 시도]는 새 계획과 새 모델 표시의 확인 창만 열고, 사용자가 승인하기 전에는 아무것도 보내지 않는다
    const retryButton = page.getByRole('button', { name: '다시 시도', exact: true });
    assert.equal(await retryButton.count(), 1, '[다시 시도]가 있다');
    await retryButton.click();
    await dialog(page).waitFor();
    assert.ok((await dialog(page).innerText()).includes(labelB), `확인 창이 새 모델 B(${labelB})를 보인다`);
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '승인 전에는 요청이 없다');
    assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).count(), 0, '확인 창이 열린 동안 오래된 [다시 시도]는 없다');
    await dialog(page).locator('button.primary').click(); // 사용자가 B를 명시 승인
    await until('B 분석 요청이 나가지 않았다', async () => responses().length >= 1);
    assert.ok(responses().every((r) => modelOf(r) === B), `B 승인 뒤 요청: ${JSON.stringify(responses().map(modelOf))}`);
    const sent = responses().length;
    await page.waitForTimeout(300);
    assert.equal(responses().length, sent, '재시도·승인으로 추가 전송이 없다');
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

const nav = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title, exact: true });
const body = (title: string) => (title === 'One' ? 'alpha one' : 'alpha two');

for (const [name, path] of [
  ['Two → One', ['One']],
  ['Two → One → Two', ['One', 'Two']],
] as const) {
  test(`현재 화 분석 요청 대기 중 화 이동(${name}) 뒤 늦은 MODEL_CHANGED 거절은 이동한 화에 이전 화의 [다시 시도]·확인 창을 만들지 않고, 요청도 0이다`, { timeout: 120_000 }, async () => {
    const { dir, app, page, B } = await setup();
    try {
      const before = await bytes(dir);
      await nav(page, 'Two').click();
      await page.locator('.ProseMirror').getByText(body('Two')).waitFor();
      await holdAnalyze(app);
      await page.getByRole('button', { name: '이 화 분석', exact: true }).click(); // Two의 분석
      await dialog(page).locator('button.primary').click();
      await until('실제 분석 handler가 붙잡히지 않았다', async () => (await gs(app)).held);
      for (const title of path) {
        await nav(page, title).click();
        await page.locator('.ProseMirror').getByText(body(title)).waitFor();
      }
      await page.evaluate((m) => window.loreweave.ai.setModel(m), B);
      await releaseHold(app);
      await until('늦은 거절이 오지 않았다', async () => (await page.getByRole('alert').count()) > 0);
      await page.waitForTimeout(300);
      assert.equal(responses().length, 0, '요청이 없다');
      assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).count(), 0, '이전 선택의 [다시 시도]가 없다');
      assert.equal(await dialog(page).count(), 0, '확인 창이 없다');
      assert.deepEqual(await bytes(dir), before, '원고 바이트는 그대로다');
    } finally {
      await cleanup(app, page);
    }
  });
}

test('대조: 프로젝트 범위 [남은 화 분석]의 늦은 거절은 화를 옮겨도 [다시 시도]가 남고, 눌러도 확인 창만 열리며 요청은 0이다', { timeout: 120_000 }, async () => {
  const { dir, app, page, B } = await setup();
  try {
    const before = await bytes(dir);
    await holdAnalyze(app);
    await page.getByRole('button', { name: /남은 화 분석/ }).click();
    await dialog(page).locator('button.primary').click();
    await until('실제 분석 handler가 붙잡히지 않았다', async () => (await gs(app)).held);
    await nav(page, 'Two').click();
    await page.locator('.ProseMirror').getByText(body('Two')).waitFor();
    await page.evaluate((m) => window.loreweave.ai.setModel(m), B);
    await releaseHold(app);
    await until('늦은 거절이 오지 않았다', async () => (await page.getByRole('alert').count()) > 0);
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0);
    const retry = page.getByRole('button', { name: '다시 시도', exact: true });
    assert.equal(await retry.count(), 1, '프로젝트 범위의 [다시 시도]는 화 이동과 무관하게 있다');
    await retry.click();
    await dialog(page).waitFor();
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '확인 전에는 요청이 없다');
    assert.deepEqual(await bytes(dir), before);
  } finally {
    await cleanup(app, page);
  }
});

// ---- 최종 승인 뒤 보내기 전 준비 구간(confirmRun의 재계산·상태 확인)

type S = { armed: boolean; held: boolean; release?: () => void; statusCalls: number; estimates: number };
/** 실제 ai:status handler를 감싼다: arm한 뒤 첫 호출(최종 승인 뒤의 모델 재확인)의 시작을 붙잡고, ai:estimate는 호출 수만 센다 (둘 다 실제 handler를 그대로 부른다) */
async function holdStatus(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const s: S = ((globalThis as unknown as { __s?: S }).__s = { armed: false, held: false, statusCalls: 0, estimates: 0 });
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const status = handlers.get('ai:status')!;
    handlers.set('ai:status', async (...args: unknown[]) => {
      s.statusCalls++;
      if (s.armed) {
        s.armed = false;
        s.held = true;
        await new Promise<void>((resolve) => (s.release = resolve));
        s.held = false;
      }
      return status(...args);
    });
    const estimate = handlers.get('ai:estimate')!;
    handlers.set('ai:estimate', async (...args: unknown[]) => {
      s.estimates++;
      return estimate(...args);
    });
  });
}
const ss = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __s: S }).__s);
const armStatus = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as { __s: S }).__s.armed = true));
const releaseStatus = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __s?: S }).__s?.release?.());
const cleanup2 = async (app: ElectronApplication, page: Page) => {
  await releaseStatus(app).catch(() => {});
  await cleanup(app, page);
};
/** Two의 현재 화 분석(또는 프로젝트 범위)을 승인하고, 최종 실행 뒤 모델 재확인(ai:status)이 붙잡힌 상태로 만든다 */
async function prepHeld(app: ElectronApplication, page: Page, button: string | RegExp) {
  await holdStatus(app);
  await page.getByRole('button', { name: button, exact: typeof button === 'string' }).click();
  await dialog(page).waitFor(); // 첫 확인 창 (모델 A)
  const estimatesBefore = (await ss(app)).estimates;
  await armStatus(app);
  await dialog(page).locator('button.primary').click();
  await until('최종 재확인(ai:status)이 붙잡히지 않았다', async () => (await ss(app)).held);
  // 최종 재계산(두 번째 실제 ai:estimate)이 이 구간에서 수신됐다
  await until('최종 재계산(ai:estimate)이 수신되지 않았다', async () => (await ss(app)).estimates > estimatesBefore);
}

for (const [name, path] of [
  ['Two → One', ['One']],
  ['Two → One → Two', ['One', 'Two']],
] as const) {
  test(`현재 화 분석 최종 승인 뒤 재확인을 기다리는 중 화 이동(${name}) 후 모델이 달라져도, 이전 화의 확인 창을 다시 열지 않고 요청도 0이며 입력이 풀린다`, { timeout: 120_000 }, async () => {
    const { dir, app, page, B } = await setup();
    try {
      const before = await bytes(dir);
      await nav(page, 'Two').click();
      await page.locator('.ProseMirror').getByText(body('Two')).waitFor();
      await prepHeld(app, page, '이 화 분석');
      for (const title of path) {
        await nav(page, title).click();
        await page.locator('.ProseMirror').getByText(body(title)).waitFor();
      }
      await page.evaluate((m) => window.loreweave.ai.setModel(m), B); // 재확인이 읽기 전에 설정이 B가 된다
      await releaseStatus(app);
      await page.waitForTimeout(600);
      assert.equal(responses().length, 0, '요청이 없다');
      assert.equal(await dialog(page).count(), 0, '이전 화의 확인 창이 다시 열리지 않았다');
      assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).count(), 0);
      assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true', '입력이 풀렸다');
      assert.deepEqual(await bytes(dir), before, '원고 바이트는 그대로다');
    } finally {
      await cleanup2(app, page);
    }
  });
}

test('대조: 같은 화에서 최종 승인 뒤 모델이 달라지면 새 B 확인 창이 열리고(요청 0), 취소하면 0이며, 새 확인에서 B를 명시 승인한 뒤에만 B로 보낸다', { timeout: 120_000 }, async () => {
  const { dir, app, page, B } = await setup();
  try {
    const before = await bytes(dir);
    const labelB = (await page.evaluate(() => window.loreweave.ai.status())).models.find((m) => m.id === B)!.label;
    await nav(page, 'Two').click();
    await page.locator('.ProseMirror').getByText(body('Two')).waitFor();
    await prepHeld(app, page, '이 화 분석');
    await page.evaluate((m) => window.loreweave.ai.setModel(m), B);
    await releaseStatus(app);
    await dialog(page).waitFor();
    assert.ok((await dialog(page).innerText()).includes(labelB), '새 확인 창이 B를 보인다');
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '확인 전에는 요청이 없다');
    await dialog(page).getByRole('button', { name: '취소', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '취소 뒤에도 요청이 없다');
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).waitFor();
    await dialog(page).locator('button.primary').click(); // B 명시 승인
    await until('B 요청이 나가지 않았다', async () => responses().length >= 1);
    assert.ok(responses().every((r) => modelOf(r) === B), JSON.stringify(responses().map(modelOf)));
    assert.deepEqual(await bytes(dir), before);
  } finally {
    await cleanup2(app, page);
  }
});

test('대조: 프로젝트 범위 [남은 화 분석]은 최종 승인 뒤 화를 옮겨도 모델이 달라지면 새 확인 창이 열리고 요청은 0이다', { timeout: 120_000 }, async () => {
  const { dir, app, page, B } = await setup();
  try {
    const before = await bytes(dir);
    await prepHeld(app, page, /남은 화 분석/);
    await nav(page, 'Two').click();
    await page.locator('.ProseMirror').getByText(body('Two')).waitFor();
    await page.evaluate((m) => window.loreweave.ai.setModel(m), B);
    await releaseStatus(app);
    await dialog(page).waitFor();
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '확인 전에는 요청이 없다');
    assert.deepEqual(await bytes(dir), before);
  } finally {
    await cleanup2(app, page);
  }
});
