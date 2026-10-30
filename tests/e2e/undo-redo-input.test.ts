// PR116의 keydown 동기화(비조합 keydown마다 DOM 선택을 PM 상태에 반영) 뒤에도 실행 취소/다시 실행이 수락한 입력을 정확히 되돌리고 복구하는지:
// 선택만 바뀐 transaction(flush가 만드는 것)이 history 경계를 만들거나 원고 글자를 유실·중복·다른 위치로 복구하지 않아야 한다.
// 제품의 실제 단축키(설치된 @tiptap/extensions UndoRedo): undo = Mod-z, redo = Shift-Mod-z / Mod-y (Windows의 Mod = Ctrl). 이 테스트는 Control+Z와 Control+Shift+Z를 실제 키로 누른다.
// 취소 그룹은 시간/인접성 규칙(prosemirror-history newGroupDelay 500ms·isAdjacentTo)에 맡기지 않고 **결정적 경계**로 정의한다: 단계마다 explicit closeHistory(history 플러그인의 closeHistory 메타 `closeHistory$`)를
// 문서 변경 없는 transaction으로 보내 한 단계 = 한 취소 이벤트가 되게 한다. 입력 단계는 하나의 transaction이 되도록 Enter(실제 키)와 `keyboard.insertText`(단일 input 이벤트)를 쓴다.
// 사전 기대(구조 규칙으로 독립 정의, 현상 뒤 변경 없음):
//   B0 원본 / B1 = Enter 뒤(TARGET_BODY 바로 뒤 빈 문단 추가) / B2 = 'EXTRA_LINE' 입력 뒤 / B3 = ' MORE' 입력 뒤.
//   Ctrl+Z ×3 → B2, B1, B0 (+ 한 번 더 누르면 변화 없음: can().undo()=false), Ctrl+Shift+Z ×3 → B1, B2, B3. 캐럿(PM 선택)은 항상 접혀 있고 취소는 그 변경 직전의 위치로, 다시 실행은 변경 뒤 위치로 돌아간다.
// 관측(읽기 전용): TipTap `.editor`의 transaction 리스너로 문서 변경 여부·history 메타(redo 여부)·선택을 기록한다 = 실제 undo/redo 명령 수신과 문서 변경 관측. 진단 리스너는 순서에 영향을 줄 수 있다.
// 두 순서: (자연) 연속 실제 키 / (합성) selectionchange 전달을 테스트가 보류한 순서 (PR116의 합성 스케줄 제어 재사용).
// 실제 IME(한글 조합)는 이 테스트로 통과를 주장하지 않는다. 실제 앱(Electron + Playwright). 합성 원고, 별도 userData. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '# ONE\n\nEVIDENCE_QUOTE\n';
const TWO = '# TWO\n\nTARGET_BODY\n\nFACT_QUOTE\n';
// 구조 규칙으로 정의한 단계별 문서 (블록 = `타입:본문`)
const B0 = ['heading:TWO', 'paragraph:', 'paragraph:TARGET_BODY', 'paragraph:', 'paragraph:FACT_QUOTE'];
const B1 = ['heading:TWO', 'paragraph:', 'paragraph:TARGET_BODY', 'paragraph:', 'paragraph:', 'paragraph:FACT_QUOTE']; // Enter: TARGET_BODY 바로 뒤에 빈 문단
const B2 = ['heading:TWO', 'paragraph:', 'paragraph:TARGET_BODY', 'paragraph:EXTRA_LINE', 'paragraph:', 'paragraph:FACT_QUOTE'];
const B3 = ['heading:TWO', 'paragraph:', 'paragraph:TARGET_BODY', 'paragraph:EXTRA_LINE MORE', 'paragraph:', 'paragraph:FACT_QUOTE'];
/** C3 규칙(한 줄 = 한 문단, 빈 줄 = 빈 문단, 제목 `# `)으로 블록에서 바이트를 도출한다 (제품 직렬화 비사용) */
const bytesOf = (blocks: string[]) => blocks.map((b) => (b.startsWith('heading:') ? `# ${b.slice('heading:'.length)}` : b.slice('paragraph:'.length))).join('\n') + '\n';

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
type Tx = { n: number; docChanged: boolean; history: 'none' | 'undo' | 'redo'; sel: string };
type W = { txlog: Tx[]; blockSel: boolean };
type Ed = {
  state: { selection: { from: number; to: number; empty: boolean; $from: { index(depth: number): number } }; doc: { forEach(cb: (n: { type: { name: string }; textContent: string }) => void): void }; tr: { setMeta(k: string, v: unknown): unknown } };
  view: { dispatch(tr: unknown): void };
  can(): { undo(): boolean; redo(): boolean };
  on(n: string, cb: (p: { transaction: { docChanged: boolean; getMeta(k: string): { redo?: boolean } | undefined } }) => void): void;
};
const state = (page: Page) =>
  page.evaluate(() => {
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
    const blocks: string[] = [];
    ed.state.doc.forEach((n) => void blocks.push(`${n.type.name}:${n.textContent}`));
    const { from, to, empty, $from } = ed.state.selection;
    return { blocks, from, to, empty, caretBlock: $from.index(0), canUndo: ed.can().undo(), canRedo: ed.can().redo() };
  });
