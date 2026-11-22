// 외부에서 이름이 바뀐 화의 [내 것으로 다시 만들기]가 성공하면, 프로젝트를 다시 열지 않아도 화 목록(이동된 원본 포함)과 중복 id 경고가 바로 갱신되어야 한다.
// 실제 앱(Electron + Playwright), 합성 원고(BOM + CRLF + frontmatter)·별도 userData. 외부 이름 변경은 테스트가 파일을 직접 옮긴다(다른 프로그램 흉내).
// 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 이름 변경 전에 저장되는 경합을 없앤다 (제품 코드·주기는 바꾸지 않는다).
// main의 chapters:list·chapter:write 처리기는 호출 수·거절·보류를 위한 무료 대역으로 감싼다 (원래 처리기로 그대로 넘긴다). 실제 파일 탐색기·실제 IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const ONE = `${envelope('one', 'ONE')}${lines('ONLY_LINE')}`;
const TWO = `${envelope('two', 'TWO')}${lines('KEEP_A')}`;
const BEE = `${envelope('bee', 'BEE')}${lines('BEE_LINE')}`;
const RECOVERED = `${envelope('one', 'ONE')}${lines('ONLY_LINE MINE')}`;

interface Hooks {
  listCalls: number;
  writes: number;
  /** 남은 거절 횟수 (chapters:list) */
  failList: number;
  /** 다음 chapters:list 한 번을 release()까지 붙잡는다: 'before'는 읽기 전, 'after'는 디스크를 읽어 스냅숏을 만든 뒤(그 뒤의 변경은 이 응답에 없다) */
  hold: false | 'before' | 'after';
  /** 붙잡았던 'before' 호출을 풀 때 거절한다 (늦은 실패 응답) */
  failHeld: boolean;
  /** true면 다음 chapter:create를 디스크를 바꾸기 전에 거절한다 */
  failCreate: boolean;
  held: number;
  release?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없다)
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { listCalls: 0, writes: 0, failList: 0, hold: false, failHeld: false, failCreate: false, held: 0 };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const list = handlers.get('chapters:list')!;
    handlers.set('chapters:list', async (...args: unknown[]) => {
      const h = g.hooks;
      h.listCalls += 1;
      if (h.failList > 0) {
        h.failList -= 1;
        throw Object.assign(new Error("EACCES: permission denied, scandir 'chapters' (synthetic)"), { code: 'EACCES' });
      }
      if (h.hold === 'before') {
        h.hold = false;
        h.held += 1;
        await new Promise<void>((resolve) => (h.release = resolve));
        if (h.failHeld) {
          h.failHeld = false;
          throw Object.assign(new Error("EACCES: permission denied, scandir 'chapters' (synthetic)"), { code: 'EACCES' });
        }
      }
      if (h.hold === 'after') {
        h.hold = false;
        const snapshot = await list(...args);
        h.held += 1;
        await new Promise<void>((resolve) => (h.release = resolve));
        return snapshot;
      }
      return list(...args);
    });
    const create = handlers.get('chapter:create')!;
    handlers.set('chapter:create', async (...args: unknown[]) => {
      if (g.hooks.failCreate) {
        g.hooks.failCreate = false;
        throw Object.assign(new Error("EACCES: permission denied, open '004.md' (synthetic)"), { code: 'EACCES' });
      }
      return create(...args);
    });
    const write = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.hooks.writes += 1;
      return write(...args);
    });
  });
const setHooks = (app: ElectronApplication, patch: Partial<Pick<Hooks, 'failList' | 'hold' | 'failHeld' | 'failCreate'>>) =>
  app.evaluate((_e, p) => void Object.assign((globalThis as unknown as { hooks: Hooks }).hooks, p), patch);
