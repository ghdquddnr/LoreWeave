// 환경설정 최초 AI 상태 조회에서 저장된 API 키 파일(openai-key.bin)의 일시적 읽기 I/O 실패가 정상 '키 없음'으로 표시되지 않고, 읽기 실패 안내와 명시적 다시 시도로 이어지는지 본다.
// 실제 renderer(SettingsDialog) → 실제 ai:status handler → 제품 함수. 실제 safeStorage로 명백한 가짜 키 A를 저장한다(암호화 대역 아님). handler 대역 없음.
// 실패 주입(합성): 앱 안에서 이 테스트의 독점 새 userData의 키 파일 하나에 대한 fs/promises.readFile만 EIO로 거부한다(읽기 횟수 계측). 실제 디스크/ACL 오류가 아니다.
// 키 값 검증은 main 안 boolean과 해시로만 한다. 프로젝트·AI 연결·외부 요청 없음. 격리: tests/e2e/isolated-launch.ts(main 전 격리 시작 파일): 매 실행 독점 새 빈 userData·증거 확인. 합성 Electron 자동화이며 수동 GUI/IME가 아니다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow } from './launch.ts';

const KEY_A = 'sk-e2e-fake-key-AAAA';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type F = { fail: boolean; reads: number; failed: number };

async function patchRead(app: ElectronApplication, keyFile: string) {
  await app.evaluate((_e, file) => {
    const f: F = ((globalThis as unknown as { __f?: F }).__f = { fail: false, reads: 0, failed: 0 });
    const fsp = process.getBuiltinModule('fs/promises');
    const original = fsp.readFile;
    (fsp as { readFile: unknown }).readFile = async (p: unknown, ...args: unknown[]) => {
      if (String(p) === file) {
        f.reads++;
        if (f.fail) {
          f.failed++;
          throw Object.assign(new Error('합성 EIO'), { code: 'EIO' });
        }
      }
      return (original as (...a: unknown[]) => unknown)(p, ...args);
    };
  }, keyFile);
}
const fs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __f: F }).__f);
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __f: F }).__f.fail = v), fail);
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

test('저장된 키 파일 읽기가 EIO로 실패하면 환경설정이 키 없음으로 보이지 않고 읽기 실패 안내·다시 시도만 보이며, 해제만으로는 재시도가 없고, 명시적 다시 시도 뒤에야 기존 키 A가 저장됨으로 복구된다', { timeout: 120_000 }, async () => {
  const { app, page, userData } = await launchIsolated('keyread');
  try {
    const keyFile = join(userData, 'openai-key.bin');
    await page.evaluate((k) => window.loreweave.ai.setKey(k), KEY_A);
    const hashA = sha(await readFile(keyFile));
    assert.equal(await decryptsTo(app, keyFile, KEY_A), true);
    await patchRead(app, keyFile);
    await setFail(app, true);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    // 읽기 실패 안내: 정확한 요소가 visible이고 요약이 비어 있지 않으며 기술 상세는 접혀 있다
    const note = dialog(page).locator('p.error[role="alert"] .error-note');
    await dialog(page).getByRole('heading', { name: 'OpenAI API 키' }).or(note).first().waitFor(); // 상태 조회가 끝난 첫 화면 (키 영역 또는 읽기 실패 안내)
    const lines = (await dialog(page).innerText()).split(String.fromCharCode(10));
    const shown = lines.filter((l) => /없음|저장됨|API 키/.test(l));
    assert.equal(await note.count(), 1, `읽기 실패 안내가 보인다. 실제 표시: ${JSON.stringify(shown)}`);
    await note.waitFor({ state: 'visible' });
    const summary = (await note.innerText()).trim();
    assert.match(summary, /AI 설정.*읽지 못했습니다/, summary);
    assert.equal(await dialog(page).getByRole('button', { name: '기술 상세' }).count(), 1);
    assert.equal(await dialog(page).locator('.tech-detail').count(), 0, '기술 상세는 접혀 있다');
    // 키 없음/저장됨으로 오해하지 않고, 키 관련 조작은 보이지 않는다
    assert.equal(await dialog(page).getByText('없음', { exact: true }).count(), 0, '키 없음으로 보이지 않는다');
    assert.equal(await dialog(page).getByText('저장됨', { exact: false }).count(), 0, '저장됨으로도 보이지 않는다');
    assert.equal(await dialog(page).getByLabel('API 키').count(), 0, '키 입력창이 없다');
    assert.equal(await dialog(page).getByRole('button', { name: '삭제', exact: true }).count(), 0, '키 삭제 조작이 없다');
    const failed = await fs(app);
    assert.ok(failed.failed >= 1, `키 파일 읽기에 합성 EIO가 주입됐다: ${JSON.stringify(failed)}`);
    // 해제만으로는 재시도가 없다
    await setFail(app, false);
    await page.waitForTimeout(700);
    assert.equal((await fs(app)).reads, failed.reads, '해제 뒤 자동 재시도(읽기) 0');
    assert.equal(sha(await readFile(keyFile)), hashA, '키 파일 해시 불변');
    assert.equal(await decryptsTo(app, keyFile, KEY_A), true, '기존 키 A가 복호화된다');
    assert.equal(await dialog(page).getByText('저장됨', { exact: false }).count(), 0, '해제만으로 상태가 바뀌지 않는다');
    // 명시적 다시 시도 뒤에만 기존 A가 저장됨으로 복구된다
    await note.getByRole('button', { name: '다시 시도' }).click();
    await dialog(page).getByText('저장됨', { exact: false }).waitFor();
    assert.ok((await fs(app)).reads > failed.reads, '다시 시도가 키 파일을 다시 읽었다');
    assert.equal(await dialog(page).locator('.error-note').count(), 0);
    assert.equal(sha(await readFile(keyFile)), hashA, '복구 뒤에도 키 파일 해시 불변');
  } finally {
    await setFail(app, false).catch(() => undefined);
    await closeWindow(app);
  }
});

test('대조: 키 파일이 처음부터 없으면(ENOENT) 환경설정은 오류 없이 키 없음으로 보인다', { timeout: 120_000 }, async () => {
  const { app, page } = await launchIsolated('keyread-enoent');
  try {
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    await dialog(page).getByText('없음', { exact: true }).waitFor();
    assert.equal(await dialog(page).locator('.error-note').count(), 0, '오류 안내가 없다');
    assert.equal(await dialog(page).getByLabel('API 키').count(), 1, '키 입력창이 있다');
  } finally {
    await closeWindow(app);
  }
});
