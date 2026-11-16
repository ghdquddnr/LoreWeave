// 설정 조회가 진행 중일 때 같은 폴더의 저장(updateSettings)이 조회를 앞질러 읽기·임시 쓰기·rename을 하지 않고, strict 조회가 실패한 뒤에도 대기 중이던 저장이 정상 진행되는지 본다.
// 환경 기법(합성): 독점 새 임시 폴더의 settings.json을 대상으로 하는 fs/promises.readFile 첫 진입을 장벽으로 멈추고(진입은 promise로 확인), 이 파일의 readFile 진입·임시(.tmp) writeFile·rename 횟수를 센다. 다른 경로는 통과한다.
// 원래 fs 함수는 hook 설치 전에 보존하고 검증용 읽기는 그것을 쓴다(검증이 계수·장벽을 바꾸지 않는다). 실제 제품 함수·실제 합성 파일, 결과 대역 없음. 실제 ACL/백신 잠금이 아니다.
// 한계: "장벽 중 후속 저장이 진행되지 않음"은 임의 sleep이 아니라 장벽 중 setImmediate 몇 번 양보한 뒤의 계수·완료 플래그 관측이다(유한 양보). 각 테스트가 finally로 장벽 해제·원함수 복구, 테스트별 timeout, node:test 파일별 별도 프로세스.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_APPEARANCE } from '../../src/core/appearance.ts';
import { readSettings, readSettingsStrict, settingsPath, updateSettings } from '../../src/main/settings.ts';