const hooks = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { hooks: Hooks }).hooks, release: undefined }));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.release?.());
async function until(app: ElectronApplication, what: string, ok: (h: Hooks) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const h = await hooks(app);
    if (ok(h)) return h;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${what} ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const names = (page: Page) => list(page).getByRole('button').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
const recreateButton = (page: Page) => page.getByRole('button', { name: '내 것으로 다시 만들기' });
const dupAlert = (page: Page) => page.getByRole('alert').filter({ hasText: '같은 id를 쓰는 화가 있습니다' });
const footerError = (page: Page) => page.locator('footer .error');
const newChapter = (page: Page) => page.getByRole('button', { name: '+ 새 화', exact: true });
const reread = (page: Page) => page.locator('footer').getByRole('button', { name: '목록 다시 읽기' });
const exists = (path: string) => access(path).then(() => true, () => false);

async function prepare(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const f = (n: string) => join(dir, 'chapters', n);
  await writeFile(f('001.md'), ONE);
  await writeFile(f('002.md'), TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await list(page).getByRole('button', { name: 'ONE' }).click();
  await editor(page).getByText('ONLY_LINE', { exact: true }).waitFor();
  await page.evaluate(`(() => {
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
  })()`);
  await hook(app);
  // 미저장 입력 뒤 외부에서 001.md를 003.md로 옮긴다: 이름 변경/삭제 충돌 안내가 나온다
  await editor(page).getByText('ONLY_LINE', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' MINE');
  await rename(f('001.md'), f('003.md'));
  await recreateButton(page).waitFor({ timeout: 15_000 });
  return { app, page, dir, f };
}

test('이름이 바뀐 화를 [내 것으로 다시 만들기]로 저장하면 다시 열지 않아도 목록에 이동된 원본이 보이고 중복 id 경고가 뜨며, 두 파일의 바이트가 보존된다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list');
  try {
    // 클릭 전: 목록은 아직 옛 두 화이고 옛 이름은 디스크에 없으며 아직 아무것도 쓰지 않았다
    assert.deepEqual(await names(page), ['ONE', 'TWO'], '이름 변경 직후 목록은 아직 옛 상태다');
    assert.equal(await exists(f('001.md')), false, '옛 이름은 자동으로 되살아나지 않는다');
    assert.equal((await hooks(app)).writes, 0, '클릭 전 저장 요청 0');
    assert.equal(await dupAlert(page).count(), 0, '클릭 전 중복 id 경고 없음');

    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    // 다시 열지 않아도: 세 화(이동된 원본 포함)와 중복 id 경고가 바로 보인다
    await list(page).getByRole('button', { name: 'ONE' }).nth(1).waitFor({ timeout: 10_000 });
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE'], '001/002/003 세 화가 목록에 있다');
    await dupAlert(page).waitFor();
    const items = await dupAlert(page).locator('li').allInnerTexts();
    assert.ok(items.some((t) => t.includes('001.md')) && items.some((t) => t.includes('003.md')), `중복 경고가 두 파일을 가리킨다: ${items.join(' | ')}`);
    const after = await hooks(app);
    assert.equal(after.writes, 1, '복구는 기존 저장 경로로 정확히 한 번 썼다');
    assert.equal(after.listCalls, 1, '복구 성공 뒤 목록 조회는 한 번이다');

    // 바이트: 옛 경로는 미저장 글이 든 복구본(BOM·CRLF·frontmatter 보존), 이동된 원본과 이웃 화는 그대로
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED), '복구된 001.md');
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE), '이동된 원본 003.md 불변');
    assert.deepEqual(await readFile(f('002.md')), Buffer.from(TWO), '이웃 002.md 불변');

    // 두 파일을 모두 열 수 있다 (같은 제목이어도 목록 순서로 구분): 003은 원본, 001은 복구본
    await list(page).getByRole('button', { name: 'ONE' }).nth(1).click();
    await editor(page).getByText('ONLY_LINE', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-path').innerText(), 'chapters/003.md');
    await list(page).getByRole('button', { name: 'ONE' }).nth(0).click();
    await editor(page).getByText('ONLY_LINE MINE', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-path').innerText(), 'chapters/001.md');
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE), '화를 오간 뒤에도 003.md 불변');
  } finally {
    await closeWindow(app);
  }
});

