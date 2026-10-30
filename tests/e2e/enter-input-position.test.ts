// 클릭 → End → Enter → 입력이 클릭한 문단 뒤에 들어가는지: PR115 준비 단계에서 EXTRA_LINE이 제목 앞(`EXTRA_LINETWO`)에 들어갔고, PR116 진단에서 같은 오배치가 독립 재현됐다.
// 읽은 설치 코드(prosemirror-view 1.42.7): 키 처리(Enter 등 keymap)는 `view.state.selection`을 쓴다. DOM 선택 변경은 `selectionchange` 이벤트로만 PM 상태에 반영되고,
// keydown 처리의 `domObserver.forceFlush()`는 예약된 flush(`flushingSoon`)가 있을 때만 일한다 → 클릭이 만든 DOM 선택 변경보다 키가 먼저 오면 PM은 옛 선택(문서 시작)으로 Enter를 처리한다.
// 두 테스트: (1) 최초 순서 그대로(PM 동기화 대기 없음, 자연 스케줄) (2) `selectionchange` 전달을 테스트가 보류해 "키가 selectionchange보다 먼저 온다"를 결정적으로 만든 순서(합성 스케줄 제어).
// 둘 다: 입력 전 문서 블록 확인 → 입력 → **전체 문서 블록과 정확한 순서** → 저장(실제 저장 완료) → 디스크 바이트 → 다른 화(1화)로 갔다가 **2화를 실제로 다시 열어** 블록·본문·디스크 바이트 재확인.
// 예상 바이트는 제품 직렬화를 부르지 않고 C3 규칙(한 줄 = 한 문단, 빈 줄 = 빈 문단, 제목은 `# `)으로 블록에서 독립 도출한다. 같은 규칙이 입력 전 원본 바이트를 그대로 만드는지도 먼저 확인한다(정상 경로를 오판하지 않기 위해).
// 관측(읽기 전용): 이벤트 순서와 PM/DOM 선택(TipTap `.editor`)을 console에 남긴다. 진단 리스너는 순서에 영향을 줄 수 있다. 실제 앱(Electron + Playwright). 합성 원고, 별도 userData. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '# ONE\n\nEVIDENCE_QUOTE\n';
const TWO = '# TWO\n\nTARGET_BODY\n\nFACT_QUOTE\n';
const BLOCKS_BEFORE = ['heading:TWO', 'paragraph:', 'paragraph:TARGET_BODY', 'paragraph:', 'paragraph:FACT_QUOTE'];
const BLOCKS_AFTER = ['heading:TWO', 'paragraph:', 'paragraph:TARGET_BODY', 'paragraph:EXTRA_LINE', 'paragraph:', 'paragraph:FACT_QUOTE'];
/** C3 규칙으로 블록에서 바이트를 도출한다 (제품 직렬화 비사용) */
const bytesOf = (blocks: string[]) => blocks.map((b) => (b.startsWith('heading:') ? `# ${b.slice('heading:'.length)}` : b.slice('paragraph:'.length))).join('\n') + '\n';

const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
type Ev = { t: number; type: string; key?: string; pm: string; dom: string };
type W = { evlog: Ev[]; t0: number; blockSel: boolean };
const blocksOf = (page: Page) =>
  page.evaluate(() => {
    const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { forEach(cb: (n: { type: { name: string }; textContent: string }) => void): void } } } }).editor;
    const blocks: string[] = [];
    ed.state.doc.forEach((n) => void blocks.push(`${n.type.name}:${n.textContent}`));
    return blocks;
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
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 }); // 시작 포커스가 끝났다
  return { app, page, dir };
}

/** 읽기 전용 이벤트 기록기. block이면 selectionchange 전달을 PM(document의 비-capture 리스너)에 닿기 전에 막는다 (테스트의 합성 스케줄 제어) */
async function recorder(page: Page, block: boolean) {
  await page.evaluate((block) => {
    const w = window as unknown as W & { pmSel: () => string; domSel: () => string };
    w.evlog = [];
    w.t0 = performance.now();
    w.blockSel = block;
    w.pmSel = () => {
      const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { selection: { from: number; to: number } } } }).editor;
      return `${ed.state.selection.from}-${ed.state.selection.to}`;
    };
    w.domSel = () => {
      const s = window.getSelection();
      return `${s?.anchorNode?.nodeName === '#text' ? JSON.stringify((s.anchorNode.textContent ?? '').slice(0, 14)) : (s?.anchorNode as HTMLElement | null)?.nodeName}@${s?.anchorOffset}`;
    };
    for (const type of ['mouseup', 'keydown', 'selectionchange']) {
      document.addEventListener(
        type,
        (e) => {
          if (type === 'selectionchange' && w.blockSel) e.stopImmediatePropagation();
          w.evlog.push({ t: Math.round((performance.now() - w.t0) * 10) / 10, type: type === 'selectionchange' && w.blockSel ? 'selectionchange(held)' : type, key: (e as KeyboardEvent).key, pm: w.pmSel(), dom: w.domSel() });
        },
        true,
      );
    }
  }, block);
}

