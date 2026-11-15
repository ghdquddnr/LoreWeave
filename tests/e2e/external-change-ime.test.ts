// 저장된 깨끗한 화에서 한국어 조합이 진행 중일 때 외부 변경(watcher 알림)이 도착하면, 앱이 수락한 입력을 자동 재읽기로 조용히 버리지 않는지 본다.
// ChapterEditor의 외부 변경 처리는 version===savedVersion && !saving(깨끗함)만 보고 view.composing은 보지 않는다 — 조합 글자가 문서(version)에 이미 들어갔다면 충돌 분기로 가고, 아니라면 자동 재읽기로 갈 수 있다. 실행으로 확인한다.
// 조합은 CDP Input.imeSetComposition(실제 Chromium 입력 경로)이다: 이벤트를 dispatch해 흉내 내지 않는다. 실제 OS IME·수동 GUI 검증이 아니다.
// watcher 알림은 실제 fs.watch가 만든 것이고 창의 webContents.send로 보낸 chapter:changed-outside를 기록해 전달을 관측한다. 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 유료·외부 호출 없음.
// 구별: autosave-ime는 자동저장·재시도 타이머, window-close-ime는 창 닫기이며, 조합 중 외부 변경의 자동 재읽기/충돌 분기는 다루지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const chapter = (title: string, body: string) => `${BOM}---\r\nid: one\r\ntitle: ${title}\r\n---\r\n${body}\r\n`;
const V0 = chapter('T0', 'V0 본문');
const V1 = chapter('T1', 'V1 본문');
const B2 = `${BOM}---\r\nid: two\r\ntitle: 이웃\r\n---\r\n이웃 본문\r\n`;
const MESSAGE = '저장되지 않은 내 수정이 사라지고 디스크 내용을 불러옵니다. 계속할까요?';

