// 환경설정 UI에서 기존 키 A를 키 B로 교체 저장하다 실제 파일 쓰기 실패가 돌아왔을 때, 기존 키·저장됨 표시·입력 초안이 보존되고 새 명시 [저장]으로만 교체되는지 본다.
// 실제 renderer → 실제 ai:set-key handler → 실제 saveApiKey(실제 safeStorage). handler 결과 대역 없음: handler는 수신 횟수만 세고 원래 handler를 그대로 부른다.
// 실패 주입(합성): 앱 안에서 이 테스트의 독점 새 userData의 키 파일(및 임시 파일)에 대한 fs/promises.writeFile만 "앞 절반을 실제로 쓰고 EIO"로 감싼다. 실제 디스크/권한 오류가 아니다.
// 키 값 검증은 main 안의 boolean(복호화 결과가 가짜 키와 같은가)과 해시로만 한다. 명백한 가짜 키만, 프로젝트·AI 연결 확인·외부 요청 없음. 기본 진입(`launch(tempDir)`)을 쓰는 기존 settings-key-draft/save-focus는 실행하지 않았다.
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인. 합성 Electron 자동화이며 수동 GUI/IME가 아니다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow } from './launch.ts';

const KEY_A = 'sk-e2e-fake-key-AAAA';
const KEY_B = 'sk-e2e-fake-key-BBBB';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type I = { fail: boolean; writes: number; received: number };
async function inject(app: ElectronApplication, keyFile: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const i: I = ((globalThis as unknown as { __i?: I }).__i = { fail: false, writes: 0, received: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const writeFile = fsp.writeFile;
    (fsp as { writeFile: unknown }).writeFile = async (p: unknown, data: unknown, ...args: unknown[]) => {
      const path = String(p);
      if (path === file || path.startsWith(`${file}.`)) {
        i.writes++;
        if (i.fail) {
          const buf = Buffer.from(data as Uint8Array);
          await (writeFile as (...a: unknown[]) => Promise<void>)(p, buf.subarray(0, Math.max(1, buf.length >> 1)), ...args); // 실제로 앞 절반만 쓴다
          throw Object.assign(new Error('합성 EIO (부분 쓰기)'), { code: 'EIO' });
        }
      }
      return (writeFile as (...a: unknown[]) => Promise<void>)(p, data, ...args);
    };
    // 실제 handler를 그대로 부르고 수신 횟수만 센다
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('ai:set-key')!;
    handlers.set('ai:set-key', async (...args: unknown[]) => {
      i.received++;
      return original(...args);
    });
  }, keyFile);
}
const state = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __i: I }).__i);
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __i: I }).__i.fail = v), fail);
/** 키 파일을 지금 복호화한 값이 expected와 같은가: main 안에서 boolean만 돌려준다 (키 값은 밖으로 나오지 않는다) */
const decryptsTo = (app: ElectronApplication, keyFile: string, expected: string) =>
  app.evaluate(({ safeStorage }, a) => {
    const fs = process.getBuiltinModule('fs');
    try {
      return safeStorage.decryptString(fs.readFileSync(a.file)) === a.expected;
    } catch {
      return false;
    }
  }, { file: keyFile, expected });
async function until(what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(await ok(), true, what);
}
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });

test('UI에서 키 교체 저장이 실제 파일 쓰기 실패로 끝나도 기존 키·저장됨 표시·B 초안이 보존되고, 오류 해제만으로는 쓰기가 없으며, 새로 [저장]을 눌러야 B로 교체된다', { timeout: 120_000 }, async () => {
  const { app, page, userData } = await launchIsolated('keyui');
  try {
    const keyFile = join(userData, 'openai-key.bin');
    await page.evaluate((k) => window.loreweave.ai.setKey(k), KEY_A); // 실제 safeStorage로 A 저장 준비
    const hashA = sha(await readFile(keyFile));
    assert.equal(await decryptsTo(app, keyFile, KEY_A), true);
    await inject(app, keyFile);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    await dialog(page).getByText('저장됨', { exact: false }).waitFor();
    const input = dialog(page).getByLabel('API 키');
    await input.fill(KEY_B);
    await setFail(app, true);
    const save = dialog(page).getByRole('button', { name: '저장', exact: true });
    await save.click();
    await until('교체 저장이 handler에 수신되고 제품이 쓰기 경계를 지나지 않았다', async () => (await state(app)).received === 1 && (await state(app)).writes >= 1);
    await until('실패 안내가 보이지 않았다', async () => (await dialog(page).locator('.error-note').count()) > 0 || (await dialog(page).getByText(/저장|실패|오류/).count()) > 0);
    await page.waitForTimeout(500);
    const text = await dialog(page).innerText();
    assert.ok(!text.includes(KEY_A) && !text.includes(KEY_B), '화면 글에 키 값이 없다');
    assert.equal(text.includes('키를 저장했습니다'), false, '성공 문구가 없다');
    assert.ok(text.includes('저장됨'), '기존 저장됨 표시가 유지된다');
    assert.equal(await input.inputValue(), KEY_B, '입력 초안 B가 보존된다');
    assert.equal(await save.isDisabled(), false, '[저장]이 다시 눌린다');
    assert.equal(sha(await readFile(keyFile)), hashA, '기존 암호문 해시가 그대로다');
    assert.equal(await decryptsTo(app, keyFile, KEY_A), true, '기존 키 A가 복호화된다');
    assert.equal((await page.evaluate(() => window.loreweave.ai.status())).hasKey, true);
    assert.deepEqual((await readdir(userData)).filter((n) => n.startsWith('openai-key') && n !== 'openai-key.bin'), [], '독점 임시 파일이 남지 않았다');
    // 오류 해제만으로는 쓰기·재전송이 없다
    await setFail(app, false);
    await page.waitForTimeout(700);
    assert.deepEqual({ received: (await state(app)).received, writes: (await state(app)).writes }, { received: 1, writes: (await state(app)).writes }, '자동 재전송·중복 저장이 없다');
    const writesAfterFail = (await state(app)).writes;
    assert.equal(sha(await readFile(keyFile)), hashA, '해제만으로 키 파일이 바뀌지 않았다');
    assert.equal(await input.inputValue(), KEY_B);
    // 사용자가 새로 [저장]을 눌러야 B로 교체된다
    await save.click();
    await dialog(page).getByText('키를 저장했습니다').waitFor();
    assert.equal((await state(app)).received, 2);
    assert.ok((await state(app)).writes > writesAfterFail);
    assert.equal(await decryptsTo(app, keyFile, KEY_B), true, 'B로 교체되어 복호화된다');
    assert.notEqual(sha(await readFile(keyFile)), hashA);
    assert.equal(await input.inputValue(), '', '같은 제출 초안이 비워진다');
    assert.equal((await readFile(keyFile)).includes(Buffer.from(KEY_B)), false, '키가 평문으로 저장되지 않았다');
    assert.deepEqual((await readdir(userData)).filter((n) => n.startsWith('openai-key') && n !== 'openai-key.bin'), []);
  } finally {
    await setFail(app, false).catch(() => undefined);
    await closeWindow(app);
  }
});
