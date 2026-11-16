// 환경설정의 최초 AI 조회에서 settings.json의 일시적 읽기 I/O 실패가 정상 기본 모델로 표시되지 않고, 읽기 실패 안내와 명시적 다시 시도로 이어지는지 본다.
// 실패 주입: 앱 안에서 이 테스트의 독점 새 userData의 settings.json 하나에 대한 fs/promises.readFile만 합성 EIO로 거부한다(읽기 횟수 계측). 원래 ai:status handler와 제품 읽기 함수를 그대로 통과한다 (handler 전체 reject 대역이 아니다).
// 실제 디스크/ACL 오류가 아니다. 가짜 키·연결 없음, 프로젝트 없음 첫 화면. 격리: hooks/main-isolated-userdata-entry.cjs가 제품 main 전에 독점 새 userData를 강제하고 증거를 남긴다 (start가 확인한다).

import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, tempDir } from './launch.ts';

const ENTRY = join(__dirname, 'hooks', 'main-isolated-userdata-entry.cjs');
type F = { fail: boolean; reads: number; failed: number };

async function start() {
  const userData = await tempDir('ssio-userdata');
  const { app, page } = await launch(userData, { LW_TEST_USERDATA: userData }, ENTRY);
  const evidence = JSON.parse(await readFile(join(userData, '.isolated-entry-evidence.json'), 'utf8')) as { stage: string; userData: string; entriesBefore: string[] };
  assert.equal(evidence.stage, 'before-product-main');
  assert.deepEqual(evidence.entriesBefore, []);
  assert.equal(evidence.userData, await app.evaluate(({ app: a }) => a.getPath('userData')));
  assert.equal((await realpath(userData)).toLowerCase(), evidence.userData.toLowerCase());
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
  return { app, page, settingsFile: join(evidence.userData, 'settings.json') };
}
async function patchRead(app: ElectronApplication, settingsFile: string) {
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
  }, settingsFile);
}
const fs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __f: F }).__f);
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __f: F }).__f.fail = v), fail);
const dialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });

test('환경설정 최초 AI 조회에서 settings.json 읽기가 실패하면 기본 모델을 정상처럼 보이지 않고 읽기 실패 안내·다시 시도를 보이며, 해제 뒤 명시적 다시 시도만 실제 저장된 모델을 보인다', { timeout: 120_000 }, async () => {
  const { app, page, settingsFile } = await start();
  try {
    const status0 = await page.evaluate(() => window.loreweave.ai.status());
    const [DEFAULT, SOL] = status0.models.map((m) => m.id);
    assert.ok(DEFAULT && SOL && DEFAULT !== SOL);
    await page.evaluate((m) => window.loreweave.ai.setModel(m), SOL); // 비기본 모델을 실제로 저장한다
    await page.evaluate(() => window.loreweave.ai.setConsent(true));
    const bytesBefore = await readFile(settingsFile);
    assert.match(bytesBefore.toString('utf8'), new RegExp(String(SOL)));
    await patchRead(app, settingsFile);
    await setFail(app, true);
    await page.getByRole('button', { name: '환경설정', exact: true }).click();
    await dialog(page).waitFor();
    await page.waitForTimeout(800);
    const shown = {
      reads: (await fs(app)).failed,
      model: (await dialog(page).getByRole('combobox', { name: '모델' }).count()) ? await dialog(page).getByRole('combobox', { name: '모델' }).inputValue() : null,
      note: await dialog(page).locator('.error-note').count(),
    };
    assert.ok(shown.reads >= 1, `ai:status가 settings.json 읽기를 시도했고 합성 EIO가 주입됐다: ${JSON.stringify(shown)}`);
    assert.equal(shown.model, null, `기본 모델을 정상처럼 표시하지 않는다: ${JSON.stringify(shown)}`);
    assert.equal(shown.note, 1, `읽기 실패 안내가 있다: ${JSON.stringify(shown)}`);
    assert.match(await dialog(page).locator('.error-note').innerText(), /AI 설정.*읽지 못했습니다/);
    // 자동 재시도 없음: 읽기 수가 늘지 않는다
    const readsHeld = (await fs(app)).reads;
    await page.waitForTimeout(500);
    assert.equal((await fs(app)).reads, readsHeld, '해제 전 자동 재시도가 없다');
    assert.deepEqual(await readFile(settingsFile), bytesBefore, 'settings.json Buffer가 그대로다');
    assert.ok((await dialog(page).getByText(/테마/).count()) > 0, '외관 설정은 그대로 쓸 수 있다');
    // 해제 뒤 명시적 다시 시도만 실제 저장된 모델을 보인다
    await setFail(app, false);
    await dialog(page).locator('.error-note').getByRole('button', { name: '다시 시도' }).click();
    await dialog(page).getByRole('combobox', { name: '모델' }).waitFor();
    assert.equal(await dialog(page).getByRole('combobox', { name: '모델' }).inputValue(), SOL, '실제 저장된 비기본 모델이 보인다');
    assert.deepEqual(await readFile(settingsFile), bytesBefore, '복구 뒤에도 settings.json Buffer가 그대로다');
  } finally {
    await setFail(app, false).catch(() => {});
    await closeWindow(app);
  }
});
