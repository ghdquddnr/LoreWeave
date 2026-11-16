// 기존 E2E를 제품 main 진입 전 격리 시작 파일(hooks/main-isolated-userdata-entry.cjs)로 띄운다. launch.ts의 전역 정책은 바꾸지 않는다.
// 매 실행: 독점 mkdtemp 새 빈 userData를 LW_TEST_USERDATA로 넘기고, 시작 파일이 남긴 증거(stage=before-product-main, 빈 폴더, getPath 일치)를 확인한다.
// 확인에 실패하면 띄운 앱을 정리하고 오류를 던진다 (앱을 남기지 않는다).

import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const ENTRY = join(__dirname, 'hooks', 'main-isolated-userdata-entry.cjs');

export async function launchIsolated(prefix: string, env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = await tempDir(prefix);
  const { app, page } = await launch(userData, { ...env, LW_TEST_USERDATA: userData }, ENTRY);
  try {
    const evidence = JSON.parse(await readFile(join(userData, '.isolated-entry-evidence.json'), 'utf8')) as { stage: string; userData: string; entriesBefore: string[] };
    assert.equal(evidence.stage, 'before-product-main');
    assert.deepEqual(evidence.entriesBefore, []);
    assert.equal(evidence.userData, await app.evaluate(({ app: a }) => a.getPath('userData')));
    assert.equal((await realpath(userData)).toLowerCase(), evidence.userData.toLowerCase());
  } catch (e) {
    await closeWindow(app).catch(() => undefined);
    throw e;
  }
  return { app, page, userData };
}
