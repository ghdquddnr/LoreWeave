// 기존 원고 저장(writeChapter→atomicWrite)에서 tmp writeFile 부분 기록 ENOSPC(A)와 FileHandle.close 오류(B)가 겹칠 때 최초 저장 오류 A가 B에 가려지지 않는지 본다.
// 대조 제어: write/sync가 성공하고 close만 실패하면 그 close 오류(B)가 그대로 전달되고 saved를 반환하지 않으며 tmp를 정리하고 원본을 보존한다.
// 환경 기법(합성): 독점 새 임시 원고 폴더. fs/promises.open을 원고 경로 + '.' + UUID + '.tmp' 이고 wx인 호출에만 한정해 감싸 실제 FileHandle을 얻고, 그 인스턴스의 writeFile·close를 감싼다(원메서드 this 유지, prototype 전역 패치·결과 대역 없음).
// overlap: writeFile은 앞 절반 바이트만 실제로 기록한 뒤 합성 ENOSPC 객체 A를 던지고, close는 원래 close로 실제로 닫은 뒤(handle 누수·Windows 파일 잠금 회피) 별개의 합성 EIO 객체 B를 던진다.
// close-only: writeFile·sync는 원메서드로 실제 성공, close는 실제로 닫은 뒤 B를 던진다. 이는 OS의 close 자체 실패 시험이 아니라 close 호출의 오류 반환 경로를 합성한 것이다. tmp 정리 rm은 실제로 성공한다.
// 원래 fs 함수는 hook 설치 전에 보존하고 검증은 그것을 쓴다. 한계: "해제만으로 자동 저장 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수 snapshot 관측(유한 양보)이다. 실제 디스크 고갈·ACL 시험이 아니다.
// finally로 원함수 복구 후 이 테스트가 만든 독점 폴더만 정리, 테스트 timeout, node:test 파일별 별도 프로세스.

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

type Mode = 'overlap' | 'close-only' | 'off';
type FH = import('node:fs/promises').FileHandle;
type Hook = {
  mode: Mode;
  opens: number;
  writes: number;
  syncs: number;
  closes: number;
  renames: number;
  tmpRms: number;
  tmpRmOk: number;
  handles: FH[];
  partialBytes: Buffer | null;
  intendedBytes: number;
  enospc: Error | null;
  closeError: Error | null;
  restore: () => void;
};

