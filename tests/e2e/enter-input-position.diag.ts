// [수동 실행 진단 — 기본 `test:e2e`(tests/e2e/**/*.test.ts)에 포함되지 않는다] 실행: `node --import tsx --test --test-concurrency=1 tests/e2e/enter-input-position.diag.ts` (먼저 `corepack pnpm build`).
// 이 진단은 원하는 동작(Enter가 TARGET_BODY 뒤에 새 문단을 만든다)을 단언하며, 이 저장소의 현재 상태에서 **실패한다**(PR 본문 참조). 원인이 정해지기 전에 CI를 붉게 하지 않으려고 `.test.ts`로 두지 않았다.
// PR115 준비 단계에서 관측된 입력 위치 문제의 제한 진단: 합성 본문 `# TWO\n\nTARGET_BODY\n\nFACT_QUOTE\n`에서 TARGET_BODY를 클릭 → End → Enter → 'EXTRA_LINE' 입력을
// Playwright의 연속 키로 보냈더니 EXTRA_LINE이 TARGET_BODY 뒤가 아니라 제목 앞에 들어갔다 (PR115 found-prep.log의 편집기 본문: "…EXTRA_LINETWO…TARGET_BODY…FACT_QUOTE").
// 그때의 최초 테스트 순서(동기화 대기 없음): click → press End → press Enter → type 'EXTRA_LINE'. 이 테스트는 그 순서를 **그대로**(PM 동기화 대기 없이) 한 번 재현하며
// 읽기 전용으로 기록한다: 마우스(mousedown/mouseup/click)·keydown·beforeinput·input·selectionchange 이벤트의 순서와 각 시점의 DOM 선택/PM 선택/activeElement, TipTap Editor의 transaction(문서 변경 여부·선택).
// 진단 간섭: 이벤트 리스너와 transaction 리스너가 순서/타이밍에 영향을 줄 수 있다. PM 동기화 대기는 **자연 입력 케이스에 넣지 않는다**(증상을 숨기지 않기 위해).
// 이 결과만으로 사람의 입력 속도에서의 동작이나 PM 지연이 원인이라는 결론은 내지 않는다: 자동 연속 키에서의 관측이며 원인은 단계 증거가 보여 주는 순서까지만 기술한다.
// 실제 앱(Electron + Playwright). 합성 원고(PR115 준비 단계와 같은 LF 본문), 별도 userData. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

// PR115 준비 단계와 같은 합성 본문 (LF, 제목 `# TWO`)
const ONE = '# ONE\n\nEVIDENCE_QUOTE\n';
const TWO = '# TWO\n\nTARGET_BODY\n\nFACT_QUOTE\n';
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

type Ev = { t: number; type: string; key?: string; inputType?: string; data?: string | null; pm: string; dom: string; active: string; docChanged?: boolean; selSet?: boolean };
type W = { evlog: Ev[]; t0: number; pmSel: () => string; domSel: () => string; activeKind: () => string };

