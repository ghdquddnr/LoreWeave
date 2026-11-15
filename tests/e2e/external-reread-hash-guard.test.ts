// 외부 변경 자동 재읽기의 응답을 기다리는 동안 같은 디스크 파일이 다시 바뀌면, 재읽기 중에는 외부 변경 구독(LoadedEditor)이 없어 그 알림이 놓친다.
// 늦게 읽은 화면(V1)에서 이후 저장할 때 최신 외부 바이트(V2)를 덮어쓰지 않는지 *실제 쓰기 보호*(chapter:write의 기대 해시)를 본다. 오래된 스냅샷이 화면에 보이는 것 자체를 결함으로 보지 않는다.
// 장벽: main의 chapter:read 처리기 안에서, 자동 재읽기(V1)의 원래 처리기를 먼저 실행해 text/해시 스냅샷을 확보한 뒤 *응답만* 붙잡는다 (읽기 전 HOLD가 아니다).
// watcher 알림은 대역이 아니라 실제 fs.watch가 만든 것이고, 창의 webContents.send로 renderer에 보낸 chapter:changed-outside(file, hash)를 그대로 기록해 전달·공백을 관측한다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 합성 Electron 자동화이며 수동 GUI·실제 OS IME가 아니다. 유료·외부 호출 없음.
// 자동저장은 막지 않는다: 입력 뒤 Ctrl+S를 누르지만 쓰기 시도가 자동저장인지 명시 저장인지는 구분하지 못한다 (둘 다 같은 기대 해시를 쓴다).

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
const V2 = chapter('T2', 'V2 본문');
const B2 = `${BOM}---\r\nid: two\r\ntitle: 이웃\r\n---\r\n이웃 본문\r\n`;
const MESSAGE = '저장되지 않은 내 수정이 사라지고 디스크 내용을 불러옵니다. 계속할까요?';

