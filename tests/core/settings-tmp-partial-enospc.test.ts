// settings.json 임시 파일(.tmp) 쓰기가 일부 바이트를 기록한 뒤 ENOSPC로 거절돼도 기존 정상 settings.json이 보존되고, 실패 뒤 새 명시적 부분 설정 저장이 정상 복구되는지 본다.
// 환경 기법(합성): 독점 새 임시 폴더의 settings.json.tmp 한 곳에 대한 fs/promises.writeFile만 감싸, 원래 writeFile로 의도한 JSON의 앞 절반 바이트를 실제로 기록한 뒤 합성 ENOSPC를 던진다. rename은 대상 호출 횟수만 센다.
// 원래 fs 함수는 hook 설치 전에 보존하고 검증용 읽기·존재 확인은 그것을 쓴다(검증이 hook 계수를 바꾸지 않는다). 실제 updateSettings/readSettingsStrict·실제 합성 파일, 결과 대역 없음. 실제 디스크 고갈·ACL 검증이 아니다.
// 한계: "해제만으로 재쓰기 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수·파일 snapshot 관측(유한 양보)이다. 실패 직후 tmp 잔류는 관측 그대로 보고하며 정리 정책·고유 tmp 이름·재시도는 이번 범위가 아니다.
// 각 테스트가 finally로 원함수 복구, 테스트별 timeout, node:test 파일별 별도 프로세스.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_APPEARANCE } from '../../src/core/appearance.ts';
import { readSettingsStrict, settingsPath, updateSettings } from '../../src/main/settings.ts';

const fsp = process.getBuiltinModule('fs/promises');
const nodeFs = process.getBuiltinModule('fs');
// hook 설치 전에 보존한 원래 함수
const realWriteFile = fsp.writeFile;
const realRename = fsp.rename;
const realReadFile = fsp.readFile;
const readDisk = (p: string) => (realReadFile as (p: string) => Promise<Buffer>)(p);
const dir = () => mkdtemp(join(tmpdir(), 'loreweave-settings-enospc-'));
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Hook = { fail: boolean; tmpWrites: number; tmpFailed: number; renames: number; intendedBytes: number; partialBytes: number; restore: () => void };
function hook(target: string): Hook {
  const tmp = `${target}.tmp`;
  const h: Hook = {
    fail: true,
    tmpWrites: 0,
    tmpFailed: 0,
    renames: 0,
    intendedBytes: 0,
    partialBytes: 0,
    restore: () => {
      (fsp as { writeFile: unknown }).writeFile = realWriteFile;
      (fsp as { rename: unknown }).rename = realRename;
    },
  };
  (fsp as { writeFile: unknown }).writeFile = async (p: unknown, data: unknown, ...args: unknown[]) => {
    if (String(p) !== tmp) return (realWriteFile as (...a: unknown[]) => Promise<unknown>)(p, data, ...args);
    h.tmpWrites++;
    if (!h.fail) return (realWriteFile as (...a: unknown[]) => Promise<unknown>)(p, data, ...args);
    h.tmpFailed++;
    const full = Buffer.from(String(data));
    const part = full.subarray(0, Math.floor(full.length / 2));
    await (realWriteFile as (...a: unknown[]) => Promise<unknown>)(p, part, ...args); // 일부 바이트를 실제로 기록한다
    h.intendedBytes = full.length;
    h.partialBytes = part.length;
    throw Object.assign(new Error('합성 ENOSPC (writeFile, 일부 기록 뒤)'), { code: 'ENOSPC' });
  };
  (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to) === target) h.renames++;
    return (realRename as (...a: unknown[]) => Promise<void>)(from, to);
  };
  return h;
}

async function seed(d: string) {
  await updateSettings(d, { lastProject: '합성/처음', aiModel: 'gpt-6.1-sol', aiSendConsent: true });
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'lamplight', followSystem: false, manuscriptSize: 20 } }));
}
const SEED_APPEARANCE = { ...DEFAULT_APPEARANCE, theme: 'lamplight', followSystem: false, manuscriptSize: 20 };
const parse = (b: Buffer) => JSON.parse(b.toString('utf8')) as { lastProject: string; aiModel: string; aiSendConsent: boolean; appearance: unknown };