test('복구 저장은 성공했는데 뒤따르는 목록 조회가 실패하면 저장 실패로 처리하지 않고, 읽기 실패로 알리며 [목록 다시 읽기]로 복구한다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-fail');
  try {
    await setHooks(app, { failList: 1 });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await footerError(page).waitFor({ timeout: 10_000 });
    const text = await footerError(page).innerText();
    assert.match(text, /다시 만들어 저장했지만 화 목록을 다시 읽지 못했습니다/, '저장 성공과 목록 조회 실패를 구별해 알린다');
    assert.match(text, /읽을 수 없습니다/, '읽기 실패로 안내한다');
    for (const wrong of ['저장 실패', '저장하지 못']) assert.ok(!text.includes(wrong), `성공한 저장을 실패(${wrong})로 안내하지 않는다: ${text}`);
    assert.equal(await page.getByRole('status').getByText('저장됨', { exact: true }).count(), 1, '저장 상태는 저장됨 그대로');
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED), '복구본은 디스크에 그대로');
    assert.deepEqual(await names(page), ['ONE', 'TWO'], '목록은 갱신되지 않았다');

    await reread(page).click();
    await list(page).getByRole('button', { name: 'ONE' }).nth(1).waitFor({ timeout: 10_000 });
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE']);
    await dupAlert(page).waitFor();
    assert.equal(await footerError(page).count(), 0, '복구하면 안내가 사라진다');
    const h = await hooks(app);
    assert.equal(h.writes, 1, '복구 뒤에도 쓰기는 한 번뿐이다 (다시 읽기가 다시 쓰지 않는다)');
    assert.equal(h.listCalls, 2, '실패 한 번 + 다시 읽기 한 번');
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE), '003.md 불변');
    assert.deepEqual(await readFile(f('002.md')), Buffer.from(TWO), '002.md 불변');
  } finally {
    await closeWindow(app);
  }
});

test('복구 뒤 목록 조회가 끝나기 전에 다른 프로젝트를 열면, 이전 프로젝트의 목록·오류·중복 경고가 새 프로젝트 화면에 반영되지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-switch');
  const other = await tempDir('recreate-list-switch-b');
  await mkdir(join(other, 'chapters'));
  await writeFile(join(other, 'chapters', '001.md'), BEE);
  try {
    await setHooks(app, { hold: 'before' });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '복구 뒤 목록 조회가 붙잡힘', (h) => h.held === 1);
    // 붙잡힌 사이에 다른 프로젝트로 바꾼다
    await stubFolderDialog(app, other);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await list(page).getByRole('button', { name: 'BEE' }).waitFor({ timeout: 10_000 });
    await release(app);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(await names(page), ['BEE'], '새 프로젝트의 목록만 보인다');
    assert.equal(await dupAlert(page).count(), 0, '이전 프로젝트의 중복 id 경고가 남지 않는다');
    assert.equal(await footerError(page).count(), 0, '이전 프로젝트의 늦은 응답·거절이 오류로 나타나지 않는다');
    // 이전 프로젝트에 이미 성공한 복구는 그 폴더에 그대로 남는다
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED), '이전 프로젝트의 복구본 보존');
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE), '이전 프로젝트의 003.md 보존');
    assert.deepEqual(await readFile(join(other, 'chapters', '001.md')), Buffer.from(BEE), '새 프로젝트 원고 불변');
  } finally {
    await closeWindow(app);
  }
});

test('복구 뒤 목록 응답이 늦는 사이 [+ 새 화]를 만들면, 늦게 도착한 이전 목록이 새 화를 목록에서 지우지 않는다 (디스크에는 남아 있고 목록도 유지)', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-race-new');
  try {
    await setHooks(app, { hold: 'after' }); // 001/002/003 스냅숏을 만든 뒤 응답을 붙잡는다
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '스냅숏 뒤 응답이 붙잡힘', (h) => h.held === 1);
    // 사용자가 새 화를 만든다: 최신 목록에 4화가 보인다
    await newChapter(page).click();
    await list(page).getByRole('button', { name: '4화' }).waitFor({ timeout: 10_000 });
    assert.ok(await exists(f('004.md')), '004.md가 디스크에 있다');
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE', '4화']);
    // 이전 스냅숏 응답 도착: 새 화가 목록에서 사라지지 않는다
    await release(app);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE', '4화'], '늦은 이전 목록이 최신 목록을 덮지 않았다');
    assert.ok(await exists(f('004.md')), '004.md는 디스크에 그대로다');
    await dupAlert(page).waitFor();
    assert.equal(await footerError(page).count(), 0, '안내 오류 없음');
    const h = await hooks(app);
    assert.equal(h.writes, 1, '복구 쓰기는 한 번뿐이다');
    assert.equal(h.listCalls, 2, '복구 뒤 조회 한 번 + 새 화 뒤 조회 한 번');
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED), '복구본 보존');
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE), '003.md 불변');
    assert.deepEqual(await readFile(f('002.md')), Buffer.from(TWO), '002.md 불변');
  } finally {
    await closeWindow(app);
  }
});

