// 충돌 안내의 [디스크 내용 불러오기 (내 수정은 버림)]를 사용자가 명시 수락한 뒤, 에디터를 교체하는 chapter:read가 실패하는 경계와 명시 [다시 시도] 복구.
// 구별: conflict-reload-confirm은 폐기 확인 취소/성공, conflict-compare-reload는 읽기전용 비교 패널의 재시도다 — 이 검사는 실제 에디터 교체(reloadKey 재마운트)의 읽기 실패를 본다.
// 계약 구분: 사용자가 수락하기 전의 내 수정(MINE)은 폐기 계약(수락으로 버려진다)이고, 외부 디스크 내용과 복구 뒤 수락한 입력은 보존 계약이다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 충돌 UI. 실패 주입 지점: main의 chapter:read 처리기 안, 수락 뒤 첫 001.md 읽기만 HOLD → 명시 EACCES 거절 (처리기 전체 사전 거절 아님: 충돌을 만든 앞선 읽기는 원래대로).
// 자동 저장 경합: 이 검사 안에서만 renderer의 1500ms 자동저장 타이머를 막아(conflict-reload-confirm과 같은 방식) 미저장 입력이 충돌 전에 저장되는 경합을 없앤다 — 따라서 복구 뒤 저장은 명시 Ctrl+S뿐이다.
// 합성 자동화이며 수동 GUI·실제 OS IME가 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const chapter = (id: string, title: string, body: string) => `${BOM}---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${body}\r\n`;
const A1 = chapter('a-1', 'A첫째', 'A첫째 본문');
const B2 = chapter('b-2', 'B둘째', 'B둘째 본문');
const C3 = chapter('c-3', 'C셋째', 'C셋째 본문');
const EXTERNAL = chapter('a-1', 'A외부', 'A 외부 본문');
const files: Record<string, string> = { '001.md': A1, '002.md': B2, '003.md': C3 };
const MESSAGE = '저장되지 않은 내 수정이 사라지고 디스크 내용을 불러옵니다. 계속할까요?';