test('tmp 쓰기가 일부 기록 뒤 ENOSPC로 거절되면 기존 settings.json Buffer가 그대로이고 조회는 기존값이며, 해제만으로는 재쓰기가 없고, 새 명시 부분 저장만 실패 변경 혼입 없이 복구한다', { timeout: 30_000 }, async () => {
  const d = await dir();
  await seed(d);
  const target = settingsPath(d);
  const tmp = `${target}.tmp`;
  const before = await readDisk(target); // 정상 settings.json Buffer snapshot
  const h = hook(target);
  try {
    // 실패하는 변경: 동의·모델처럼 기존값과 뚜렷이 다른 값
    await assert.rejects(updateSettings(d, { aiModel: 'gpt-6-luna', aiSendConsent: false }), (e: NodeJS.ErrnoException) => e.code === 'ENOSPC');
    assert.deepEqual({ tmpWrites: h.tmpWrites, tmpFailed: h.tmpFailed, renames: h.renames }, { tmpWrites: 1, tmpFailed: 1, renames: 0 }, '대상 tmp 쓰기 1회 시도·거절 1회, rename 0');
    // 부분 기록이 실제로 존재하고 전체 JSON보다 짧다
    const partial = await readDisk(tmp);
    assert.equal(partial.length, h.partialBytes, '실제로 일부 바이트가 tmp에 기록됐다');
    assert.ok(partial.length > 0 && partial.length < h.intendedBytes, `부분 기록(${partial.length})이 전체(${h.intendedBytes})보다 짧다`);
    assert.throws(() => JSON.parse(partial.toString('utf8')), SyntaxError, '부분 tmp는 완전한 JSON이 아니다');
    // 기존 정상 파일 보존
    assert.deepEqual(await readDisk(target), before, '기존 settings.json Buffer가 그대로다');
    const seen = await readSettingsStrict(d);
    assert.equal(seen.aiModel, 'gpt-6.1-sol', '기존 모델');
    assert.equal(seen.aiSendConsent, true, '기존 동의');
    assert.equal(seen.lastProject, '합성/처음');
    assert.deepEqual(seen.appearance, SEED_APPEARANCE);
    console.log(`관측: 실패 직후 settings.json.tmp 잔류 = 있음 (${partial.length}/${h.intendedBytes} 바이트, 정리 정책은 바꾸지 않음)`);
    // 해제만으로는 재쓰기가 없다 (유한 양보 뒤 계수·파일 snapshot과 비교)
    h.fail = false;
    await yieldTasks();
    assert.deepEqual({ tmpWrites: h.tmpWrites, renames: h.renames }, { tmpWrites: 1, renames: 0 }, '해제 뒤 유한 양보 동안 쓰기·rename 증가 0');
    assert.deepEqual(await readDisk(target), before, '해제만으로 파일이 바뀌지 않았다');
    assert.deepEqual(await readDisk(tmp), partial, '해제만으로 tmp가 바뀌지 않았다');
    // 새 명시 부분 저장은 다른 항목만 바꾼다
    await updateSettings(d, { lastProject: '합성/복구 뒤' });
    assert.deepEqual({ tmpWrites: h.tmpWrites, renames: h.renames }, { tmpWrites: 2, renames: 1 }, '새 저장이 tmp 쓰기 1·rename 1을 했다');
    const disk = parse(await readDisk(target)); // 완전한 JSON으로 파싱된다
    assert.equal(disk.lastProject, '합성/복구 뒤', '명시 변경');
    assert.equal(disk.aiModel, 'gpt-6.1-sol', '실패한 모델 변경이 섞이지 않았다');
    assert.equal(disk.aiSendConsent, true, '실패한 동의 변경이 섞이지 않았다');
    assert.deepEqual(disk.appearance, SEED_APPEARANCE, '비변경 외관 보존');
    assert.equal(nodeFs.existsSync(tmp), false, '정상 rename 뒤 tmp가 사라졌다');
    const after = await readSettingsStrict(d);
    assert.equal(after.lastProject, '합성/복구 뒤');
    assert.equal(after.aiModel, 'gpt-6.1-sol');
    assert.equal(after.aiSendConsent, true);
  } finally {
    h.restore();
  }
});
