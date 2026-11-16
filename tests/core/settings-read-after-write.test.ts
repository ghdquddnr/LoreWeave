// 설정 저장이 진행 중일 때 readSettings/readSettingsStrict가 같은 폴더의 쓰기를 앞지르지 않고(오래된 모델/동의를 반환하지 않고), 저장이 실패한 뒤에도 읽기가 정상 복구되는지 본다.
// 환경 기법(합성): 독점 새 임시 폴더의 settings.json을 대상으로 하는 fs/promises.rename을 첫 진입에서 장벽으로 멈추고(진입은 promise로 확인), readFile은 이 파일에 한해 호출 수만 센다. 다른 경로는 통과한다. 실제 제품 함수·실제 합성 파일, 결과 대역 없음.
// 시나리오마다 정확 대상만 감싸고 finally에서 장벽 해제·원함수 복구한다. node:test가 파일마다 별도 프로세스로 실행하고 각 테스트에 timeout이 있다. 실제 ACL/백신 동작이 아니다.
// 한계: "장벽 중 읽기가 앞지르지 않음"은 장벽 중 setImmediate 몇 번 양보한 뒤 readFile 호출 수·완료 플래그가 그대로임을 보는 것이며, 임의 시간 대기가 아니라 쓰기가 큐 선두에 있는 상태의 관측이다.

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_APPEARANCE } from '../../src/core/appearance.ts';
import { readSettings, readSettingsStrict, settingsPath, updateSettings } from '../../src/main/settings.ts';

const fsp = process.getBuiltinModule('fs/promises');
const dir = () => mkdtemp(join(tmpdir(), 'loreweave-settings-raw-'));
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Hook = { reads: number; entered: Promise<void>; release: () => void; restore: () => void };
/** 이 settings.json: rename 첫 진입에서 release()까지 멈춘 뒤 failCode가 있으면 그 오류로 거부하고 없으면 실제 rename. readFile은 이 파일에 한해 호출 수를 센다 */
function hook(target: string, failCode: string | null): Hook {
  const originalRename = fsp.rename;
  const originalRead = fsp.readFile;
  let resolveEntered!: () => void;
  const entered = new Promise<void>((r) => (resolveEntered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h: Hook = {
    reads: 0,
    entered,
    release,
    restore: () => {
      (fsp as { rename: unknown }).rename = originalRename;
      (fsp as { readFile: unknown }).readFile = originalRead;
    },
  };
  (fsp as { readFile: unknown }).readFile = async (p: unknown, ...args: unknown[]) => {
    if (String(p) === target) h.reads++;
    return (originalRead as (...a: unknown[]) => Promise<unknown>)(p, ...args);
  };
  (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to) !== target) return (originalRename as (...a: unknown[]) => Promise<void>)(from, to);
    resolveEntered();
    await gate;
    if (failCode) throw Object.assign(new Error(`합성 ${failCode}`), { code: failCode });
    return (originalRename as (...a: unknown[]) => Promise<void>)(from, to);
  };
  return h;
}

async function seed(d: string) {
  await updateSettings(d, { lastProject: '합성/처음', aiModel: 'gpt-6.1-sol', aiSendConsent: true });
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'lamplight', followSystem: false, manuscriptSize: 20 } }));
}
const kept = { lastProject: '합성/처음', theme: 'lamplight', size: 20 };

test('저장 진행 중 읽기: 쓰기가 rename 장벽에 있는 동안 readSettings·readSettingsStrict는 앞지르지 않고, 해제 뒤 둘 다 새 모델/동의와 보존값을 반환한다', { timeout: 30_000 }, async () => {
  const d = await dir();
  await seed(d);
  const h = hook(settingsPath(d), null);
  try {
    const write = updateSettings(d, { aiModel: 'gpt-6-luna', aiSendConsent: false });
    await h.entered; // 쓰기가 대상 rename에 진입했다 (이 시점에 쓰기의 읽기는 끝났다)
    const readsAtBarrier = h.reads;
    const done = { lenient: false, strict: false };
    const lenient = readSettings(d).then((s) => ((done.lenient = true), s));
    const strict = readSettingsStrict(d).then((s) => ((done.strict = true), s));
    await yieldTasks();
    assert.deepEqual(done, { lenient: false, strict: false }, '장벽 중에는 두 읽기가 완료되지 않았다');
    assert.equal(h.reads, readsAtBarrier, '장벽 중에는 두 읽기가 파일을 읽기 시작하지도 않았다');
    h.release();
    await write;
    const [a, b] = await Promise.all([lenient, strict]);
    for (const s of [a, b]) {
      assert.equal(s.aiModel, 'gpt-6-luna', '새 모델');
      assert.equal(s.aiSendConsent, false, '새 동의');
      assert.equal(s.lastProject, kept.lastProject);
      assert.equal(s.appearance.theme, kept.theme);
      assert.equal(s.appearance.manuscriptSize, kept.size);
      assert.equal(s.appearance.followSystem, false);
    }
    assert.ok(h.reads >= readsAtBarrier + 2, '해제 뒤 두 읽기가 각각 파일을 읽었다');
  } finally {
    h.release();
    h.restore();
  }
});

test('저장 실패 뒤 읽기: 쓰기가 EIO로 실패해도 대기 중이던 두 읽기는 막히지 않고 이전 정상 설정을 반환하며 파일 Buffer 불변, 실패한 변경값은 섞이지 않는다', { timeout: 30_000 }, async () => {
  const d = await dir();
  await seed(d);
  const before = await readFile(settingsPath(d));
  const h = hook(settingsPath(d), 'EIO');
  try {
    const write = updateSettings(d, { aiModel: 'gpt-6-luna', aiSendConsent: false });
    const writeOutcome = write.then(() => 'ok' as const, (e: NodeJS.ErrnoException) => e.code); // reject 관찰자를 미리 연결한다
    await h.entered;
    const readsAtBarrier = h.reads;
    const done = { lenient: false, strict: false };
    const lenient = readSettings(d).then((s) => ((done.lenient = true), s));
    const strict = readSettingsStrict(d).then((s) => ((done.strict = true), s));
    await yieldTasks();
    assert.deepEqual(done, { lenient: false, strict: false }, '장벽 중에는 두 읽기가 완료되지 않았다');
    assert.equal(h.reads, readsAtBarrier, '장벽 중에는 읽기가 시작되지 않았다');
    h.release();
    assert.equal(await writeOutcome, 'EIO', '쓰기 호출자가 EIO를 받는다');
    const [a, b] = await Promise.all([lenient, strict]);
    for (const s of [a, b]) {
      assert.equal(s.aiModel, 'gpt-6.1-sol', '실패한 모델 변경이 섞이지 않았다');
      assert.equal(s.aiSendConsent, true, '실패한 동의 변경이 섞이지 않았다');
      assert.equal(s.lastProject, kept.lastProject);
      assert.deepEqual({ ...s.appearance, manuscriptSize: s.appearance.manuscriptSize }, { ...DEFAULT_APPEARANCE, theme: 'lamplight', followSystem: false, manuscriptSize: 20 });
    }
    h.restore();
    assert.deepEqual(await readFile(settingsPath(d)), before, '파일 Buffer가 그대로다');
  } finally {
    h.release();
    h.restore();
  }
});
