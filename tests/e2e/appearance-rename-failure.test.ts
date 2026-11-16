// 외관 UI 저장의 실제 settings.json 바꿔치기(rename) 실패 뒤, 화면에는 적용되고 디스크에는 아직 저장되지 않았음을 정확히 안내하며 [다시 저장]으로만 복구되는지 본다.
// 실제 renderer 원고 글자 크기 슬라이더 → 실제 appearance:update handler → updateSettings → replaceFile. handler 결과 대역 없음: handler는 수신 횟수만 세고 원래 handler를 그대로 부른다.
// 실패 주입(합성): 앱 안에서 이 테스트의 독점 새 userData의 settings.json을 대상으로 하는 fs/promises.rename만 EIO로 거부한다(대상 rename 시도·거절 횟수 계측). 실제 디스크/ACL 오류가 아니다.
// 프로젝트·원고·키·AI 요청 없음. 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인. 합성 Electron 자동화이며 수동 GUI/IME가 아니다. 기존 비격리 appearance 검사는 실행하지 않았다.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow } from './launch.ts';

type R = { fail: boolean; received: number; renameAttempts: number; renameFailed: number };

async function inject(app: ElectronApplication, settingsFile: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const r: R = ((globalThis as unknown as { __r?: R }).__r = { fail: false, received: 0, renameAttempts: 0, renameFailed: 0 });
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
    const original = handlers.get('appearance:update')!;
    handlers.set('appearance:update', async (...args: unknown[]) => {
      r.received++;
      return original(...args);
    });
  }, settingsFile);
}
const state = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { __r: R }).__r }));
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __r: R }).__r.fail = v), fail);
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });
const cssSize = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--lw-ms-size'));
const disk = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { aiModel: string; aiSendConsent: boolean; lastProject: string | null; appearance: Record<string, unknown> };

test('외관 저장의 rename EIO 뒤 화면에는 적용되고 파일은 불변이며 아직 저장되지 않았음을 안내하고, 해제만으로는 재시도가 없고, [다시 저장]으로만 저장된다', { timeout: 120_000 }, async () => {
  const { app, page, userData } = await launchIsolated('apprename');
  try {
    const settingsFile = join(userData, 'settings.json');
    await page.evaluate(() => window.loreweave.ai.setModel('gpt-6.1-sol')); // 합성 비외관 설정 (모델·동의)
    await page.evaluate(() => window.loreweave.ai.setConsent(true));
    await inject(app, settingsFile);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    const slider = dialog(page).getByRole('slider', { name: '원고 글자 크기' });
    await slider.waitFor();
    const baseSize = Number(await slider.inputValue());
    const newSize = baseSize + 3;
    const baseline = await readFile(settingsFile); // 초기화가 끝난 기준 파일
    const before = await disk(settingsFile);
    assert.equal(before.aiModel, 'gpt-6.1-sol');
    assert.equal(before.aiSendConsent, true);
    await setFail(app, true);
    await slider.fill(String(newSize)); // 실제 UI 조작 → 실제 appearance:update → updateSettings → replaceFile
    // 실패 완료: 외관 저장 실패 alert가 visible이고 요약이 비어 있으며 '아직 저장되지 않았음' 안내와 [다시 저장]이 있다. 기술 상세는 접혀 있다
    const alert = dialog(page).locator('p.error[role="alert"]');
    await alert.waitFor({ state: 'visible' });
    const text = (await alert.innerText()).trim();
    assert.ok(text.length > 0 && text.includes('외관 설정을 저장하지 못했습니다'), `사용자 요약: ${text}`);
    assert.ok(text.includes('아직 저장되지 않았습니다'), `아직 저장되지 않았음 안내: ${text}`);
    assert.equal(await alert.getByRole('button', { name: '다시 저장', exact: true }).count(), 1);
    assert.equal(await alert.getByRole('button', { name: '기술 상세' }).count(), 1);
    assert.equal(await alert.locator('.tech-detail').count(), 0, '기술 상세는 접혀 있다');
    // 화면에는 적용돼 있다
    assert.equal(await cssSize(page), `${newSize}px`, '선택한 크기가 화면에 적용돼 있다');
    assert.equal(await slider.inputValue(), String(newSize));
    // 실패 완료 시점 스냅샷: 수신 1·대상 rename 시도 1·거절 1, 파일은 불변
    const failed = await state(app);
    assert.deepEqual({ received: failed.received, attempts: failed.renameAttempts, rejected: failed.renameFailed }, { received: 1, attempts: 1, rejected: 1 });
    assert.deepEqual(await readFile(settingsFile), baseline, 'settings.json Buffer가 그대로다');
    // 해제만으로는 재시도가 없다 (실패 시점 스냅샷과 각각 비교)
    await setFail(app, false);
    assert.equal((await state(app)).received, failed.received, '해제 직후 수신 증가 0');
    assert.equal((await state(app)).renameAttempts, failed.renameAttempts, '해제 직후 rename 증가 0');
    await page.waitForTimeout(700);
    assert.equal((await state(app)).received, failed.received, '관찰 구간 뒤 자동 재시도 0');
    assert.equal((await state(app)).renameAttempts, failed.renameAttempts, '관찰 구간 뒤 rename 증가 0');
    assert.deepEqual(await readFile(settingsFile), baseline, '해제만으로 파일이 바뀌지 않았다');
    assert.equal(await alert.count(), 1, '안내가 그대로다');
    // 새 명시 [다시 저장]만 실제 handler → updateSettings를 통과해 저장한다
    await alert.getByRole('button', { name: '다시 저장', exact: true }).click();
    await alert.waitFor({ state: 'detached' });
    assert.equal((await state(app)).received, failed.received + 1, '[다시 저장]으로 수신이 한 번 늘었다');
    assert.ok((await state(app)).renameAttempts > failed.renameAttempts, '대상 rename이 늘었다');
    const after = await disk(settingsFile);
    assert.equal(after.appearance['manuscriptSize'], newSize, '선택한 크기가 파일에 저장됐다');
    assert.deepEqual({ ...after.appearance, manuscriptSize: null }, { ...before.appearance, manuscriptSize: null }, '다른 외관 필드가 보존된다');
    assert.equal(after.aiModel, 'gpt-6.1-sol');
    assert.equal(after.aiSendConsent, true);
    assert.equal(after.lastProject, before.lastProject);
    assert.equal(await cssSize(page), `${newSize}px`, '화면 값이 되돌려지지 않았다');
    assert.equal(await slider.inputValue(), String(newSize));
  } finally {
    await setFail(app, false).catch(() => undefined);
    await closeWindow(app);
  }
});
