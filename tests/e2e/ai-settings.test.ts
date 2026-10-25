// API 키 보안 (M3-PLAN 5절): 키는 암호화돼 저장되고, 디스크 어디에도 평문으로 없고, renderer로 돌아오지 않는다.

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeWindow, launch, tempDir } from './launch.ts';

const KEY = 'sk-loreweave-e2e-plaintext-check-1234567890';

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if ((await stat(path)).size < 20_000_000) out.push(path);
  }
  return out;
}

test('키 저장: 상태만 알 수 있고, 디스크에 평문이 없고, 모델 선택은 다시 켜도 남는다', async () => {
  const userData = await tempDir('ai-userdata');
  let { app, page } = await launch(userData);
  const before = await page.evaluate(() => window.loreweave.ai.status());
  assert.deepEqual({ ...before, models: before.models.map((m) => m.id) }, {
    hasKey: false,
    canEncrypt: true,
    model: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-6.1-sol'],
  });
  const after = await page.evaluate((key) => window.loreweave.ai.setKey(key), KEY);
  assert.equal(after.hasKey, true);
  assert.equal(JSON.stringify(after).includes(KEY), false);
  await page.evaluate(() => window.loreweave.ai.setModel('gpt-6.1-sol'));
  await closeWindow(app);

  for (const file of await filesUnder(userData)) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes(Buffer.from(KEY, 'utf8')), false, file);
    assert.equal(bytes.includes(Buffer.from(KEY, 'utf16le')), false, file);
  }

  ({ app, page } = await launch(userData));
  const reopened = await page.evaluate(() => window.loreweave.ai.status());
  assert.equal(reopened.hasKey, true);
  assert.equal(reopened.model, 'gpt-6.1-sol');
  const deleted = await page.evaluate(() => window.loreweave.ai.deleteKey());
  assert.equal(deleted.hasKey, false);
  const check = await page.evaluate(() => window.loreweave.ai.check());
  assert.deepEqual(check, { ok: false, message: 'API 키가 없습니다' });
  await closeWindow(app);
});
