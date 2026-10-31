// 새 id 발급은 디스크에 성공했는데 같은 처리기의 뒤 단계(목록 조회)가 실패하면, 발급 실패로 오인하지 않고 복구할 수 있어야 한다.
// 장벽은 main의 fs 호출 안이다: 선택한 화의 이름 바꾸기(id를 쓰는 저장)가 끝난 뒤, 같은 chapter:reissue-id 처리기 안의 첫 chapters/ 폴더 읽기만 한 번 거절한다
// (처리기 전체를 실행하기 전에 거절하는 것은 이 경계가 아니다). 합성 중복 id 원고·격리 userData. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const dup = (title: string) => `${BOM}---\r\nid: same-id\r\ntitle: ${title}\r\n---\r\n${title} 본문\r\n`;
const ONE = dup('첫째');
const TWO = dup('둘째');

interface Hooks {
  /** reissue 처리기 호출 수 */
  calls: number;
  inHandler: boolean;
  renamed: boolean;
  /** 남은 거절 횟수 (처리기 안, 이름 바꾸기 뒤의 chapters 폴더 읽기) */
  failures: number;
  /** 실제로 거절한 지점들 */
  failedAt: string[];
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { calls: 0, inHandler: false, renamed: false, failures: 0, failedAt: [] };
    const fsp = process.getBuiltinModule('fs/promises');
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없다)
    const rename = fsp.rename;
    fsp.rename = (async (from: string, to: string) => {
      const out = await (rename as (...a: unknown[]) => Promise<unknown>)(from, to);
      if (g.hooks.inHandler && String(to).endsWith('002.md')) g.hooks.renamed = true;
      return out;
    }) as typeof fsp.rename;
    const readdir = fsp.readdir;
    fsp.readdir = (async (path: string, ...rest: unknown[]) => {
      const h = g.hooks;
      if (h.inHandler && h.renamed && h.failures > 0 && /chapters$/.test(String(path))) {
        h.failures -= 1;
        h.failedAt.push(`readdir ${String(path)} after rename`);
        throw Object.assign(new Error("EACCES: permission denied, scandir 'chapters' (synthetic)"), { code: 'EACCES' });
      }
      return (readdir as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof fsp.readdir;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:reissue-id')!;
    handlers.set('chapter:reissue-id', async (...args: unknown[]) => {
      const h = g.hooks;
      h.calls += 1;
      h.inHandler = true;
      h.renamed = false;
      try {
        return await original(...args);
      } finally {
        h.inHandler = false;
      }
    });
  });
const arm = (app: ElectronApplication, failures: number) => app.evaluate((_e, n) => void ((globalThis as unknown as { hooks: Hooks }).hooks.failures = n), failures);
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks);

const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const footerError = (page: Page) => page.locator('footer .error');
const dupWarning = (page: Page) => page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/);
const reread = (page: Page) => page.locator('footer').getByRole('button', { name: '목록 다시 읽기' });
const idOf = (text: string) => /id: (.+)\r?\n/.exec(text)?.[1];

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await list(page).getByRole('button', { name: '둘째' }).click();
  await editor(page).getByText('둘째 본문').waitFor();
  await dupWarning(page).waitFor();
  await hook(app);
  const read = (f: string) => readFile(join(dir, 'chapters', f), 'utf8');
  return { app, page, dir, read };
}