test('진단(최초 순서 그대로, 동기화 대기 없음): TARGET_BODY 클릭 → End → Enter → EXTRA_LINE 입력의 이벤트·선택·transaction 순서와 입력 위치', { timeout: 60_000 }, async () => {
  const dir = await tempDir('enter-input-diag');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir('enter-input-diag-userdata'));
  const two = join(dir, 'chapters', '002.md');
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).waitFor();
    await chapter(page, 'TWO').click();
    await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 }); // 시작 포커스가 끝났다 (PR115와 같은 준비)
    // 읽기 전용 기록기 설치 (페이지 안: 이름 붙은 함수를 변수에 담지 않고 속성에 대입한다)
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.evlog = [];
      w.t0 = performance.now();
      w.pmSel = () => {
        const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { selection: { from: number; to: number } } } }).editor;
        return `${ed.state.selection.from}-${ed.state.selection.to}`;
      };
      w.domSel = () => {
        const s = window.getSelection();
        return `${s?.anchorNode?.nodeName === '#text' ? JSON.stringify((s.anchorNode.textContent ?? '').slice(0, 14)) : (s?.anchorNode as HTMLElement | null)?.nodeName}@${s?.anchorOffset}`;
      };
      w.activeKind = () => (document.activeElement?.classList.contains('ProseMirror') ? 'editor' : (document.activeElement?.tagName.toLowerCase() ?? 'none'));
      for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'beforeinput', 'input', 'selectionchange']) {
        document.addEventListener(
          type,
          (e) => {
            w.evlog.push({
              t: Math.round((performance.now() - w.t0) * 10) / 10,
              type,
              key: (e as KeyboardEvent).key,
              inputType: (e as InputEvent).inputType,
              data: (e as InputEvent).data,
              pm: w.pmSel(),
              dom: w.domSel(),
              active: w.activeKind(),
            });
          },
          true,
        );
      }
      const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { on(n: string, cb: (p: { transaction: { docChanged: boolean; selectionSet: boolean } }) => void): void } }).editor;
      ed.on('transaction', ({ transaction }) => {
        w.evlog.push({ t: Math.round((performance.now() - w.t0) * 10) / 10, type: 'transaction', pm: w.pmSel(), dom: w.domSel(), active: w.activeKind(), docChanged: transaction.docChanged, selSet: transaction.selectionSet });
      });
    });
    // 최초 테스트와 같은 순서 (PM 동기화 대기 없음)
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('EXTRA_LINE');
    // 완료 관측: EXTRA_LINE 글자가 문서 어딘가에 모두 들어갔는지(입력 처리 완료) 조건으로 기다린다 (입력 위치와 무관한 완료 조건이다)
    await page.waitForFunction(() => (document.querySelector('.ProseMirror') as HTMLElement).innerText.includes('EXTRA_LINE'), null, { timeout: 5000 });
    const result = await page.evaluate(() => {
      const w = window as unknown as W;
      const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { forEach(cb: (n: { type: { name: string }; textContent: string }) => void): void } } } }).editor;
      const blocks: string[] = [];
      ed.state.doc.forEach((n) => void blocks.push(`${n.type.name}:${n.textContent}`));
      return { blocks, evlog: w.evlog };
    });
    console.log(JSON.stringify({ blocks: result.blocks, evlog: result.evlog }));
    // 기대: 제목 TWO는 그대로, TARGET_BODY 문단 뒤에 EXTRA_LINE 문단 (그 다음 빈 줄과 FACT_QUOTE)
    const problems: string[] = [];
    if (!result.blocks.some((b) => b === 'paragraph:EXTRA_LINE')) problems.push(`EXTRA_LINE이 TARGET_BODY 뒤의 독립 문단으로 들어가지 않았다: 문서 블록=${JSON.stringify(result.blocks)}`);
    if (result.blocks.some((b) => b.startsWith('heading:') && b.includes('EXTRA_LINE'))) problems.push('EXTRA_LINE이 제목에 들어갔다');
    // 저장/Ctrl+S/재열기: 실제 저장 완료와 디스크 바이트, 다른 화 이동·재열기
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    const disk = await readFile(two, 'utf8');
    await chapter(page, 'ONE').click();
    await editor(page).getByText('EVIDENCE_QUOTE').waitFor();
    const oneDisk = await readFile(join(dir, 'chapters', '001.md'), 'utf8');
    console.log(JSON.stringify({ disk }));
    const expectedBody = '# TWO\n\nTARGET_BODY\nEXTRA_LINE\n\nFACT_QUOTE\n';
    if (disk !== expectedBody) problems.push(`저장된 002 바이트가 예상과 다르다: ${JSON.stringify(disk)} (기대 ${JSON.stringify(expectedBody)})`);
    if (oneDisk !== ONE) problems.push('1화 원고가 바뀌었다');
    assert.deepEqual(problems, [], `입력 위치(최초 순서, 동기화 대기 없음): ${JSON.stringify({ blocks: result.blocks })}`);
  } finally {
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
