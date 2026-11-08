// 파일이 외부에서 지워졌거나 이름이 바뀐 충돌(diskHash === null)에서의 [본문 복사]: [차이 보기]가 없는 이 충돌에서도 명시 클릭으로 현재 본문 글자를 복사해 보관할 수 있다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 외부 삭제는 실제 파일 삭제(rm)이고, 클립보드는 renderer의 navigator.clipboard.writeText 대역(성공/실패/보류)이다.
// 이 검사 안에서만 renderer의 1500ms(자동 저장) setTimeout을 가로채 기록만 한다: 미저장 입력이 삭제 전에 저장되어 버리는 경합을 없애기 위해서다 (제품 코드·주기는 바꾸지 않는다).
// main의 chapter:write 처리기는 호출 수만 세는 무료 대역으로 감싼다 (원래 처리기로 그대로 넘긴다).
// 본문 글자만 복사한다: BOM·frontmatter·Markdown 파일 전체 백업이 아니다. 합성 Electron 검사이며 실제 OS 클립보드·수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

interface Clip {
  auto: 'ok' | 'fail' | 'hold';
  calls: { text: string; settle(ok: boolean): void }[];
}
const editor = (page: Page) => page.locator('.ProseMirror');
const bar = (page: Page) => page.locator('footer.statusbar');
const copyButton = (page: Page) => bar(page).getByRole('button', { name: '본문 복사', exact: true });
const note = (page: Page) => bar(page).locator('.copy-note');
const setAuto = (page: Page, auto: Clip['auto']) => page.evaluate((a) => void ((window as unknown as { __clip: Clip }).__clip.auto = a), auto);
const texts = (page: Page) => page.evaluate(() => (window as unknown as { __clip: Clip }).__clip.calls.map((c) => c.text));
const settle = (page: Page, i: number, ok: boolean) => page.evaluate(([i, ok]) => (window as unknown as { __clip: Clip }).__clip.calls[i as number]!.settle(ok as boolean), [i, ok] as const);
const writeCalls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { writes: number }).writes);
const exists = (path: string) => stat(path).then(() => true, () => false);

test('삭제·이름 변경 충돌에서도 [본문 복사]가 누른 순간의 본문 글자를 복사하고, 실패 뒤 다시 시도되며, 충돌·입력·파일 없음·쓰기 호출 수는 그대로다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('deleted-conflict-copy');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('deleted-conflict-copy-ud'));
  page.on('dialog', (d) => void d.accept()); // 정리용으로만: 판정에 쓰지 않는다
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { writes: number };
      g.writes = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('chapter:write')!;
      handlers.set('chapter:write', async (...args: unknown[]) => {
        g.writes++;
        return original(...args);
      });
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await editor(page).getByText('Alpha text').waitFor();
    // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 renderer에는 없다
    await page.evaluate(`(() => {
      const w = window;
      const real = w.setTimeout.bind(w);
      w.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
      const clip = { auto: 'fail', calls: [] };
      w.__clip = clip;
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: (text) =>
          new Promise((resolve, reject) => {
            clip.calls.push({ text, settle: (ok) => (ok ? resolve() : reject(new Error('NotAllowedError (synthetic)'))) });
            if (clip.auto === 'ok') resolve();
            else if (clip.auto === 'fail') reject(new Error('NotAllowedError (synthetic)'));
          }),
      });
    })()`);

    // 1) 미저장 입력 뒤 실제로 파일을 지운다: 삭제 충돌 안내와 [내 것으로 다시 만들기]만 있고 [차이 보기]는 없다
    assert.equal(await copyButton(page).count(), 0, '충돌 전에는 복사 버튼이 없다');
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    await rm(path);
    await page.getByRole('button', { name: '내 것으로 다시 만들기' }).waitFor({ timeout: 15_000 });
    await page.getByText('이 화 파일이 다른 곳에서 지워졌거나 이름이 바뀌었습니다.').waitFor();
    assert.equal(await page.getByRole('button', { name: '차이 보기' }).count(), 0);
    await copyButton(page).waitFor();
    assert.deepEqual(await texts(page), [], '누르기 전에는 복사하지 않는다');
    assert.equal(await writeCalls(app), 0, '충돌까지 쓰기 요청은 없다');

    // 2) 복사 직전 추가 입력이 포함되어야 한다. 클립보드 실패: 실패라고 알리고, 다른 상태를 말하지 않는다
    await page.keyboard.type(' B');
    await copyButton(page).click();
    await note(page).getByText('복사하지 못했습니다').waitFor();
    assert.ok((await texts(page)).length === 1 && (await texts(page))[0] === 'Alpha text A B', '누른 순간의 본문 글자 (BOM·frontmatter 없음)');
    assert.ok(!/저장 실패/.test(await note(page).innerText()), '삭제 충돌의 복사 실패 문구가 저장 실패를 말하지 않는다');
    assert.equal(await page.getByRole('button', { name: '내 것으로 다시 만들기' }).count(), 1, '충돌 안내 유지');

    // 3) 다시 시도: 성공. 저장됨으로 바뀌지 않는다
    await setAuto(page, 'ok');
    await copyButton(page).click();
    await note(page).getByText('본문 글자만 복사했습니다 (저장된 것은 아닙니다)').waitFor();
    assert.ok((await texts(page)).length === 2 && (await texts(page))[1] === 'Alpha text A B', '재시도 본문이 같다');
    assert.ok(!/저장됨/.test(await bar(page).innerText()), '복사 성공이 저장됨으로 보이지 않는다');
    await page.evaluate(() => window.loreweave.chapters.list(1)); // 복사 처리가 끝난 뒤의 상태를 본다
    assert.equal(await writeCalls(app), 0, '복사는 쓰기를 만들지 않았다');
    assert.equal(await exists(path), false, '파일은 만들어지지 않았다 (복사가 다시 만들기를 대신하지 않는다)');
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, '입력 보존');
    assert.equal(await page.getByRole('button', { name: '내 것으로 다시 만들기' }).count(), 1, '충돌 상태 유지');

    // 4) 보류된 복사 응답은 충돌이 풀린 뒤(다시 만들기로 저장됨) 늦게 와도 안내를 되살리지 않는다
    await setAuto(page, 'hold');
    await copyButton(page).click();
    await note(page).getByText('복사하는 중').waitFor();
    await page.getByRole('button', { name: '내 것으로 다시 만들기' }).click();
    await bar(page).getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await writeCalls(app), 1, '다시 만들기의 쓰기 한 건');
    assert.ok((await readFile(path, 'utf8')) === ONE.replace('Alpha text', 'Alpha text A B'), '다시 만들기는 최신 본문을 envelope과 함께 만들었다');
    assert.equal(await note(page).count(), 0, '저장되면 복사 안내가 사라진다');
    await settle(page, 2, true);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    assert.equal(await note(page).count(), 0, '늦은 복사 응답이 안내를 되살리지 않는다');
    assert.equal(await copyButton(page).count(), 0, '충돌이 풀리면 복사 버튼이 없다');
  } finally {
    await setAuto(page, 'ok').catch(() => undefined);
    await closeWindow(app);
  }
});
