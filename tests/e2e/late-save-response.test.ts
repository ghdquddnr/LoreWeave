// main의 저장이 성공한 뒤 renderer로 가는 chapter:write 응답만 늦어지는 동안, 바깥에서 그 화를 고치거나 지우면
// 실제 watcher가 보낸 충돌이 늦게 도착한 옛 성공 응답에 지워지지 않는지 본다. (save-race는 임시 파일·이름 바꾸기 전의 변경을 본다.)
// 장벽은 chapter:write 처리기가 끝난 뒤(디스크 쓰기·자기 쓰기 기록까지 끝난 뒤) 응답을 붙잡는다. 호출 카운터로 수신·해제를 구분한다.
// 실제 앱(Electron + Playwright). 실제 API는 쓰지 않는다. 합성 원고(BOM + CRLF + frontmatter).

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const EXTERNAL = '# One\n\nexternal must survive\n';
const withText = (text: string) => ONE.replace('Alpha text', text);

async function project(): Promise<string> {
  const dir = await tempDir('late-response');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

type G = { armed: boolean; calls: number; holds: number; held: boolean; returned: number; release?: () => void };
/** chapter:write 처리기가 끝난 뒤 응답을 붙잡는다 (armed일 때 한 번) */
async function installResponseBarrier(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as G;
    g.armed = false;
    g.calls = 0;
    g.holds = 0;
    g.held = false;
    g.returned = 0;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.calls++;
      const r = await Promise.resolve()
        .then(() => original(...args))
        .then(
          (v) => ({ v }),
          (e: unknown) => ({ e }),
        );
      if (g.armed) {
        g.armed = false;
        g.holds++;
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
      g.returned++;
      if ('e' in r) throw r.e;
      return r.v;
    });
  });
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const counters = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { calls: g.calls, holds: g.holds, held: g.held, returned: g.returned }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
/** 상태 줄(role=status)과 충돌 안내(role=alert)의 글자가 바뀔 때마다 window.seen에 쌓는다 */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    new MutationObserver(() => {
      const texts = [...document.querySelectorAll('[role="status"], [role="alert"]')].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' '));
      w.seen.push(texts.join(' | '));
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
const alert = (page: Page) => page.getByRole('alert');

async function start() {
  const dir = await project();
  const { app, page } = await launch(await tempDir('late-response-userdata'));
  await installResponseBarrier(app);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('Alpha text').click();
  await page.keyboard.press('End');
  return { dir, app, page, path: join(dir, 'chapters', '001.md') };
}

for (const kind of ['modify', 'delete'] as const) {
  test(`쓰기 성공 뒤 응답이 늦는 동안 바깥에서 ${kind === 'modify' ? '수정' : '삭제'}: 충돌이 늦은 성공 응답에 지워지지 않고, 바깥 상태와 입력이 남으며, 사용자가 고른 대로 끝난다`, { timeout: 90_000 }, async () => {
    const { app, page, path } = await start();
    try {
      await arm(app);
      await page.keyboard.type(' A');
      await page.keyboard.press('Control+S');
      await waitUntil(page, '저장 응답을 붙잡지 못했다', async () => (await counters(app)).held);
      assert.equal(await readFile(path, 'utf8'), withText('Alpha text A'), '쓰기는 이미 디스크에 성공했다');
      await record(page);
      if (kind === 'modify') await writeFile(path, EXTERNAL);
      else await rm(path);
      // 응답이 아직 붙잡힌 채로 실제 watcher가 보낸 충돌이 도착한다
      await alert(page).getByText(kind === 'modify' ? /다른 프로그램에서 바뀌었습니다/ : /지워졌거나 이름이 바뀌었습니다/).waitFor({ timeout: 10_000 });
      const during = await counters(app);
      assert.equal(during.held, true, '충돌은 응답이 붙잡힌 동안 도착해야 한다');
      assert.equal(during.returned, 0, '응답은 아직 renderer에 가지 않았다');
      // 늦은 성공 응답을 푼다. 응답이 renderer에서 처리된 뒤(returned 증가 + renderer 왕복)의 상태를 본다
      await release(app);
      await waitUntil(page, '응답이 반환되지 않았다', async () => (await counters(app)).returned === 1);
      await page.evaluate(() => window.loreweave.chapters.list(1));
      assert.equal(await alert(page).count(), 1, '늦은 성공 응답이 충돌 안내를 지웠다');
      const states = (await seen(page)).filter((t) => t.includes('저장됨'));
      assert.deepEqual(states, [], '충돌이 있는데 "저장됨"으로 보인 적이 있다');
      assert.equal(await editor(page).getByText('Alpha text A', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
      if (kind === 'modify') assert.equal(await readFile(path, 'utf8'), EXTERNAL);
      else await assert.rejects(readFile(path), /ENOENT/);
      // 충돌이 살아 있으므로 자동 저장은 멈췄고 바깥 상태가 그대로다: 사용자가 고른 대로 끝난다
      const calls = (await counters(app)).calls;
      await page.keyboard.type(' more');
      await page.keyboard.press('Control+S');
      await page.evaluate(() => window.loreweave.chapters.list(1));
      assert.equal((await counters(app)).calls, calls, '충돌 중에는 저장을 보내지 않는다');
      if (kind === 'modify') assert.equal(await readFile(path, 'utf8'), EXTERNAL);
      else await assert.rejects(readFile(path), /ENOENT/);
      await page.getByRole('button', { name: kind === 'modify' ? '내 것으로 덮어쓰기' : '내 것으로 다시 만들기' }).click();
      await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
      assert.equal(await readFile(path, 'utf8'), withText('Alpha text A more'));
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
  });
}

test('정상 저장: 응답이 늦어도 자기 쓰기는 충돌이 되지 않고, 늦은 응답 뒤 저장됨이 된다 (자기 쓰기와 바깥 변경의 구분)', { timeout: 60_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await arm(app);
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await waitUntil(page, '저장 응답을 붙잡지 못했다', async () => (await counters(app)).held);
    await record(page);
    // watcher가 자기 쓰기를 알아볼 시간을 준다: 감시 알림이 올 만한 일이 있었는지가 아니라, 응답이 붙잡힌 채 renderer가 한 번 왕복하는 동안 충돌이 없는지만 본다
    await page.evaluate(() => window.loreweave.chapters.list(1));
    assert.equal(await alert(page).count(), 0, '자기 쓰기가 바깥 변경으로 보였다');
    await release(app);
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await alert(page).count(), 0);
    assert.equal(await readFile(path, 'utf8'), withText('Alpha text A'));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