test('발급 성공 뒤 목록 조회가 실패하면: 발급은 성공했다고 알리고, 열린 화가 옛 id로 되돌리지 않으며, 재발급 없이 목록·중복 안내를 복구한다', { timeout: 120_000 }, async () => {
  const { app, page, read } = await start('rlf-basic');
  try {
    await arm(app, 1);
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    const failed = await hooks(app);
    // 최초 실제 실패 지점: 이름 바꾸기(발급 저장)가 끝난 뒤 같은 처리기의 chapters 폴더 읽기
    console.error('REISSUE_BOUNDARY', JSON.stringify({ calls: failed.calls, failedAt: failed.failedAt, shown: await footerError(page).innerText() }));
    assert.equal(failed.failedAt.length, 1, '처리기 안, 이름 바꾸기 뒤의 목록 읽기가 실제로 한 번 거절됐다');
    const afterFail = await read('002.md');
    assert.notEqual(idOf(afterFail), 'same-id', '디스크의 id는 이미 새로 바뀌었다');
    assert.equal(afterFail.startsWith(BOM), true, 'BOM 보존');
    assert.match(afterFail, /\r\n/);
    assert.match(afterFail, /둘째 본문\r\n$/, '본문 보존');
    assert.equal(await read('001.md'), ONE, '다른 화 바이트 보존');
    const newId = idOf(afterFail)!;
    // 안내: 발급 자체 실패가 아니라 발급은 됐고 목록을 못 읽었다
    const shown = await footerError(page).innerText();
    assert.match(shown, /새 id.*(발급했|발급됐|바꿨|바뀌었)/, `발급은 성공했다고 알린다: ${shown}`);
    assert.match(shown, /목록/, '목록을 읽지 못했다고 알린다');
    // 편집 잠금은 풀렸다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('추가입력');
    await editor(page).getByText(/추가입력/).waitFor();
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    const saved = await read('002.md');
    assert.equal(idOf(saved), newId, '옛 에디터의 envelope가 새 id를 되돌리지 않는다');
    assert.match(saved, /추가입력/, '후속 입력은 저장됐다');
    assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 0, '충돌 상태가 되지 않았다');
    // 복구: 목록만 다시 읽는다 (재발급 0)
    await reread(page).click();
    await dupWarning(page).waitFor({ state: 'detached', timeout: 10_000 });
    assert.equal((await hooks(app)).calls, 1, '복구는 id를 다시 발급하지 않는다');
    assert.equal(idOf(await read('002.md')), newId);
    assert.equal(await footerError(page).count(), 0, '복구하면 안내가 사라진다');
    assert.equal(await read('001.md'), ONE);
  } finally {
    await closeWindow(app);
  }
});

test('목록 다시 읽기가 반복 실패하면 안내가 유지되고, 발급 자체의 실패는 기존 의미대로 목록 복구 조작 없이 알린다', { timeout: 120_000 }, async () => {
  const { app, page, read } = await start('rlf-repeat');
  try {
    await arm(app, 1);
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    // 다시 읽기도 한 번 더 실패하게 한다 (조회 실패는 chapters:list 처리기에서)
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('chapters:list')!;
      let left = 1;
      handlers.set('chapters:list', async (...args: unknown[]) => {
        if (left > 0) {
          left -= 1;
          throw new Error('EACCES: permission denied (synthetic list)');
        }
        return original(...args);
      });
    });
    await reread(page).click();
    await footerError(page).getByText(/목록/).waitFor();
    await reread(page).waitFor();
    await reread(page).click();
    await dupWarning(page).waitFor({ state: 'detached', timeout: 10_000 });
    assert.equal((await hooks(app)).calls, 1, '재발급 0');
    assert.notEqual(idOf(await read('002.md')), 'same-id');
  } finally {
    await closeWindow(app);
  }
});

test('발급 자체가 실패하면(디스크 변경 없음) 목록 다시 읽기 조작 없이 실패를 알리고 id·본문이 그대로다', { timeout: 90_000 }, async () => {
  const { app, page, read } = await start('rlf-self-fail');
  try {
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      handlers.set('chapter:reissue-id', async () => {
        throw new Error('EACCES: permission denied (synthetic reissue)');
      });
    });
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    assert.equal(await reread(page).count(), 0);
    assert.doesNotMatch(await footerError(page).innerText(), /발급했|발급됐/);
    assert.equal(await read('002.md'), TWO);
    assert.equal(await dupWarning(page).count(), 1);
  } finally {
    await closeWindow(app);
  }
});