function hook(target: string): Hook {
  const tmpPattern = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f-]{36}\\.tmp$`);
  const h: Hook = { mode: 'overlap', opens: 0, writes: 0, syncs: 0, closes: 0, renames: 0, tmpRms: 0, tmpRmOk: 0, handles: [], partialBytes: null, intendedBytes: 0, enospc: null, closeError: null, restore: () => undefined };
  (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => Promise<FH>)(p, flags, ...rest);
    if (!tmpPattern.test(String(p)) || flags !== 'wx') return handle; // 정확 대상 tmp의 wx만 감싼다
    h.opens++;
    h.handles.push(handle);
    const origWrite = handle.writeFile;
    const origSync = handle.sync;
    const origClose = handle.close;
    (handle as unknown as { writeFile: unknown }).writeFile = async (data: unknown, ...a: unknown[]) => {
      h.writes++;
      if (h.mode !== 'overlap') return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a);
      const full = Buffer.from(data as Uint8Array);
      await (origWrite as (...x: unknown[]) => Promise<void>).call(handle, full.subarray(0, Math.floor(full.length / 2)), ...a); // 앞부분만 실제로 기록한다
      h.intendedBytes = full.length;
      h.partialBytes = await readDisk(String(p));
      h.enospc = Object.assign(new Error('합성 ENOSPC (writeFile, 일부 기록 뒤) — 최초 오류 A'), { code: 'ENOSPC' });
      throw h.enospc;
    };
    (handle as unknown as { sync: unknown }).sync = async () => {
      h.syncs++;
      return origSync.call(handle);
    };
    (handle as unknown as { close: unknown }).close = async () => {
      h.closes++;
      await origClose.call(handle); // 원래 close로 실제로 닫는다 (handle 누수·잠금 없음)
      if (h.mode === 'off') return;
      h.closeError = Object.assign(new Error('합성 EIO (FileHandle.close 오류 반환 경로) — 별개 오류 B'), { code: 'EIO' });
      throw h.closeError;
    };
    return handle;
  };
  (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
    if (String(to) === target) h.renames++;
    return (realRename as (...a: unknown[]) => Promise<void>)(from, to);
  };
  (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
    if (!tmpPattern.test(String(p))) return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    h.tmpRms++;
    await (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest); // 정리 rm은 실제로 성공한다
    h.tmpRmOk++;
  };
  h.restore = () => {
    (fsp as { open: unknown }).open = realOpen;
    (fsp as { rename: unknown }).rename = realRename;
    (fsp as { rm: unknown }).rm = realRm;
  };
  return h;
}

const BOM = '﻿';
const ORIGINAL = Buffer.from(`${BOM}---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n`, 'utf8');
const FAILED_TEXT = `${BOM}---\r\nid: syn-1\r\n---\r\n실패할 저장 본문\r\n`;
const RECOVER_TEXT = `${BOM}---\r\nid: syn-1\r\n---\r\n복구 뒤 새 본문\r\n한글 CRLF 유지\r\n`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-close-masks-'));
  const chapters = join(root, 'chapters');
  await mkdir(chapters);
  const target = join(chapters, '001.md');
  const sentinel = join(chapters, 'sentinel.txt');
  const sentinelBytes = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');
  await writeFile(target, ORIGINAL);
  await writeFile(sentinel, sentinelBytes);
  const read0 = await readChapter(root, '001.md');
  assert.equal(read0.hash, sha(ORIGINAL));
  return { root, chapters, target, sentinel, sentinelBytes, read0 };
}

async function attempt(root: string, hash: string): Promise<{ returned: unknown; caught: unknown }> {
  let returned: unknown = 'not-returned';
  let caught: unknown;
  try {
    returned = await writeChapter(root, '001.md', FAILED_TEXT, hash);
  } catch (e) {
    caught = e;
  }
  return { returned, caught };
}

const closed = (h: Hook) => h.handles.every((fh) => fh.fd === -1);

test('write ENOSPC(A)와 close 오류(B)가 겹쳐도 호출자는 최초 오류 A 객체를 받고, B가 가리지 않으며, 부분 tmp는 정리되고 원고·sentinel 불변이며, 해제만으로 자동 저장이 없고, 새 명시 저장은 정상 저장한다', { timeout: 30_000 }, async () => {
  const s = await setup();
  const h = hook(s.target);
  try {
    const { returned, caught } = await attempt(s.root, s.read0.hash);
    assert.equal(returned, 'not-returned', '성공(saved) 반환 0');
    assert.ok(h.enospc && h.closeError && h.enospc !== h.closeError, '최초 오류 A와 close 오류 B는 별개 객체다');
    assert.equal(caught, h.enospc, '호출자는 최초 저장 오류 A를 그대로 받는다');
    assert.notEqual(caught, h.closeError, 'B가 A를 가리지 않았다');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms, tmpRmOk: h.tmpRmOk }, { opens: 1, writes: 1, syncs: 0, closes: 1, renames: 0, tmpRms: 1, tmpRmOk: 1 }, 'write·close 각 1, sync 0, rename 0, tmp rm 시도·성공 각 1');
    assert.ok(closed(h), '실제 handle 누수 0 (fd === -1)');
    assert.ok(h.partialBytes && h.partialBytes.length > 0 && h.partialBytes.length < h.intendedBytes, `부분 기록(${h.partialBytes?.length})이 0보다 크고 전체(${h.intendedBytes})보다 짧았다`);
    assert.deepEqual((await readdir(s.chapters)).sort(), ['001.md', 'sentinel.txt'], '부분 tmp 잔류 0');
    assert.deepEqual(await readDisk(s.target), ORIGINAL, '기존 원고 Buffer 불변');
    assert.equal(sha(await readDisk(s.target)), s.read0.hash, '기존 원고 hash 불변');
    assert.deepEqual(await readDisk(s.sentinel), s.sentinelBytes, 'sentinel 불변');
    // 해제만으로는 자동 저장이 없다 (유한 양보 뒤 계수 snapshot과 비교)
    const snap = { opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms };
    h.mode = 'off';
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms }, snap, '해제 뒤 유한 양보 동안 open·write·sync·close·rename·rm 증가 0');
    assert.deepEqual(await readDisk(s.target), ORIGINAL, '해제만으로 원고가 바뀌지 않았다');
    // 새 명시 저장
    const result = await writeChapter(s.root, '001.md', RECOVER_TEXT, s.read0.hash);
    assert.equal(result.status, 'saved');
    const finalBytes = await readDisk(s.target);
    assert.deepEqual(finalBytes, Buffer.from(RECOVER_TEXT, 'utf8'), '의도한 복구 원문 그대로 (BOM/CRLF/frontmatter/한글)');
    if (result.status === 'saved') assert.equal(result.hash, sha(finalBytes), '반환 hash가 실제 Buffer 해시와 일치');
    assert.equal((await readChapter(s.root, '001.md')).text, RECOVER_TEXT, 'readChapter 일치');
    assert.deepEqual({ syncs: h.syncs, renames: h.renames }, { syncs: 1, renames: 1 }, '새 저장은 실제 sync·rename 1회씩');
    assert.deepEqual((await readdir(s.chapters)).sort(), ['001.md', 'sentinel.txt'], 'tmp 없음');
    assert.deepEqual(await readDisk(s.sentinel), s.sentinelBytes);
  } finally {
    h.restore();
    await (realRm as (p: string, o: object) => Promise<void>)(s.root, { recursive: true, force: true }); // 이 테스트가 만든 독점 폴더만 정리한다
  }
});

test('대조 제어: write·sync는 실제 성공하고 close만 실패하면 그 close 오류 B가 같은 객체로 전달되고 saved 반환 0, rename 0, tmp 정리 성공, 원본 보존, handle 누수 0이다', { timeout: 30_000 }, async () => {
  const s = await setup();
  const h = hook(s.target);
  try {
    h.mode = 'close-only';
    const { returned, caught } = await attempt(s.root, s.read0.hash);
    assert.equal(returned, 'not-returned', '성공(saved) 반환 0');
    assert.ok(h.closeError, 'close 오류 B가 주입됐다');
    assert.equal(caught, h.closeError, '앞선 오류가 없으면 close 오류 B가 그대로 전달된다');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms, tmpRmOk: h.tmpRmOk }, { opens: 1, writes: 1, syncs: 1, closes: 1, renames: 0, tmpRms: 1, tmpRmOk: 1 }, '실제 write·sync 성공, close 1, rename 0, tmp rm 시도·성공 각 1');
    assert.ok(closed(h), '실제 handle 누수 0 (fd === -1)');
    assert.deepEqual((await readdir(s.chapters)).sort(), ['001.md', 'sentinel.txt'], 'tmp 잔류 0');
    assert.deepEqual(await readDisk(s.target), ORIGINAL, '원본 Buffer 보존');
    assert.deepEqual(await readDisk(s.sentinel), s.sentinelBytes);
  } finally {
    h.restore();
    await (realRm as (p: string, o: object) => Promise<void>)(s.root, { recursive: true, force: true });
  }
});
