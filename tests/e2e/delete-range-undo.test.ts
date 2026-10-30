// 문단 경계를 가로지르는 선택 범위를 Delete로 지운 뒤 실행 취소/다시 실행: PR116의 keydown 동기화(DOM 선택을 PM 상태에 반영) 뒤에도 여러 문단 삭제가 다른 위치를 지우거나
// 복구 때 글자를 유실·중복하지 않는지, 삭제 상태와 복구 상태의 저장·다른 화 이동·재열기 바이트가 정확한지 본다.
// 선택은 **DOM에서** 만든다(`getSelection().setBaseAndExtent`): 제품의 PM 선택을 미리 강제하지 않는다. 그 뒤 실제 키 Delete → Ctrl+Z → Ctrl+Shift+Z(제품의 실제 단축키: Mod-z / Shift-Mod-z).
// 두 순서: (자연) setBaseAndExtent 직후 곧바로 키 / (합성) `selectionchange` 전달을 테스트가 보류한 순서(PR116의 합성 스케줄 제어). 자연 순서에서는 selectionchange가 먼저 오는지 늦는지 이 테스트가 정하지 않는다.
// 합성 fixture: BOM + CRLF + frontmatter (본문 단락 7개: 단락 사이마다 빈 줄). 사전 기대는 구조 규칙으로 독립 정의한다(결과를 본 뒤 바꾸지 않음):
//   원본 블록 = ALPHA_ONE, '', BETA_TWO, '', GAMMA_THREE, '', DELTA_FOUR (모두 paragraph; frontmatter의 title이 화 이름).
//   선택 = BETA_TWO의 오프셋 5(= 'BETA_' 뒤)부터 GAMMA_THREE의 오프셋 6(= 'GAMMA_' 뒤)까지 → 'TWO' + 문단 경계 + 빈 문단 + 문단 경계 + 'GAMMA_'.
//   PM 위치(문단 크기 = 글자 수 + 2, 내용은 문단 시작 + 1): ALPHA_ONE 0..11, '' 11..13, BETA_TWO 13..23(내용 14), '' 23..25, GAMMA_THREE 25..(내용 26) → 선택 from = 14+5 = 19, to = 26+6 = 32.
//   Delete → 블록 = ALPHA_ONE, '', BETA_THREE, '', DELTA_FOUR (BETA_ + THREE 병합, 사이의 빈 문단 삭제), 캐럿 19 접힘(블록 인덱스 2).
//   Ctrl+Z → 원본 블록, 선택은 삭제 직전 선택 19–32 (history는 변경 직전 선택을 되돌린다). Ctrl+Shift+Z → 삭제 블록, 캐럿 19.
//   삭제는 첫 변경이라 그 앞에 닫을 history 그룹이 없다(별도 closeHistory 불필요). 바이트는 C3 규칙(한 줄=한 문단, 빈 줄=빈 문단)과 envelope(BOM + frontmatter + CRLF)로 블록에서 독립 도출한다.
// 관측(읽기 전용): TipTap `.editor`의 PM 선택/블록, DOM 선택, transaction(문서 변경 여부·history 메타). 진단 리스너는 순서에 영향을 줄 수 있다. 이 테스트로 pending DOM mutation 일반 경로, 시간 그룹(500ms), 실제 IME를 검증했다고 주장하지 않는다.
// 실제 앱(Electron + Playwright). 합성 원고, 별도 userData. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const LINES_ORIGINAL = ['ALPHA_ONE', '', 'BETA_TWO', '', 'GAMMA_THREE', '', 'DELTA_FOUR'];
const LINES_DELETED = ['ALPHA_ONE', '', 'BETA_THREE', '', 'DELTA_FOUR'];
const toBlocks = (lines: string[]) => lines.map((l) => `paragraph:${l}`);
const bytesOf = (lines: string[]) => `${envelope('two', 'TWO')}${lines.join('\r\n')}\r\n`;
const ONE = `${envelope('one', 'ONE')}EVIDENCE_QUOTE\r\n`;
const TWO = bytesOf(LINES_ORIGINAL);

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
type Tx = { docChanged: boolean; history: 'none' | 'undo' | 'redo' };
type W = { txlog: Tx[]; blockSel: boolean };
type Ed = {
  state: { selection: { from: number; to: number; empty: boolean; $from: { index(depth: number): number } }; doc: { forEach(cb: (n: { type: { name: string }; textContent: string }) => void): void } };
  on(n: string, cb: (p: { transaction: { docChanged: boolean; getMeta(k: string): { redo?: boolean } | undefined } }) => void): void;
};
const state = (page: Page) =>
  page.evaluate(() => {
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
    const blocks: string[] = [];
    ed.state.doc.forEach((n) => void blocks.push(`${n.type.name}:${n.textContent}`));
    const { from, to, empty, $from } = ed.state.selection;
    return { blocks, from, to, empty, caretBlock: $from.index(0) };
  });
