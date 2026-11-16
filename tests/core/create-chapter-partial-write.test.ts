// 새 화 생성(createChapter)의 실제 대상 파일 writeFile이 일부 바이트를 기록한 뒤 ENOSPC로 거절됐을 때, 불완전한 .md가 남아 목록에 나타나지 않고 오류가 호출자에게 전달되며, 새 명시 생성만 성공하는지 본다.
// 환경 기법(합성): 독점 새 임시 원고 폴더. fs/promises.open을 "새 화의 정확한 경로 + wx" 호출에만 한정해 감싸 실제 FileHandle을 얻고, 그 인스턴스의 writeFile에서 원래 메서드로 앞 절반 바이트를 실제로 기록한 뒤 합성 ENOSPC를 던진다
// (sync·close는 원래 메서드를 this로 호출해 통과·계수. prototype 전역 패치·결과 대역 없음). EEXIST 대조는 같은 정확 경로에 외부 합성 파일을 미리 두어 실제 open(wx)이 EEXIST를 내게 한다.
// 원래 fs 함수는 hook 설치 전에 보존하고 검증은 그것을 쓴다. 실제 createChapter/listChapters/readChapter·실제 합성 파일. 실제 디스크 고갈·ACL 시험이 아니다.
// 한계: "해제만으로 자동 생성 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수·목록 관측(유한 양보)이다. finally로 원함수 복구, 테스트 timeout, node:test 파일별 별도 프로세스.

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
const realStat = fsp.stat;
const realRename = fsp.rename;
const realRm = fsp.rm;
const readDisk = (p: string) => (realReadFile as (p: string) => Promise<Buffer>)(p);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const yieldTasks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

type Mode = 'partial-enospc' | 'swap-then-enospc' | 'preexisting-eexist' | 'off';
type Hook = { mode: Mode; opens: number; writes: number; syncs: number; closes: number; targetRms: number; partial: Buffer | null; intendedBytes: number; restore: () => void };

function hook(target: string): Hook {
  const h: Hook = { mode: 'partial-enospc', opens: 0, writes: 0, syncs: 0, closes: 0, targetRms: 0, partial: null, intendedBytes: 0, restore: () => undefined };
  (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
    if (String(p) !== target || flags !== 'wx') return (realOpen as (...a: unknown[]) => Promise<unknown>)(p, flags, ...rest); // 정확 대상의 wx만
    h.opens++;
    if (h.mode === 'preexisting-eexist') await writeFile(target, EXTERNAL); // 실제 open(wx)이 EEXIST를 내도록 외부 합성 파일을 둔다
    const handle = await (realOpen as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(p, flags, ...rest);
    const origWrite = handle.writeFile;
    const origSync = handle.sync;
    const origClose = handle.close;
    (handle as unknown as { writeFile: unknown }).writeFile = async (data: unknown, ...a: unknown[]) => {
      h.writes++;
      if (h.mode !== 'partial-enospc' && h.mode !== 'swap-then-enospc') return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a);
      const full = Buffer.from(data as Uint8Array);
      if (h.mode === 'swap-then-enospc') {
        // 일부 바이트를 실제로 기록하고 이 handle을 실제로 닫은 뒤(Windows는 열린 파일을 옮길 수 없다), 자기 파일을 별도 합성 경로로 옮기고 정확 원경로에 다른 실제 외부 파일을 독점 생성한 다음 ENOSPC를 던진다
        await (origWrite as (...x: unknown[]) => Promise<void>).call(handle, full.subarray(0, Math.floor(full.length / 2)), ...a);
        h.intendedBytes = full.length;
        h.partial = await readDisk(target);
        await origClose.call(handle); // 실제 close (래퍼 계수 밖): 제품의 close 호출은 이미 닫힌 handle에 대한 두 번째 호출이 된다
        await (realRename as (...x: unknown[]) => Promise<void>)(target, MOVED(target));
        await writeFile(target, EXTERNAL2, { flag: 'wx' }); // 실제 외부 합성 파일 (원래 파일과 다른 inode)
        throw Object.assign(new Error('합성 ENOSPC (writeFile, 교체 뒤)'), { code: 'ENOSPC' });
      }
      await (origWrite as (...x: unknown[]) => Promise<void>).call(handle, full.subarray(0, Math.floor(full.length / 2)), ...a); // 일부 바이트를 실제로 기록한다
      h.intendedBytes = full.length;
      h.partial = await readDisk(target);
      throw Object.assign(new Error('합성 ENOSPC (writeFile, 일부 기록 뒤)'), { code: 'ENOSPC' });
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
  (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
    if (String(p) === target) h.targetRms++;
    return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
  };
  h.restore = () => {
    (fsp as { open: unknown }).open = realOpen;
    (fsp as { rm: unknown }).rm = realRm;
  };
  return h;
}

const EXTERNAL2 = Buffer.from('정리 직전 외부 프로그램이 새로 만든 합성 파일\r\n', 'utf8');
const MOVED = (target: string) => `${target}.moved-by-test`;
const EXTERNAL = Buffer.from('외부 프로그램이 만든 합성 파일\r\n', 'utf8');
const ORIGINAL = Buffer.from('﻿---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-create-partial-'));
  const chapters = join(root, 'chapters');
  await mkdir(chapters);
  await writeFile(join(chapters, '001.md'), ORIGINAL);
  const sentinel = join(chapters, 'sentinel.txt');
  const sentinelBytes = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');
  await writeFile(sentinel, sentinelBytes);
  return { root, chapters, target: join(chapters, '002.md'), sentinel, sentinelBytes };
}

