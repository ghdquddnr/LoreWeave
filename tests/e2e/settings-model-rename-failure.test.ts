// 환경설정에서 모델을 바꾸다 settings.json 바꿔치기(rename)가 실패해도 기존 모델·설정 파일·UI 표시가 보존되고, 새 명시 선택으로만 저장되는지 본다.
// 실제 renderer select → 실제 ai:set-model handler → updateSettings → replaceFile. handler 결과 대역 없음: handler는 수신 횟수만 세고 원래 handler를 그대로 부른다.
// 실패 주입(합성): 앱 안에서 이 테스트의 독점 새 userData의 settings.json 한 곳을 대상으로 하는 fs/promises.rename만 EIO로 거부한다(대상 rename 시도·실패 횟수 계측). 실제 디스크/ACL 오류가 아니다. EIO는 replaceFile의 내부 재시도 대상(EPERM/EBUSY/EACCES)이 아니라 한 번의 시도로 끝난다.
// 키·프로젝트·AI 요청 없음. 모델 선택은 합성 격리 제품 설정일 뿐이다. 격리: tests/e2e/isolated-launch.ts(main 전 격리 시작 파일): 매 실행 독점 새 빈 userData·증거 확인. 합성 Electron 자동화이며 수동 GUI/IME가 아니다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow } from './launch.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type R = { fail: boolean; renameAttempts: number; renameFailed: number; received: number };

async function inject(app: ElectronApplication, settingsFile: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const r: R = ((globalThis as unknown as { __r?: R }).__r = { fail: false, renameAttempts: 0, renameFailed: 0, received: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const rename = fsp.rename;
    (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
      if (String(to) === file) {
        r.renameAttempts++;
        if (r.fail) {
          r.renameFailed++;
          throw Object.assign(new Error('합성 EIO (rename)'), { code: 'EIO' });
        }
      }
      return (rename as (...a: unknown[]) => Promise<void>)(from, to);
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('ai:set-model')!;
    handlers.set('ai:set-model', async (...args: unknown[]) => {
      r.received++;
      return original(...args);
    });
  }, settingsFile);
}
const state = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { __r: R }).__r }));
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __r: R }).__r.fail = v), fail);
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const modelOnDisk = async (file: string) => (JSON.parse(await readFile(file, 'utf8')) as { aiModel: string }).aiModel;

test('모델 변경 중 settings.json 바꿔치기(rename)가 EIO로 실패하면 오류 안내만 보이고 기존 모델·설정 파일 Buffer가 보존되며, 해제만으로는 재시도가 없고, 새로 B를 명시 선택해야만 저장된다', { timeout: 120_000 }, async () => {
  const { app, page, userData } = await launchIsolated('modelrename');
  try {
    const settingsFile = join(userData, 'settings.json');
    const models = (await page.evaluate(() => window.loreweave.ai.status())).models.map((m) => m.id);
    const A = 'gpt-6.1-sol';
    const B = 'gpt-6-luna';
    assert.ok(models.includes(A) && models.includes(B), `승인 목록에 두 모델이 있다: ${models.join(',')}`);
    await page.evaluate((m) => window.loreweave.ai.setModel(m), A); // 실제 제품 API로 기존 모델 A 저장
    await page.evaluate(() => window.loreweave.ai.setConsent(true)); // 모델과 무관한 설정 (보존 확인용 합성값)
    const bufferA = await readFile(settingsFile);
    assert.equal(await modelOnDisk(settingsFile), A);
    assert.equal(JSON.parse(bufferA.toString('utf8')).aiSendConsent, true);
    await inject(app, settingsFile);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    const select = dialog(page).getByRole('combobox', { name: '모델' });
    await select.waitFor();
    assert.equal(await select.inputValue(), A, '환경설정이 기존 모델 A를 보인다');
    await setFail(app, true);
    await select.selectOption(B); // 실제 select 조작 → 실제 ai:set-model → updateSettings → replaceFile
    // 실패 처리 완료: 실패 안내(p.error)가 visible이고 사용자 요약이 비어 있지 않다 (기술 상세는 접혀 있다)
    const failure = dialog(page).locator('p.error[role="status"]');
    await failure.waitFor({ state: 'visible' });
    const summary = (await failure.locator('.error-note').first().innerText()).trim();
    assert.ok(summary.length > 0, '실패 안내의 사용자 요약이 비어 있지 않다');
    assert.equal(await failure.getByRole('button', { name: '기술 상세' }).count(), 1);
    assert.equal(await failure.locator('.tech-detail').count(), 0, '기술 상세는 접혀 있다');
    assert.equal(await dialog(page).locator('p.notice[role="status"]').count(), 0, '성공 표시가 없다');
    // 실패 완료 시점 스냅샷: 요청 1회·대상 rename 1회 시도·1회 실패
    const failed = await state(app);
    assert.deepEqual({ received: failed.received, attempts: failed.renameAttempts, failed: failed.renameFailed }, { received: 1, attempts: 1, failed: 1 });
    assert.equal(await select.isDisabled(), false, 'select가 다시 선택 가능하다');
    assert.equal(await select.inputValue(), A, 'UI가 기존 모델 A를 유지한다');
    assert.deepEqual(await readFile(settingsFile), bufferA, 'settings.json Buffer가 그대로다 (비모델 설정 포함)');
    assert.equal(await modelOnDisk(settingsFile), A);
    const leftovers = (await readdir(userData)).filter((n) => n.startsWith('settings.json') && n !== 'settings.json');
    console.log(`관측: 실패 뒤 settings.json 임시 파일 잔류 = ${JSON.stringify(leftovers)} (이번 과제에서 정리 정책은 바꾸지 않음)`);
    // 해제만으로는 재전송·rename이 없다 (실패 시점 스냅샷과 각각 비교)
    await setFail(app, false);
    assert.equal((await state(app)).received, failed.received, '해제 직후 수신 증가 0');
    assert.equal((await state(app)).renameAttempts, failed.renameAttempts, '해제 직후 rename 증가 0');
    await page.waitForTimeout(700);
    assert.equal((await state(app)).received, failed.received, '관찰 구간 뒤 자동 재전송 0');
    assert.equal((await state(app)).renameAttempts, failed.renameAttempts, '관찰 구간 뒤 rename 증가 0');
    assert.deepEqual(await readFile(settingsFile), bufferA, '해제만으로 파일이 바뀌지 않았다');
    assert.equal(await select.inputValue(), A);
    // 새로 B를 명시 선택해야만 저장된다
    await select.selectOption(B);
    for (let n = 0; n < 200 && (await modelOnDisk(settingsFile)) !== B; n++) await page.waitForTimeout(25);
    assert.equal((await state(app)).received, failed.received + 1, '새 명시 선택으로 수신이 한 번 늘었다');
    assert.ok((await state(app)).renameAttempts > failed.renameAttempts, '대상 rename이 늘었다');
    assert.equal(await modelOnDisk(settingsFile), B, '실제 파일이 B다');
    assert.equal(await select.inputValue(), B, 'UI가 B로 일치한다');
    assert.equal(JSON.parse((await readFile(settingsFile)).toString('utf8')).aiSendConsent, true, '다른 설정이 보존된다');
  } finally {
    await setFail(app, false).catch(() => undefined);
    await closeWindow(app);
  }
});