interface G {
  /** 001.md 읽기 진입 수 (훅 설치 뒤) */
  reads: number;
  armed: boolean;
  held: boolean;
  /** chapter:changed-outside 전달 기록: renderer로 보낸 해시 */
  outside: { file: string; hash: string | null }[];
  writes: number;
  writeResults: string[];
  creates: number;
  reissues: number;
  ais: number;
  release?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { reads: 0, armed: false, held: false, outside: [], writes: 0, writeResults: [], creates: 0, reissues: 0, ais: 0 });
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const read = map.get('chapter:read')!;
    map.set('chapter:read', async (...args: unknown[]) => {
      if (!String(args[1]).endsWith('001.md')) return read(...args);
      g.reads += 1;
      const result = await read(...args); // 원래 처리기를 먼저 실행해 스냅샷을 확보한다
      if (g.armed) {
        g.armed = false;
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve)); // 응답만 붙잡는다
        g.held = false;
      }
      return result;
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
      if (channel === 'chapter:changed-outside') g.outside.push(rest[0] as { file: string; hash: string | null });
      return send(channel, ...rest);
    }) as typeof wc.send;
  });
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    return { reads: g.reads, held: g.held, outside: g.outside.map((o) => `${o.file}:${o.hash === null ? 'null' : o.hash.slice(0, 8)}`), writes: g.writes, writeResults: g.writeResults, creates: g.creates, reissues: g.reissues, ais: g.ais };
  });
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
async function waitUntil(what: string, ok: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const footer = (page: Page) => page.locator('footer.statusbar');
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('자동 재읽기(V1) 응답 대기 중 디스크가 V2로 또 바뀌어 알림이 놓쳐도: 늦게 읽은 화면의 저장은 해시로 거절되어 V2를 덮어쓰지 않고, 불러오기 수락 뒤 V2로 복구해 이어서 저장된다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('erhg');
  await mkdir(join(dir, 'chapters'));
  const p1 = join(dir, 'chapters', '001.md');
  await writeFile(p1, V0);
  await writeFile(join(dir, 'chapters', '002.md'), B2);
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  const { app, page } = await launch(await tempDir('erhg-ud'));
  const asked: string[] = [];
  const unexpected: string[] = [];
  let phase: 'conflict' | 'cleanup' = 'conflict';
  page.on('dialog', (d) => {
    if (phase === 'cleanup') return void d.accept();
    // 폐기 확인은 3단계의 명시 수락 때만 온다: 문구가 맞는 확인만 수락한다
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

    // 1) 깨끗한 V0 → 외부 V1: 실제 자동 재읽기가 일어나고, 그 응답(스냅샷 V1은 확보됨)만 붙잡는다
    await arm(app);
    await writeFile(p1, V1);
    await waitUntil('자동 재읽기의 응답을 붙잡지 못했다', async () => (await state(app)).held);
    const held = await state(app);
    assert.equal(held.reads, 1, '자동 재읽기 읽기 1회 (읽기 처리기는 실행됐고 응답만 HOLD)');
    assert.equal(held.outside.length, 1, 'V1 알림 하나가 renderer로 전달됐다 (그 알림이 재읽기를 일으켰다)');

    // 2) 응답 대기 중 디스크가 V2로 또 바뀐다: watcher는 실제로 알리지만 재읽기 중에는 구독자가 없다 (구독 공백)
    await writeFile(p1, V2);
    await waitUntil('V2 알림이 전달되지 않았다', async () => (await state(app)).outside.length >= 2);
    await frames(page);
    await frames(page);
    const gap = await state(app);
    console.error('EXTERNAL_REREAD_GAP', JSON.stringify(gap));
    assert.notEqual(gap.outside[0], gap.outside[1], 'V1과 V2의 해시가 다르다');
    assert.equal(gap.reads, 1, '앱은 V2를 자동으로 다시 읽지 않았다 (알림은 소비되지 않았다)');
    assert.equal(await editor(page).count(), 0, '재읽기 응답 대기 중이라 에디터가 없다');

    // 3) V1 응답을 풀면: 늦게 읽은 화면(V1)이 보인다 — 오래된 스냅샷 표시 자체는 결함으로 보지 않는다
    await release(app);
    await editor(page).getByText('V1 본문', { exact: true }).waitFor();
    await frames(page);
    assert.equal(await editor(page).getByText('V2 본문').count(), 0);
    assert.deepEqual(await read('001.md'), Buffer.from(V2), '디스크는 최신 V2다');
    const late = await state(app);
    assert.equal(late.reads, 1, 'V1 표시 뒤에도 V2를 자동으로 읽지 않았다');
    assert.equal(late.writes, 0, '읽기·표시만으로 쓰기 0');

    // 4) 늦게 읽은 화면에서 입력 MINE → 쓰기 시도: 기대 해시(V1)가 디스크(V2)와 달라 거절된다 (자동저장/명시 저장 구분 불가)
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' MINE');
    await editor(page).getByText('V1 본문 MINE', { exact: true }).waitFor();
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    const guarded = await state(app);
    console.error('EXTERNAL_REREAD_GUARDED', JSON.stringify({ writes: guarded.writes, results: guarded.writeResults }));
    assert.ok(guarded.writes >= 1, '쓰기 시도가 chapter:write에 진입했다');
    assert.deepEqual([...new Set(guarded.writeResults)], ['conflict'], '모든 쓰기 시도가 해시 충돌로 거절됐다 (성공한 쓰기 0)');
    assert.deepEqual(await read('001.md'), Buffer.from(V2), '최신 외부 바이트 V2가 그대로다 (덮어쓰지 않았다)');
    assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 불변');
    assert.deepEqual(await readdir(join(dir, 'chapters')), ['001.md', '002.md'], '화 파일 수·이름 불변');
    assert.equal(await editor(page).getByText('V1 본문 MINE', { exact: true }).count(), 1, '수락한 화면 입력 MINE은 화면에 남는다');
    assert.equal(guarded.creates + guarded.reissues + guarded.ais, 0, '불필요한 create/reissue/AI 0');
    assert.deepEqual(asked, [], '이 단계에서 폐기 확인이 없었다');

    // 5) 명시 [디스크 내용 불러오기 (내 수정은 버림)] 수락: MINE 폐기는 사용자 승인. V2로 복구하고 제목이 맞는다 (복구 읽기는 쓰기 0)
    const writesBefore = (await state(app)).writes;
    await page.getByRole('button', { name: /디스크 내용 불러오기/ }).click();
    await editor(page).getByText('V2 본문', { exact: true }).waitFor({ timeout: 15_000 });
    assert.deepEqual(asked, [MESSAGE], '폐기 확인 문구와 횟수 (수락 1회)');
    await list(page).getByRole('button', { name: 'T2' }).waitFor();
    await page.getByRole('button', { name: '탭 닫기: T2', exact: true }).waitFor();
    assert.match(await footer(page).innerText(), /T2/, '상태줄 제목도 V2의 제목이다');
    assert.equal((await state(app)).writes, writesBefore, '불러오기가 쓰기를 만들지 않았다');
    assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 0, '충돌이 풀렸다');
    assert.deepEqual(await read('001.md'), Buffer.from(V2), '불러오기도 디스크를 바꾸지 않았다');

    // 6) 복구 뒤 새 입력 → 정상 저장: 해당 화만 정확히 바뀌고 이웃은 그대로
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' AFTER');
    await page.keyboard.press('Control+s');
    await waitUntil('복구 뒤 저장이 되지 않았다', async () => (await read('001.md')).toString('utf8') === V2.replace('V2 본문', 'V2 본문 AFTER'));
    assert.deepEqual(await read('001.md'), Buffer.from(V2.replace('V2 본문', 'V2 본문 AFTER')), '원래 id·BOM·CRLF·제목 그대로 V2 + 새 입력');
    assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 불변');
    const end = await state(app);
    assert.ok(end.writeResults.includes('saved'), '복구 뒤 쓰기는 성공했다');
    assert.equal(end.creates + end.reissues + end.ais, 0);
    assert.deepEqual(unexpected, [], '예상하지 않은 확인 창이 없다');
  } finally {
    phase = 'cleanup';
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