test('새 화 생성의 실제 대상 writeFile이 일부 기록 뒤 ENOSPC면 호출자에 ENOSPC, 불완전한 002.md가 목록·폴더에 남지 않고 기존 원고·sentinel 불변이며, 해제만으로 자동 생성이 없고, 새 명시 생성만 완전한 파일로 성공한다', { timeout: 30_000 }, async () => {
  const s = await setup();
  const h = hook(s.target);
  try {
    await assert.rejects(createChapter(s.root), (e: NodeJS.ErrnoException) => e.code === 'ENOSPC');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes }, { opens: 1, writes: 1, syncs: 0, closes: 1 }, '대상 open·write 1, sync 0, close 1');
    // 부분 기록이 실제로 있었고 전체보다 짧았다
    assert.ok(h.partial && h.partial.length > 0 && h.partial.length < h.intendedBytes, `부분 기록(${h.partial?.length})이 전체(${h.intendedBytes})보다 짧았다`);
    // 목록·폴더에 불완전한 화가 없다
    const listed = (await listChapters(s.root)).chapters.map((c) => c.file);
    console.log(`관측: 실패 뒤 chapters 폴더 = ${JSON.stringify((await readdir(s.chapters)).sort())}, 목록 = ${JSON.stringify(listed)}`);
    assert.deepEqual(listed, ['001.md'], '실패한 화가 목록에 나타나지 않는다');
    assert.deepEqual((await readdir(s.chapters)).sort(), ['001.md', 'sentinel.txt'], '불완전한 파일이 남지 않았다');
    assert.deepEqual(await readDisk(join(s.chapters, '001.md')), ORIGINAL, '기존 원고 Buffer 불변');
    assert.deepEqual(await readDisk(s.sentinel), s.sentinelBytes, '무관 sentinel 불변');
    // 해제만으로는 자동 생성이 없다 (유한 양보 뒤 계수·목록)
    const snap = { opens: h.opens, writes: h.writes, closes: h.closes };
    h.mode = 'off';
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, closes: h.closes }, snap, '해제 뒤 유한 양보 동안 open·write·close 증가 0');
    assert.deepEqual((await listChapters(s.root)).chapters.map((c) => c.file), ['001.md']);
    // 새 명시 생성만 성공한다
    const created = await createChapter(s.root);
    assert.equal(created.file, '002.md');
    const bytes = await readDisk(s.target);
    assert.equal(created.text, bytes.toString('utf8'), '반환 text가 실제 완전한 파일과 같다');
    assert.equal(created.hash, sha(bytes), '반환 hash가 실제 Buffer 해시와 같다');
    assert.deepEqual(await readChapter(s.root, '002.md'), { text: created.text, hash: created.hash });
    const after = (await listChapters(s.root)).chapters.map((c) => c.file);
    assert.deepEqual(after, ['001.md', '002.md'], '목록과 일치');
    assert.deepEqual(await readDisk(join(s.chapters, '001.md')), ORIGINAL, '기존 원고 보존');
    assert.deepEqual((await readdir(s.chapters)).sort(), ['001.md', '002.md', 'sentinel.txt']);
  } finally {
    h.restore();
  }
});

