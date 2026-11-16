// 기존 원고 저장(writeChapter→atomicWrite)의 임시 파일에 실제 일부 바이트를 기록한 뒤 ENOSPC가 나면: 원본 보존·오류 전달·부분 tmp 정리·새 명시 저장 복구를 본다.
// PR252(전체 기록 뒤 sync EIO)·PR253~255(새 화 생성)·PR251(settings tmp 부분 기록)과 다른 기존 원고 저장 경계다.
// 환경 기법(합성): 독점 새 임시 원고 폴더의 합성 원고 한 화에 대해, fs/promises.open을 "이 원고 경로 + '.' + UUID + '.tmp'" 이고 flag가 wx인 호출에만 한정해 감싸 실제 FileHandle을 얻고,
// 그 handle 인스턴스의 writeFile에서 원래 메서드(this 유지)로 앞 절반 바이트만 실제로 기록하고 원본 readFile로 0<부분<의도 바이트임을 확인한 뒤 합성 ENOSPC 객체를 던진다.
// 같은 handle의 sync·close와 정확 tmp의 rm, 원고 rename은 원메서드를 통과시키며 횟수만 센다. prototype 전역 패치·결과 대역 없음. 원래 fs 함수는 hook 설치 전에 보존하고 검증은 그것을 쓴다.
// 실제 디스크 고갈·ACL 시험이 아니다. 한계: "해제만으로 자동 재저장 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수·Buffer·목록 관측(유한 양보)이다.
// close/정리 오류 동시 주입·경쟁 교체·재시도 정책은 범위 밖. finally로 원함수 복구, 테스트 timeout, node:test 파일별 별도 프로세스.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readChapter, writeChapter } from '../../src/main/project-files.ts';

const fsp = process.getBuiltinModule('fs/promises');
// hook 설치 전에 보존한 원래 함수
const realOpen = fsp.open;
const realRename = fsp.rename;
const realRm = fsp.rm;
const realReadFile = fsp.readFile;
const readDisk = (p: string) => (realReadFile as (p: string) => Promise<Buffer>)(p);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Hook = {
  fail: boolean;
  opens: number;
  writes: number;
  syncs: number;
  enospcFailed: number;
  closes: number;
  renames: number;
  tmpRms: number;
  tmpPath: string | null;
  partialBytes: Buffer | null;
  intendedBytes: number;
  enospc: Error | null;
  restore: () => void;
};

