// save-race.test.ts '재시도가 모두 실패하면…'의 감독 격리 실행에서 최초 한 번 `editor.innerText().includes('original typed')` 단언이 실패했다
// (57/58, 원시 로그 review-e2e.log; 같은 테스트 단독 진단 1/1 통과, review-save-diag.log). 그 실행에는 PM 선택/삽입 지점 관측이 없어 원인이 불명이다.
// 이 테스트는 같은 시나리오(합성 원고, 별도 userData, 이름 바꾸기가 늘 EPERM인 로컬 주입)를 되풀이하되, 클릭/End/입력/Ctrl+S/EPERM 안내 각 단계 직후에
// 실제 PM 선택(from/to)·문서 본문·DOM 선택·activeElement·화면 본문(innerText)을 읽어 기록한다. 판정은 원래와 같다: 입력이 'original typed'로 화면에 남고 원고는 그대로.
// 취소/바이트 보존(원고 파일이 그대로인지, 임시 파일이 없는지)과 커서 위치/삽입 지점(입력이 문서의 어디로 들어갔는지)은 따로 판정한다.
// 진단용 page.evaluate는 입력 사이에 끼어 순서를 바꿀 수 있다 (관측 간섭 가능성).
// 실제 앱(Electron + Playwright). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ORIGINAL = '# A\n\noriginal\n';
const editor = (page: Page) => page.locator('.ProseMirror');
const chapters = (dir: string) => join(dir, 'chapters');

/** 화 파일(target)의 임시 파일 이름 바꾸기가 늘 EPERM이다 (save-race의 rename-fails와 같다) */
async function failRenames(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const fsp = process.getBuiltinModule('fs/promises');
    const rename = fsp.rename;
    fsp.rename = (async (from: string, to: string) => {
      if (String(from).startsWith(`${target}.`) && String(from).endsWith('.tmp')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      return rename(from, to);
    }) as typeof fsp.rename;
  }, target);
}

type Obs = { stage: string; from: number; to: number; doc: string; dom: string; domAnchor: number | null; active: string; inner: string; status: string };
/** 단계별 관측: PM 선택/문서 본문(TipTap이 `.ProseMirror`에 붙인 editor 읽기 전용), DOM 선택, activeElement, 화면 본문, 상태 줄 */
const observe = (page: Page, stage: string): Promise<Obs> =>
  page.evaluate((stage) => {
    const dom = document.querySelector('.ProseMirror') as unknown as HTMLElement & { editor: { state: { selection: { from: number; to: number }; doc: { textContent: string } } } };
    const { from, to } = dom.editor.state.selection;
    const sel = window.getSelection();
    return {
      stage,
      from,
      to,
      doc: dom.editor.state.doc.textContent,
      dom: sel?.toString() ?? '',
      domAnchor: sel?.anchorOffset ?? null,
      active: document.activeElement?.classList.contains('ProseMirror') ? 'editor' : (document.activeElement?.tagName.toLowerCase() ?? 'none'),
      inner: dom.innerText.replace(/\n+/g, '⏎'),
      status: [...document.querySelectorAll('[role="status"]')].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ')).join(' | '),
    };
  }, stage);

test('저장이 모두 실패해도 입력은 화면에 남는다: 클릭·End·입력·Ctrl+S·EPERM 안내 단계별 PM 선택/삽입 지점 관측 (save-race 174 최초 단언 실패의 제한 진단)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('race-input-diag');
  await mkdir(chapters(dir));
  await writeFile(join(chapters(dir), '001.md'), ORIGINAL);
  const { app, page } = await launch(await tempDir('race-input-diag-userdata'));
  const path = join(chapters(dir), '001.md');
  const trail: Obs[] = [];
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).waitFor();
    await failRenames(app, path);
    trail.push(await observe(page, '0 열기 직후(편집기 DOM 있음)'));
    await editor(page).getByText('original').click();
    trail.push(await observe(page, '1 클릭 직후'));
    await page.keyboard.press('End');
    trail.push(await observe(page, '2 End 직후'));
    await page.keyboard.type(' typed');
    trail.push(await observe(page, '3 입력 직후'));
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('EPERM', { exact: false }).waitFor({ timeout: 10_000 });
    trail.push(await observe(page, '4 EPERM 안내 직후'));
    console.log(JSON.stringify(trail));
    // 판정 1: 취소/바이트 보존 (저장은 모두 실패했으므로 원고 파일은 그대로, 임시 파일 없음)
    const bytes = await readFile(path, 'utf8');
    const temps = (await readdir(chapters(dir))).filter((f) => f.endsWith('.tmp'));
    // 판정 2: 커서 위치/삽입 지점과 화면 본문 (원래 단언: 화면 본문에 'original typed')
    const last = trail[trail.length - 1]!;
    const problems: string[] = [];
    if (bytes !== ORIGINAL) problems.push('원고 파일이 바뀌었다');
    if (temps.length > 0) problems.push(`임시 파일이 남았다: ${temps.join(',')}`);
    if (!last.inner.includes('original typed')) problems.push(`화면 본문에 'original typed'가 없다 (삽입 지점: 문서 본문=${JSON.stringify(last.doc)})`);
    assert.deepEqual(problems, [], `단계별 관측: ${JSON.stringify(trail)}`);
  } finally {
    // 닫을 때 다시 저장하려다 실패하면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