test('대조: 정확 대상 open(wx)가 EEXIST를 내면 그 경로의 외부 합성 파일은 Buffer 불변·삭제 0이고 오류가 EEXIST로 전달된다', { timeout: 30_000 }, async () => {
  const s = await setup();
  const h = hook(s.target);
  try {
    h.mode = 'preexisting-eexist';
    await assert.rejects(createChapter(s.root), (e: NodeJS.ErrnoException) => e.code === 'EEXIST');
    assert.equal(h.opens, 1);
    assert.deepEqual({ writes: h.writes, syncs: h.syncs, closes: h.closes }, { writes: 0, syncs: 0, closes: 0 }, 'handle을 얻지 못해 write·sync·close 0');
    assert.deepEqual(await readDisk(s.target), EXTERNAL, '외부 합성 파일 Buffer 불변 (삭제·덮어쓰기 0)');
    assert.deepEqual(await readDisk(join(s.chapters, '001.md')), ORIGINAL);
    assert.deepEqual(await readDisk(s.sentinel), s.sentinelBytes);
  } finally {
    h.restore();
  }
});

test('정리 직전 정확 원경로가 다른 외부 파일로 바뀌어 있으면(실제 dev/ino 불일치) 그 외부 파일은 Buffer/hash 불변·삭제 0이고, ENOSPC는 그대로 전달되며, 옮겨 둔 자기 부분 파일·기존 원고·sentinel도 보존된다', { timeout: 30_000 }, async () => {
  const s = await setup();
  const h = hook(s.target);
  try {
    h.mode = 'swap-then-enospc';
    await assert.rejects(createChapter(s.root), (e: NodeJS.ErrnoException) => e.code === 'ENOSPC');
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes }, { opens: 1, writes: 1, syncs: 0, closes: 1 }, '제품의 close 호출 1회(실제 close는 주입 중 래퍼 밖에서 먼저 1회 있었으므로 이는 이미 닫힌 handle에 대한 두 번째 close다)');
    // 실제 다른 파일임을 신원으로 증명: 외부 파일(원경로)과 옮긴 자기 파일의 dev/ino가 다르다
    const external = await (realStat as (p: string, o: object) => Promise<{ dev: bigint; ino: bigint }>)(s.target, { bigint: true });
    const moved = await (realStat as (p: string, o: object) => Promise<{ dev: bigint; ino: bigint }>)(MOVED(s.target), { bigint: true });
    assert.ok(external.dev !== moved.dev || external.ino !== moved.ino, `실제 dev/ino 불일치: 외부 ${external.dev}/${external.ino} vs 자기 ${moved.dev}/${moved.ino}`);
    // 외부 대체 파일 보존·삭제 0
    assert.equal(h.targetRms, 0, '정확 대상 경로에 대한 rm 호출 0');
    assert.deepEqual(await readDisk(s.target), EXTERNAL2, '외부 대체 파일 Buffer 불변');
    assert.equal(sha(await readDisk(s.target)), sha(EXTERNAL2), '외부 대체 파일 hash 불변');
    // 옮긴 자기 부분 파일·기존 원고·sentinel 보존
    assert.deepEqual(await readDisk(MOVED(s.target)), h.partial, '옮긴 자기 부분 파일 보존');
    assert.deepEqual(await readDisk(join(s.chapters, '001.md')), ORIGINAL);
    assert.deepEqual(await readDisk(s.sentinel), s.sentinelBytes);
  } finally {
    h.restore();
  }
});
