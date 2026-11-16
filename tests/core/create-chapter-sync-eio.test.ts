// 새 화 생성(createChapter)의 실제 대상 writeFile이 전체 바이트를 성공 기록한 뒤 정확한 FileHandle.sync에서 EIO가 나면: 실패 전달·생성한 파일 정리·새 명시 재생성을 본다.
// PR252(기존 원고 atomicWrite의 tmp sync EIO)와 다른, 새 화 최종 경로 생성 경계다. 부분 기록 ENOSPC/외부 교체/EEXIST는 create-chapter-partial-write가 다룬다.
// 환경 기법(합성): 독점 새 임시 원고 폴더. fs/promises.open을 "새 화의 정확한 경로 + wx" 호출에만 한정해 감싸 실제 FileHandle을 얻고, 그 인스턴스의 sync만 합성 EIO로 거절한다
// (writeFile·close는 원래 메서드를 this로 호출해 통과·계수. prototype 전역 패치·결과 대역 없음). sync 진입 시 원본 readFile로 실제 파일이 의도한 전체 바이트와 같음을 확인한 뒤 EIO를 던진다.
// 원래 fs 함수는 hook 설치 전에 보존하고 검증은 그것을 쓴다. 실제 createChapter/listChapters/readChapter·실제 합성 파일. sync EIO는 합성 주입이며 실제 fsync·디스크·ACL 시험이 아니다.
// 한계: "해제만으로 자동 재생성 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수·목록 관측(유한 양보)이다. 정리의 stat→rm 사이 교체 경쟁·신원 조회/정리 실패 시 잔류 가능성은 이 테스트의 보장 범위가 아니다.
// finally로 원함수 복구, 테스트 timeout, node:test 파일별 별도 프로세스.

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
const realReadFile = fsp.readFile;
const readDisk = (p: string) => (realReadFile as (p: string) => Promise<Buffer>)(p);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Hook = { fail: boolean; opens: number; writes: number; syncs: number; syncFailed: number; closes: number; intended: Buffer | null; atSync: Buffer | null; restore: () => void };

function hook(target: string): Hook {
  const h: Hook = { fail: true, opens: 0, writes: 0, syncs: 0, syncFailed: 0, closes: 0, intended: null, atSync: null, restore: () => undefined };
  (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
    const handle = await (realOpen as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(p, flags, ...rest);
    if (String(p) !== target || flags !== 'wx') return handle; // 정확 대상의 wx만 감싼다
    h.opens++;
    const origWrite = handle.writeFile;
    const origSync = handle.sync;
    const origClose = handle.close;
    (handle as unknown as { writeFile: unknown }).writeFile = async (data: unknown, ...a: unknown[]) => {
      h.writes++;
      h.intended = Buffer.from(data as Uint8Array);
      return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a);
    };
    (handle as unknown as { sync: unknown }).sync = async () => {
      h.syncs++;
      if (!h.fail) return origSync.call(handle);
      h.syncFailed++;
      h.atSync = await readDisk(target); // 주입 지점: 원본 읽기로 실제 파일 바이트를 확인한다
      throw Object.assign(new Error('합성 EIO (FileHandle.sync)'), { code: 'EIO' });
    };
    (handle as unknown as { close: unknown }).close = async () => {
      h.closes++;
      return origClose.call(handle);
    };
    return handle;
  };
  h.restore = () => void ((fsp as { open: unknown }).open = realOpen);
  return h;
}

const ORIGINAL = Buffer.from('﻿---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');

test('새 화 생성의 writeFile 성공 뒤 FileHandle.sync가 EIO면 호출자에 EIO, 전체 바이트가 실제 기록됐지만 새 화 파일·목록 잔류 0이고 기존 원고·sentinel 불변이며, 해제만으로 자동 재생성이 없고, 새 명시 생성만 같은 번호로 성공한다', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-create-sync-'));
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
    await assert.rejects(createChapter(root), (e: NodeJS.ErrnoException) => e.code === 'EIO');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, syncFailed: h.syncFailed, closes: h.closes }, { opens: 1, writes: 1, syncs: 1, syncFailed: 1, closes: 1 }, 'open·write·sync 실패·close 각 1');
    // 부분이 아닌 전체 바이트가 실제로 존재했다
    assert.ok(h.intended && h.intended.length > 0, '의도한 바이트가 있다');
    assert.deepEqual(h.atSync, h.intended, 'sync 진입 시 실제 파일이 의도한 전체 바이트와 같았다');
    // 실패 뒤 잔류 0
    const listed = (await listChapters(root)).chapters.map((c) => c.file);
    console.log(`관측: 실패 뒤 chapters 폴더 = ${JSON.stringify((await readdir(chapters)).sort())}, 목록 = ${JSON.stringify(listed)}`);
    assert.deepEqual(listed, ['001.md'], '실패한 화가 목록에 나타나지 않는다');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt'], '생성했던 파일이 남지 않았다');
    assert.deepEqual(await readDisk(first), ORIGINAL, '기존 원고 Buffer 불변');
    assert.equal(sha(await readDisk(first)), sha(ORIGINAL), '기존 원고 hash 불변');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, 'sentinel Buffer 불변');
    // 해제만으로는 자동 재생성·재쓰기가 없다 (유한 양보 뒤 계수 snapshot과 비교)
    const snap = { opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes };
    h.fail = false;
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes }, snap, '해제 뒤 유한 양보 동안 open·write·sync·close 증가 0');
    assert.deepEqual((await readdir(chapters)).sort(), ['001.md', 'sentinel.txt']);
    // 새 명시 생성만 같은 다음 번호로 성공한다
    const created = await createChapter(root);
    assert.equal(created.file, '002.md', '같은 다음 번호');
    const bytes = await readDisk(target);
    assert.equal(created.text, bytes.toString('utf8'), '반환 text가 실제 전체 파일과 같다');
    assert.equal(created.hash, sha(bytes), '반환 hash가 실제 Buffer 해시와 같다');
    assert.deepEqual(await readChapter(root, '002.md'), { text: created.text, hash: created.hash });
    assert.deepEqual((await listChapters(root)).chapters.map((c) => c.file), ['001.md', '002.md'], '목록과 일치');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, syncFailed: h.syncFailed }, { opens: 2, writes: 2, syncs: 2, syncFailed: 1 }, '새 생성은 실제 sync 성공');
    assert.deepEqual(await readDisk(first), ORIGINAL, '기존 원고 보존');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes);
  } finally {
    h.restore();
  }
});
