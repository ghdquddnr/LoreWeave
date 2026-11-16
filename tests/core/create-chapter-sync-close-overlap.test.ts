// 새 화 생성(createChapter)에서 실제 전체 writeFile 성공 뒤 FileHandle.sync EIO(A)와 close EIO(B)가 겹쳐도 최초 sync 오류 A 객체가 전달되고, 새 화가 정리되며, 새 명시 생성으로 복구되는지 본다.
// create-chapter-sync-eio는 close 성공, create-chapter-write-close-overlap은 write 실패(sync 0)를 다룬다. 이 파일은 sync+close 겹침 분기를 고정한다. 기존원고 atomicWrite(PR259)와는 다른 새 화 최종 경로 생성 경계다.
// 환경 기법(합성): 독점 새 임시 원고 폴더. fs/promises.open을 새 화의 정확한 경로(002.md) + wx 호출에만 한정해 그 실제 FileHandle 인스턴스의 writeFile·sync·close만 감싼다(원메서드 this 유지, prototype 전역 패치·결과 대역 없음).
// writeFile은 원메서드로 전체를 실제 기록한다. sync 진입 시 hook 전에 보존한 원본 readFile로 파일이 의도한 전체 Buffer와 일치함을 확인한 뒤 별개의 합성 EIO 객체 A를 던진다(실제 fsync 실패 시험 아님).
// close는 원래 close로 실제로 닫은 뒤(handle 누수·Windows 잠금 회피) 별개의 합성 EIO 객체 B를 던진다(OS close 실패 시험이 아니라 오류 반환 경로 합성). 둘 다 code가 EIO이므로 code 비교가 아니라 A 객체 동일·B 객체 상이성으로 검증한다.
// 정리의 stat(dev/ino 신원 확인)과 rm은 실제로 수행·성공한다(정확 대상 rm은 계수만). 한계: "해제만으로 자동 생성 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수·목록·Buffer 관측(유한 양보)이다.
// 부분 write·정리 실패·신원 교체는 범위 밖이며 PR253의 TOCTOU/잔류 한계는 그대로다. finally로 원함수 복구 후 이 테스트가 만든 독점 폴더만 정리, 테스트 timeout, node:test 파일별 별도 프로세스.

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
  targetRmOk: number;
  handles: FH[];
  intended: Buffer | null;
  atSync: Buffer | null;
  syncError: Error | null;
  closeError: Error | null;
  restore: () => void;
};

function hook(target: string): Hook {
  const h: Hook = { fail: true, opens: 0, writes: 0, syncs: 0, closes: 0, targetRms: 0, targetRmOk: 0, handles: [], intended: null, atSync: null, syncError: null, closeError: null, restore: () => undefined };
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
      h.intended = Buffer.from(data as Uint8Array);
      return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a); // 전체를 실제로 기록한다
    };
    (handle as unknown as { sync: unknown }).sync = async () => {
      h.syncs++;
      if (!h.fail) return origSync.call(handle);
      h.atSync = await readDisk(target); // 주입 지점: 원본 읽기로 실제 파일 바이트를 확인한다
      h.syncError = Object.assign(new Error('합성 EIO (FileHandle.sync) — 최초 오류 A'), { code: 'EIO' });
      throw h.syncError;
    };
    (handle as unknown as { close: unknown }).close = async () => {
      h.closes++;
      await origClose.call(handle); // 원래 close로 실제로 닫는다 (handle 누수·잠금 없음)
      if (!h.fail) return;
      h.closeError = Object.assign(new Error('합성 EIO (FileHandle.close 오류 반환 경로) — 별개 오류 B'), { code: 'EIO' });
      throw h.closeError;
    };
    return handle;
  };
  (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
    if (String(p) !== target) return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    h.targetRms++;
    await (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest); // 정리 rm은 실제로 성공한다
    h.targetRmOk++;
  };
  h.restore = () => {
    (fsp as { open: unknown }).open = realOpen;
    (fsp as { rm: unknown }).rm = realRm;
  };
  return h;
}

const ORIGINAL = Buffer.from('﻿---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');

test('새 화 생성에서 전체 write 뒤 sync EIO(A)와 close EIO(B)가 겹쳐도 호출자는 A 객체를 받고, 새 002.md가 정리되며 기존 원고·sentinel 불변이고, 해제만으로 자동 생성이 없고, 새 명시 생성만 002.md로 성공한다', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-create-overlap-'));
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
    assert.ok(h.syncError && h.closeError && h.syncError !== h.closeError, '최초 오류 A와 close 오류 B는 별개 객체다');
    assert.equal(caught, h.syncError, '호출자는 최초 sync 오류 A를 같은 객체로 받는다');
    assert.notEqual(caught, h.closeError, 'B가 A를 가리지 않았다');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, targetRms: h.targetRms, targetRmOk: h.targetRmOk }, { opens: 1, writes: 1, syncs: 1, closes: 1, targetRms: 1, targetRmOk: 1 }, 'write·sync·close 각 1, 정확 대상 rm 시도·성공 각 1');
    assert.ok(h.handles.every((fh) => fh.fd === -1), '실제 handle 누수 0 (fd === -1)');
    assert.ok(h.intended && h.intended.length > 0, '의도한 바이트가 있다');
    assert.deepEqual(h.atSync, h.intended, 'sync 진입 시 실제 파일이 의도한 전체 Buffer와 같았다 (부분 기록 아님)');
    // 잔류 0
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt'], '생성했던 002.md·tmp 잔류 0');
    assert.deepEqual((await listChapters(root)).chapters.map((c) => c.file), ['001.md'], '목록에 나타나지 않는다');
    assert.deepEqual(await readDisk(first), ORIGINAL, '기존 원고 Buffer 불변');
    assert.equal(sha(await readDisk(first)), sha(ORIGINAL), '기존 원고 hash 불변');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, 'sentinel 불변');
    // 해제만으로는 자동 생성이 없다 (유한 양보 전후 계수·목록·Buffer)
    const snap = { opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, targetRms: h.targetRms };
    h.fail = false;
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, targetRms: h.targetRms }, snap, '해제 뒤 유한 양보 동안 open·write·sync·close·rm 증가 0');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt'], '해제만으로 목록 불변');
    assert.deepEqual(await readDisk(first), ORIGINAL);
    // 새 명시 생성만 002.md로 성공한다
    const created = await createChapter(root);
    assert.equal(created.file, '002.md');
    const bytes = await readDisk(target);
    assert.equal(created.text, bytes.toString('utf8'), '반환 text가 실제 완전한 파일과 같다');
    assert.equal(created.hash, sha(bytes), '반환 hash가 실제 Buffer 해시와 같다');
    assert.deepEqual(await readChapter(root, '002.md'), { text: created.text, hash: created.hash }, 'readChapter 일치');
    assert.deepEqual((await listChapters(root)).chapters.map((c) => c.file), ['001.md', '002.md'], '목록과 일치');
    assert.deepEqual(await readDisk(first), ORIGINAL, '기존 001 보존');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, 'sentinel 보존');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', '002.md', 'sentinel.txt']);
  } finally {
    h.restore();
    await (realRm as (p: string, o: object) => Promise<void>)(root, { recursive: true, force: true }); // 이 테스트가 만든 독점 폴더만 정리한다
  }
});
