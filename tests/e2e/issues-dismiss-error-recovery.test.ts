// 문제 가능성 패널: [무시]가 한 번 실패해 오류를 보인 뒤 같은 결과의 재시도가 성공하면, 이전 실패를 현재 오류로 남기지 않는다.
// 합성 원고·합성 검사 결과·격리 userData. 첫 ai:dismiss만 처리기 앞에서 거절한다 (무료, OpenAI 접근 0).

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const FAIL = '합성 무시 실패';

async function project(): Promise<string> {
  const dir = await tempDir('issues-dismiss-recovery');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# 1화\n\nONE_BODY\n');
  const db = AiStore.open(dir);
  db.saveCheck({
    file: '001.md',
    contentHash: 'synthetic',
    model: 'fake',
    modelVersion: 'fake',
    promptVersion: 'fake',
    factCount: 0,
    dropped: 0,
    costUsd: 0,
    createdAt: new Date().toISOString(),
    inputs: [],
    findings: [{ category: 'age', claim: 'ONE_CLAIM', confidence: 0.9, key: 'one', target: { quote: 'ONE_BODY', line: 3, start: 0, end: 8 }, evidence: [] }],
  });
  db.close();
  return dir;
}
function dismissed(dir: string): boolean[] {
  const db = AiStore.open(dir);
  try {
    return db.check('001.md')!.findings.map((f) => f.dismissed);
  } finally {
    db.close();
  }
}
const issues = (page: Page) => page.getByRole('region', { name: '문제 가능성' });
const dismissButton = (page: Page) => issues(page).getByRole('button', { name: '무시', exact: true });
const failNote = (page: Page) => issues(page).getByText(new RegExp(FAIL));

test('무시 실패 뒤 같은 결과의 재시도가 성공하면 이전 실패 안내가 사라지고, 반복 실패는 안내와 재시도를 유지한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('issues-dismiss-recovery-ud'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
    // 앞의 두 번만 처리기 앞에서 거절한다(저장 없음), 그 뒤는 실제 처리기
    await app.evaluate(({ ipcMain }, message) => {
      const g = globalThis as unknown as { dismissCalls: number };
      g.dismissCalls = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:dismiss')!;
      handlers.set('ai:dismiss', async (...args: unknown[]) => {
        if (++g.dismissCalls <= 2) throw new Error(message);
        return original(...args);
      });
    }, FAIL);

    await dismissButton(page).click();
    await failNote(page).waitFor();
    // 반복 실패: 오류와 재시도 가능성이 남는다
    await dismissButton(page).click();
    assert.equal(await app.evaluate(() => (globalThis as unknown as { dismissCalls: number }).dismissCalls), 2);
    await failNote(page).waitFor();
    assert.equal(await dismissButton(page).isEnabled(), true);

    // 세 번째 시도는 성공한다: 재조회로 결과가 무시됨 상태가 되고, 옛 실패 안내는 남지 않는다
    await dismissButton(page).click();
    await issues(page).getByText('찾은 문제 가능성이 없습니다.').waitFor();
    await issues(page).getByRole('button', { name: /무시한 결과 1개 보기/ }).waitFor();
    assert.equal(await failNote(page).count(), 0, '성공한 뒤에는 이전 무시 실패를 현재 오류로 남기지 않는다');
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir), [true]);
});
