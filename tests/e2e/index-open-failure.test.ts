// 색인 DB를 여는 ManuscriptIndex.open 자체가 실패해도(예: `.loreweave`가 폴더가 아니라 일반 파일이라 mkdirSync가 실패), 원고 열기·편집·저장은 영향이 없고
// 검색은 정상 "없음"으로 가장하지 않고 명확한 오류를 알리며, 원인을 없애고 같은 폴더를 다시 열면 복구되는지 본다.
// (initial-sync-eacces는 초기 맞춤 중 실패, save-index-failure는 갱신 실패다. 기존 indexer 단위 테스트의 손상/버전 재생성과 다른 경계다.)
// 실패는 주입이 아니라 실제 파일시스템 상태다: 합성 프로젝트에 `.loreweave`를 일반 파일로 만든다 (키·권한 변경 없음; mkdirSync가 EEXIST로 실패).
// 관측: 열기 응답(화 목록 표시), 검색 IPC/UI 응답(검색은 openIndex의 처리가 끝난 뒤 응답한다), 편집·저장·바이트·외부 수정 알림/충돌.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', 'One', 'Alpha originalword');
const TWO = doc('two', 'Two', 'Beta twoword');
const EXTERNAL = doc('one', 'One', 'Alpha externalword');

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const searchApi = (page: Page, q: string) =>
  page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => ({ ok: true, total: r.total }), (e) => ({ ok: false, message: e.message }))`) as Promise<
    { ok: true; total: number } | { ok: false; message: string }
  >;
async function searchUiError(page: Page, q: string): Promise<string | null> {
  const box = page.getByRole('search').getByRole('searchbox', { name: '원고 검색' });
  await box.fill(q);
  await box.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.search-summary')?.textContent?.includes('찾는 중'));
  const error = await page.locator('.search p.error').first().textContent({ timeout: 1000 }).catch(() => null);
  await box.press('Escape');
  return error;
}
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

/** 합성 프로젝트. broken이면 `.loreweave`를 일반 파일로 만들어 색인 DB를 열 수 없게 한다 */
async function project(broken: boolean): Promise<string> {
  const dir = await tempDir('index-open-fail');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  if (broken) await writeFile(join(dir, '.loreweave'), 'not a directory');
  return dir;
}

test('색인 DB를 열 수 없어도 원고 열기·편집·저장은 정상이고, 검색은 명확한 오류를 알리며, 바깥 수정 보호가 유지되고, 원인을 없애고 다시 열면 복구된다', { timeout: 150_000 }, async () => {
  const dir = await project(true);
  const one = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('index-open-fail-userdata'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').click();
    await editor(page).getByText('originalword').waitFor(); // 열기·읽기는 정상
    assert.equal((await stat(join(dir, '.loreweave'))).isFile(), true, '실제 파일시스템 상태: .loreweave는 일반 파일이다');
    // 검색: 정상 "없음"으로 가장하지 않고 오류를 알린다 (IPC와 화면 모두)
    const api = await searchApi(page, 'originalword');
    assert.equal(api.ok, false, '색인을 열 수 없는데 검색이 정상 결과로 답했다');
    assert.match(api.ok ? '' : api.message, /검색 색인을 만들 수 없습니다/);
    const uiError = await searchUiError(page, 'originalword');
    assert.ok(uiError && /검색 색인을 만들 수 없습니다/.test(uiError), `화면에 검색 오류가 보여야 한다: ${uiError}`);
    // 편집·저장: 수락한 입력이 정확한 바이트로 저장되고, 다른 화를 갔다 와도 다시 읽힌다
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' mine');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(one, 'utf8'), doc('one', 'One', 'Alpha originalword mine'));
    await chapter(page, 'Two').click();
    await editor(page).getByText('twoword').waitFor();
    await chapter(page, 'One').click();
    await editor(page).getByText('Alpha originalword mine', { exact: true }).waitFor();
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), TWO, '다른 화 원고는 바뀌지 않는다');
    // 바깥 수정: 감시는 정상이다. 저장하지 않은 입력이 있는 채 바깥에서 바꾸면 덮어쓰지 않고 충돌로 알린다 (바깥 바이트·입력 보존)
    await editor(page).getByText('Alpha originalword mine', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await writeFile(one, EXTERNAL);
    await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(one, 'utf8'), EXTERNAL, '바깥 바이트는 덮어쓰이지 않는다');
    assert.equal(await editor(page).getByText('Alpha originalword mine more', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    // 원인을 없애고(.loreweave 파일 제거) 같은 폴더를 다시 열면 색인이 만들어져 검색이 복구된다
    await rm(join(dir, '.loreweave'));
    await stubFolderDialog(app, dir);
    page.once('dialog', (d) => void d.accept()); // 충돌 중인 미저장 입력을 버리고 다시 연다 (합성 원고)
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '다시 연 뒤 검색이 복구되지 않았다', async () => {
      const r = await searchApi(page, 'externalword');
      return r.ok && r.total === 1;
    });
    assert.deepEqual(await searchApi(page, 'twoword'), { ok: true, total: 1 });
    assert.equal(await readFile(one, 'utf8'), EXTERNAL);
  } finally {
    await cleanup(app, page);
  }
});

test('색인을 열 수 없던 프로젝트의 오류는 다른 프로젝트로 퍼지지 않는다', { timeout: 150_000 }, async () => {
  const dir = await project(true);
  const { app, page } = await launch(await tempDir('index-open-fail-userdata'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    assert.equal((await searchApi(page, 'originalword')).ok, false, '실패한 프로젝트는 검색 오류를 낸다');
    const other = await tempDir('index-open-fail-other');
    await mkdir(join(other, 'chapters'));
    await writeFile(join(other, 'chapters', '001.md'), doc('x1', 'Other One', 'Delta otherword'));
    await stubFolderDialog(app, other);
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await chapter(page, 'Other One').waitFor();
    await waitUntil(page, '다른 프로젝트의 검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'otherword');
      return r.ok && r.total === 1;
    });
  } finally {
    await cleanup(app, page);
  }
});

test('대조: 정상 프로젝트는 색인이 만들어지고 검색이 정상이다', { timeout: 120_000 }, async () => {
  const dir = await project(false);
  const { app, page } = await launch(await tempDir('index-open-fail-userdata'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await chapter(page, 'One').waitFor();
    await waitUntil(page, '검색이 열리지 않았다', async () => {
      const r = await searchApi(page, 'originalword');
      return r.ok && r.total === 1;
    });
    assert.equal((await stat(join(dir, '.loreweave'))).isDirectory(), true);
  } finally {
    await cleanup(app, page);
  }
});