async function reach(page: Page, expected: string[]) {
  await page.waitForFunction(
    (exp) => {
      const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
      const blocks: string[] = [];
      ed.state.doc.forEach((n) => void blocks.push(`${n.type.name}:${n.textContent}`));
      return JSON.stringify(blocks) === JSON.stringify(exp);
    },
    expected,
    { timeout: 3000 },
  ).catch(() => {});
  return state(page);
}
/** DOM에서 실제 선택 범위를 만든다: BETA_TWO 오프셋 5 → GAMMA_THREE 오프셋 6. PM 선택은 건드리지 않는다. 만든 직후의 DOM/PM 선택을 읽어 돌려준다 */
const makeDomRange = (page: Page) =>
  page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('.ProseMirror p'));
    const a = ps.find((p) => p.textContent === 'BETA_TWO')!.firstChild!;
    const b = ps.find((p) => p.textContent === 'GAMMA_THREE')!.firstChild!;
    window.getSelection()!.setBaseAndExtent(a, 5, b, 6);
    const s = window.getSelection()!;
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
    return { dom: `${s.anchorNode?.textContent}@${s.anchorOffset} → ${s.focusNode?.textContent}@${s.focusOffset}`, domText: s.toString().replace(/\n+/g, '⏎'), pm: `${ed.state.selection.from}-${ed.state.selection.to}` };
  });

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-userdata`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await chapter(page, 'TWO').click();
  await editor(page).getByText('BETA_TWO', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 }); // 시작 포커스가 끝났다
  return { app, page, dir };
}

async function scenario(page: Page, dir: string, hold: boolean) {
  const two = join(dir, 'chapters', '002.md');
  const problems: string[] = [];
  const check = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${what}: ${JSON.stringify(actual)} (기대 ${JSON.stringify(expected)})`);
  };
  check('규칙: 도출 바이트 = 원본 002', bytesOf(LINES_ORIGINAL), TWO);
  check('입력 전 블록', (await state(page)).blocks, toBlocks(LINES_ORIGINAL));
  // 기록기: transaction(문서 변경 여부, history 메타). hold이면 selectionchange 전달을 PM에 닿기 전에 막는다 (합성 스케줄 제어)
  await page.evaluate((hold) => {
    const w = window as unknown as W;
    w.txlog = [];
    w.blockSel = hold;
    document.addEventListener('selectionchange', (e) => void (w.blockSel && e.stopImmediatePropagation()), true);
  }, hold);
  // 화를 다시 열면 새 편집기 인스턴스가 만들어진다: transaction 리스너는 편집기마다 붙인다 (처음 실행에서 한 번만 붙여 재열기 뒤 기록이 비는 준비 결함이 있었다)
  const attach = () =>
    page.evaluate(() => {
      const w = window as unknown as W;
      const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
      ed.on('transaction', ({ transaction }) => {
        const h = transaction.getMeta('history$');
        w.txlog.push({ docChanged: transaction.docChanged, history: h ? (h.redo ? 'redo' : 'undo') : 'none' });
      });
    });
  await attach();
  const txLen = () => page.evaluate(() => (window as unknown as W).txlog.length);
  const txSince = (from: number) => page.evaluate((n) => (window as unknown as W).txlog.slice(n), from);
  const save = async () => {
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
  };
  const reopen = async () => {
    await chapter(page, 'ONE').click();
    await editor(page).getByText('EVIDENCE_QUOTE').waitFor();
    await chapter(page, 'TWO').click();
    await editor(page).getByText('ALPHA_ONE', { exact: true }).waitFor();
    await attach();
  };
  /** 삭제 → (선택 단계 기록) → Delete 실제 키. 삭제 직후의 상태를 돌려준다 */
  const deleteRange = async (label: string) => {
    const before = await txLen();
    const made = await makeDomRange(page);
    check(`${label}: DOM 선택이 의도한 범위`, made.domText, 'TWO⏎GAMMA_'); // 줄바꿈 묶음은 ⏎ 하나로 본다 (문단 경계들)
    await page.keyboard.press('Delete');
    const got = await reach(page, toBlocks(LINES_DELETED));
    const tx = await txSince(before);
    check(`${label}: 삭제 뒤 블록`, got.blocks, toBlocks(LINES_DELETED));
    check(`${label}: 삭제 뒤 캐럿(접힘, 19, 블록 인덱스 2)`, { empty: got.empty, from: got.from, caretBlock: got.caretBlock }, { empty: true, from: 19, caretBlock: 2 });
    check(`${label}: 삭제 transaction (문서 변경이 history 메타 없이 정확히 1개)`, tx.filter((t) => t.docChanged).map((t) => t.history), ['none']);
    return { made, got };
  };

  // (a) 삭제 → 취소 → 저장·재열기(원본 상태)
  const a = await deleteRange('1회차');
  const tA = await txLen();
  await page.keyboard.press('Control+z');
  const undo1 = await reach(page, toBlocks(LINES_ORIGINAL));
  check('취소 뒤 블록(원본)', undo1.blocks, toBlocks(LINES_ORIGINAL));
  check('취소 뒤 선택(삭제 직전 선택 19–32)', { from: undo1.from, to: undo1.to }, { from: 19, to: 32 });
  check('취소 transaction (undo, 문서 변경 1개)', (await txSince(tA)).filter((t) => t.docChanged).map((t) => t.history), ['undo']);
  await save();
  check('취소 상태 저장 바이트 = 원본', await readFile(two, 'utf8'), TWO);
  await reopen();
  check('취소 상태 재열기 블록', (await state(page)).blocks, toBlocks(LINES_ORIGINAL));
  check('취소 상태 재열기 뒤 디스크', await readFile(two, 'utf8'), TWO);
  // (b) 재열기한 새 편집기에서 다시 삭제 → 취소 → 다시 실행 → 저장·재열기(삭제 상태)
  await deleteRange('2회차(재열기 뒤)');
  await page.keyboard.press('Control+z');
  check('2회차 취소 뒤 블록', (await reach(page, toBlocks(LINES_ORIGINAL))).blocks, toBlocks(LINES_ORIGINAL));
  const tB = await txLen();
  await page.keyboard.press('Control+Shift+z');
  const redo = await reach(page, toBlocks(LINES_DELETED));
  check('다시 실행 뒤 블록(삭제)', redo.blocks, toBlocks(LINES_DELETED));
  check('다시 실행 뒤 캐럿(접힘 19)', { empty: redo.empty, from: redo.from }, { empty: true, from: 19 });
  check('다시 실행 transaction (redo, 문서 변경 1개)', (await txSince(tB)).filter((t) => t.docChanged).map((t) => t.history), ['redo']);
  if (hold) await page.evaluate(() => void ((window as unknown as W).blockSel = false));
  await save();
  check('삭제 상태 저장 바이트', await readFile(two, 'utf8'), bytesOf(LINES_DELETED));
  await reopen();
  check('삭제 상태 재열기 블록', (await state(page)).blocks, toBlocks(LINES_DELETED));
  check('삭제 상태 재열기 뒤 디스크', await readFile(two, 'utf8'), bytesOf(LINES_DELETED));
  check('1화 원고 불변', await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE);
  console.log(JSON.stringify({ hold, made: a.made, deleted: a.got, undoSel: `${undo1.from}-${undo1.to}`, redoSel: `${redo.from}-${redo.to}` }));
  assert.deepEqual(problems, [], `범위 삭제 undo/redo (hold=${hold})`);
}

test('문단 경계를 가로지르는 DOM 선택을 Delete → Ctrl+Z → Ctrl+Shift+Z (자연 전달): 블록·선택·저장·재열기 바이트(BOM/CRLF/frontmatter)가 사전 기대와 같다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('delete-range-natural');
  try {
    await scenario(page, dir, false);
  } finally {
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('같은 순서에서 selectionchange 전달이 늦는 경우(합성 스케줄 제어): 범위 삭제 undo/redo와 저장·재열기 결과가 같다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('delete-range-held');
  try {
    await scenario(page, dir, true);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