interface G {
  outside: string[];
  writes: number;
  writeResults: string[];
  reads: number;
  creates: number;
  reissues: number;
  ais: number;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { outside: [], writes: 0, writeResults: [], reads: 0, creates: 0, reissues: 0, ais: 0 });
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const read = map.get('chapter:read')!;
    map.set('chapter:read', (...args: unknown[]) => {
      if (String(args[1]).endsWith('001.md')) g.reads += 1;
      return read(...args);
    });
    const write = map.get('chapter:write')!;
    map.set('chapter:write', async (...args: unknown[]) => {
      g.writes += 1;
      const result = (await write(...args)) as { status: string };
      g.writeResults.push(result.status);
      return result;
    });
    for (const [channel, key] of [
      ['chapter:create', 'creates'],
      ['chapter:reissue-id', 'reissues'],
      ['ai:analyze', 'ais'],
      ['ai:check', 'ais'],
    ] as const) {
      const original = map.get(channel)!;
      map.set(channel, (...args: unknown[]) => {
        g[key] += 1;
        return original(...args);
      });
    }
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = wc.send.bind(wc);
    wc.send = ((channel: string, ...rest: unknown[]) => {
      if (channel === 'chapter:changed-outside') g.outside.push(String((rest[0] as { file: string }).file));
      return send(channel, ...rest);
    }) as typeof wc.send;
  });
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { outside: g.outside.length, writes: g.writes, writeResults: g.writeResults, reads: g.reads, creates: g.creates, reissues: g.reissues, ais: g.ais }; });
async function waitUntil(what: string, ok: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const events = (page: Page) => page.evaluate('window.ev') as Promise<string[]>;

test('저장된 화에서 조합 중 외부 변경: 조합 글자가 문서에 들어갔으므로 자동 재읽기가 아니라 충돌 안내로 가고, 외부 V1은 그대로이며, 불러오기 수락 뒤 V1로 복구해 이어서 저장된다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('eci');
  await mkdir(join(dir, 'chapters'));
  const p1 = join(dir, 'chapters', '001.md');
  await writeFile(p1, V0);
  await writeFile(join(dir, 'chapters', '002.md'), B2);
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  const { app, page } = await launch(await tempDir('eci-ud'));
  const asked: string[] = [];
  const unexpected: string[] = [];
  let phase: 'run' | 'cleanup' = 'run';
  page.on('dialog', (d) => {
    if (phase === 'cleanup') return void d.accept();
    if (d.message() === MESSAGE) {
      asked.push(d.message());
      void d.accept();
    } else {
      unexpected.push(d.message());
      void d.dismiss();
    }
  });
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await list(page).getByRole('button', { name: 'T0' }).click();
    await editor(page).getByText('V0 본문', { exact: true }).waitFor();
    await hook(app);
    // 조합·입력 이벤트와 그 시점의 본문(DOM)을 기록한다 (문자열 스크립트: 이름 도우미가 page에 없다)
    await page.evaluate(`(() => {
      window.ev = [];
      const rec = (e) => {
        const root = document.querySelector('.ProseMirror');
        const d = e.data !== undefined && e.data !== null ? '(' + e.data + ')' : '';
        window.ev.push(e.type + d + ' text=' + JSON.stringify(root && root.textContent));
      };
      for (const t of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) document.addEventListener(t, rec, true);
    })()`);
    const cdp = await page.context().newCDPSession(page);

    // 1) 깨끗한(저장된) V0에서 조합을 시작한다: 입력 없이 조합만. 화면 DOM에는 조합 글자가 보이고 compositionend는 없다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    const before = await events(page);
    assert.ok(before.some((e) => e.startsWith('compositionstart')) && !before.some((e) => e.startsWith('compositionend')), '조합이 진행 중이다');
    assert.equal(await editor(page).innerText(), 'V0 본문감', '화면 DOM에 조합 글자가 보인다 (미확정)');
    assert.deepEqual(await read('001.md'), Buffer.from(V0), '조합 중 디스크는 V0 그대로');

    // 2) 조합을 유지한 채 디스크를 외부 V1로 바꾼다: 실제 watcher 알림이 renderer로 전달된다
    await writeFile(p1, V1);
    await waitUntil('watcher 알림이 전달되지 않았다', async () => (await state(app)).outside >= 1);
    // 자동 재읽기(읽기 증가) 또는 충돌 안내 중 어느 분기로 갔는지 관측한다
    await waitUntil('외부 변경 처리 분기를 관측하지 못했다', async () => (await state(app)).reads >= 1 || (await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count()) > 0);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const after = await state(app);
    const conflict = (await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count()) > 0;
    const text = await editor(page).innerText().catch(() => null);
    console.error('EXTERNAL_CHANGE_IME_BRANCH', JSON.stringify({ outside: after.outside, reads: after.reads, writes: after.writes, conflict, text, events: await events(page) }));
    assert.deepEqual(await read('001.md'), Buffer.from(V1), '외부 V1 바이트가 그대로다');
    assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 불변');
    assert.deepEqual(await readdir(join(dir, 'chapters')), ['001.md', '002.md'], '화 파일 수·이름 불변');
    assert.equal(after.creates + after.reissues + after.ais, 0);
    assert.deepEqual(after.writeResults.filter((r) => r === 'saved'), [], '외부 V1을 덮어쓴 성공한 쓰기 0');
    assert.equal(conflict, true, '조합 글자가 이미 수락된 입력(미저장)이라 자동 재읽기가 아니라 충돌 안내로 갔다');
    assert.equal(after.reads, 0, '자동 재읽기로 입력을 조용히 버리지 않았다');
    assert.ok(text !== null && text.includes('감'), '조합 글자는 화면에 남아 있다');

    // 3) 조합을 확정해도 화면 입력과 충돌 안내가 일관된다
    await page.keyboard.insertText('감');
    await editor(page).getByText('V0 본문감', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 1, '확정 뒤에도 충돌 안내가 있다');
    assert.deepEqual(await read('001.md'), Buffer.from(V1), '확정 뒤에도 V1 그대로 (쓰기는 해시 거절)');
    assert.deepEqual((await state(app)).writeResults.filter((r) => r === 'saved'), []);

    // 4) 명시 [디스크 내용 불러오기]: 폐기 확인 수락(내 입력 폐기는 사용자 승인) → V1 본문·제목 일치, 복구 읽기는 쓰기 0
    const writesBefore = (await state(app)).writes;
    await page.getByRole('button', { name: /디스크 내용 불러오기/ }).click();
    await editor(page).getByText('V1 본문', { exact: true }).waitFor({ timeout: 15_000 });
    assert.deepEqual(asked, [MESSAGE], '폐기 확인 문구와 횟수 (수락 1회)');
    await list(page).getByRole('button', { name: 'T1' }).waitFor();
    await page.getByRole('button', { name: '탭 닫기: T1', exact: true }).waitFor();
    assert.equal((await state(app)).writes, writesBefore, '불러오기가 쓰기를 만들지 않았다');
    assert.deepEqual(await read('001.md'), Buffer.from(V1));

    // 5) 복구 뒤 새 입력 → 저장: 원래 id·BOM·CRLF 그대로 해당 화만 바뀌고 이웃 불변 (자동저장과 Ctrl+S를 구분하지 못한다)
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' AFTER');
    await page.keyboard.press('Control+s');
    await waitUntil('복구 뒤 저장이 되지 않았다', async () => (await read('001.md')).toString('utf8') === V1.replace('V1 본문', 'V1 본문 AFTER'));
    assert.deepEqual(await read('001.md'), Buffer.from(V1.replace('V1 본문', 'V1 본문 AFTER')));
    assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 불변');
    assert.deepEqual(unexpected, [], '예상하지 않은 확인 창이 없다');
  } finally {
    phase = 'cleanup';
    await closeWindow(app);
  }
});
