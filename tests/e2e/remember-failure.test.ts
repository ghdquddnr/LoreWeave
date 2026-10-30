// 프로젝트를 열 때 "다음 실행 때 다시 열 폴더"(settings.json의 lastProject)를 저장하지 못해도, 열기는 성공한다.
// main과 화면이 같은 프로젝트를 보고 입력·저장이 되며, 기억하지 못했다는 오류는 숨기지 않고 보인다.
// 실제 앱(Electron + Playwright). 설정 쓰기를 실제로 실패시킨다 (settings.json 자리에 폴더 / 읽기 전용 파일). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { diagFailure } from './diag.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(prefix: string, text: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), text);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const header = (page: Page) => page.locator('.sidebar header strong');
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
const read = (dir: string) => readFile(join(dir, 'chapters', '001.md'), 'utf8');
const remembered = (page: Page) => page.getByRole('status').getByText('다음 실행 때 다시 열 폴더로 기억하지 못했습니다', { exact: false });
const settingsFile = (userData: string) => join(userData, 'settings.json');

async function open(app: ElectronApplication, page: Page, dir: string, first = false) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: first ? '원고 폴더 열기' : '열기', exact: true }).click();
}
/** settings.json 자리에 폴더를 만들어 설정 쓰기(와 읽기)를 실패하게 한다. 원래 파일은 옆에 옮겨 둔다 */
async function breakSettings(userData: string) {
  await rename(settingsFile(userData), join(userData, 'settings.saved.json')).catch(() => {});
  await mkdir(settingsFile(userData));
}
async function restoreSettings(userData: string) {
  await rm(settingsFile(userData), { recursive: true, force: true });
  await rename(join(userData, 'settings.saved.json'), settingsFile(userData)).catch(() => {});
}
/** 열린 화 끝에 글을 붙여 저장하고, 디스크에 들어갔는지 본다 */
async function typeAndSave(page: Page, dir: string, before: string, add: string) {
  await editor(page).getByText(before).click();
  await page.keyboard.press('End');
  await page.keyboard.type(add);
  // 진단 (E2E_DIAG_DIR가 있을 때만 기록): 입력 직후·저장 직후 상태 줄. 판정·대기는 바꾸지 않는다
  const statusAfterType = await page.getByRole('status').allInnerTexts();
  await page.keyboard.press('Control+S');
  const statusAfterSave = await page.getByRole('status').allInnerTexts();
  await saved(page);
  const text = await read(dir);
  const expected = new RegExp(`${before}${add}\\n$`);
  if (!expected.test(text)) {
    await diagFailure('fail.log', async () => `remember typeAndSave: statusAfterType=${JSON.stringify(statusAfterType)} statusAfterSave=${JSON.stringify(statusAfterSave)} fileLength=${text.length} hasAdd=${text.includes(add)}`);
  }
  assert.match(text, expected);
}

test('설정 저장 실패 중 전환 (감독 재현): B가 열리고 화면·main이 같은 B이며 입력·저장되고, 실패는 보이며, A로 다시 전환·취소·실패해도 저장되고, 설정이 돌아오면 다시 기억한다', { timeout: 90_000 }, async () => {
  const A = await project('remember-A', '# Alpha\n\nAlpha text\n');
  const B = await project('remember-B', '# Beta\n\nBeta text\n');
  const broken = await tempDir('remember-broken');
  await writeFile(join(broken, 'chapters'), 'not a folder');
  const userData = await tempDir('remember-userdata');
  const { app, page } = await launch(userData);
  try {
    await open(app, page, A, true);
    await editor(page).getByText('Alpha text').waitFor();
    assert.equal(await remembered(page).count(), 0);
    await breakSettings(userData);
    // B로 전환: 열기는 성공하고, 기억하지 못했다는 오류가 보인다
    await open(app, page, B);
    await editor(page).getByText('Beta text').waitFor({ timeout: 5000 });
    await remembered(page).waitFor({ timeout: 5000 });
    assert.equal(await header(page).innerText(), basename(B));
    assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
    await typeAndSave(page, B, 'Beta text', ' ACCEPTED');
    assert.equal(await page.getByText('원고 폴더가 바뀌어', { exact: false }).count(), 0);
    assert.equal(await read(A), '# Alpha\n\nAlpha text\n');
    assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
    // 연속 전환: 다시 A
    await open(app, page, A);
    await editor(page).getByText('Alpha text').waitFor({ timeout: 5000 });
    await remembered(page).waitFor({ timeout: 5000 });
    await typeAndSave(page, A, 'Alpha text', ' in A');
    assert.equal(await read(B), '# Beta\n\nBeta text ACCEPTED\n');
    // 취소·실패한 전환 뒤에도 A에 저장된다
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await typeAndSave(page, A, 'Alpha text in A', ' after-cancel');
    await open(app, page, broken);
    await page.getByRole('status').getByText(/ENOTDIR|not a directory/i).waitFor({ timeout: 5000 });
    await typeAndSave(page, A, 'Alpha text in A after-cancel', ' after-fail');
    // 설정이 돌아오면 다시 열 때 기억하고, 오류는 사라진다
    await restoreSettings(userData);
    await open(app, page, B);
    await editor(page).getByText('Beta text ACCEPTED').waitFor({ timeout: 5000 });
    assert.equal(await remembered(page).count(), 0);
    assert.equal(JSON.parse(await readFile(settingsFile(userData), 'utf8')).lastProject, B);
    await typeAndSave(page, B, 'Beta text ACCEPTED', ' again');
    assert.equal(await read(A), '# Alpha\n\nAlpha text in A after-cancel after-fail\n');
  } finally {
    await restoreSettings(userData);
    await closeWindow(app);
  }
});

test('설정 저장 실패 중 첫 열기: 열리고 입력·저장되며 실패가 보인다', { timeout: 60_000 }, async () => {
  const A = await project('remember-first', '# Alpha\n\nAlpha text\n');
  const userData = await tempDir('remember-first-userdata');
  await mkdir(settingsFile(userData));
  const { app, page } = await launch(userData);
  try {
    await open(app, page, A, true);
    await editor(page).getByText('Alpha text').waitFor({ timeout: 5000 });
    await remembered(page).waitFor({ timeout: 5000 });
    await typeAndSave(page, A, 'Alpha text', ' first');
  } finally {
    await closeWindow(app);
  }
});

test('설정 저장 실패 중 다시 시작해 마지막 폴더 다시 열기 (읽기 전용 settings.json): 열리고 입력·저장되며 실패가 보인다', { timeout: 60_000 }, async () => {
  const A = await project('remember-reopen', '# Alpha\n\nAlpha text\n');
  const userData = await tempDir('remember-reopen-userdata');
  let first = await launch(userData);
  try {
    await open(first.app, first.page, A, true);
    await editor(first.page).getByText('Alpha text').waitFor();
  } finally {
    await closeWindow(first.app);
  }
  // 읽기는 되지만 쓰기는 실패한다
  await chmod(settingsFile(userData), 0o444);
  const before = await readFile(settingsFile(userData), 'utf8');
  first = await launch(userData);
  try {
    await editor(first.page).getByText('Alpha text').waitFor({ timeout: 10_000 });
    await remembered(first.page).waitFor({ timeout: 5000 });
    assert.equal(await header(first.page).innerText(), basename(A));
    await typeAndSave(first.page, A, 'Alpha text', ' reopened');
    assert.equal(await readFile(settingsFile(userData), 'utf8'), before);
  } finally {
    await chmod(settingsFile(userData), 0o644);
    await closeWindow(first.app);
  }
});
