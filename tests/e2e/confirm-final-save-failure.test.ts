// 현재 화 AI 실행 전 저장이 실패할 때: 미저장 글 보존·AI 요청 차단·입력 잠금 해제·명시적 다시 시도, 그리고 최종 승인 뒤(confirmRun)의 저장 실패 경계가 사용자 입력으로 닿을 수 있는지.
// 기존 commands.test.ts는 '최초 계획 전 저장 불가(바깥 수정 충돌)'를 본다. 거부 주입으로 저장 실패 뒤 보존·다시 시도·복구 뒤 새 내용 전송까지 이어서 확인하는 것은 여기가 처음이다.
// 관측한 제약: 확인 창이 열려 있는 동안에는 편집기가 입력을 받지 않아(아래 첫 테스트) 확인 뒤 최종 저장 때 새 미저장 글이 생길 수 없다. 그래서 confirmRun의 최종 저장 실패 분기는 실제 입력으로 닿지 않았고, 억지 호출·내부 조작으로 닿지 않았다.
// 실패 주입: 실제 chapter:write handler를 감싸고, 실패를 켠 동안의 호출은 실제 handler를 부르지 않고 거부한다 (합성 저장 거부이며 실제 파일 권한·디스크는 건드리지 않는다). 꺼진 동안의 호출은 실제 handler를 그대로 통과해 실제로 쓴다.
// 가짜 OpenAI 서버(localhost)와 가짜 키만 쓴다. 격리: hooks/main-isolated-userdata-entry.cjs가 제품 main 전에 독점 새 userData를 강제하고 증거를 남긴다 (setup이 확인한다).
// 합성 원고(BOM + CRLF + frontmatter).

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
  await page.evaluate(() => window.loreweave.ai.setConsent(true));
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

type W = { fail: boolean; received: number; rejected: number; passed: number };
/** 실제 chapter:write handler를 감싼다: fail이 켜진 동안은 실제 handler를 부르지 않고 합성으로 거부하고, 꺼진 동안은 실제 handler로 통과시킨다 */
async function wrapWrite(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const w: W = ((globalThis as unknown as { __w?: W }).__w = { fail: false, received: 0, rejected: 0, passed: 0 });
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      w.received++;
      if (w.fail) {
        w.rejected++;
        throw new Error('합성 저장 거부 (EACCES)');
      }
      w.passed++;
      return original(...args);
    });
  });
}
const ws = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __w: W }).__w);
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, f) => void ((globalThis as unknown as { __w: W }).__w.fail = f), fail);
const nav = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title, exact: true });

test('제약: 확인 창이 열려 있는 동안에는 편집기가 입력을 받지 않아, 최종 실행 때 새 미저장 글이 생기지 않는다 (최종 저장 단계는 저장할 것이 없다)', { timeout: 120_000 }, async () => {
  const { dir, app, page } = await setup();
  try {
    await wrapWrite(app);
    await nav(page, 'Two').click();
    await page.locator('.ProseMirror').getByText('alpha two').waitFor();
    const diskBefore = await readFile(join(dir, 'chapters', '002.md'));
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).waitFor();
    const received = (await ws(app)).received;
    await page.locator('.ProseMirror').getByText('alpha two').click({ force: true });
    await page.keyboard.press('End');
    await page.keyboard.insertText('합성입력');
    await page.waitForTimeout(300);
    assert.equal((await page.locator('.ProseMirror').innerText()).includes('합성입력'), false, '확인 창이 열린 동안의 입력은 편집기에 들어가지 않는다');
    assert.equal((await ws(app)).received, received, '저장 요청이 없다');
    assert.deepEqual(await readFile(join(dir, 'chapters', '002.md')), diskBefore);
    await dialog(page).getByRole('button', { name: '취소', exact: true }).click();
  } finally {
    await cleanup(app, page);
  }
});

