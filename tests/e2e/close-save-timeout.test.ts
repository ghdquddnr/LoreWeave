// 창 닫기에서 저장 응답이 늦을 때: 10초 timeout 경과는 저장 승인도 사용자 폐기 승인도 아니므로 창을 닫지 않고, renderer와 무관한 native 안내로 "계속 기다리기"/"닫기 취소"를 묻는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapter:write를 장벽(hold)으로 감싸 저장 응답을 붙잡고, 10초 타이머(정확히 지연 10000ms인 setTimeout)만 300ms로 앞당겨 실제 타이머 경로가 발화함을 기록한다.
// native dialog(dialog.showMessageBox)는 선택을 테스트가 정하는 대역이다: 실제 수동 GUI 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.
// 관측 범위: 취소한 시도의 늦은 reply가 "이후 다른 시도"를 승인하지 못하는 경계는 이 파일이 아니라 tests/core/close-guard.test.ts(fake main)가 시도 번호로 확인한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const withText = (text: string) => ONE.replace('Alpha text', text);

interface Hooks {
  armed: number;
  fired: number;
  writes: number;
  held: boolean;
  hold: boolean;
  release?: () => void;
  dialogs: { buttons: string[]; resolve(response: number): void; aborted: boolean }[];
}
const hooks = (app: ElectronApplication) =>
  app.evaluate(() => {
    const h = (globalThis as unknown as { h: Hooks }).h;
    return { armed: h.armed, fired: h.fired, writes: h.writes, held: h.held, dialogs: h.dialogs.map((d) => ({ buttons: d.buttons, aborted: d.aborted })) };
  });
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as { h: Hooks }).h.hold = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: Hooks }).h.release?.());
const answer = (app: ElectronApplication, n: number, response: number) => app.evaluate((_e, a) => (globalThis as unknown as { h: Hooks }).h.dialogs[a.n]!.resolve(a.response), { n, response });
const requestClose = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function until(app: ElectronApplication, what: string, ok: (h: Awaited<ReturnType<typeof hooks>>) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const h = await hooks(app);
    if (ok(h)) return h;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${what} ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('저장 응답이 늦으면 10초 timeout만으로 창을 닫지 않고 안내하며, 기다림·취소·재시도·정상 저장 뒤 닫기가 안전하다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('close-save-timeout');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const original = await readFile(path);
  const { app, page } = await launch(await tempDir('close-save-timeout-ud'));
  try {
    // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 main 프로세스에는 없다
    const install = `
      const h = { armed: 0, fired: 0, writes: 0, held: false, hold: false, dialogs: [] };
      globalThis.h = h;
      // 정확히 지연 10000ms인 타이머만 앞당긴다: 실제 setTimeout 경로가 발화했는지 센다
      const real = globalThis.setTimeout;
      globalThis.setTimeout = (fn, delay, ...rest) => {
        if (delay !== 10000) return real(fn, delay, ...rest);
        h.armed++;
        return real(() => { h.fired++; fn(); }, 300);
      };
      dialog.showMessageBox = (_win, opts) =>
        new Promise((resolve, reject) => {
          const entry = { buttons: opts.buttons, aborted: false, resolve: (response) => resolve({ response, checkboxChecked: false }) };
          h.dialogs.push(entry);
          if (opts.signal) opts.signal.addEventListener('abort', () => { entry.aborted = true; reject(new Error('aborted')); });
        });
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('chapter:write');
      handlers.set('chapter:write', async (...args) => {
        h.writes++;
        if (h.hold) {
          h.hold = false;
          h.held = true;
          await new Promise((resolve) => (h.release = resolve));
          h.held = false;
        }
        return original(...args);
      });
    `;
    await app.evaluate(({ ipcMain, dialog }, code) => new Function('ipcMain', 'dialog', code)(ipcMain, dialog), install);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');

    // 1) 저장 응답을 붙잡은 채 창을 닫는다: 10초 타이머 경로가 발화해도 창은 닫히지 않고 안내만 한다
    await arm(app);
    await requestClose(app);
    await until(app, '저장 요청이 장벽에 붙잡히지 않았다', (h) => h.held);
    const asked = await until(app, 'timeout 안내가 뜨지 않았다', (h) => h.fired >= 1 && h.dialogs.length === 1);
    assert.deepEqual(asked.dialogs[0]!.buttons, ['계속 기다리기', '닫기 취소'], '기다림/취소 경로를 준다');
    assert.equal(await windows(app), 1, 'timeout만으로 창이 닫히지 않았다');
    assert.equal(await page.locator('.ProseMirror').getByText('Alpha text A', { exact: true }).count(), 1, '미저장 글자 보존');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '저장 응답 전 디스크 원본 바이트 그대로');
    // 중복 닫기 요청은 새 시도·새 안내를 만들지 않는다
    await requestClose(app);
    await requestClose(app);
    await settled(page);
    const dup = await hooks(app);
    assert.equal(dup.dialogs.length, 1, '중복 닫기가 안내를 늘리지 않았다 (관측 범위 안)');
    assert.equal(dup.armed, 1, '중복 닫기가 타이머를 새로 걸지 않았다');
    assert.equal(dup.writes, 1, '중복 닫기가 저장 요청을 새로 만들지 않았다');

    // 2) 계속 기다리기: 같은 시도를 이어 가고 시간이 다시 지나면 다시 묻는다. 그 사이에도 창은 그대로다
    await answer(app, 0, 0);
    await until(app, '두 번째 안내가 뜨지 않았다', (h) => h.fired >= 2 && h.dialogs.length === 2);
    assert.equal(await windows(app), 1);

    // 3) 닫기 취소: 시도가 끝난다. 그 뒤 늦게 도착한 저장 완료 응답으로는 닫히지 않는다
    await answer(app, 1, 1);
    await settled(page);
    assert.equal(await windows(app), 1, '취소하면 창은 그대로다');
    await release(app); // 늦은 저장 성공 (원래 처리기가 디스크에 쓴다)
    await until(app, '저장이 끝나지 않았다', (h) => !h.held);
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    await settled(page);
    assert.equal(await windows(app), 1, '취소된 시도에서는 늦은 저장 완료로도 닫히지 않는다');
    assert.equal((await hooks(app)).dialogs.length, 2, '취소된 시도는 더 묻지 않는다');
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A'), '저장은 늦게라도 원래 처리기로 끝났다');

    // 4) 다시 닫기: 저장된 상태에서는 추가 확인 없이 닫힌다
    const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
    await requestClose(app).catch(() => undefined);
    await closed;
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A'), '닫은 뒤에도 디스크 내용 보존');
  } finally {
    await release(app).catch(() => undefined);
    await closeWindow(app);
  }
});
