// API 키를 교체 저장하는 도중 쓰기/바꿔치기가 실패해도 이전 암호화 키 파일이 보존되는지 본다.
// 실제 safeStorage(OS 암호화)와 실제 제품 함수 saveApiKey를 쓴다 (암호화 대역 아님). 키 값은 어디에도 출력하지 않고 해시·복호화 가능 여부·가짜 서버가 받은 Authorization으로만 비교한다 (명백한 가짜 키, localhost 가짜 서버).
// 실패 주입(합성): 앱 안에서 이 테스트의 독점 새 userData의 키 파일(openai-key.bin)과 그 임시 파일에 대한 fs/promises.writeFile을 감싸 "앞 절반만 실제로 쓰고 EIO", 또는 rename을 EIO로 거부한다. 제품 예외 처리를 우회하지 않고 제품 함수가 그 위를 지난다. 실제 디스크/권한 오류가 아니다.
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication } from 'playwright';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow } from './launch.ts';

const KEY_A = 'sk-e2e-fake-key-AAAA';
const KEY_B = 'sk-e2e-fake-key-BBBB';
let fake: FakeOpenAi;
before(async () => {
  fake = await startFakeOpenAi(() => ({}));
});
after(async () => {
  await fake.close();
});
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type I = { mode: 'none' | 'partial-write' | 'rename'; touched: string[] };
async function inject(app: ElectronApplication, keyFile: string) {
  await app.evaluate((_e, file) => {
    const i: I = ((globalThis as unknown as { __i?: I }).__i = { mode: 'none', touched: [] });
    const fsp = process.getBuiltinModule('fs/promises');
    const writeFile = fsp.writeFile;
    (fsp as { writeFile: unknown }).writeFile = async (p: unknown, data: unknown, ...args: unknown[]) => {
      const path = String(p);
      if (i.mode === 'partial-write' && (path === file || path.startsWith(`${file}.`))) {
        i.touched.push(path);
        const buf = Buffer.from(data as Uint8Array);
        await (writeFile as (...a: unknown[]) => Promise<void>)(p, buf.subarray(0, Math.max(1, buf.length >> 1)), ...args); // 실제로 앞 절반만 쓴다
        throw Object.assign(new Error('합성 EIO (부분 쓰기)'), { code: 'EIO' });
      }
      return (writeFile as (...a: unknown[]) => Promise<void>)(p, data, ...args);
    };
    const rename = fsp.rename;
    (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
      if (i.mode === 'rename' && String(to) === file) {
        i.touched.push(String(from));
        throw Object.assign(new Error('합성 EIO (rename)'), { code: 'EIO' });
      }
      return (rename as (...a: unknown[]) => Promise<void>)(from, to);
    };
  }, keyFile);
}
const setMode = (app: ElectronApplication, mode: I['mode']) => app.evaluate((_e, m) => void ((globalThis as unknown as { __i: I }).__i.mode = m), mode);
const touched = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __i: I }).__i.touched);

/** 지금 저장된 키가 무엇인지 값 없이 확인한다: 복호화 가능 여부(hasKey)와 연결 확인이 가짜 서버로 보낸 Authorization */
async function currentKey(app: ElectronApplication, page: import('playwright').Page): Promise<{ hasKey: boolean; bearer: string | undefined }> {
  const hasKey = (await page.evaluate(() => window.loreweave.ai.status())).hasKey;
  const before = fake.requests.length;
  const checked = await page.evaluate(() => window.loreweave.ai.check());
  assert.deepEqual(checked, { ok: true });
  return { hasKey, bearer: fake.requests.slice(before).at(-1)?.authorization };
}

for (const mode of ['partial-write', 'rename'] as const) {
  test(`키 교체 중 ${mode === 'partial-write' ? '부분 쓰기+EIO' : '바꿔치기(rename) EIO'}: 오류를 돌려주고 이전 암호문 Buffer가 그대로이며 이전 키가 복호화되고 임시 파일이 남지 않으며, 오류 해제 뒤 새 명시 저장만 B로 교체된다`, { timeout: 120_000 }, async () => {
    const { app, page, userData } = await launchIsolated('apikey-' + mode, { OPENAI_BASE_URL: fake.baseUrl });
    try {
      const keyFile = join(userData, 'openai-key.bin');
      await page.evaluate((k) => window.loreweave.ai.setKey(k), KEY_A);
      const hashA = sha(await readFile(keyFile));
      assert.equal(await readFile(keyFile).then((b) => b.includes(Buffer.from(KEY_A))), false, '키 A가 평문으로 저장되지 않았다');
      assert.deepEqual(await currentKey(app, page), { hasKey: true, bearer: `Bearer ${KEY_A}` });
      await inject(app, keyFile);
      await setMode(app, mode);
      const failed = await page.evaluate((k) => window.loreweave.ai.setKey(k).then(() => null, (e: Error) => e.message), KEY_B);
      assert.ok(failed, '교체 저장이 오류를 돌려준다');
      assert.ok(!failed.includes(KEY_B) && !failed.includes(KEY_A), '오류에 키 값이 없다');
      assert.ok((await touched(app)).length >= 1, '제품이 주입 지점(쓰기/바꿔치기)을 실제로 지났다');
      await setMode(app, 'none');
      assert.equal(sha(await readFile(keyFile)), hashA, '이전 암호문 Buffer가 그대로다');
      assert.deepEqual(await currentKey(app, page), { hasKey: true, bearer: `Bearer ${KEY_A}` }, '이전 키가 그대로 복호화돼 쓰인다');
      const names = await readdir(userData);
      assert.deepEqual(names.filter((n) => n.startsWith('openai-key') && n !== 'openai-key.bin'), [], `독점 임시 파일이 남지 않았다: ${names.join(',')}`);
      // 오류 해제 뒤 새 명시 저장만 B로 교체한다
      await page.evaluate((k) => window.loreweave.ai.setKey(k), KEY_B);
      assert.notEqual(sha(await readFile(keyFile)), hashA, '키 파일이 교체됐다');
      assert.deepEqual(await currentKey(app, page), { hasKey: true, bearer: `Bearer ${KEY_B}` });
      const after = await readFile(keyFile);
      assert.equal(after.includes(Buffer.from(KEY_B)) || after.includes(Buffer.from(KEY_A)), false, '키가 평문으로 저장되지 않았다');
      assert.deepEqual((await readdir(userData)).filter((n) => n.startsWith('openai-key') && n !== 'openai-key.bin'), []);
    } finally {
      await closeWindow(app);
    }
  });
}
