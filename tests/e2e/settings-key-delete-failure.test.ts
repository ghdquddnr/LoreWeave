// 환경설정에서 API 키 삭제가 파일 삭제 EIO로 실패했을 때 기존 키·저장됨 표시·삭제 가능 상태가 보존되고, 새 명시 [삭제]로만 지워지는지 본다.
// 실제 renderer [삭제] → 실제 ai:delete-key handler → 실제 deleteApiKey(실제 safeStorage). handler 결과 대역 없음: handler는 수신 횟수만 세고 원래 handler를 그대로 부른다.
// 실패 주입(합성): 앱 안에서 이 테스트의 독점 새 userData의 openai-key.bin 한 곳에 대한 fs/promises.rm만 EIO로 거부한다(대상 rm 시도·거절 횟수 계측). 실제 디스크/ACL 오류가 아니다.
// 키 값 검증은 main 안 boolean과 해시로만 한다 (값은 로그·renderer 반환에 없다). 명백한 가짜 키만, 프로젝트·AI 연결 확인·외부 요청 없음. 기존 비격리 settings-delete-focus/ai-settings는 실행하지 않았다.
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인. 합성 Electron 자동화이며 수동 GUI/IME가 아니다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow } from './launch.ts';

const KEY_A = 'sk-e2e-fake-key-AAAA';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type R = { fail: boolean; received: number; rmAttempts: number; rmFailed: number };

async function inject(app: ElectronApplication, keyFile: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const r: R = ((globalThis as unknown as { __r?: R }).__r = { fail: false, received: 0, rmAttempts: 0, rmFailed: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const rm = fsp.rm;
    (fsp as { rm: unknown }).rm = async (p: unknown, ...args: unknown[]) => {
      if (String(p) === file) {
        r.rmAttempts++;
        if (r.fail) {
          r.rmFailed++;
          throw Object.assign(new Error('합성 EIO (rm)'), { code: 'EIO' });
        }
      }
      return (rm as (...a: unknown[]) => Promise<void>)(p, ...args);
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('ai:delete-key')!;
    handlers.set('ai:delete-key', async (...args: unknown[]) => {
      r.received++;
      return original(...args);
    });
  }, keyFile);
}
const state = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { __r: R }).__r }));
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __r: R }).__r.fail = v), fail);
const decryptsTo = (app: ElectronApplication, keyFile: string, expected: string) =>
  app.evaluate(({ safeStorage }, a) => {
    const nodeFs = process.getBuiltinModule('fs');
    try {
      return safeStorage.decryptString(nodeFs.readFileSync(a.file)) === a.expected;
    } catch {
      return false;
    }
  }, { file: keyFile, expected });
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });

test('키 삭제가 파일 삭제 EIO로 실패하면 오류 안내만 보이고 기존 키·저장됨·삭제 버튼이 보존되며, 해제만으로는 재시도가 없고, 새로 [삭제]를 눌러야만 지워진다', { timeout: 120_000 }, async () => {
  const { app, page, userData } = await launchIsolated('keydelete');
  try {
    const keyFile = join(userData, 'openai-key.bin');
    const settingsFile = join(userData, 'settings.json');
    await page.evaluate((k) => window.loreweave.ai.setKey(k), KEY_A); // 실제 safeStorage로 A 저장
    await page.evaluate(() => window.loreweave.ai.setConsent(true)); // 키와 무관한 설정 (보존 확인용 합성값)
    const hashA = sha(await readFile(keyFile));
    const settingsBefore = await readFile(settingsFile);
    assert.equal(await decryptsTo(app, keyFile, KEY_A), true);
    await inject(app, keyFile);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    await dialog(page).getByText('저장됨', { exact: false }).waitFor();
    const del = dialog(page).getByRole('button', { name: '삭제', exact: true });
    assert.equal(await del.count(), 1, '삭제 버튼이 있다');
    await setFail(app, true);
    await del.click(); // 실제 [삭제] → 실제 ai:delete-key → deleteApiKey
    // 실패 처리 완료: 실패 안내(p.error)가 visible이고 사용자 요약이 비어 있지 않다 (기술 상세는 접혀 있다)
    const failure = dialog(page).locator('p.error[role="status"]');
    await failure.waitFor({ state: 'visible' });
    const summary = (await failure.locator('.error-note').first().innerText()).trim();
    assert.ok(summary.length > 0, '실패 안내의 사용자 요약이 비어 있지 않다');
    assert.equal(await failure.getByRole('button', { name: '기술 상세' }).count(), 1);
    assert.equal(await failure.locator('.tech-detail').count(), 0, '기술 상세는 접혀 있다');
    // 실패 완료 시점 스냅샷: 요청 1회·대상 rm 1회 시도·1회 거절
    const failed = await state(app);
    assert.deepEqual({ received: failed.received, attempts: failed.rmAttempts, rejected: failed.rmFailed }, { received: 1, attempts: 1, rejected: 1 });
    const text = await dialog(page).innerText();
    assert.ok(text.includes('저장됨'), '기존 저장됨 표시가 유지된다');
    assert.equal(await dialog(page).getByText('없음', { exact: true }).count(), 0, '키 없음으로 잘못 바뀌지 않았다');
    assert.equal(await del.isDisabled(), false, '삭제 버튼이 다시 눌린다');
    assert.equal(sha(await readFile(keyFile)), hashA, '암호문 Buffer가 그대로다');
    assert.equal(await decryptsTo(app, keyFile, KEY_A), true, '기존 키 A가 복호화된다');
    assert.deepEqual(await readFile(settingsFile), settingsBefore, '설정 파일이 그대로다');
    // 해제만으로는 재시도·추가 삭제가 없다 (실패 시점 스냅샷과 각각 비교)
    await setFail(app, false);
    assert.equal((await state(app)).received, failed.received, '해제 직후 수신 증가 0');
    assert.equal((await state(app)).rmAttempts, failed.rmAttempts, '해제 직후 rm 증가 0');
    await page.waitForTimeout(700);
    assert.equal((await state(app)).received, failed.received, '관찰 구간 뒤 자동 재시도 0');
    assert.equal((await state(app)).rmAttempts, failed.rmAttempts, '관찰 구간 뒤 rm 증가 0');
    assert.equal(existsSync(keyFile), true, '해제만으로 키 파일이 지워지지 않았다');
    // 새로 [삭제]를 눌러야만 지워진다
    await del.click();
    await dialog(page).getByText('없음', { exact: true }).waitFor();
    assert.equal((await state(app)).received, failed.received + 1, '새 명시 삭제로 수신이 한 번 늘었다');
    assert.ok((await state(app)).rmAttempts > failed.rmAttempts, '대상 rm이 늘었다');
    assert.equal(existsSync(keyFile), false, '키 파일이 지워졌다 (ENOENT)');
    assert.equal(await dialog(page).getByRole('button', { name: '삭제', exact: true }).count(), 0, '삭제 버튼이 사라졌다');
    assert.deepEqual(await readFile(settingsFile), settingsBefore, '다른 설정이 그대로다');
  } finally {
    await setFail(app, false).catch(() => undefined);
    await closeWindow(app);
  }
});