interface G {
  /** 001.md 읽기 요청 수 (충돌 이후 수락 뒤 읽기부터 센다) */
  reads: number;
  armed: boolean;
  held: boolean;
  /** 수락 뒤 첫 읽기: HOLD 뒤 거절, 그다음부터 정상 */
  postReads: number;
  writes: number;
  creates: number;
  reissues: number;
  ais: number;
  release?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { reads: 0, armed: false, held: false, postReads: 0, writes: 0, creates: 0, reissues: 0, ais: 0 });
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const read = map.get('chapter:read')!;
    map.set('chapter:read', async (...args: unknown[]) => {
      if (!String(args[1]).endsWith('001.md')) return read(...args);
      g.reads += 1;
      if (g.armed) {
        g.postReads += 1;
        if (g.postReads === 1) {
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
          throw new Error("EACCES: permission denied, open 'C:/Users/synthetic/chapters/001.md' (synthetic, reload read)");
        }
        if (g.postReads === 2) {
          // 명시 [다시 시도]의 읽기도 한 번 붙잡았다가 정상으로 통과시킨다 (읽는 중 상태줄 관측용)
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
        }
      }
      return read(...args);
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
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { reads: g.reads, postReads: g.postReads, held: g.held, writes: g.writes, creates: g.creates, reissues: g.reissues, ais: g.ais }; });
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
const message = (page: Page) => page.locator('.editor-message');
const retry = (page: Page) => page.locator('.editor-pane').getByRole('button', { name: '다시 시도' });
const footerText = (page: Page) => page.locator('footer.statusbar').innerText();
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
/** 실제 키보드(Tab)로 에디터의 [다시 시도]에 포커스를 옮긴다 (한정된 횟수) */
async function tabToRetry(page: Page) {
  for (let i = 0; i < 40; i++) {
    const on = await page.evaluate(() => {
      const a = document.activeElement;
      return a instanceof HTMLButtonElement && a.textContent?.trim() === '다시 시도' && !!a.closest('.editor-pane');
    });
    if (on) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab으로 [다시 시도]에 닿지 못했다');
}

test('수락한 [디스크 내용 불러오기]의 읽기가 실패해도: 읽기 오류로 안내하고 외부 디스크·이웃은 그대로이며 저장·생성·발급·AI 0, 명시 [다시 시도]로 외부 본문·제목이 복구되고 이어서 저장된다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('crrf');
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', name), text);
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  const { app, page } = await launch(await tempDir('crrf-ud'));
  // 폐기 확인은 이 검사의 사용자 의도다: MESSAGE만 수락하고(그 확인이 이 경계의 입구), 다른 확인은 거절·기록한다
  const asked: string[] = [];
  const unexpected: string[] = [];
  page.on('dialog', (d) => {
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
    await list(page).getByRole('button', { name: 'A첫째' }).click();
    await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
    await hook(app);
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);

    // 1) 미저장 수정 MINE + 다른 외부 디스크 내용 → 실제 충돌
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' MINE');
    await editor(page).getByText('A첫째 본문 MINE', { exact: true }).waitFor();
    await writeFile(join(dir, 'chapters', '001.md'), EXTERNAL);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    const conflict = await state(app);
    assert.equal(conflict.writes, 0, '충돌 전에 저장이 없었다 (자동저장 타이머를 막았다)');

    // 2) 사용자가 [디스크 내용 불러오기]를 누르고 폐기 확인을 수락 → 에디터 교체의 읽기를 HOLD한다 (비교 패널의 읽기가 아니다)
    await arm(app);
    await page.getByRole('button', { name: /디스크 내용 불러오기/ }).click();
    await waitUntil('교체 읽기를 붙잡지 못했다', async () => (await state(app)).held);
    const held = await state(app);
    console.error('CONFLICT_RELOAD_BARRIER', JSON.stringify({ ...held, asked: asked.length, status: await page.getByRole('status').allInnerTexts(), message: await message(page).allInnerTexts() }));
    assert.deepEqual(asked, [MESSAGE], '폐기 확인 문구와 횟수 (수락 1회)');
    // 읽기는 HOLD로 고정돼 있다: 상태줄 렌더(React 상태 전달)를 기다린 뒤 본다 (main의 HOLD 도달과 renderer 재렌더 사이 경합을 피한다)
    await page.locator('footer.statusbar').getByText('여는 중…').waitFor();
    const readingFooter = await footerText(page);
    assert.match(readingFooter, /여는 중…/, `읽기 대기 중 상태줄이 읽는 중이라고 말한다: ${readingFooter}`);
    for (const wrong of ['저장됨', '저장 중', '저장 실패', '저장 대기']) assert.ok(!readingFooter.includes(wrong), `읽기 대기 중 상태줄에 쓰기 결과(${wrong})가 없다: ${readingFooter}`);
    assert.equal(await page.getByRole('button', { name: '다시 저장' }).count() + (await page.getByRole('button', { name: '본문 복사' }).count()), 0, '읽기 대기 중 저장 복구 버튼이 없다');
    assert.equal(held.postReads, 1, '수락 뒤 001.md 읽기 1회가 장벽에 걸렸다');
    assert.equal(held.reads, conflict.reads + 1, '그 읽기는 수락이 만든 읽기 하나다');
    assert.equal(await editor(page).count(), 0, '읽는 동안 옛 에디터는 없다');
    assert.equal(held.writes, 0);

    // 3) 읽기 거절: 읽기 오류로 안내, 기술 상세 기본 접힘, 저장 성공·빈 원고로 보이지 않음, 재시도 제시
    await release(app);
    await message(page).getByText(/이 화를 열 수 없습니다/).waitFor();
    const text = await message(page).innerText();
    const statusTexts = await page.getByRole('status').allInnerTexts();
    console.error('CONFLICT_RELOAD_FAILED', JSON.stringify({ text, status: statusTexts, editors: await editor(page).count() }));
    assert.match(text, /이 화를 열 수 없습니다: .*읽을 수 없습니다/, '읽기 실패로 안내한다');
    for (const raw of ['Error invoking', 'EACCES', 'permission denied', 'C:/Users', 'synthetic', '001.md']) assert.ok(!text.includes(raw), `기본 안내에 기술 문구(${raw})가 없다`);
    for (const wrong of ['쓸 수 없습니다', '저장', '쓰기']) assert.ok(!text.includes(wrong), `읽기 실패를 쓰기·저장 실패(${wrong})로 설명하지 않는다`);
    assert.equal(await page.locator('.tech-detail').count(), 0, '기술 상세는 기본 접힘이다');
    assert.equal(await editor(page).count(), 0, '실패를 빈 원고 편집기로 열지 않는다');
    await page.locator('footer.statusbar').getByText('열기 실패').waitFor();
    const failedFooter = await footerText(page);
    assert.match(failedFooter, /열기 실패/, `읽기 실패 중 상태줄이 열기 실패라고 말한다: ${failedFooter}`);
    for (const wrong of ['저장됨', '저장 중', '저장 실패', '저장 대기', '입력은 이 화면에 남아']) assert.ok(!failedFooter.includes(wrong), `읽기 실패 중 상태줄에 쓰기 결과·입력 보존 주장(${wrong})이 없다: ${failedFooter}`);
    assert.equal(await page.getByRole('button', { name: '다시 저장' }).count() + (await page.getByRole('button', { name: '본문 복사' }).count()), 0, '읽기 실패 중 잘못된 다시 저장·본문 복사 버튼이 없다');
    await retry(page).waitFor();
    assert.equal(await page.getByText('A 외부 본문').count(), 0, '아직 외부 본문을 보여주지 않는다 (읽기에 실패했다)');
    await frames(page);
    await frames(page);
    const failed = await state(app);
    assert.equal(failed.postReads, 1, '자동 읽기 재시도 0');
    assert.equal(failed.writes + failed.creates + failed.reissues + failed.ais, 0, '불필요한 write/create/reissue/AI 진입 0');
    assert.deepEqual(await read('001.md'), Buffer.from(EXTERNAL), '외부 디스크 내용 그대로 (불러오기 실패가 쓰지 않았다)');
    for (const f of ['002.md', '003.md']) assert.deepEqual(await read(f), Buffer.from(files[f]!), `${f} 불변`);
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');

    // 4) 실제 키보드로 명시 [다시 시도] → 같은 화의 원래 읽기로 복구 (재발급·재생성·쓰기로 우회하지 않는다)
    await tabToRetry(page);
    await page.keyboard.press('Enter');
    await waitUntil('재시도 읽기를 붙잡지 못했다', async () => (await state(app)).held && (await state(app)).postReads === 2);
    await page.locator('footer.statusbar').getByText('여는 중…').waitFor();
    const retryFooter = await footerText(page);
    assert.match(retryFooter, /여는 중…/, `재시도 읽기 대기 중 상태줄이 다시 읽는 중이라고 말한다: ${retryFooter}`);
    for (const wrong of ['저장됨', '열기 실패']) assert.ok(!retryFooter.includes(wrong), `재시도 읽기 대기 중 상태줄에 ${wrong}가 없다: ${retryFooter}`);
    await release(app);
    await editor(page).getByText('A 외부 본문', { exact: true }).waitFor();
    const recovered = await state(app);
    assert.equal(recovered.postReads, 2, '시도 1회 = 읽기 1회');
    assert.equal(recovered.writes + recovered.creates + recovered.reissues + recovered.ais, 0, '복구가 쓰기·생성·발급·AI로 우회하지 않았다');
    assert.equal(await message(page).count(), 0);
    await list(page).getByRole('button', { name: 'A외부' }).waitFor();
    await page.getByRole('button', { name: '탭 닫기: A외부', exact: true }).waitFor();
    const readyFooter = await footerText(page);
    assert.match(readyFooter, /A외부/, `복구 뒤 상태줄 제목이 실제 외부 제목이다: ${readyFooter}`);
    assert.match(readyFooter, /저장됨/, `복구 뒤 정상 저장 표시로 돌아온다: ${readyFooter}`);
    for (const wrong of ['여는 중', '열기 실패']) assert.ok(!readyFooter.includes(wrong), `복구 뒤 상태줄에 ${wrong}가 없다: ${readyFooter}`);
    console.error('READ_STATE_FOOTER', JSON.stringify({ reading: readingFooter, failed: failedFooter, retrying: retryFooter, ready: readyFooter }));
    assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 0, '충돌 안내가 사라졌다');
    assert.deepEqual(await read('001.md'), Buffer.from(EXTERNAL), '복구 읽기도 디스크를 바꾸지 않았다');

    // 5) 복구 뒤 실제 입력 → 기존 저장 경로(명시 Ctrl+S: 자동저장 타이머를 막았다)로 원래 id·BOM·CRLF 그대로 저장
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' AFTER');
    await editor(page).getByText('A 외부 본문 AFTER', { exact: true }).waitFor();
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    const expected = EXTERNAL.replace('A 외부 본문', 'A 외부 본문 AFTER');
    assert.deepEqual(await read('001.md'), Buffer.from(expected), '원래 id·BOM·CRLF·제목 그대로 외부 본문 + 복구 뒤 입력이 저장됐다');
    const end = await state(app);
    assert.equal(end.writes, 1, '저장은 복구 뒤 입력의 명시 저장 한 번뿐이다');
    assert.equal(end.creates + end.reissues + end.ais, 0);
    for (const f of ['002.md', '003.md']) assert.deepEqual(await read(f), Buffer.from(files[f]!), `${f} 불변`);
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files));
    assert.deepEqual(unexpected, [], '예상하지 않은 확인 창이 없다');
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }

  // 6) 새 격리 앱 재열기: 저장된 본문과 제목
  const second = await launch(await tempDir('crrf-reopen-ud'));
  try {
    await stubFolderDialog(second.app, dir);
    await second.page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await list(second.page).getByRole('button', { name: 'A외부' }).click();
    await editor(second.page).getByText('A 외부 본문 AFTER', { exact: true }).waitFor();
    assert.deepEqual(await read('001.md'), Buffer.from(EXTERNAL.replace('A 외부 본문', 'A 외부 본문 AFTER')));
  } finally {
    await closeWindow(second.app);
  }
});
