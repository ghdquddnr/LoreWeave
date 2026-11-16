// 새 id 발급이 디스크에 성공한 직후, 열린 화를 다시 여는 chapter:read가 실패하는 경계: 새 id와 본문이 디스크에 남고,
// 읽기 대기·실패 중에는 옛 envelope로 쓰지 않으며, 에디터의 명시적 [다시 시도]로만 읽기를 다시 해 복구한 뒤 계속 저장된다.
// 장벽은 main의 chapter:read 안이다: reissue 처리기는 그대로 실행(실제 안전 쓰기)시키고, 그 뒤 002.md의 첫 후속 읽기만 붙잡았다가 거절한다.
// (처리기 전체를 사전 거절하는 것은 이 경계가 아니다. 목록 조회는 정상 — reissue-list-failure와 다른 경계.) 합성 중복 id 원고. 유료·외부 호출 없음.
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs)로 시작한다: 매 실행 독점 새 빈 userData·제품 main 전 격리 증거 확인. 합성 Electron 자동화이며 수동 GUI/실 IME가 아니다.

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const dup = (title: string) => `${BOM}---\r\nid: same-id\r\ntitle: ${title}\r\n---\r\n${title} 본문\r\n`;
const ONE = dup('첫째');
const TWO = dup('둘째');

interface Hooks {
  /** reissue 처리기 호출 수 / 성공 완료 여부 */
  reissues: number;
  issued: boolean;
  /** 발급 뒤 002.md 읽기 요청 수 (1: 붙잡았다 거절, 2: 거절, 3~: 정상) */
  postReads: number;
  /** 발급 앞 002.md 읽기 수 (이 경계 밖) */
  preReads: number;
  /** chapter:write IPC 수 */
  ipcWrites: number;
  /** 002.md로 이름을 바꾼 안전 쓰기 수: 발급 처리기 안 / 그 밖 */
  renamesInReissue: number;
  renamesOutside: number;
  inReissue: boolean;
  release?: () => void;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { reissues: 0, issued: false, postReads: 0, preReads: 0, ipcWrites: 0, renamesInReissue: 0, renamesOutside: 0, inReissue: false };
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
    const fsp = process.getBuiltinModule('fs/promises');
    const rename = fsp.rename;
    fsp.rename = (async (from: string, to: string) => {
      const out = await (rename as (...a: unknown[]) => Promise<unknown>)(from, to);
      if (String(to).endsWith('002.md')) {
        if (g.hooks.inReissue) g.hooks.renamesInReissue += 1;
        else g.hooks.renamesOutside += 1;
      }
      return out;
    }) as typeof fsp.rename;
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const reissue = map.get('chapter:reissue-id')!;
    map.set('chapter:reissue-id', async (...args: unknown[]) => {
      const h = g.hooks;
      h.reissues += 1;
      h.inReissue = true;
      try {
        const out = await reissue(...args);
        h.issued = true; // 처리기가 끝난 뒤(= 디스크 확정 뒤)부터 후속 읽기를 센다
        return out;
      } finally {
        h.inReissue = false;
      }
    });
    const read = map.get('chapter:read')!;
    map.set('chapter:read', async (...args: unknown[]) => {
      const h = g.hooks;
      if (!String(args[1]).endsWith('002.md')) return read(...args);
      if (!h.issued) {
        h.preReads += 1;
        return read(...args);
      }
      h.postReads += 1;
      if (h.postReads === 1) {
        await new Promise<void>((resolve) => (h.release = resolve));
        throw new Error('EACCES: permission denied (synthetic, held read after reissue)');
      }
      if (h.postReads === 2) throw new Error('EACCES: permission denied (synthetic, first retry)');
      return read(...args);
    });
    const write = map.get('chapter:write')!;
    map.set('chapter:write', (...args: unknown[]) => {
      g.hooks.ipcWrites += 1;
      return write(...args);
    });
  });
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.release?.());
const until = async (app: ElectronApplication, ok: (h: Hooks) => boolean) => {
  const deadline = Date.now() + 15_000;
  while (!ok(await hooks(app))) {
    if (Date.now() > deadline) throw new Error('장벽 대기 시간 초과');
    await new Promise((r) => setTimeout(r, 25));
  }
};
/** 프레임 두 번: 화면 관측일 뿐, main의 응답 처리가 끝났다는 장벽은 아니다 (처리 완료는 호출 수 불변으로 따로 본다) */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const message = (page: Page) => page.locator('.editor-message');
const retry = (page: Page) => page.locator('.editor-pane').getByRole('button', { name: '다시 시도' });
const footerError = (page: Page) => page.locator('footer .error');
const dupWarning = (page: Page) => page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/);
const idOf = (text: string) => /id: (.+)\r?\n/.exec(text)?.[1];
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

