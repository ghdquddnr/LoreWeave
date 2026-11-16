// 첫 AI 전송 동의 저장이 실패해도 전송 없이 입력을 복구하고 새 확인으로만 재시도하는가 (현재 화 분석 대표).
// 실패 주입: 실제 ai:set-consent handler를 감싸고, 거절 모드에서는 실제 handler를 부르지 않고(동의를 쓰지 않는다) 합성으로 거부한다 (실제 권한/디스크 오류가 아니다). 통과 모드는 실제 handler를 그대로 부른다.
// 동의 저장이 실제로 성공하고 응답만 잃는 경우는 이번 범위가 아니다. 가짜 OpenAI 서버(localhost)와 가짜 키만 쓴다.
// 격리: hooks/main-isolated-userdata-entry.cjs가 제품 main 전에 독점 새 userData를 강제하고 증거를 남긴다 (setup이 확인한다). 합성 원고(BOM + CRLF + frontmatter).

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
  await page.evaluate((m) => window.loreweave.ai.setModel(m), A);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').getByText('alpha two').or(page.locator('.ProseMirror')).first().waitFor();
  return { dir, app, page, A: A!, B: B! };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};
const bytes = async (dir: string) => [await readFile(join(dir, 'chapters', '001.md')), await readFile(join(dir, 'chapters', '002.md'))];
const dialog = (page: Page) => page.getByRole('dialog', { name: 'AI 실행 확인' });


type C = { mode: 'reject' | 'pass'; received: number; rejected: number; passed: number; held: boolean; heldAfter: boolean; release1?: () => void; release2?: () => void };
async function wrapConsent(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const c: C = ((globalThis as unknown as { __c?: C }).__c = { mode: 'reject', received: 0, rejected: 0, passed: 0, held: false, heldAfter: false });
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('ai:set-consent')!;
    handlers.set('ai:set-consent', async (...args: unknown[]) => {
      c.received++;
      if (c.mode === 'reject') {
        // 수신을 붙잡았다가 합성으로 거부한다 (실제 handler 미호출: 동의는 쓰이지 않는다)
        c.held = true;
        await new Promise<void>((resolve) => (c.release1 = resolve));
        c.held = false;
        c.rejected++;
        throw new Error('합성 동의 저장 거부 (EACCES)');
      }
      const result = await original(...args); // 실제 handler: 동의가 실제로 저장된다
      c.passed++;
      c.heldAfter = true; // 저장 응답을 붙잡아, 응답 전에는 AI 요청이 없음을 본다
      await new Promise<void>((resolve) => (c.release2 = resolve));
      c.heldAfter = false;
      return result;
    });
  });
}
const cs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __c: C }).__c);
const cMode = (app: ElectronApplication, mode: 'reject' | 'pass') => app.evaluate((_e, m) => void ((globalThis as unknown as { __c: C }).__c.mode = m), mode);
const cRelease = (app: ElectronApplication, which: 1 | 2) =>
  app.evaluate((_e, w) => (globalThis as unknown as { __c: { release1?: () => void; release2?: () => void } }).__c[w === 1 ? 'release1' : 'release2']?.(), which);
const consentSaved = (page: Page) => page.evaluate(() => window.loreweave.ai.analysisStatus(1).then((s) => s.consent));
const nav = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title, exact: true });