const fsp = process.getBuiltinModule('fs/promises');
// hook 설치 전에 보존한 원래 함수: hook과 검증이 이것을 쓴다
const realReadFile = fsp.readFile;
const realWriteFile = fsp.writeFile;
const realRename = fsp.rename;
const readDisk = async (p: string) => (realReadFile as (p: string) => Promise<Buffer>)(p);
const dir = () => mkdtemp(join(tmpdir(), 'loreweave-settings-war-'));
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Hook = { reads: number; tmpWrites: number; renames: number; entered: Promise<void>; release: () => void; restore: () => void };
/** 이 settings.json의 readFile 첫 진입에서 release()까지 멈춘다. failFirst면 해제 뒤 그 첫 read만 EIO로 거절하고 이후 read는 실제로 읽는다 */
function hook(target: string, failFirst: boolean): Hook {
  let resolveEntered!: () => void;
  const entered = new Promise<void>((r) => (resolveEntered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h: Hook = {
    reads: 0,
    tmpWrites: 0,
    renames: 0,
    entered,
    release,
    restore: () => {
      (fsp as { readFile: unknown }).readFile = realReadFile;
      (fsp as { writeFile: unknown }).writeFile = realWriteFile;
      (fsp as { rename: unknown }).rename = realRename;
    },
  };
  (fsp as { readFile: unknown }).readFile = async (p: unknown, ...args: unknown[]) => {
    if (String(p) !== target) return (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...args);
    const n = ++h.reads;
    if (n === 1) {
      resolveEntered();
      await gate;
      if (failFirst) throw Object.assign(new Error('합성 EIO (readFile)'), { code: 'EIO' });
    }
    return (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...args);
  };
  (fsp as { writeFile: unknown }).writeFile = async (p: unknown, ...args: unknown[]) => {
    if (String(p) === `${target}.tmp`) h.tmpWrites++;
    return (realWriteFile as (...a: unknown[]) => Promise<unknown>)(p, ...args);
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

for (const [name, read] of [['readSettings', readSettings], ['readSettingsStrict', readSettingsStrict]] as const) {
  test(`${name}가 읽는 중일 때: 같은 폴더의 저장은 읽기·임시 쓰기·rename·완료 없이 기다리고, 해제 뒤 조회는 seed값, 저장은 변경값과 비변경 설정 보존으로 성공한다`, { timeout: 30_000 }, async () => {
    const d = await dir();
    await seed(d);
    const target = settingsPath(d);
    const h = hook(target, false);
    try {
      const done = { read: false, write: false };
      const first = read(d).then((s) => ((done.read = true), s));
      await h.entered; // 독립 조회가 대상 readFile 첫 진입에서 장벽에 머문다
      assert.equal(h.reads, 1);
      const write = updateSettings(d, { aiModel: 'gpt-6-luna' }).then((s) => ((done.write = true), s));
      await yieldTasks();
      assert.deepEqual(done, { read: false, write: false }, '장벽 중에는 조회도 저장도 완료되지 않았다');
      assert.equal(h.reads, 1, '최초 조회 외 readFile 증가 0');
      assert.equal(h.tmpWrites, 0, '장벽 중 임시 쓰기 0');
      assert.equal(h.renames, 0, '장벽 중 rename 0');
      h.release();
      const seen = await first;
      assert.equal(seen.aiModel, 'gpt-6.1-sol', '먼저 시작한 조회는 seed값을 반환한다');
      assert.equal(seen.aiSendConsent, true);
      assert.equal(seen.lastProject, '합성/처음');
      const saved = await write;
      assert.equal(saved.aiModel, 'gpt-6-luna');
      assert.deepEqual({ reads: h.reads, tmpWrites: h.tmpWrites, renames: h.renames }, { reads: 2, tmpWrites: 1, renames: 1 }, '저장은 조회 뒤 실제로 읽고(1) 임시 쓰고(1) rename(1)했다');
      const disk = parse(await readDisk(target));
      assert.equal(disk.aiModel, 'gpt-6-luna', '파일에 변경값');
      assert.equal(disk.aiSendConsent, true);
      assert.equal(disk.lastProject, '합성/처음');
      assert.deepEqual(disk.appearance, SEED_APPEARANCE);
      h.restore();
      const after = await readSettings(d);
      assert.equal(after.aiModel, 'gpt-6-luna', '후속 조회도 변경값');
      assert.equal(after.aiSendConsent, true);
      assert.equal(after.lastProject, '합성/처음');
    } finally {
      h.release();
      h.restore();
    }
  });
}

test('strict 조회가 해제 뒤 첫 read EIO로 실패해도: 대기 중이던 저장은 그 오류를 물려받지 않고 실제 read→merge→write→rename으로 성공하며 최종 파일은 기존값+명시 변경만 담는다', { timeout: 30_000 }, async () => {
  const d = await dir();
  await seed(d);
  const target = settingsPath(d);
  const h = hook(target, true);
  try {
    const strict = readSettingsStrict(d);
    const strictOutcome = strict.then(() => 'ok' as const, (e: NodeJS.ErrnoException) => e.code); // reject 관찰자를 미리 연결한다
    await h.entered;
    const done = { write: false };
    const write = updateSettings(d, { aiSendConsent: false }).then((s) => ((done.write = true), s));
    await yieldTasks();
    assert.equal(done.write, false, '장벽 중 저장 미완료');
    assert.deepEqual({ reads: h.reads, tmpWrites: h.tmpWrites, renames: h.renames }, { reads: 1, tmpWrites: 0, renames: 0 }, '장벽 중 후속 저장의 읽기·임시 쓰기·rename 0');
    h.release();
    assert.equal(await strictOutcome, 'EIO', 'strict 조회는 그 EIO를 받는다');
    const saved = await write;
    assert.equal(saved.aiSendConsent, false, '대기 저장은 막히거나 오류를 물려받지 않고 성공했다');
    assert.deepEqual({ reads: h.reads, tmpWrites: h.tmpWrites, renames: h.renames }, { reads: 2, tmpWrites: 1, renames: 1 }, '저장이 실제로 read(2번째)→임시 쓰기→rename했다');
    const disk = parse(await readDisk(target));
    assert.equal(disk.aiSendConsent, false, '명시 변경');
    assert.equal(disk.aiModel, 'gpt-6.1-sol', '비변경 모델 보존 (기본값으로 덮이지 않음)');
    assert.equal(disk.lastProject, '합성/처음');
    assert.deepEqual(disk.appearance, SEED_APPEARANCE);
  } finally {
    h.release();
    h.restore();
  }
});
