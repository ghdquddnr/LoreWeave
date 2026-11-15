// 파일명이 같은(001.md) 두 프로젝트 사이 전환 중, 이전 프로젝트 A의 지연된 화 읽기 응답이 새 프로젝트 B의 본문·제목·읽기 상태줄을 오염하지 않는다.
// 장벽은 main의 chapter:read 처리기 안이다: A의 읽기는 원래 처리기를 먼저 실행해 결과를 확보한 뒤 *응답만* 붙잡는다(main의 stale-token 거절이 renderer의 늦은 응답 검사를 대신하지 않게 한다).
// B의 읽기는 별도로 붙잡는다. 호출은 진입 순번·token으로 구분하고(원문 로그 0), A의 늦은 응답(성공/실패)을 B가 여는 중일 때 풀어 B 화면을 본다.
// (chapter-read-retry는 같은 프로젝트의 다른 화, project-switch/project-boundary는 정상 전환·project:choose 응답/저장 token을 본다 — 전환 중 이전 프로젝트의 늦은 *화 읽기* 응답은 다루지 않았다.)
// 합성 A/B(같은 화 파일명·다른 제목/id/본문, A는 BOM+CRLF, B는 BOM 없음·LF)·격리 userData. 합성 Electron 자동화이며 수동 GUI·실제 OS IME가 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const A1 = `${BOM}---\r\nid: a-1\r\ntitle: A제목\r\n---\r\nA본문\r\n`;
const B1 = '---\nid: b-1\ntitle: B제목\n---\nB본문\n';

interface Entry {
  seq: number;
  token: number;
  phase: 'entered' | 'executed' | 'responded' | 'failed';
}
interface G {
  log: Entry[];
  aToken: number | null;
  /** A의 늦은 응답이 풀렸을 때 실패시킨다 */
  aFail: boolean;
  /** B의 첫 읽기: 원래 처리기 진입 전에 붙잡았다가 풀면 bFail이면 거절, 아니면 정상 */
  bFail: boolean;
  aHeld: boolean;
  bHeld: boolean;
  bReads: number;
  writes: number;
  creates: number;
  reissues: number;
  ais: number;
  releaseA?: () => void;
  releaseB?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { log: [], aToken: null, aFail: false, bFail: false, aHeld: false, bHeld: false, bReads: 0, writes: 0, creates: 0, reissues: 0, ais: 0 });
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const read = map.get('chapter:read')!;
    map.set('chapter:read', async (...args: unknown[]) => {
      const token = Number(args[2]);
      const seq = g.log.length + 1;
      g.log.push({ seq, token, phase: 'entered' });
      if (g.aToken === null) g.aToken = token; // 이 훅 뒤 첫 읽기는 A의 것이다
      if (token === g.aToken) {
        const result = await read(...args); // 원래 처리기를 먼저 실행해 결과를 확보한다
        g.log.push({ seq, token, phase: 'executed' });
        g.aHeld = true;
        await new Promise<void>((resolve) => (g.releaseA = resolve));
        g.aHeld = false;
        if (g.aFail) {
          g.log.push({ seq, token, phase: 'failed' });
          throw new Error('EACCES: permission denied (synthetic, late A read)');
        }
        g.log.push({ seq, token, phase: 'responded' });
        return result;
      }
      g.bReads += 1;
      if (g.bReads === 1) {
        g.bHeld = true;
        await new Promise<void>((resolve) => (g.releaseB = resolve));
        g.bHeld = false;
        if (g.bFail) {
          g.log.push({ seq, token, phase: 'failed' });
          throw new Error('EACCES: permission denied (synthetic, B read)');
        }
      }
      const result = await read(...args);
      g.log.push({ seq, token, phase: 'responded' });
      return result;
    });
    for (const [channel, key] of [
      ['chapter:write', 'writes'],
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
  });
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    return { log: g.log.map((e) => `${e.token === g.aToken ? 'A' : 'B'}:${e.phase}`), aHeld: g.aHeld, bHeld: g.bHeld, bReads: g.bReads, writes: g.writes, creates: g.creates, reissues: g.reissues, ais: g.ais };
  });
const setBFail = (app: ElectronApplication, on: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as G).bFail = v), on);
const setAFail = (app: ElectronApplication, on: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as G).aFail = v), on);
const releaseA = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).releaseA?.());
const releaseB = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).releaseB?.());
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
const message = (page: Page) => page.locator('.editor-message');
/** 프레임 두 번: 화면 관측일 뿐이다 (renderer가 응답 처리를 끝냈다는 장벽은 아니다. 처리 완료는 main 로그의 순번과 화면 불변으로 간접 확인한다) */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

