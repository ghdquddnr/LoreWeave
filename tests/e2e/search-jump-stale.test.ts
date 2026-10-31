// 검색 결과로 이동할 때, 검색한 뒤 같은 화의 본문이 바뀌었다면 옛 줄/글자 좌표로 엉뚱한 글자를 일치처럼 선택하지 않는다.
// 현재 본문에서 검색 당시의 줄이 그대로 하나뿐이면 그 줄의 일치로 옮기고, 사라졌거나 하나로 정할 수 없으면 선택을 접고 다시 검색하라고 알린다.
// 합성 원고·격리 userData. 이동만으로 쓰기·저장·불러오기를 하지 않는다 (디스크 바이트·미저장 본문 보존).

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const BODY = `${envelope('one', 'ONE')}${lines('AAAA 시작 문단', '지현이 말했다 하나', 'BBBB 끝 문단')}`;
const DUP = `${envelope('dup', 'DUP')}${lines('지현이 말했다 반복', 'CCCC 사이', '지현이 말했다 반복')}`;

const editor = (page: Page) => page.locator('.ProseMirror');
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const results = (page: Page) => page.getByRole('list', { name: '검색 결과' }).getByRole('button');
const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');
/** 선택이 있는 문단의 번호 (0부터) */
const selectedParagraph = (page: Page) =>
  page.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    const p = (node instanceof Element ? node : node?.parentElement)?.closest('.ProseMirror > p');
    return p ? [...(p.parentElement?.children ?? [])].indexOf(p) : -1;
  });
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

async function start(prefix: string, file: string, text: string, title: string, extra: Record<string, string> = {}) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', file), text);
  for (const [f, t] of Object.entries(extra)) await writeFile(join(dir, 'chapters', f), t);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title }).click();
  await editor(page).getByText('지현', { exact: false }).first().waitFor();
  await box(page).fill('지현');
  await box(page).press('Enter');
  await results(page).first().waitFor();
  return { app, page, dir, disk: () => readFile(join(dir, 'chapters', file), 'utf8') };
}

test('검색한 뒤 일치보다 앞에 문단을 넣어도 옛 좌표의 엉뚱한 글자 대신 지금 본문의 그 일치를 선택한다', { timeout: 90_000 }, async () => {
  const { app, page, disk } = await start('sjs-insert', '001.md', BODY, 'ONE');
  try {
    // 일치(둘째 문단)보다 앞에 새 문단을 넣는다: 줄 번호가 하나 밀린다 (저장하지 않은 입력)
    await editor(page).getByText('AAAA 시작 문단', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('NEWTOP');
    await page.keyboard.press('Enter');
    await editor(page).getByText('NEWTOP', { exact: true }).waitFor();
    const before = await disk();
    await results(page).first().click();
    await settled(page);
    assert.equal(await selection(page), '지현', '엉뚱한 글자가 아니라 검색한 글자를 선택한다');
    assert.equal(await selectedParagraph(page), 2, '밀린 위치(지금 본문의 그 줄)를 선택한다');
    assert.equal(await disk(), before, '이동만으로 디스크는 바뀌지 않는다');
    assert.match(await editor(page).innerText(), /NEWTOP/, '미저장 입력 보존');
  } finally {
    await closeWindow(app);
  }
});

test('일치한 문구를 지운 뒤에는 아무 글자도 일치처럼 선택하지 않고 다시 검색하라고 알린다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('sjs-deleted', '001.md', BODY, 'ONE');
  try {
    // 일치가 있던 둘째 문단의 글을 모두 지운다
    await editor(page).getByText('지현이 말했다 하나', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Delete');
    await editor(page).getByText('지현이 말했다 하나').waitFor({ state: 'detached' });
    await results(page).first().click();
    await settled(page);
    assert.equal(await selection(page), '', '아무 글자도 선택하지 않는다');
    await page.getByText(/다시 검색/).first().waitFor();
  } finally {
    await closeWindow(app);
  }
});

test('본문이 그대로이면 같은 문구가 반복돼도 누른 결과의 줄을 정확히 선택하고, 앞에 문단을 넣은 뒤에는 옛 좌표를 차지한 다른 발생이 아니라 앞뒤 줄로 식별되는 원래 발생으로 가고 식별할 수 없으면 선택을 접는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('sjs-dup', '001.md', DUP, 'DUP');
  try {
    assert.equal(await results(page).count(), 2);
    await results(page).nth(1).click();
    await settled(page);
    assert.equal(await selection(page), '지현');
    assert.equal(await selectedParagraph(page), 2, '두 번째 결과는 두 번째 줄');
    await results(page).nth(0).click();
    await settled(page);
    assert.equal(await selectedParagraph(page), 0, '첫 결과는 첫 줄');
    // 첫 문단 앞에 두 문단을 넣는다: 같은 줄이 둘이고, 옛 좌표(문단 2)에는 이제 첫 발생이 놓인다
    await editor(page).getByText('지현이 말했다 반복').first().click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('TOP1');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('TOP2');
    await page.keyboard.press('Enter');
    await editor(page).getByText('TOP2', { exact: true }).waitFor();
    const lines = await editor(page).locator('> p').allInnerTexts();
    assert.deepEqual(lines.map((t) => t.trim()), ['TOP1', 'TOP2', '지현이 말했다 반복', 'CCCC 사이', '지현이 말했다 반복'], '삽입 뒤 본문');
    // 원래 둘째 결과: 옛 좌표(문단 2)는 첫 발생이지만, 앞뒤 줄로 식별되는 원래 둘째(문단 4)로 간다
    await results(page).nth(1).click();
    await settled(page);
    assert.equal(await selection(page), '지현');
    assert.equal(await selectedParagraph(page), 4, '옛 좌표를 차지한 다른 발생(첫째)이 아니라 원래 둘째 발생');
    // 원래 첫째 결과는 앞줄이 바뀌어(문서 처음 → TOP2) 안전하게 식별할 수 없으므로 선택을 접는다 (둘째로 가지 않는다)
    await results(page).nth(0).click();
    await settled(page);
    assert.equal(await selection(page), '', '식별할 수 없으면 선택하지 않는다');
  } finally {
    await closeWindow(app);
  }
});

