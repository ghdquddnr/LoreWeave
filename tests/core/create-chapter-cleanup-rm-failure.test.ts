// 새 화 생성(createChapter)에서 실제 부분 기록 writeFile ENOSPC(A) 뒤 신원 일치 정리 rm이 별개 EIO(B)로 실패해도 최초 오류 A 객체가 전달되고, 부분 002.md 잔류가 정확히 관측되며, 새 명시 생성은 잔류 파일을 덮지 않고 003.md로 성공하는지 본다.
// 기존 새 화 검사는 정리 rm 성공 또는 신원 불일치만 다루었고 정리 실패는 명시적 범위 밖이었다. 이 파일은 정리 실패 분기를 고정한다. 새 정정책·자동 복구는 없다.
// 환경 기법(합성): 독점 새 임시 원고 폴더. fs/promises.open을 새 화의 정확한 경로(002.md) + wx 호출에만 한정해 그 실제 FileHandle 인스턴스의 writeFile·sync·close만 감싼다(원메서드 this 유지, prototype 전역 패치·결과 대역 없음).
// writeFile은 앞 절반 바이트만 실제로 기록하고 원본 readFile로 확인한 뒤 합성 ENOSPC 객체 A를 던진다. sync는 호출되지 않는다. close는 원래 close로 실제로 성공한다(fd === -1). 정리의 신원 stat은 실제로 성공한다.
// 정확 002.md의 rm만 별개 합성 EIO 객체 B로 거절한다(실제로 삭제하지 않으므로 부분 002.md가 남는다). 원래 fs 함수는 hook 설치 전에 보존하고 검증은 그것을 쓴다.
// 한계(정직한 기록): 이 경로에서는 부분 002.md가 잔류하고 listChapters에 실제로 노출된다. 노출되지 않는다거나 원자적으로 롤백된다고 주장하지 않으며, 제품은 잔류 파일을 자동 삭제·수정하지 않는다. "해제만으로 변화 없음"은 setImmediate 몇 번 양보한 유한 관측이다.
// 실제 디스크 고갈·ACL 시험이 아니다. 테스트 종료 시 hook 복구 후 이 테스트가 만든 독점 폴더만 정리한다. timeout, node:test 파일별 별도 프로세스.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChapter, listChapters, readChapter } from '../../src/main/project-files.ts';

const fsp = process.getBuiltinModule('fs/promises');
// hook 설치 전에 보존한 원래 함수
const realOpen = fsp.open;
const realRm = fsp.rm;
const realReadFile = fsp.readFile;
const readDisk = (p: string) => (realReadFile as (p: string) => Promise<Buffer>)(p);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type FH = import('node:fs/promises').FileHandle;
type Hook = {
  fail: boolean;
  opens: number;
  writes: number;
  syncs: number;
  closes: number;
  targetRms: number;
  targetRmFailed: number;
  handles: FH[];
  partialBytes: Buffer | null;
  intendedBytes: number;
  enospc: Error | null;
  rmError: Error | null;
  restore: () => void;
};

function hook(target: string): Hook {
  const h: Hook = { fail: true, opens: 0, writes: 0, syncs: 0, closes: 0, targetRms: 0, targetRmFailed: 0, handles: [], partialBytes: null, intendedBytes: 0, enospc: null, rmError: null, restore: () => undefined };
  (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => Promise<FH>)(p, flags, ...rest);
    if (String(p) !== target || flags !== 'wx') return handle; // 정확 새 화 경로의 wx만 감싼다
    h.opens++;
    h.handles.push(handle);
    const origWrite = handle.writeFile;
    const origSync = handle.sync;
    const origClose = handle.close;
    (handle as unknown as { writeFile: unknown }).writeFile = async (data: unknown, ...a: unknown[]) => {
      h.writes++;
      if (!h.fail) return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a);
      const full = Buffer.from(data as Uint8Array);
      await (origWrite as (...x: unknown[]) => Promise<void>).call(handle, full.subarray(0, Math.floor(full.length / 2)), ...a); // 앞부분만 실제로 기록한다
      h.intendedBytes = full.length;
      h.partialBytes = await readDisk(target);
      h.enospc = Object.assign(new Error('합성 ENOSPC (writeFile, 일부 기록 뒤) — 최초 오류 A'), { code: 'ENOSPC' });
      throw h.enospc;
    };
    (handle as unknown as { sync: unknown }).sync = async () => {
      h.syncs++;
      return origSync.call(handle);
    };
    (handle as unknown as { close: unknown }).close = async () => {
      h.closes++;
      return origClose.call(handle); // 원래 close가 실제로 성공한다
    };
    return handle;
  };
  (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
    if (String(p) !== target) return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    h.targetRms++;
    h.targetRmFailed++;
    h.rmError = Object.assign(new Error('합성 EIO (정리 rm 거절) — 별개 오류 B'), { code: 'EIO' }); // 실제로 삭제하지 않는다
    throw h.rmError;
  };
  h.restore = () => {
    (fsp as { open: unknown }).open = realOpen;
    (fsp as { rm: unknown }).rm = realRm;
  };
  return h;
}

