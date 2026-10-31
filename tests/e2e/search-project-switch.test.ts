// 완료된 검색 결과를 보는 중 다른 프로젝트를 열면 새 프로젝트의 화 목록이 보인다 (검색 활성 상태는 프로젝트 경계에서 초기화).
// 폴더 선택을 취소하면 기존 프로젝트의 검색 결과를 지우지 않는다. 합성 원고·격리 userData, 외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const A1 = `${envelope('a1', 'A_ONE')}알파 하나\r\n`;
const B1 = `${envelope('b1', 'B_ONE')}베타 하나\r\n`;

async function make(prefix: string, file: string, text: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', file), text);
  return dir;
}
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const results = (page: Page) => page.getByRole('list', { name: '검색 결과' });

async function openFolder(page: Page, app: Parameters<typeof stubFolderDialog>[0], dir: string, button: '원고 폴더 열기' | '열기') {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: button, exact: true }).click();
}
async function searchDone(page: Page, q: string) {
  await box(page).fill(q);
  await box(page).press('Enter');
  await results(page).waitFor();
}

test('완료된 검색 결과를 보다가 다른 프로젝트를 열면 새 화 목록이 보이고 검색 상태가 남지 않으며, 같은 폴더 다시 열기도 같다', { timeout: 90_000 }, async () => {
  const a = await make('sps-a', '001.md', A1);
  const b = await make('sps-b', '001.md', B1);
  const { app, page } = await launch(await tempDir('sps-ud'));
  try {
    await openFolder(page, app, a, '원고 폴더 열기');
    await list(page).getByRole('button', { name: 'A_ONE' }).waitFor();
    await searchDone(page, '알파');
    assert.equal(await list(page).isVisible(), false, '검색 결과 중에는 목록이 가려진다');

    await openFolder(page, app, b, '열기');
    await list(page).getByRole('button', { name: 'B_ONE' }).waitFor();
    assert.equal(await list(page).isVisible(), true, '새 프로젝트의 화 목록이 보인다');
    assert.equal(await box(page).inputValue(), '', '검색어 잔존 0');
    assert.equal(await results(page).count(), 0, '결과 잔존 0');
    assert.equal(await page.locator('.search-summary').count(), 0, '요약·찾는 중·오류 잔존 0');
    assert.equal(await page.locator('.search .error').count(), 0);

    // 새 프로젝트에서 정상 검색 → 같은 폴더 다시 열기도 목록 복원
    await searchDone(page, '베타');
    assert.equal(await list(page).isVisible(), false);
    await openFolder(page, app, b, '열기');
    await list(page).getByRole('button', { name: 'B_ONE' }).waitFor();
    assert.equal(await list(page).isVisible(), true, '같은 폴더 다시 열기: 목록 복원');
    assert.equal(await results(page).count(), 0);
    assert.equal(await readFile(join(a, 'chapters', '001.md'), 'utf8'), A1, 'A 원고 바이트 보존');
    assert.equal(await readFile(join(b, 'chapters', '001.md'), 'utf8'), B1, 'B 원고 바이트 보존');
  } finally {
    await closeWindow(app);
  }
});

test('폴더 선택을 취소하면 기존 프로젝트의 완료된 검색 결과와 상태를 그대로 둔다', { timeout: 90_000 }, async () => {
  const a = await make('sps-cancel', '001.md', A1);
  const { app, page } = await launch(await tempDir('sps-cancel-ud'));
  try {
    await openFolder(page, app, a, '원고 폴더 열기');
    await list(page).getByRole('button', { name: 'A_ONE' }).waitFor();
    await searchDone(page, '알파');
    const before = await page.locator('.search-summary').first().innerText();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: '열기', exact: true }).click();
    await page.waitForFunction(() => new Promise<boolean>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    assert.equal(await results(page).count(), 1, '취소해도 A의 검색 결과가 남는다');
    assert.equal(await box(page).inputValue(), '알파');
    assert.equal(await page.locator('.search-summary').first().innerText(), before);
    assert.equal(await list(page).isVisible(), false);
    assert.equal(await readFile(join(a, 'chapters', '001.md'), 'utf8'), A1);
  } finally {
    await closeWindow(app);
  }
});
