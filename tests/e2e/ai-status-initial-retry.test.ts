// 프로젝트를 연 직후 첫 AI 상태 조회가 실패해도 원고는 열려 편집할 수 있고, 폴더를 다시 열지 않고 명령 팔레트의 [AI 분석·검사 결과 다시 읽기]로 복구한다.
// 실제 앱(Electron + Playwright). ai:analysis-status는 무료 대역(처음 n번 거절, 성공 응답은 붙잡기·합성 비용). OpenAI 접근 0.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const FAIL = '합성 최초 상태 조회 실패';

async function project(): Promise<string> {
  const dir = await tempDir('ai-status-initial');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# ONE\n\nONE_BODY\n');
  return dir;
}
/** ai:analysis-status: 앞의 failures번은 거절하고, 그 뒤 첫 성공 응답은 release 전까지 붙잡은 뒤 합성 비용을 더해 돌려준다 */
async function script(app: ElectronApplication, failures: number) {
  await app.evaluate(
    ({ ipcMain }, { failures, message }) => {
      const g = globalThis as unknown as { n: number; held: boolean; release?: () => void };
      g.n = 0;
      g.held = false;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:analysis-status')!;
      handlers.set('ai:analysis-status', async (...args: unknown[]) => {
        if (g.n++ < failures) throw new Error(message);
        const base = (await original(...args)) as { totalCostUsd: number };
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        return { ...base, totalCostUsd: 3.3333 };
      });
    },
    { failures, message: FAIL },
  );
}
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { n: number }).n);
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { held: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release: () => void }).release());
async function until(cond: () => Promise<boolean>, what: string) {
  const start = Date.now();
  while (!(await cond())) {
    assert.ok(Date.now() - start < 10_000, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const palette = (page: Page) => page.getByRole('dialog', { name: '명령 팔레트' });
const rereadOption = (page: Page) => palette(page).getByRole('option', { name: /AI 분석·검사 결과 다시 읽기/ });
const failNote = (page: Page) => page.getByText(FAIL);
const analyzeButton = (page: Page) => page.getByRole('button', { name: '이 화 분석', exact: true });

/** 환경설정을 열어 비용 줄의 글을 읽고 Esc로 닫는다 */
async function settingsCost(page: Page): Promise<string> {
  // 프로젝트 화면의 활동 막대는 '설정', 시작 화면은 '환경설정'이다
  await page.getByRole('button', { name: /^(설정|환경설정)$/ }).click();
  const dialog = page.getByRole('dialog', { name: '환경설정' });
  const text = (await dialog.getByText(/이 프로젝트에서 AI에 쓴 비용/).innerText()).replace(/\s+/g, ' ');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  return text;
}
const UNKNOWN = '이 프로젝트에서 AI에 쓴 비용: 아직 확인하지 못했습니다';

async function reread(page: Page) {
  await page.keyboard.press('Control+k');
  assert.notEqual(await rereadOption(page).getAttribute('aria-disabled'), 'true', '처음 읽기에 실패해도 다시 읽기 명령이 막히지 않는다');
  await rereadOption(page).click();
  await palette(page).waitFor({ state: 'detached' });
}

for (const failures of [1, 2]) {
  test(`최초 AI 상태 조회가 ${failures}번 실패해도 원고는 열려 편집되고, 폴더를 다시 열지 않고 다시 읽기로 복구한다 (성공 응답 전에는 분석 없음·비용 0으로 확정하지 않는다)`, { timeout: 90_000 }, async () => {
    const dir = await project();
    const { app, page } = await launch(await tempDir('ai-status-initial-ud'));
    try {
      await script(app, failures);
      await stubFolderDialog(app, dir);
      await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
      await page.locator('.ProseMirror').getByText('ONE_BODY', { exact: true }).waitFor();
      await failNote(page).first().waitFor();
      assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true');
      assert.equal(await analyzeButton(page).count(), 0, '상태를 읽지 못했으면 AI 동작을 준비된 것처럼 보이지 않는다');
      assert.equal(await page.getByText(/이 프로젝트 AI 비용/).count(), 0);
      assert.equal(await settingsCost(page), UNKNOWN, '최초 조회 실패 뒤 환경설정은 비용을 0으로 확정하지 않는다');
      for (let i = 1; i < failures; i++) {
        await reread(page);
        await until(async () => (await calls(app)) === i + 1, '재조회 요청이 갔다');
        await failNote(page).first().waitFor();
        assert.equal(await analyzeButton(page).count(), 0);
      }
      await reread(page);
      await until(() => held(app), '성공 응답을 붙잡았다');
      // 응답 전: 오류 안내는 그대로이고 AI 동작은 아직 준비되지 않았다
      assert.equal(await analyzeButton(page).count(), 0);
      assert.ok((await failNote(page).count()) > 0);
      assert.equal(await settingsCost(page), UNKNOWN, '응답을 기다리는 동안에도 미확인이다');
      await release(app);
      await page.getByText('이 프로젝트 AI 비용 $3.3333').waitFor();
      await analyzeButton(page).waitFor();
      assert.equal(await failNote(page).count(), 0, '다시 읽기가 성공하면 이 조회의 오류만 거두어진다');
      assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'true');
      assert.equal(await settingsCost(page), '이 프로젝트에서 AI에 쓴 비용: $3.3333', '성공한 뒤에는 실제 알려진 비용을 보인다');
    } finally {
      await closeWindow(app);
    }
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), '# ONE\n\nONE_BODY\n');
  });
}

test('확인된 비용 0은 $0.0000으로, 프로젝트를 열지 않은 설정은 미확인과 구별해 안내한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('ai-status-initial-zero-ud'));
  try {
    assert.equal(await settingsCost(page), '이 프로젝트에서 AI에 쓴 비용: 원고 폴더를 열면 볼 수 있습니다');
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await analyzeButton(page).waitFor();
    assert.equal(await failNote(page).count(), 0);
    assert.equal(await settingsCost(page), '이 프로젝트에서 AI에 쓴 비용: $0.0000', '실제로 확인된 0은 0으로 표현한다');
  } finally {
    await closeWindow(app);
  }
});
