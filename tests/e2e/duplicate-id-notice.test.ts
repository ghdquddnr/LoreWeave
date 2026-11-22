// 중복 id 안내: 원인(복사)을 단정하거나 파일 삭제를 암시하지 않고, 안내 자체는 디스크를 쓰지 않으며, 두 파일이 모두 열리고,
// 사용자가 명시적으로 [새 id 발급]을 누를 때만 그 파일의 머리말 id 한 줄만 바뀌고 본문·BOM·줄바꿈·다른 파일은 그대로인지 확인한다.
// 실제 앱(Electron + Playwright), 합성 원고(BOM + CRLF + frontmatter)·별도 userData. main의 chapter:write는 호출 수만 세는 무료 대역이다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (title: string, body: string) => `﻿---\r\nid: same-id\r\ntitle: ${title}\r\n---\r\n${body}\r\n`;
const ONE = doc('첫째', '첫째 본문');
const TWO = doc('둘째', '둘째 본문');

test('중복 id 안내는 원인을 단정하거나 삭제를 암시하지 않고 디스크를 쓰지 않으며, [새 id 발급]은 눌린 파일의 id 한 줄만 바꾼다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('dup-notice');
  await mkdir(join(dir, 'chapters'));
  const one = join(dir, 'chapters', '001.md');
  const two = join(dir, 'chapters', '002.md');
  await writeFile(one, ONE);
  await writeFile(two, TWO);
  const { app, page } = await launch(await tempDir('dup-notice-ud'));
  try {
    await app.evaluate(({ ipcMain }) => {
      // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
      const g = globalThis as unknown as { writes: number };
      g.writes = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const write = handlers.get('chapter:write')!;
      handlers.set('chapter:write', async (...args: unknown[]) => {
        g.writes += 1;
        return write(...args);
      });
    });
    const writes = () => app.evaluate(() => (globalThis as unknown as { writes: number }).writes);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: '같은 id를 쓰는 화가 있습니다' });
    await alert.waitFor();

    // 안내 문구: 원인을 복사로 단정하지 않고, 하나만 남기라(삭제)고 하지 않으며, 파일을 지우거나 바꾸지 않는다고 말하고 새 id가 무엇을 바꾸는지 알린다
    const text = await alert.innerText();
    for (const bad of ['파일 복사로 생김', '하나만 남기고']) assert.ok(!text.includes(bad), `단정·삭제 암시 문구(${bad})가 없다: ${text}`);
    for (const must of ['생길 수 있습니다', '파일을 바꾸거나 지우지 않으며', '모두 그대로 열 수 있습니다', 'id 한 줄만 새 값으로', '본문과 다른 화는 그대로', '첫 파일에는 이 단추가 없습니다']) assert.ok(text.includes(must), `안내에 "${must}"가 있다: ${text}`);
    const buttons = alert.getByRole('button', { name: '새 id 발급' });
    assert.equal(await buttons.count(), 1, '묶음의 첫 파일(001.md)에는 단추가 없고 나머지(002.md)에만 있다');
    assert.match((await buttons.first().getAttribute('title')) ?? '', /id 한 줄만 새 값으로 바꿔 저장/, '단추 설명이 실제 동작과 같다');

    // 안내를 보고 두 파일을 열어 보기만 해서는 디스크에 아무것도 쓰지 않는다
    const nav = page.getByRole('navigation', { name: '화 목록' });
    await nav.getByRole('button', { name: '첫째' }).click();
    await page.locator('.ProseMirror').getByText('첫째 본문', { exact: true }).waitFor();
    await nav.getByRole('button', { name: '둘째' }).click();
    await page.locator('.ProseMirror').getByText('둘째 본문', { exact: true }).waitFor();
    assert.equal(await writes(), 0, '안내와 열기만으로는 저장 요청이 없다');
    assert.deepEqual(await readFile(one), Buffer.from(ONE), '001.md 불변');
    assert.deepEqual(await readFile(two), Buffer.from(TWO), '002.md 불변');

    // 명시적으로 [새 id 발급]: 002.md의 id 한 줄만 바뀐다 (본문·BOM·CRLF·title 그대로), 001.md는 불변, 두 파일 모두 계속 열린다
    await buttons.first().click();
    await alert.waitFor({ state: 'detached', timeout: 10_000 });
    const after = (await readFile(two)).toString('utf8');
    const newId = /\nid: (.+)\r\n/.exec(after)?.[1];
    assert.ok(newId && newId !== 'same-id', `새 id가 들어갔다: ${newId}`);
    assert.equal(after, TWO.replace('id: same-id', `id: ${newId}`), 'id 한 줄 외에는 바이트가 같다 (BOM·CRLF·title·본문)');
    assert.deepEqual(await readFile(one), Buffer.from(ONE), '001.md는 그대로');
    await nav.getByRole('button', { name: '첫째' }).click();
    await page.locator('.ProseMirror').getByText('첫째 본문', { exact: true }).waitFor();
    await nav.getByRole('button', { name: '둘째' }).click();
    await page.locator('.ProseMirror').getByText('둘째 본문', { exact: true }).waitFor();
  } finally {
    await closeWindow(app);
  }
});