test('복구 뒤 목록 조회가 늦게 실패해도, 그 사이 새 화로 갱신된 최신 목록과 안내를 이전 오류가 덮지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-race-error');
  try {
    await setHooks(app, { hold: 'before', failHeld: true });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '복구 뒤 목록 조회가 붙잡힘', (h) => h.held === 1);
    await newChapter(page).click();
    await list(page).getByRole('button', { name: '4화' }).waitFor({ timeout: 10_000 });
    const before = await names(page);
    await release(app); // 붙잡았던 이전 조회가 이제 거절된다
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await footerError(page).count(), 0, '늦게 온 이전 오류가 새 상태에 나타나지 않는다');
    assert.equal(await reread(page).count(), 0, '이전 오류의 [목록 다시 읽기]가 남지 않는다');
    assert.deepEqual(await names(page), before, '최신 목록이 그대로다');
    assert.ok(await exists(f('004.md')));
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED));
    assert.equal((await hooks(app)).writes, 1);
  } finally {
    await closeWindow(app);
  }
});

test('복구 뒤 목록 응답이 늦는 사이 [+ 새 화]가 디스크를 바꾸기 전에 거절돼도, 복구의 유효한 목록(003·중복 경고)은 반영되고 생성 오류는 그대로 남는다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-race-create-rejected');
  try {
    await setHooks(app, { hold: 'after' });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '스냅숏 뒤 응답이 붙잡힘', (h) => h.held === 1);
    await setHooks(app, { failCreate: true });
    await newChapter(page).click();
    await footerError(page).waitFor({ timeout: 10_000 });
    const createError = await footerError(page).innerText();
    assert.equal(await exists(f('004.md')), false, '거절된 생성은 디스크를 바꾸지 않았다');
    assert.deepEqual(await names(page), ['ONE', 'TWO'], '복구 응답이 오기 전 목록은 아직 옛 상태다');
    await release(app);
    // 실패한 목록 조작은 복구 결과를 무효로 만들지 않는다: 003과 중복 경고가 나타난다
    await list(page).getByRole('button', { name: 'ONE' }).nth(1).waitFor({ timeout: 10_000 });
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE'], '001/002/003 세 화');
    await dupAlert(page).waitFor();
    assert.equal(await footerError(page).innerText(), createError, '생성 오류는 보존된다');
    assert.equal(await reread(page).count(), 0, '생성 오류에는 [목록 다시 읽기]가 없다');
    assert.equal(await exists(f('004.md')), false, '004.md 없음');
    const h = await hooks(app);
    assert.equal(h.writes, 1, '복구 쓰기는 한 번뿐이다');
    assert.equal(h.listCalls, 1, '목록 조회는 복구 뒤 한 번뿐이다 (생성이 거절돼 다른 조회 없음)');
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED), '복구본 보존');
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE), '003.md 불변');
    assert.deepEqual(await readFile(f('002.md')), Buffer.from(TWO), '002.md 불변');
  } finally {
    await closeWindow(app);
  }
});

test('복구 뒤 목록 응답이 늦는 사이 [+ 새 화]는 만들어졌지만 그 목록 조회가 실패하면, 반영되지 않은 새 조작이 복구 결과를 무효로 만들지 않고 [목록 다시 읽기]로 최신 목록이 된다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-race-new-list-fails');
  try {
    await setHooks(app, { hold: 'after' });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '스냅숏 뒤 응답이 붙잡힘', (h) => h.held === 1);
    await setHooks(app, { failList: 1 }); // 새 화 뒤의 목록 조회만 거절한다 (붙잡힌 조회는 이미 지나갔다)
    await newChapter(page).click();
    await footerError(page).waitFor({ timeout: 10_000 });
    const createdNote = await footerError(page).innerText();
    assert.match(createdNote, /새 화\(004\.md\)는 만들어졌지만/, '생성 성공과 목록 조회 실패를 구별해 알린다');
    assert.ok(await exists(f('004.md')), '004.md는 디스크에 있다');
    await release(app);
    await list(page).getByRole('button', { name: 'ONE' }).nth(1).waitFor({ timeout: 10_000 });
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE'], '새 조작이 실패했으므로 복구 목록이 가장 새 정보다 (004는 아직 목록에 없다)');
    await dupAlert(page).waitFor();
    assert.equal(await footerError(page).innerText(), createdNote, '새 화 안내는 그대로 남는다');
    await reread(page).first().click();
    await list(page).getByRole('button', { name: '4화' }).waitFor({ timeout: 10_000 });
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE', '4화']);
    assert.equal(await footerError(page).count(), 0, '다시 읽으면 안내가 사라진다');
    assert.equal((await hooks(app)).writes, 1, '복구 쓰기는 한 번뿐이다');
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED));
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE));
  } finally {
    await closeWindow(app);
  }
});