async function scenario(page: Page, dir: string, block: boolean) {
  const two = join(dir, 'chapters', '002.md');
  // 규칙 확인: 입력 전 블록이 예상과 같고, 같은 규칙으로 원본 바이트가 그대로 도출된다
  assert.deepEqual(await blocksOf(page), BLOCKS_BEFORE, '입력 전 문서 블록');
  assert.equal(bytesOf(BLOCKS_BEFORE), TWO, 'C3 규칙으로 도출한 바이트가 원본 002와 같다');
  assert.equal(bytesOf(BLOCKS_AFTER), '# TWO\n\nTARGET_BODY\nEXTRA_LINE\n\nFACT_QUOTE\n', '입력 뒤 예상 바이트(규칙 도출)');
  await recorder(page, block);
  // 최초 순서 그대로: PM 동기화 대기 없음, 선택/포커스를 따로 강제하지 않는다
  await editor(page).getByText('TARGET_BODY', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('EXTRA_LINE');
  await page.waitForFunction(() => (document.querySelector('.ProseMirror') as HTMLElement).innerText.includes('EXTRA_LINE'), null, { timeout: 5000 }); // 입력 처리 완료(위치와 무관한 조건)
  if (block) await page.evaluate(() => void ((window as unknown as W).blockSel = false));
  const blocksAfterTyping = await blocksOf(page);
  const evlog = await page.evaluate(() => (window as unknown as W).evlog);
  console.log(JSON.stringify({ block, blocks: blocksAfterTyping, events: evlog.filter((e) => e.type !== 'keydown' || ['End', 'Enter'].includes(e.key ?? '')).slice(0, 12) }));
  const problems: string[] = [];
  if (JSON.stringify(blocksAfterTyping) !== JSON.stringify(BLOCKS_AFTER)) problems.push(`입력 직후 문서 블록이 예상과 다르다: ${JSON.stringify(blocksAfterTyping)} (기대 ${JSON.stringify(BLOCKS_AFTER)})`);
  // 저장: 실제 저장 완료와 디스크 바이트
  await page.keyboard.press('Control+S');
  await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
  const diskAfterSave = await readFile(two, 'utf8');
  if (diskAfterSave !== bytesOf(BLOCKS_AFTER)) problems.push(`저장 직후 002 바이트가 예상과 다르다: ${JSON.stringify(diskAfterSave)}`);
  // 다른 화로 갔다가 2화를 실제로 다시 연다: 전체 블록·본문·디스크 바이트 재확인
  await chapter(page, 'ONE').click();
  await editor(page).getByText('EVIDENCE_QUOTE').waitFor();
  await chapter(page, 'TWO').click();
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  const reopenedBlocks = await blocksOf(page);
  const reopenedText = await page.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).innerText.replace(/\n+/g, '⏎'));
  if (JSON.stringify(reopenedBlocks) !== JSON.stringify(BLOCKS_AFTER)) problems.push(`다시 연 2화의 문서 블록이 예상과 다르다: ${JSON.stringify(reopenedBlocks)}`);
  if (reopenedText !== 'TWO⏎TARGET_BODY⏎EXTRA_LINE⏎FACT_QUOTE') problems.push(`다시 연 2화의 본문이 예상과 다르다: ${reopenedText}`);
  if ((await readFile(two, 'utf8')) !== bytesOf(BLOCKS_AFTER)) problems.push('다시 연 뒤 002 바이트가 예상과 다르다');
  if ((await readFile(join(dir, 'chapters', '001.md'), 'utf8')) !== ONE) problems.push('1화 원고가 바뀌었다');
  assert.deepEqual(problems, [], `입력 위치 (block=${block}): ${JSON.stringify({ blocksAfterTyping, diskAfterSave, reopenedBlocks })}`);
}

test('클릭 → End → Enter → 입력 (최초 순서, 동기화 대기 없음): 입력이 TARGET_BODY 바로 뒤 새 문단에 들어가고, 저장·2화 다시 열기 뒤에도 전체 블록과 바이트가 예상과 정확히 같다', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('enter-input-natural');
  try {
    await scenario(page, dir, false);
  } finally {
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('같은 순서에서 selectionchange 전달이 키 입력보다 늦는 경우(테스트가 selectionchange를 보류해 결정적으로 만든 합성 스케줄): 입력 위치와 저장·다시 열기 결과가 같다', { timeout: 90_000 }, async () => {
  const { app, page, dir } = await start('enter-input-held');
  try {
    await scenario(page, dir, true);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