test('첫 동의 저장이 거부되면 전송 0·동의 false·안내·잠금 해제·재시도 접근이 되고, 다시 시도는 동의 문구가 있는 새 확인만 열며, 복구 뒤 명시적 동의 실행만 동의 저장 → 그 뒤 요청 순서로 나간다', { timeout: 150_000 }, async () => {
  const { dir, app, page, A } = await setup();
  try {
    const before = [await readFile(join(dir, 'chapters', '001.md')), await readFile(join(dir, 'chapters', '002.md'))];
    const labelA = (await page.evaluate(() => window.loreweave.ai.status())).models.find((m) => m.id === A)!.label;
    await wrapConsent(app);
    assert.equal(await consentSaved(page), false, '동의 false로 시작한다');
    await nav(page, 'Two').click();
    await page.locator('.ProseMirror').getByText('alpha two').waitFor();
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).waitFor();
    assert.ok((await dialog(page).innerText()).includes('원고가 OpenAI로 전송됩니다.'), '첫 확인에 동의 문구가 있다');
    await dialog(page).getByRole('button', { name: '동의하고 실행', exact: true }).click();
    await until('동의 저장 요청이 handler에 수신되지 않았다', async () => (await cs(app)).held);
    // 대기 중: 중복 시작 금지, 입력 잠금
    assert.equal(await page.getByRole('button', { name: '이 화 분석', exact: true }).isDisabled(), true, '대기 중 [이 화 분석]이 막혀 있다');
    await page.locator('.ProseMirror').getByText('alpha two').click({ force: true }).catch(() => undefined);
    await page.keyboard.insertText('합성입력');
    await page.waitForTimeout(300);
    assert.equal((await page.locator('.ProseMirror').innerText()).includes('합성입력'), false, '대기 중 입력은 받지 않는다');
    assert.equal((await cs(app)).received, 1, '동의 저장 요청은 한 번이다');
    await cRelease(app, 1); // 합성 거부
    await page.getByRole('alert').first().waitFor();
    await page.waitForTimeout(400);
    assert.equal((await cs(app)).rejected, 1);
    assert.equal((await cs(app)).passed, 0, '실제 handler를 통과한 동의 저장이 없다');
    assert.equal(await consentSaved(page), false, '동의 false 그대로');
    assert.equal(responses().length, 0, '선행 분석 포함 AI 요청 0');
    assert.equal(await dialog(page).count(), 0);
    assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true', '입력 잠금이 풀렸다');
    assert.equal(await page.getByRole('button', { name: '이 화 분석', exact: true }).isDisabled(), false, '시작 버튼이 다시 눌린다');
    assert.ok((await page.locator('.ProseMirror').innerText()).includes('alpha two'), '화면의 글이 그대로다');
    // 다시 시도: 동의 문구·모델·범위·비용이 있는 새 확인만 열린다 (요청 0·동의 false)
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await dialog(page).waitFor();
    const text = await dialog(page).innerText();
    assert.ok(text.includes('원고가 OpenAI로 전송됩니다.') && text.includes(labelA) && text.includes('002.md') && text.includes('예상 비용'), `새 확인: ${JSON.stringify(text)}`);
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0);
    assert.equal(await consentSaved(page), false);
    assert.equal((await cs(app)).received, 1, '확인 창이 떠도 동의 저장 요청이 더 오지 않는다');
    await dialog(page).getByRole('button', { name: '취소', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(await consentSaved(page), false, '취소해도 동의 false');
    assert.equal(responses().length, 0);
    assert.equal((await cs(app)).received, 1);
    // 합성 거절을 풀고 새 확인에서 명시적으로 동의하고 실행: 실제 handler로 동의가 저장된 뒤에야 요청이 나간다
    await cMode(app, 'pass');
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).waitFor();
    await dialog(page).getByRole('button', { name: '동의하고 실행', exact: true }).click();
    await until('실제 동의 저장이 통과하지 않았다', async () => (await cs(app)).heldAfter);
    assert.equal((await cs(app)).passed, 1, '실제 handler를 통과한 동의 저장 1회');
    assert.equal(responses().length, 0, '동의 저장 응답 전에는 AI 요청이 없다');
    await cRelease(app, 2);
    await until('요청이 나가지 않았다', async () => responses().length >= 1);
    assert.equal(await consentSaved(page), true, '동의가 저장됐다');
    assert.ok(responses().every((r) => modelOf(r) === A), JSON.stringify(responses().map(modelOf)));
    const userOf = (r: { body: unknown }) => (r.body as { input?: { role: string; content: string }[] }).input?.find((m) => m.role === 'user')?.content ?? '';
    const two = responses().map(userOf).filter((u) => u.includes('<chapter n="2">'));
    assert.equal(two.length, 1, `2화 본문 요청 한 번: ${responses().length}건`);
    assert.ok(two[0]!.includes('alpha two'), '실제 대상 화 본문이 들어 있다');
    assert.deepEqual([await readFile(join(dir, 'chapters', '001.md')), await readFile(join(dir, 'chapters', '002.md'))], before, '합성 두 원고 Buffer 불변');
  } finally {
    await cRelease(app, 1).catch(() => {});
    await cRelease(app, 2).catch(() => {});
    await cleanup(app, page);
  }
});