test('복구 조회와 새 화 뒤 조회가 모두 실패할 때(새 조작이 먼저 실패): 늦게 거절된 이전 복구 오류가 새 화 안내와 재시도 대상을 덮지 않고, 다시 읽기 성공 시 새 화가 열린다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-dual-fail-new-first');
  try {
    await setHooks(app, { hold: 'before', failHeld: true });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '복구 뒤 목록 조회가 붙잡힘', (h) => h.held === 1);
    await setHooks(app, { failList: 1 }); // 새 화 뒤의 조회도 거절한다
    await newChapter(page).click();
    await footerError(page).waitFor({ timeout: 10_000 });
    const note = await footerError(page).innerText();
    assert.ok(note.includes('새 화(004.md)는 만들어졌지만'), '새 화 생성 성공·목록 조회 실패 안내: ' + note);
    assert.ok(await exists(f('004.md')), '004.md는 디스크에 있다');
    await release(app); // 붙잡았던 이전 복구 조회가 이제 늦게 거절된다
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await footerError(page).innerText(), note, '이전 복구 오류가 더 새 조작의 안내를 덮지 않았다');
    assert.equal(await reread(page).count(), 1, '재시도 단추는 새 화의 것 하나뿐이다');
    await reread(page).first().click();
    await list(page).getByRole('button', { name: '4화' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.file-path').innerText(), 'chapters/004.md', '다시 읽기가 성공하면 새 화가 열린다 (001이 계속 열려 있지 않다)');
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE', '4화']);
    await dupAlert(page).waitFor();
    assert.equal(await footerError(page).count(), 0, '안내가 정리된다');
    assert.equal(await reread(page).count(), 0, '재시도 단추도 정리된다');
    assert.equal((await hooks(app)).writes, 1, '복구 쓰기는 한 번뿐이다');
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED));
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE));
    assert.deepEqual(await readFile(f('002.md')), Buffer.from(TWO));
  } finally {
    await closeWindow(app);
  }
});

test('복구 조회와 새 화 뒤 조회가 모두 실패할 때(복구 오류가 먼저): 나중 새 화 실패 안내가 복구 안내를 대체하고, 다시 읽기 성공 시 새 화가 열리며 안내가 정리된다', { timeout: 120_000 }, async () => {
  const { app, page, f } = await prepare('recreate-list-dual-fail-recreate-first');
  try {
    await setHooks(app, { hold: 'before', failHeld: true });
    await recreateButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    await until(app, '복구 뒤 목록 조회가 붙잡힘', (h) => h.held === 1);
    await release(app); // 복구 조회가 먼저 거절된다
    await footerError(page).waitFor({ timeout: 10_000 });
    assert.ok((await footerError(page).innerText()).includes('이 화는 다시 만들어 저장했지만'), '복구 목록 조회 실패 안내');
    assert.equal(await reread(page).count(), 1);
    await setHooks(app, { failList: 1 });
    await newChapter(page).click();
    await page.locator('footer .error', { hasText: '새 화(004.md)' }).waitFor({ timeout: 10_000 });
    assert.equal(await reread(page).count(), 1, '재시도 단추는 하나뿐이다');
    await reread(page).first().click();
    await list(page).getByRole('button', { name: '4화' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('.file-path').innerText(), 'chapters/004.md', '다시 읽기가 성공하면 새 화가 열린다');
    assert.deepEqual(await names(page), ['ONE', 'TWO', 'ONE', '4화']);
    await dupAlert(page).waitFor();
    assert.equal(await footerError(page).count(), 0, '안내가 정리된다');
    assert.equal((await hooks(app)).writes, 1);
    assert.deepEqual(await readFile(f('001.md')), Buffer.from(RECOVERED));
    assert.deepEqual(await readFile(f('003.md')), Buffer.from(ONE));
  } finally {
    await closeWindow(app);
  }
});