async function makeProject(prefix: string, text: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), text);
  return dir;
}

/** A를 열고 A의 읽기 응답을 붙잡은 채 [열기]로 B로 전환해 B의 읽기도 붙잡는다 */
async function switchWhileAReadHeld(app: ElectronApplication, page: Page, A: string, B: string) {
  await hook(app);
  await stubFolderDialog(app, A);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await list(page).getByRole('button', { name: 'A제목' }).click();
  await waitUntil('A의 읽기 응답을 붙잡지 못했다', async () => (await state(app)).aHeld);
  await stubFolderDialog(app, B);
  await page.getByRole('button', { name: '열기', exact: true }).click();
  await list(page).getByRole('button', { name: 'B제목' }).waitFor();
  await waitUntil('B의 읽기를 붙잡지 못했다', async () => (await state(app)).bHeld);
  const s = await state(app);
  console.error('PROJECT_SWITCH_LATE_READ_BARRIER', JSON.stringify(s));
  assert.deepEqual(s.log, ['A:entered', 'A:executed', 'B:entered'], 'A는 읽기를 실행해 응답만 붙잡혔고(진입·실행), B의 읽기가 별도로 진입했다');
  assert.equal(s.aHeld && s.bHeld, true);
  // 전환 직후: B는 여는 중이고 A의 흔적이 없다
  await footer(page).getByText('여는 중…').waitFor();
  assert.equal(await editor(page).count(), 0);
  assert.equal(await page.getByText('A제목').count() + (await page.getByText('A본문').count()), 0, '화면 어디에도 A 제목·본문이 없다');
  return s;
}

/** 늦은 A 응답을 푼 뒤에도 B는 여전히 여는 중이고 A의 본문·제목·거짓 저장됨·거짓 열기 실패가 없다 */
async function assertBStillReading(page: Page) {
  await frames(page);
  await frames(page);
  const text = await footer(page).innerText();
  assert.match(text, /B제목/);
  assert.match(text, /여는 중…/, `B는 여전히 여는 중이다: ${text}`);
  for (const wrong of ['저장됨', '저장 중', '저장 실패', '열기 실패', 'A제목']) assert.ok(!text.includes(wrong), `A의 늦은 응답 뒤 상태줄에 ${wrong}가 없다: ${text}`);
  assert.equal(await editor(page).count(), 0, 'A의 늦은 성공이 에디터를 열지 않았다');
  assert.equal(await page.getByText('A본문').count() + (await page.getByText('A제목').count()), 0, 'A 본문·제목이 보이지 않는다');
  assert.equal(await page.getByText(/이 화를 열 수 없습니다/).count(), 0, 'A의 늦은 실패가 읽기 오류로 보이지 않는다');
  assert.equal((await page.getByRole('button', { name: '다시 저장' }).count()) + (await page.getByRole('button', { name: '본문 복사' }).count()), 0);
}