const OTHER = `${envelope('other', 'OTHER')}${lines('지현 OTHER 본문')}`;

test('다른 화를 거쳐 돌아와도(편집기가 새로 만들어져도) 검색 당시 앞뒤 줄로 원래 발생을 식별하고, 식별할 수 없으면 선택을 접는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('sjs-reopen', '001.md', DUP, 'DUP', { '002.md': OTHER });
  try {
    assert.equal(await results(page).count(), 3, 'DUP 2건 + OTHER 1건');
    await results(page).nth(1).click();
    await settled(page);
    assert.equal(await selectedParagraph(page), 2, '둘째 결과(변경 전)');
    await results(page).nth(0).click();
    await settled(page);
    assert.equal(await selectedParagraph(page), 0, '첫째 결과(변경 전)');
    // DUP 첫 문단 앞에 TOP1/TOP2 삽입
    await editor(page).getByText('지현이 말했다 반복').first().click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('TOP1');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('TOP2');
    await page.keyboard.press('Enter');
    await editor(page).getByText('TOP2', { exact: true }).waitFor();
    // 다른 화(OTHER)로 갔다 온다: 정상 이동은 보존된다
    await results(page).nth(2).click();
    await editor(page).getByText('지현 OTHER 본문').waitFor();
    // 본문이 보이는 것과 이동(선택)이 적용되는 것은 다르다: 올바른 선택이 적용될 때까지 조건으로 기다린다 (시간 제한 안에 안 되면 실패)
    await page.waitForFunction(() => window.getSelection()?.toString() === '지현', undefined, { timeout: 10_000 });
    await settled(page);
    assert.equal(await selection(page), '지현', '다른 화 결과의 정상 이동');
    // DUP 편집기는 새로 만들어진다: 원래 둘째는 문단 4로, 원래 첫째는 선택을 접는다
    await results(page).nth(1).click();
    await editor(page).getByText('TOP2', { exact: true }).waitFor();
    await settled(page);
    assert.equal(await selection(page), '지현');
    assert.equal(await selectedParagraph(page), 4, '다른 화를 거친 뒤에도 원래 둘째 발생');
    await results(page).nth(0).click();
    await settled(page);
    assert.equal(await selection(page), '', '식별할 수 없으면 선택하지 않는다');
  } finally {
    await closeWindow(app);
  }
});

test('다음 검색이 실패해도 이전 결과의 이동은 그 결과의 검색 당시 상태를 기준으로 한다 (실패한 검색의 스냅샷을 이전 결과에 적용하지 않는다)', { timeout: 90_000 }, async () => {
  const { app, page } = await start('sjs-failed-search', '001.md', DUP, 'DUP');
  try {
    assert.equal(await results(page).count(), 2);
    await results(page).nth(1).click();
    await settled(page);
    assert.equal(await selectedParagraph(page), 2, '둘째 결과(변경 전)');
    // 첫 문단 앞에 TOP1/TOP2 삽입 → 다음 검색 IPC만 실패시킨다
    await editor(page).getByText('지현이 말했다 반복').first().click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('TOP1');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('TOP2');
    await page.keyboard.press('Enter');
    await editor(page).getByText('TOP2', { exact: true }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chapters:search');
      ipcMain.handle('chapters:search', () => {
        throw new Error('REVIEW_SEARCH_FAILURE');
      });
    });
    await box(page).press('Enter');
    await page.locator('.search .error').waitFor({ timeout: 15_000 });
    assert.equal(await results(page).count(), 2, '실패해도 이전 결과가 남는다');
    // 이전 결과의 둘째: 실패한 검색 직전의 편집 상태가 아니라 이 결과의 검색 당시 기준 → 옛 좌표를 믿지 않고 원래 둘째(문단 4)로
    await results(page).nth(1).click();
    await settled(page);
    assert.equal(await selection(page), '지현');
    assert.equal(await selectedParagraph(page), 4, '실패한 검색 때문에 옛 좌표(다른 첫 발생)를 믿지 않는다');
  } finally {
    await closeWindow(app);
  }
});