const ORIGINAL = Buffer.from('﻿---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');

test('부분 기록 ENOSPC(A) 뒤 정리 rm이 별개 EIO(B)로 실패해도 호출자는 A 객체를 받고, 부분 002.md는 잔류·목록 노출(한계)로 정확히 관측되며, 해제만으로 변화가 없고, 새 명시 생성은 잔류 002.md를 덮지 않고 003.md로 성공한다', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-create-rmfail-'));
  const chapters = join(root, 'chapters');
  await mkdir(chapters);
  const first = join(chapters, '001.md');
  const sentinel = join(chapters, 'sentinel.txt');
  const sentinelBytes = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');
  await writeFile(first, ORIGINAL);
  await writeFile(sentinel, sentinelBytes);
  const target = join(chapters, '002.md');
  const h = hook(target);
  try {
    let returned: unknown = 'not-returned';
    let caught: unknown;
    try {
      returned = await createChapter(root);
    } catch (e) {
      caught = e;
    }
    assert.equal(returned, 'not-returned', '생성 성공 반환 0');
    assert.ok(h.enospc && h.rmError && h.enospc !== h.rmError, '최초 오류 A와 정리 오류 B는 별개 객체다');
    assert.equal(caught, h.enospc, '호출자는 최초 오류 A를 같은 객체로 받는다');
    assert.notEqual(caught, h.rmError, 'B가 A를 가리지 않았다');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, targetRms: h.targetRms, targetRmFailed: h.targetRmFailed }, { opens: 1, writes: 1, syncs: 0, closes: 1, targetRms: 1, targetRmFailed: 1 }, 'write·close·rm 시도 각 1, sync 0, rm 성공 0 (거절 1)');
    assert.ok(h.handles.every((fh) => fh.fd === -1), 'close가 실제로 성공했다 (fd === -1)');
    assert.ok(h.partialBytes && h.partialBytes.length > 0 && h.partialBytes.length < h.intendedBytes, `부분 기록(${h.partialBytes?.length})이 0보다 크고 전체(${h.intendedBytes})보다 짧았다`);
    // 잔류를 정확히 관측한다 (미노출·원자적 롤백을 주장하지 않는다)
    const residue = await readDisk(target);
    assert.deepEqual(residue, h.partialBytes, '부분 002.md가 실제로 잔류하고 기록한 부분 바이트 그대로다');
    const residueHash = sha(residue);
    const listed = (await listChapters(root)).chapters;
    console.log(`관측: 정리 rm 실패 뒤 잔류 002.md 목록 노출 = ${JSON.stringify(listed.map((c) => ({ file: c.file, unreadable: c.unreadable })))} (제품은 자동 삭제·수정하지 않으며 노출 한계는 그대로다)`);
    assert.ok(listed.some((c) => c.file === '002.md'), '잔류 002.md가 목록에 실제로 노출된다 (한계)');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', '002.md', 'sentinel.txt'], '폴더에 부분 002.md만 더 있다');
    assert.deepEqual(await readDisk(first), ORIGINAL, '기존 원고 Buffer 불변');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, 'sentinel 불변');
    // 해제만으로는 변화가 없다 (유한 양보 전후 계수·목록·잔류 bytes)
    const snap = { opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, targetRms: h.targetRms };
    h.fail = false;
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, targetRms: h.targetRms }, snap, '해제 뒤 유한 양보 동안 open·write·sync·close·rm 증가 0');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', '002.md', 'sentinel.txt'], '해제만으로 목록 불변');
    assert.equal(sha(await readDisk(target)), residueHash, '잔류 002.md bytes 불변 (자동 삭제·수정 없음)');
    // 새 명시 생성은 잔류 002.md를 덮지 않고 003.md로 성공한다
    const created = await createChapter(root);
    assert.equal(created.file, '003.md', '잔류 002.md를 덮지 않고 다음 번호');
    const bytes = await readDisk(join(chapters, '003.md'));
    assert.equal(created.text, bytes.toString('utf8'), '반환 text가 실제 완전한 파일과 같다');
    assert.equal(created.hash, sha(bytes), '반환 hash가 실제 Buffer 해시와 같다');
    assert.deepEqual(await readChapter(root, '003.md'), { text: created.text, hash: created.hash }, 'readChapter 일치');
    assert.deepEqual((await listChapters(root)).chapters.map((c) => c.file), ['001.md', '002.md', '003.md'], '목록과 일치 (잔류 002 포함)');
    assert.equal(sha(await readDisk(target)), residueHash, '잔류 002.md는 그대로');
    assert.deepEqual(await readDisk(first), ORIGINAL, '기존 001 보존');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, 'sentinel 보존');
  } finally {
    h.restore();
    await (realRm as (p: string, o: object) => Promise<void>)(root, { recursive: true, force: true }); // 이 테스트가 만든 독점 폴더만 정리한다
  }
});
