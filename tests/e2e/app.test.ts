// 빌드한 앱을 실제로 띄워 창과 보안 기본값을 확인한다. 실행: pnpm test:e2e

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright';

let app: ElectronApplication;
let page: Page;

before(async () => {
  app = await _electron.launch({ executablePath: electronPath as unknown as string, args: ['.'] });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

after(async () => {
  await app?.close();
});

test('창이 열리고 첫 화면이 그려진다', async () => {
  assert.equal(await page.title(), 'LoreWeave');
  await page.getByRole('heading', { name: 'LoreWeave' }).waitFor();
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
