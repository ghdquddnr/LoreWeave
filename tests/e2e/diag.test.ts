// 진단 도구(diag.ts) 자체의 결정적 검증: Electron 없이 가짜 읽기로, 꺼짐·켜짐·읽기 거절 경로를 확인한다.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { describeProbe, diagDir, diagProbe } from './diag.ts';

const saved = process.env['E2E_DIAG_DIR'];
afterEach(() => {
  if (saved === undefined) delete process.env['E2E_DIAG_DIR'];
  else process.env['E2E_DIAG_DIR'] = saved;
});

test('꺼짐: 읽기를 부르지 않고 null을 돌려준다 (기존 action 사이에 추가 호출이 없다)', async () => {
  delete process.env['E2E_DIAG_DIR'];
  let calls = 0;
  const probe = await diagProbe(async () => ++calls);
  assert.equal(probe, null);
  assert.equal(calls, 0);
  assert.equal(describeProbe(probe), 'off');
});

test('켜짐: 읽은 값을 돌려준다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diag-'));
  try {
    process.env['E2E_DIAG_DIR'] = dir;
    const probe = await diagProbe(async () => ['저장 대기']);
    assert.deepEqual(probe, { value: ['저장 대기'] });
    assert.equal(describeProbe(probe), '["저장 대기"]');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('켜짐 + 읽기 거절: 던지지 않고 unavailable로 남겨, 뒤따르는 원래 오류가 그대로 난다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diag-'));
  try {
    process.env['E2E_DIAG_DIR'] = dir;
    const probe = await diagProbe(async () => {
      throw new Error('Target closed');
    });
    assert.deepEqual(probe, { unavailable: 'Target closed' });
    assert.equal(describeProbe(probe), 'unavailable(Target closed)');
    // 원래 테스트의 assert가 진단 수집 오류에 가려지지 않는다
    assert.throws(() => assert.equal('actual', 'expected'), assert.AssertionError);
    // 읽기 거절이 fail.log 기록을 막지도 않는다
    const { diag } = await import('./diag.ts');
    assert.equal(diag('fail.log', `probe=${describeProbe(probe)}`), true);
    assert.match(await readFile(join(dir, 'fail.log'), 'utf8'), /probe=unavailable\(Target closed\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 호출 지점과 같은 식 `diagDir() ? await diagProbe(read) : null`을 가짜 End/입력/상태 읽기와 함께 쓴다 (호출 지점의 복사본이다: 식이 바뀌면 같이 고친다).
// await이 평가되지 않으면 다음 action이 microtask를 양보하지 않고 바로 이어진다.
async function sequence(): Promise<string[]> {
  const order: string[] = [];
  const flow = (async () => {
    order.push('End');
    const probe = diagDir() ? await diagProbe(async () => order.push('read')) : null;
    order.push(`type(${describeProbe(probe)})`);
  })();
  order.push('pending-state'); // 위 흐름이 첫 await에서 양보했다면 type보다 먼저 찍힌다
  await flow;
  return order;
}

test('꺼짐: 호출 지점 식은 await을 평가하지 않아 End 다음 action이 바로 이어진다 (순서 End, type, pending-state)', async () => {
  delete process.env['E2E_DIAG_DIR'];
  assert.deepEqual(await sequence(), ['End', 'type(off)', 'pending-state']);
});

test('켜짐: 읽기가 End와 다음 action 사이에 들어간다 (순서가 달라지는 것이 켠 실행의 한계)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diag-'));
  try {
    process.env['E2E_DIAG_DIR'] = dir;
    assert.deepEqual(await sequence(), ['End', 'read', 'pending-state', 'type(2)']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
