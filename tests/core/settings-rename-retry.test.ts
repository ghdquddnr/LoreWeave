// settings.json 교체(replaceFile)가 일시 잠금(EPERM)으로 재시도되는 동안 들어온 다른 부분 설정 저장이 기존값·앞선 성공값을 유실하지 않고, 재시도가 소진돼도 대기열이 복구되는지 본다.
// 환경 기법(합성): 독점 새 임시 폴더의 settings.json을 대상으로 하는 fs/promises.rename만 감싸 EPERM을 던진다(첫 진입은 장벽으로 확인). 다른 경로의 rename은 그대로 통과한다. 실제 ACL·백신 동작이 아니다.
// updateSettings는 실제 제품 함수이고 실제 합성 파일에 쓴다. node:test가 파일마다 별도 프로세스로 실행하고, 각 테스트가 finally로 rename을 복구한다. 실제 backoff 밀리초나 재시도 횟수를 정밀 계약으로 고정하지 않는다.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_APPEARANCE } from '../../src/core/appearance.ts';
import { readSettings, settingsPath, updateSettings } from '../../src/main/settings.ts';

const fsp = process.getBuiltinModule('fs/promises');
const dir = () => mkdtemp(join(tmpdir(), 'loreweave-settings-rename-'));

type Hook = { attempts: number; succeeded: string[]; entered: Promise<void>; release: () => void; restore: () => void };

/**
 * 이 settings.json을 대상으로 하는 rename만 감싼다. failures번까지는 EPERM으로 거부하고(Infinity면 계속) 그 뒤에는 실제 rename을 부른다.
 * barrier가 true면 첫 대상 rename 진입에서 release()가 불릴 때까지 멈춘다 (진입은 entered로 확인)
 */
function hookRename(target: string, failures: number, barrier: boolean): Hook {
  const original = fsp.rename;
  let resolveEntered!: () => void;
  const entered = new Promise<void>((r) => (resolveEntered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hook: Hook = { attempts: 0, succeeded: [], entered, release, restore: () => void ((fsp as { rename: unknown }).rename = original) };
  (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to) !== target) return (original as (...a: unknown[]) => Promise<void>)(from, to);
    const n = ++hook.attempts;
    if (n === 1) {
      resolveEntered();
      if (barrier) await gate;
    }
    if (n <= failures) throw Object.assign(new Error('합성 EPERM'), { code: 'EPERM' });
    await (original as (...a: unknown[]) => Promise<void>)(from, to);
    hook.succeeded.push(await readFile(target, 'utf8'));
  };
  return hook;
}

async function seed(d: string) {
  await updateSettings(d, { lastProject: '합성/처음', aiModel: 'gpt-6.1-sol', aiSendConsent: true });
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'lamplight', followSystem: false } }));
}

test('재시도 중 끼어든 다른 항목 저장: 첫 변경이 EPERM으로 재시도되는 동안 enqueue한 뒤 변경이 앞 변경과 기존 값을 유실하지 않고, 순서대로 성공한다', async () => {
  const d = await dir();
  await seed(d);
  const hook = hookRename(settingsPath(d), 2, true);
  try {
    const first = updateSettings(d, { lastProject: '합성/첫 변경' });
    await hook.entered; // 첫 변경이 대상 rename에 진입했다 (장벽에서 멈춰 있다)
    const second = updateSettings(d, (c) => ({ appearance: { ...c.appearance, manuscriptSize: 21 } })); // 첫 변경이 끝나기 전에 enqueue
    let secondDone = false;
    void second.then(() => (secondDone = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(secondDone, false, '뒤 변경은 첫 변경이 끝나기 전에 끝나지 않는다');
    hook.release();
    await first;
    await second;
    assert.ok(hook.attempts >= 3, `첫 변경이 거부 두 번 뒤 재시도로 성공했다: 시도 ${hook.attempts}`);
    // 성공한 교체는 순서대로 두 번: 첫 변경만 담은 파일 → 둘 다 담은 파일
    assert.equal(hook.succeeded.length, 2);
    const [afterFirst, afterSecond] = hook.succeeded.map((t) => JSON.parse(t) as { lastProject: string; appearance: { manuscriptSize: number | null } });
    assert.equal(afterFirst!.lastProject, '합성/첫 변경');
    assert.notEqual(afterFirst!.appearance.manuscriptSize, 21, '첫 성공 시점에는 뒤 변경이 섞이지 않았다');
    assert.equal(afterSecond!.lastProject, '합성/첫 변경');
    assert.equal(afterSecond!.appearance.manuscriptSize, 21);
    hook.restore();
    const s = await readSettings(d);
    assert.equal(s.lastProject, '합성/첫 변경');
    assert.equal(s.appearance.manuscriptSize, 21);
    assert.equal(s.aiModel, 'gpt-6.1-sol', '미변경 모델 보존');
    assert.equal(s.aiSendConsent, true, '미변경 동의 보존');
    assert.deepEqual({ ...s.appearance, manuscriptSize: null }, { ...DEFAULT_APPEARANCE, theme: 'lamplight', followSystem: false, manuscriptSize: null }, '다른 외관 필드 보존');
  } finally {
    hook.release();
    hook.restore();
  }
});

test('재시도 소진: 같은 대상 rename이 계속 EPERM이면 호출자에게 오류, 기존 파일 Buffer 보존, 해제 뒤 새 부분 변경은 성공하고 실패한 변경값은 섞이지 않는다', { timeout: 30_000 }, async () => {
  const d = await dir();
  await seed(d);
  const before = await readFile(settingsPath(d));
  const hook = hookRename(settingsPath(d), Infinity, false);
  try {
    await assert.rejects(updateSettings(d, { lastProject: '합성/실패할 변경', aiSendConsent: false }), (e: NodeJS.ErrnoException) => e.code === 'EPERM');
    assert.ok(hook.attempts >= 2, `유한 재시도가 있었다: 시도 ${hook.attempts}`);
    assert.deepEqual(await readFile(settingsPath(d)), before, '기존 settings.json Buffer가 그대로다');
    // 같은 폴더의 뒤 변경도 막히지 않고 (같은 이유로) 자기 오류를 받는다
    await assert.rejects(updateSettings(d, { aiModel: 'gpt-6-luna' }), (e: NodeJS.ErrnoException) => e.code === 'EPERM');
    assert.deepEqual(await readFile(settingsPath(d)), before);
    const leftovers = (await readdir(d)).filter((n) => n.startsWith('settings.json') && n !== 'settings.json');
    console.log(`관측: 재시도 소진 뒤 settings.json 임시 파일 잔류 = ${JSON.stringify(leftovers)} (정리 정책은 바꾸지 않음)`);
    hook.restore();
    // 해제 뒤 새 명시 부분 변경은 성공하고, 앞서 실패한 변경값은 섞이지 않는다
    await updateSettings(d, { lastProject: '합성/복구 뒤' });
    const s = await readSettings(d);
    assert.equal(s.lastProject, '합성/복구 뒤');
    assert.equal(s.aiSendConsent, true, '실패한 동의 변경이 섞이지 않았다');
    assert.equal(s.aiModel, 'gpt-6.1-sol', '실패한 모델 변경이 섞이지 않았다');
    assert.equal(s.appearance.theme, 'lamplight');
  } finally {
    hook.restore();
  }
});