/** 문서 변경 없는 transaction으로 history를 닫는다 (explicit closeHistory) */
const closeHistory = (page: Page) =>
  page.evaluate(() => {
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
    ed.view.dispatch(ed.state.tr.setMeta('closeHistory$', true));
  });
/** 문서가 기대 블록이 될 때까지 (조건 기다림; 안 되면 그때의 실제 블록을 돌려준다) */
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
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 }); // 시작 포커스가 끝났다
  return { app, page, dir };
}

async function scenario(page: Page, dir: string, hold: boolean) {
  const two = join(dir, 'chapters', '002.md');
  const problems: string[] = [];
  const check = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`${what}: ${JSON.stringify(actual)} (기대 ${JSON.stringify(expected)})`);
  };
  const s0 = await state(page);
  check('입력 전 블록', s0.blocks, B0);
  check('규칙: 도출 바이트 = 원본 002', bytesOf(B0), TWO);
  // 기록기: transaction(문서 변경 여부, history 메타) = 실제 undo/redo 수신 관측. hold이면 selectionchange 전달을 PM에 닿기 전에 막는다 (합성 스케줄 제어)
  await page.evaluate((hold) => {
    const w = window as unknown as W;
    w.txlog = [];
    w.blockSel = hold;
    document.addEventListener('selectionchange', (e) => void (w.blockSel && e.stopImmediatePropagation()), true);
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: Ed }).editor;
    ed.on('transaction', ({ transaction }) => {
      const h = transaction.getMeta('history$');
      w.txlog.push({ n: w.txlog.length, docChanged: transaction.docChanged, history: h ? (h.redo ? 'redo' : 'undo') : 'none', sel: `${ed.state.selection.from}-${ed.state.selection.to}` });
    });
  }, hold);
  // 입력 단계 (각 단계 뒤 explicit closeHistory): 클릭 + End는 선택만, Enter는 실제 키, 텍스트는 단일 input 이벤트
  await editor(page).getByText('TARGET_BODY', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const b1 = await reach(page, B1);
  check('Enter 뒤 블록(B1)', b1.blocks, B1);
  await closeHistory(page);
  await page.keyboard.insertText('EXTRA_LINE');
  const b2 = await reach(page, B2);
  check("'EXTRA_LINE' 뒤 블록(B2)", b2.blocks, B2);
  await closeHistory(page);
  await page.keyboard.insertText(' MORE');
  const b3 = await reach(page, B3);
  check("' MORE' 뒤 블록(B3)", b3.blocks, B3);
  const afterTyping = (await page.evaluate(() => (window as unknown as W).txlog)).length;
  // 실행 취소 ×3, 한 번 더(변화 없음): 각 키 뒤 문서/캐럿
  const undoStates: Array<{ expect: string[]; caret: number; got: Awaited<ReturnType<typeof state>> }> = [];
  for (const [expect, caret] of [[B2, 3], [B1, 3], [B0, 2]] as const) {
    await page.keyboard.press('Control+z');
    undoStates.push({ expect: [...expect], caret, got: await reach(page, [...expect]) });
  }
  for (const u of undoStates) {
    check('Ctrl+Z 뒤 블록', u.got.blocks, u.expect);
    check('Ctrl+Z 뒤 캐럿(접힘, 블록 인덱스)', { empty: u.got.empty, caretBlock: u.got.caretBlock }, { empty: true, caretBlock: u.caret });
  }
  check('모두 취소한 뒤 undo 가능 여부', undoStates[2]?.got.canUndo, false);
  await page.keyboard.press('Control+z'); // 더 되돌릴 것이 없다
  const noMoreUndo = await state(page);
  check('한 번 더 Ctrl+Z: 변화 없음', noMoreUndo.blocks, B0);
  // 다시 실행 ×3: 제품의 실제 단축키 Ctrl+Shift+Z
  const redoStates: Array<{ expect: string[]; got: Awaited<ReturnType<typeof state>> }> = [];
  for (const expect of [B1, B2, B3]) {
    await page.keyboard.press('Control+Shift+z');
    redoStates.push({ expect, got: await reach(page, expect) });
  }
  for (const r of redoStates) {
    check('Ctrl+Shift+Z 뒤 블록', r.got.blocks, r.expect);
    check('Ctrl+Shift+Z 뒤 캐럿(접힘, TARGET_BODY 뒤 문단)', { empty: r.got.empty, caretBlock: r.got.caretBlock }, { empty: true, caretBlock: 3 });
  }
  // 실제 undo/redo 명령 수신과 문서 변경 관측: 취소 3번(문서 변경 3), 다시 실행 3번(문서 변경 3), 그 사이 변화 없는 Ctrl+Z는 문서 변경 없음
  const txlog = await page.evaluate(() => (window as unknown as W).txlog);
  const after = txlog.slice(afterTyping);
  check('undo transaction (history 메타, 문서 변경)', after.filter((t) => t.history === 'undo').map((t) => t.docChanged), [true, true, true]);
  check('redo transaction (history 메타, 문서 변경)', after.filter((t) => t.history === 'redo').map((t) => t.docChanged), [true, true, true]);
  check('history 메타 없는 문서 변경 transaction(유실/중복 위험)', after.filter((t) => t.history === 'none' && t.docChanged).length, 0);
  if (hold) await page.evaluate(() => void ((window as unknown as W).blockSel = false));
  // 저장: 다시 실행 끝 상태(B3)를 저장 → 디스크 바이트 → 다른 화 → 2화 실제 재열기
  await page.keyboard.press('Control+S');
  await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
  check('B3 저장 바이트', await readFile(two, 'utf8'), bytesOf(B3));
  await chapter(page, 'ONE').click();
  await editor(page).getByText('EVIDENCE_QUOTE').waitFor();
  await chapter(page, 'TWO').click();
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  check('재열기 블록(B3)', (await state(page)).blocks, B3);
  check('재열기 뒤 디스크 바이트', await readFile(two, 'utf8'), bytesOf(B3));
  // 한 번 취소한 상태(B2)도 저장·재열기로 보존된다 (재열기 뒤에는 취소 기록이 없는 것이 정상)
  await editor(page).getByText('EXTRA_LINE MORE', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' LAST');
  await page.keyboard.press('Control+z'); // 방금 입력(' LAST') 취소 → B3
  check('재열기 뒤 새 입력 취소 → B3', (await reach(page, B3)).blocks, B3);
  await page.keyboard.press('Control+S');
  await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
  check('최종 디스크 바이트(B3)', await readFile(two, 'utf8'), bytesOf(B3));
  check('1화 원고 불변', await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE);
  console.log(JSON.stringify({ hold, undo: undoStates.map((u) => ({ blocks: u.got.blocks.length, caret: u.got.caretBlock })), redo: redoStates.map((r) => ({ blocks: r.got.blocks.length, caret: r.got.caretBlock })), txlog: after }));
  assert.deepEqual(problems, [], `undo/redo (hold=${hold})`);
}

test('클릭 → End → Enter → 입력 뒤 실행 취소/다시 실행(자연 연속 키): 단계별 문서·캐럿이 사전 기대와 같고 저장·2화 재열기 바이트가 보존된다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('undo-redo-natural');
  try {
    await scenario(page, dir, false);
  } finally {
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('같은 순서에서 selectionchange 전달이 늦는 경우(합성 스케줄 제어): 실행 취소/다시 실행과 저장·재열기 결과가 같다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('undo-redo-held');
  try {
    await scenario(page, dir, true);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
