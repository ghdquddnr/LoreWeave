// 앱을 다시 실행한 직후 첫 검색의 단계별 증거와, 편집기 준비(비동기 chapter read)가 늦을 때의 순서를 결정적으로 강제하는 회귀.
// 배경: 감독 격리 실행에서 search.test.ts '2글자 검색어…'의 첫 '민수' 검색이 요약을 30초 기다리다 timeout 났다(원인 불명, PR108 본문). 이 테스트는 그 원인을 확정하려는 것이 아니라,
// "편집기 준비가 늦다"는 한 가지 가설을 해제 가능한 장벽으로 강제해 검색 입력·submit·beforeSearch·search IPC·화면 요약이 각 단계에서 어떻게 되는지 구분해 본다.
// 단계는 섞지 않는다: (1) 검색 입력 값/포커스 (2) form submit 발생 (3) beforeSearch 완료 + search IPC가 main에 도달 (4) search IPC 응답 (5) 화면 요약 (6) 편집기 준비 후에도 결과 유지.
// 장벽: main의 chapter:read 처리기(편집기의 첫 본문 읽기)를 한 번 붙잡는다. 앱을 다시 실행하면 같은 userData의 마지막 프로젝트가 자동으로 열린다.
//   (장벽 설치가 자동 열기의 chapter:read보다 늦으면 장벽을 놓친 것이다 → 그 경우 이 테스트는 준비 실패로 보고하고 판정하지 않는다.)
// 진단용 page.evaluate(리스너 설치·값 읽기)는 renderer 작업 사이에 끼어 순서를 바꿀 수 있다. 판정 단계마다 그 관측이 무엇인지 주석으로 구분한다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter), 별도 userData. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
const ONE = doc('one', '1화. 입학', '민수는 운동장에 앉아 있었다');
const TWO = doc('two', '2화. 설명회', '설명회에서 민수가 손을 들었다');
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const editor = (page: Page) => page.locator('.ProseMirror');
const searchbox = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });

type G = { armed: boolean; held: boolean; readCalls: number; searchCalls: number; searchDone: number; release?: () => void };
async function install(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { armed: true, held: false, readCalls: 0, searchCalls: 0, searchDone: 0 });
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const read = handlers.get('chapter:read')!;
    handlers.set('chapter:read', async (...args: unknown[]) => {
      g.readCalls++;
      if (g.armed) {
        g.armed = false; // 첫 읽기 하나만 붙잡는다
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
      return read(...args);
    });
    const search = handlers.get('chapters:search')!;
    handlers.set('chapters:search', async (...args: unknown[]) => {
      g.searchCalls++; // 이 호출이 main에 도달했다 = renderer의 beforeSearch가 끝나고 IPC가 갔다
      try {
        return await search(...args);
      } finally {
        g.searchDone++; // 응답을 돌려주기 직전
      }
    });
  });
}
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, readCalls: g.readCalls, searchCalls: g.searchCalls, searchDone: g.searchDone }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}

test('앱을 다시 실행한 직후, 편집기 준비(본문 읽기)가 늦은 채로 첫 검색을 해도 요약이 나오고 편집기 준비 뒤에도 유지되며, 원고 바이트와 수락한 입력은 보존된다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('first-search');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const userData = await tempDir('first-search-userdata');
  // 앱 1: 폴더를 열어 마지막 프로젝트로 기억시키고 닫는다
  const first = await launch(userData);
  try {
    await stubFolderDialog(first.app, dir);
    await first.page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await first.page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '1화. 입학' }).waitFor();
  } finally {
    await closeWindow(first.app);
  }
  // 앱 2: 다시 실행하면 마지막 프로젝트가 자동으로 열린다. 첫 chapter:read를 붙잡는다
  const { app, page } = await launch(userData);
  try {
    await install(app);
    await waitUntil(page, '장벽을 놓쳤다: 첫 chapter:read가 붙잡히지 않았다 (준비 실패, 판정하지 않는다)', async () => (await state(app)).held, app);
    // (1) 검색 입력: 검색창은 있고 편집기는 아직 없다. 진단 관측: 값/포커스를 읽는 evaluate
    await searchbox(page).waitFor();
    assert.equal(await editor(page).count(), 0, '편집기는 아직 준비되지 않았다 (본문 읽기가 붙잡혀 있다)');
    await searchbox(page).fill('민수');
    // (2) submit 발생: 진단용 리스너를 설치한다 (이 evaluate는 renderer 작업 사이에 끼므로 submit 순서에 영향을 줄 수 있다)
    await page.evaluate(() => {
      (window as unknown as { submits: number }).submits = 0;
      document.addEventListener('submit', () => void ((window as unknown as { submits: number }).submits += 1), true);
    });
    const value = await searchbox(page).inputValue();
    await searchbox(page).press('Enter');
    const submits = await page.evaluate(() => (window as unknown as { submits: number }).submits);
    assert.equal(value, '민수', '(1) 검색 입력 값이 있다');
    assert.equal(submits, 1, '(2) Enter로 form submit이 1회 일어났다');
    // (3)(4) beforeSearch 완료 + search IPC가 main에 도달하고(searchCalls) 응답이 돌아간다(searchDone). 편집기 읽기는 계속 붙잡혀 있다
    await waitUntil(page, '(3) search IPC가 main에 도달하지 않았다 (beforeSearch가 끝나지 않았거나 submit 처리 문제)', async () => (await state(app)).searchCalls === 1, app);
    await waitUntil(page, '(4) search IPC 응답이 끝나지 않았다', async () => (await state(app)).searchDone === 1, app);
    assert.equal((await state(app)).held, true, '편집기 읽기는 아직 붙잡혀 있다');
    // (5) 화면 요약: 응답이 화면에 반영된다
    await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).waitFor({ timeout: 10_000 });
    assert.equal(await editor(page).count(), 0, '요약이 나온 시점에도 편집기는 아직 준비되지 않았다');
    // (6) 편집기 준비를 풀면(autofocus가 편집기로 포커스를 옮길 수 있다) 결과가 사라지지 않는다
    await release(app);
    await editor(page).waitFor();
    await page.locator('.search-summary').filter({ hasText: /\d+줄에서 찾음/ }).waitFor();
    assert.ok((await page.getByRole('list', { name: '검색 결과' }).getByRole('button').count()) >= 1, '(6) 편집기가 준비된 뒤에도 검색 결과 목록이 남아 있다');
    // 원고 바이트와 수락한 입력: 검색 결과를 눌러 화를 열고 입력·저장한다
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE, '검색만 했을 때 원고 바이트는 그대로다');
    await page.getByRole('list', { name: '검색 결과' }).getByRole('button').first().click();
    await editor(page).getByText('민수').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 추가');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    const saved = await readFile(join(dir, 'chapters', '001.md'), 'utf8');
    assert.equal(sha(saved), sha(doc('one', '1화. 입학', '민수는 운동장에 앉아 있었다 추가')), '수락한 입력이 정확한 바이트로 저장됐다');
  } finally {
    await release(app).catch(() => {});
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
