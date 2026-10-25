// 빌드한 앱을 실제로 띄워 창과 보안 기본값을 확인한다. 실행: pnpm test:e2e

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launch, tempDir } from './launch.ts';

let app: ElectronApplication;
let page: Page;

before(async () => {
  ({ app, page } = await launch(await tempDir('userdata')));
});

after(async () => {
  await app?.close();
});

test('창이 열리고 첫 화면(원고 폴더 열기)이 그려진다', async () => {
  assert.equal(await page.title(), 'LoreWeave');
  await page.getByRole('button', { name: '원고 폴더 열기' }).waitFor();
});

test('renderer에서 Node.js에 접근할 수 없다 (컨텍스트 격리, Node 통합 끔)', async () => {
  const exposed = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
  }));
  assert.deepEqual(exposed, { require: 'undefined', process: 'undefined' });
});

test('새 창을 열 수 없다', async () => {
  await page.evaluate(() => window.open('about:blank'));
  await page.waitForTimeout(300);
  assert.equal(app.windows().length, 1);
});

test('preload API가 노출되고, 프로젝트를 열기 전에는 파일 요청을 거부한다', async () => {
  const shape = await page.evaluate(() => ({
    project: Object.keys(window.loreweave.project).sort(),
    chapters: Object.keys(window.loreweave.chapters).sort(),
    app: Object.keys(window.loreweave.app).sort(),
    ai: Object.keys(window.loreweave.ai).sort(),
  }));
  assert.deepEqual(shape, {
    project: ['choose', 'reopenLast'],
    chapters: ['create', 'list', 'onChangedOutside', 'read', 'reissueId', 'search', 'write'],
    app: ['onBeforeClose', 'replyClose'],
    // 키를 읽어 오는 함수는 없다
    ai: [
      'analysis',
      'analysisStatus',
      'analyze',
      'cancel',
      'check',
      'checkResult',
      'deleteKey',
      'dismiss',
      'estimate',
      'onProgress',
      'planCheck',
      'runCheck',
      'setConsent',
      'setKey',
      'setModel',
      'status',
    ],
  });
  const error = await page.evaluate(() => window.loreweave.chapters.list().then(() => null, (e: Error) => e.message));
  assert.match(error ?? '', /열린 프로젝트가 없습니다/);
});