test('현재 화 분석: 실행 전 저장이 실패하면 AI 요청 0·저장 실패 안내·입력 잠금 해제·입력한 글 보존·디스크 불변이고, 다시 시도는 새 확인만 열며, 복구 뒤 명시 승인으로만 새 저장 내용이 보내진다', { timeout: 150_000 }, async () => {
  const { dir, app, page, A } = await setup();
  try {
    await wrapWrite(app);
    await nav(page, 'Two').click();
    await page.locator('.ProseMirror').getByText('alpha two').waitFor();
    const diskBefore = await readFile(join(dir, 'chapters', '002.md'));
    const otherBefore = await readFile(join(dir, 'chapters', '001.md'));
    // 저장 거부를 입력보다 먼저 켠다: 느린 환경에서 자동 저장이 끼어도 성공 저장이 되지 않고, 끼어들면 수신 수가 늘어 아래에서 드러난다
    await setFail(app, true); // 이 뒤의 저장은 합성으로 거부된다 (실제 handler를 부르지 않는다)
    const baseline = (await ws(app)).received;
    await page.locator('.ProseMirror').getByText('alpha two').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText('합성입력');
    assert.ok((await page.locator('.ProseMirror').innerText()).includes('합성입력'));
    // 분석을 누르기 직전까지 저장 요청이 handler에 한 번도 오지 않았다: 아래 거부된 저장은 자동 저장이 아니라 분석 전 저장(beforeAnalyze)이 낸 것이다
    assert.equal((await ws(app)).received, baseline, '입력 뒤 클릭 직전까지 저장 요청이 없다');
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await until('분석 전 저장 시도가 거부되지 않았다', async () => (await ws(app)).rejected >= 1);
    assert.ok((await ws(app)).received > baseline, '분석 전 저장 요청이 handler에 수신됐다');
    const alert = page.getByRole('alert').filter({ hasText: /저장하지 못해 분석을 시작하지 않았습니다/ });
    await alert.first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(responses().length, 0, '선행·본 요청 모두 AI 요청이 없다');
    assert.equal(await dialog(page).count(), 0, '확인 창이 없다');
    assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true', '입력 잠금이 풀렸다');
    assert.ok((await page.locator('.ProseMirror').innerText()).includes('합성입력'), '입력한 글이 그대로다');
    assert.equal((await ws(app)).passed, 0, '실제 handler를 통과한 저장이 없다 (강제 저장 없음)');
    assert.deepEqual(await readFile(join(dir, 'chapters', '002.md')), diskBefore, '디스크는 마지막 성공 저장 그대로다');
    // 저장이 계속 막혀 있는 동안의 다시 시도: 확인 창 없이 같은 안내, 요청 0
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await page.waitForTimeout(600);
    assert.equal(await dialog(page).count(), 0, '저장이 막혀 있으면 새 확인 창도 없다');
    assert.equal(responses().length, 0);
    assert.ok((await page.locator('.ProseMirror').innerText()).includes('합성입력'));
    // 복구 후: 다시 시도 → 새 확인 창(요청 0) → 취소(요청 0) → 새 확인 → 명시 승인 뒤에만 새 저장 내용으로 정상 요청
    await setFail(app, false);
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await dialog(page).waitFor();
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '새 확인 창이 떠도 요청이 없다');
    await dialog(page).getByRole('button', { name: '취소', exact: true }).click();
    await page.waitForTimeout(300);
    assert.equal(responses().length, 0, '취소 뒤에도 요청이 없다');
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    await dialog(page).waitFor();
    await dialog(page).locator('button.primary').click(); // 명시 승인
    await until('요청이 나가지 않았다', async () => responses().length >= 1);
    assert.ok(responses().every((r) => modelOf(r) === A), JSON.stringify(responses().map(modelOf)));
    assert.match(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), /합성입력/, '복구 뒤 새 저장 내용이 디스크에 있다');
    // 실제로 보낸 요청의 원고 입력(user content)에 이 화(2화)의 원래 본문과 새로 입력한 글이 함께 들어 있다
    const userOf = (r: { body: unknown }) => (r.body as { input?: { role: string; content: string }[] }).input?.find((m) => m.role === 'user')?.content ?? '';
    const two = responses().map(userOf).filter((u) => u.includes('<chapter n="2">'));
    assert.equal(two.length, 1, `2화 본문 요청이 한 번 나갔다: ${responses().length}건`);
    assert.ok(two[0]!.includes('alpha two') && two[0]!.includes('합성입력'), `2화 요청 입력이 원래 본문과 새 입력을 함께 담는다: ${JSON.stringify(two[0])}`);
    assert.deepEqual(await readFile(join(dir, 'chapters', '001.md')), otherBefore, '다른 화(001.md)의 바이트는 그대로다');
  } finally {
    await setFail(app, false).catch(() => {});
    await cleanup(app, page);
  }
});