function hook(target: string): Hook {
  const tmpPattern = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f-]{36}\\.tmp$`);
  const h: Hook = { fail: true, opens: 0, writes: 0, syncs: 0, enospcFailed: 0, closes: 0, renames: 0, tmpRms: 0, tmpPath: null, partialBytes: null, intendedBytes: 0, enospc: null, restore: () => undefined };
  (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(p, flags, ...rest);
    if (!tmpPattern.test(String(p)) || flags !== 'wx') return handle; // 정확 대상 tmp의 wx만 감싼다
    h.opens++;
    h.tmpPath = String(p);
    const origWrite = handle.writeFile;
    const origSync = handle.sync;
    const origClose = handle.close;
    (handle as unknown as { writeFile: unknown }).writeFile = async (data: unknown, ...a: unknown[]) => {
      h.writes++;
      if (!h.fail) return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a);
      const full = Buffer.from(data as Uint8Array);
      await (origWrite as (...x: unknown[]) => Promise<void>).call(handle, full.subarray(0, Math.floor(full.length / 2)), ...a); // 앞부분만 실제로 기록한다
      h.enospcFailed++;
      h.intendedBytes = full.length;
      h.partialBytes = await readDisk(String(p)); // 원본 읽기로 tmp의 실제 부분 바이트를 확인한다
      h.enospc = Object.assign(new Error('합성 ENOSPC (writeFile, 일부 기록 뒤)'), { code: 'ENOSPC' });
      throw h.enospc;
    };
    (handle as unknown as { sync: unknown }).sync = async () => {
      h.syncs++;
      return origSync.call(handle);
    };
    (handle as unknown as { close: unknown }).close = async () => {
      h.closes++;
      return origClose.call(handle);
    };
    return handle;
  };
  (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to) === target) h.renames++;
    return (realRename as (...a: unknown[]) => Promise<void>)(from, to);
  };
  (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
    if (tmpPattern.test(String(p))) h.tmpRms++;
    return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
  };
  h.restore = () => {
    (fsp as { open: unknown }).open = realOpen;
    (fsp as { rename: unknown }).rename = realRename;
    (fsp as { rm: unknown }).rm = realRm;
  };
  return h;
}

test('tmp writeFile이 일부 기록 뒤 ENOSPC면 그 오류 객체가 호출자에 전달되고 saved 반환 0, 부분 tmp 정리·기존 원고 Buffer/hash 불변(무관 파일 보존)이고, 해제만으로는 변경이 없으며, 새 명시 저장만 의도한 원문으로 복구한다', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-partial-enospc-'));
  const chapters = join(root, 'chapters');
  await mkdir(chapters);
  const target = join(chapters, '001.md');
  const sentinel = join(chapters, 'sentinel.txt');
  const sentinelBytes = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');
  const original = Buffer.from('﻿---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');
  await writeFile(target, original);
  await writeFile(sentinel, sentinelBytes);
  const read0 = await readChapter(root, '001.md');
  assert.equal(read0.hash, sha(original));
  const failedText = '﻿---\r\nid: syn-1\r\n---\r\n실패할 저장 본문\r\n';
  const recoverText = '﻿---\r\nid: syn-1\r\n---\r\n복구 뒤 새 본문\r\n한글 CRLF 유지\r\n';
  const h = hook(target);
  try {
    // 실패 저장
    await assert.rejects(writeChapter(root, '001.md', failedText, read0.hash), (e: unknown) => e === h.enospc && (e as NodeJS.ErrnoException).code === 'ENOSPC'); // 합성 오류 객체 자체가 전달된다
    assert.deepEqual({ opens: h.opens, writes: h.writes, enospcFailed: h.enospcFailed, syncs: h.syncs, closes: h.closes, renames: h.renames }, { opens: 1, writes: 1, enospcFailed: 1, syncs: 0, closes: 1, renames: 0 }, 'tmp open·write(ENOSPC)·close 각 1, 대상 sync 0, rename 0');
    assert.ok(h.partialBytes && h.partialBytes.length > 0 && h.partialBytes.length < h.intendedBytes, `부분 기록(${h.partialBytes?.length})이 전체(${h.intendedBytes})보다 짧고 0보다 컸다`);
    assert.deepEqual(h.partialBytes, Buffer.from(failedText, 'utf8').subarray(0, h.partialBytes!.length), '부분 바이트는 의도한 내용의 앞부분이다');
    // 원래 원고 보존
    assert.deepEqual(await readDisk(target), original, '기존 원고 Buffer 불변');
    assert.equal(sha(await readDisk(target)), read0.hash, '기존 원고 hash 불변');
    const reread = await readChapter(root, '001.md');
    assert.equal(reread.text, original.toString('utf8'), 'readChapter 원문 그대로 (BOM/CRLF/frontmatter 포함)');
    assert.equal(reread.hash, read0.hash);
    // tmp 정리와 무관 파일 보존
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt'], '실패한 tmp가 남지 않았고 무관 파일은 그대로다');
    assert.equal(h.tmpRms, 1, '실패한 tmp를 지우는 rm이 1회 있었다');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, '무관 sentinel 파일 불변');
    // 해제만으로는 변경이 없다 (유한 양보 뒤 계수·snapshot과 비교)
    const snap = { opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames };
    h.fail = false;
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames }, snap, '해제 뒤 유한 양보 동안 open·write·sync·close·rename 증가 0');
    assert.deepEqual(await readDisk(target), original, '해제만으로 원고가 바뀌지 않았다');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt'], '해제만으로 목록 불변');
    // 새 명시 저장 (원래 hash, 실패했던 본문과 다른 복구 본문)
    const result = await writeChapter(root, '001.md', recoverText, read0.hash);
    assert.equal(result.status, 'saved');
    assert.deepEqual({ opens: h.opens, writes: h.writes, enospcFailed: h.enospcFailed, syncs: h.syncs, closes: h.closes, renames: h.renames }, { opens: 2, writes: 2, enospcFailed: 1, syncs: 1, closes: 2, renames: 1 }, '새 저장은 실제 write·sync(성공)·close·rename 1회씩');
    const finalBytes = await readDisk(target);
    assert.deepEqual(finalBytes, Buffer.from(recoverText, 'utf8'), '의도한 복구 원문 그대로 (BOM/CRLF/frontmatter/한글)');
    if (result.status === 'saved') assert.equal(result.hash, sha(finalBytes), '반환 hash가 실제 Buffer 해시와 일치');
    assert.ok(!finalBytes.includes(Buffer.from('실패할 저장 본문', 'utf8')), '실패했던 저장 본문이 섞이지 않았다');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt'], 'tmp가 없다');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes);
  } finally {
    h.restore();
  }
});