test('A의 읽기 응답을 붙잡은 채 B로 전환: A의 늦은 성공은 B의 본문·제목·상태줄을 오염하지 않고, B 자체의 읽기 실패는 열기 실패로 보이며 명시 재시도 뒤 B만 정상 저장된다', { timeout: 150_000 }, async () => {
  const A = await makeProject('pslr-A', A1);
  const B = await makeProject('pslr-B', B1);
  const { app, page } = await launch(await tempDir('pslr-ud'));
  try {
    await switchWhileAReadHeld(app, page, A, B);
    await setBFail(app, true);
    // A의 늦은 성공 응답을 푼다 (B는 여는 중)
    await releaseA(app);
    await waitUntil('A 응답이 풀리지 않았다', async () => !(await state(app)).aHeld);
    assert.ok((await state(app)).log.includes('A:responded'), 'A의 읽기 응답이 renderer로 돌아갔다');
    await assertBStillReading(page);

    // B 자체의 읽기 실패: 열기 실패·편집기 없음·잘못된 다시 저장/본문 복사 0
    await releaseB(app);
    await message(page).getByText(/이 화를 열 수 없습니다/).waitFor();
    await footer(page).getByText('열기 실패').waitFor();
    const failed = await footer(page).innerText();
    for (const wrong of ['저장됨', '저장 중', '저장 실패', 'A제목']) assert.ok(!failed.includes(wrong), `B 읽기 실패 중 상태줄에 ${wrong}가 없다: ${failed}`);
    assert.equal(await editor(page).count(), 0);
    assert.equal((await page.getByRole('button', { name: '다시 저장' }).count()) + (await page.getByRole('button', { name: '본문 복사' }).count()), 0);
    assert.equal(await page.getByText('A본문').count(), 0);
    const afterFail = await state(app);
    assert.equal(afterFail.writes + afterFail.creates + afterFail.reissues + afterFail.ais, 0, '전환·읽기만으로 write/create/reissue/AI 0');
    assert.deepEqual(await readFile(join(A, 'chapters', '001.md')), Buffer.from(A1), 'A 불변');
    assert.deepEqual(await readFile(join(B, 'chapters', '001.md')), Buffer.from(B1), 'B 불변');

    // 명시 [다시 시도]: B의 실제 본문·제목·정상 저장 표시
    await page.locator('.editor-pane').getByRole('button', { name: '다시 시도' }).click();
    await editor(page).getByText('B본문', { exact: true }).waitFor();
    await page.getByRole('button', { name: '탭 닫기: B제목', exact: true }).waitFor();
    const ready = await footer(page).innerText();
    assert.match(ready, /B제목/);
    assert.match(ready, /저장됨/, `복구 뒤 정상 저장 표시: ${ready}`);
    for (const wrong of ['여는 중', '열기 실패', 'A제목']) assert.ok(!ready.includes(wrong), `복구 뒤 상태줄에 ${wrong}가 없다: ${ready}`);
    assert.equal((await state(app)).bReads, 2, '재시도는 B 읽기 한 번');

    // 복구 뒤 실제 B 입력: B만 정확히 바뀌고 A는 그대로다 (자동저장과 Ctrl+S를 구분하지 못한다)
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' B추가');
    await page.keyboard.press('Control+s');
    await waitUntil('B가 저장되지 않았다', async () => (await readFile(join(B, 'chapters', '001.md'), 'utf8')) === B1.replace('B본문', 'B본문 B추가'));
    assert.deepEqual(await readFile(join(B, 'chapters', '001.md')), Buffer.from(B1.replace('B본문', 'B본문 B추가')), 'B만 정확히 바뀌었다 (LF·BOM 없음 유지)');
    assert.deepEqual(await readFile(join(A, 'chapters', '001.md')), Buffer.from(A1), 'A 불변');
    assert.deepEqual(await readdir(join(A, 'chapters')), ['001.md']);
    assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
    const end = await state(app);
    assert.equal(end.creates + end.reissues + end.ais, 0);
  } finally {
    await releaseA(app).catch(() => {});
    await releaseB(app).catch(() => {});
    await closeWindow(app);
  }
});

test('A의 읽기 응답을 붙잡은 채 B로 전환: A의 늦은 실패는 B 화면에 읽기 오류·열기 실패로 보이지 않고, B의 정상 읽기 뒤 B만 표시된다', { timeout: 150_000 }, async () => {
  const A = await makeProject('pslr2-A', A1);
  const B = await makeProject('pslr2-B', B1);
  const { app, page } = await launch(await tempDir('pslr2-ud'));
  try {
    await switchWhileAReadHeld(app, page, A, B);
    await setAFail(app, true);
    await releaseA(app); // A의 늦은 실패 응답 (B는 여는 중)
    await waitUntil('A 응답이 풀리지 않았다', async () => !(await state(app)).aHeld);
    assert.ok((await state(app)).log.includes('A:failed'), 'A의 읽기가 늦게 실패해 renderer로 돌아갔다');
    await assertBStillReading(page);

    await releaseB(app); // B 정상
    await editor(page).getByText('B본문', { exact: true }).waitFor();
    await page.getByRole('button', { name: '탭 닫기: B제목', exact: true }).waitFor();
    const ready = await footer(page).innerText();
    assert.match(ready, /B제목/);
    assert.match(ready, /저장됨/, `정상 저장 표시: ${ready}`);
    for (const wrong of ['여는 중', '열기 실패', 'A제목']) assert.ok(!ready.includes(wrong), `상태줄에 ${wrong}가 없다: ${ready}`);
    assert.equal(await page.getByText(/이 화를 열 수 없습니다/).count(), 0);
    assert.equal(await page.getByText('A본문').count(), 0);
    const end = await state(app);
    console.error('PROJECT_SWITCH_LATE_READ_END', JSON.stringify(end));
    assert.equal(end.writes + end.creates + end.reissues + end.ais, 0, '전환·읽기만으로 write/create/reissue/AI 0');
    assert.deepEqual(await readFile(join(A, 'chapters', '001.md')), Buffer.from(A1), 'A 불변');
    assert.deepEqual(await readFile(join(B, 'chapters', '001.md')), Buffer.from(B1), 'B 불변');
    assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
  } finally {
    await releaseA(app).catch(() => {});
    await releaseB(app).catch(() => {});
    await closeWindow(app);
  }
});