test('발급 성공 직후 열린 화의 읽기가 실패해도: 새 id·본문이 디스크에 남고, 대기·실패 중 옛 envelope 쓰기 0, 명시적 [다시 시도]로만 복구해 이어서 저장된다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('rrf');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launchIsolated('rrf-ud'); // 격리 시작: 매 실행 독점 새 빈 userData, 제품 main 진입 전 증거(stage=before-product-main, entriesBefore=[], getPath/realpath)를 검증하고 틀리면 앱을 정리하고 던진다
  const read = (f: string) => readFile(join(dir, 'chapters', f), 'utf8');
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).waitFor();
    await list(page).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await dupWarning(page).waitFor();
    await hook(app);

    // 1. 발급 실행 → 디스크 확정 → 후속 읽기가 장벽에 걸린다
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await until(app, (h) => h.postReads >= 1);
    const held = await hooks(app);
    console.error('REISSUE_REREAD_BARRIER', JSON.stringify({ ...held, release: undefined }));
    assert.equal(held.reissues, 1, '발급 처리기는 한 번 실행됐다 (사전 거절이 아니다)');
    assert.equal(held.issued, true, '처리기가 성공으로 끝난 뒤의 읽기다');
    assert.equal(held.renamesInReissue, 1, '발급의 필수 안전 쓰기 1회');
    assert.equal(held.renamesOutside, 0);
    assert.equal(await footerError(page).count(), 0, '목록 조회는 처리기 안에서 정상 응답했다 (목록 실패 안내 없음: 다른 경계)');
    const onDisk = await read('002.md');
    const newId = idOf(onDisk)!;
    assert.notEqual(newId, 'same-id', '디스크의 id는 이미 새로 바뀌었다');
    assert.equal(onDisk.startsWith(BOM), true, 'BOM 보존');
    assert.match(onDisk, /\r\n/);
    assert.match(onDisk, /둘째 본문\r\n$/, '본문 보존');
    assert.equal(await read('001.md'), ONE, '다른 화 바이트 보존');
    const names = await readdir(join(dir, 'chapters'));

    // 2. 읽기 대기 중: 옛 에디터 입력·Ctrl+S 모두 쓰지 않고 읽기도 중복되지 않는다
    await message(page).getByText('여는 중…').waitFor();
    assert.equal(await editor(page).count(), 0, '대기 중에는 옛 에디터가 없다');
    await page.keyboard.type('대기중입력');
    await page.keyboard.press('Control+s');
    await frames(page);
    const during = await hooks(app);
    assert.equal(during.ipcWrites, 0, '대기 중 chapter:write 0');
    assert.equal(during.renamesOutside, 0, '대기 중 불필요 쓰기 0');
    assert.equal(during.postReads, 1, '대기 중 중복 읽기 0');
    assert.equal(await read('002.md'), onDisk, '대기 중 디스크 바이트 불변');

    // 3. 읽기 실패: 읽기 오류로 안내, 기술 상세 접힘, 발급 실패로 오인하지 않음, 자동 재발급·자동 재시도 0
    await release(app);
    await message(page).getByText(/이 화를 열 수 없습니다/).waitFor();
    const text = await message(page).innerText();
    assert.match(text, /이 화를 열 수 없습니다: .*읽을 수 없습니다/, '읽기 실패로 안내한다');
    for (const raw of ['Error invoking', 'EACCES', 'permission denied', 'synthetic']) assert.ok(!text.includes(raw), `기본 안내에 기술 문구(${raw})가 없다`);
    for (const wrong of ['쓸 수 없습니다', '저장', '쓰기', '발급하지 못']) assert.ok(!text.includes(wrong), `읽기 실패를 ${wrong}로 설명하지 않는다 (안내: ${text})`);
    assert.equal(await page.locator('.tech-detail').count(), 0, '기술 상세는 기본 접힘이다');
    assert.equal(await footerError(page).count(), 0, '발급 실패 안내가 아니다');
    await frames(page);
    await frames(page);
    const failed = await hooks(app);
    assert.equal(failed.postReads, 1, '자동 읽기 재시도 0');
    assert.equal(failed.reissues, 1, '자동 재발급 0');
    assert.equal(failed.ipcWrites, 0);
    assert.equal(failed.renamesOutside, 0);
    assert.equal(await read('002.md'), onDisk, '실패 중 디스크 바이트 불변 (새 id·본문 보존)');

    // 4. 실제 키보드로 [다시 시도] → 한 번 재실패 (Enter 1회 = 읽기 1회. 연타 안전은 chapter-read-retry가 본다: 재실패로 버튼이 돌아오면 포커스도 돌아오므로 Enter 두 번은 두 번의 명시적 시도다)
    await tabToRetry(page);
    await page.keyboard.press('Enter');
    await until(app, (h) => h.postReads >= 2);
    await message(page).getByText(/이 화를 열 수 없습니다/).waitFor();
    await retry(page).waitFor();
    await frames(page);
    const second = await hooks(app);
    assert.equal(second.postReads, 2, '시도 1회 = 읽기 1회');
    assert.equal(second.reissues, 1);
    assert.equal(second.ipcWrites, 0);
    assert.equal(await read('002.md'), onDisk);

    // 5. 다음 명시적 재시도 → 성공
    await tabToRetry(page);
    await page.keyboard.press('Enter');
    await editor(page).getByText('둘째 본문').waitFor();
    assert.equal((await hooks(app)).postReads, 3);
    assert.equal(await message(page).count(), 0);
    assert.equal(await dupWarning(page).count(), 0, '새 id가 반영돼 중복 안내가 없다');

    // 6. 성공 뒤 편집 + Ctrl+S: 새 id 유지, 입력 저장, 다른 화 불변
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('복구후입력');
    await editor(page).getByText(/복구후입력/).waitFor();
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    const saved = await read('002.md');
    assert.equal(idOf(saved), newId, '새 id 유지');
    assert.equal(saved.startsWith(BOM), true);
    assert.match(saved, /복구후입력/, '입력 저장');
    assert.equal(await read('001.md'), ONE, '다른 화 바이트 불변');
    assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 0, '충돌 상태가 되지 않았다');
    const end = await hooks(app);
    assert.equal(end.reissues, 1, '재발급 총 1회');
    assert.equal(end.postReads, 3, '재시도만 읽기를 늘렸다');
    assert.equal(end.ipcWrites, 1, '사용자 저장 1회만 쓴다');
    assert.deepEqual(await readdir(join(dir, 'chapters')), names, '화 파일 수·이름 불변');
  } finally {
    await closeWindow(app);
  }
});
