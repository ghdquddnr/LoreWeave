// 기존 원고 저장(writeChapter→atomicWrite)에서 최초 저장 오류(A)가 tmp 정리 rm 오류(B)에 가려지지 않고 호출자에게 A가 그대로 전달되는지 본다.
// 환경 기법(합성): 독점 새 임시 원고 폴더. fs/promises.open을 원고 경로 + '.' + UUID + '.tmp' 이고 wx인 호출에만 한정해 감싸 실제 FileHandle을 얻고, 그 인스턴스 writeFile에서 원래 메서드로 앞 절반 바이트만 실제로 기록한 뒤 합성 ENOSPC 객체 A를 던진다.
// 같은 정확 tmp의 rm만 별개의 합성 EIO 객체 B로 거절한다(그래서 부분 tmp가 실제로 남는다). sync·close·rename은 원메서드 통과·계수(close는 실제 성공, sync 0·rename 0). prototype 전역 패치·결과 대역 없음. 원래 fs 함수는 hook 설치 전에 보존하고 검증은 그것을 쓴다.
// 실제 디스크 고갈·ACL 시험이 아니다. rm 실패 시 실패한 tmp는 잔류할 수 있으며 이 테스트는 잔류 없음을 주장하지 않는다(자동 정리 정책 없음). 한계: "해제만으로 자동 저장·정리 없음"은 임의 sleep이 아니라 setImmediate 몇 번 양보한 뒤의 계수·파일 관측(유한 양보).
// close 동시 실패·createChapter·settings 등은 범위 밖. finally에서 원함수 복구 후 이 테스트가 만든 독점 폴더만 정리, 테스트 timeout, node:test 파일별 별도 프로세스.

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
  rmError: Error | null;
  failRm: boolean;
  restore: () => void;
};

function hook(target: string): Hook {
  const tmpPattern = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-f-]{36}\\.tmp$`);
  const h: Hook = { fail: true, opens: 0, writes: 0, syncs: 0, enospcFailed: 0, closes: 0, renames: 0, tmpRms: 0, tmpPath: null, partialBytes: null, intendedBytes: 0, enospc: null, rmError: null, failRm: true, restore: () => undefined };
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
    if (tmpPattern.test(String(p))) {
      h.tmpRms++;
      if (h.failRm) {
        h.rmError = Object.assign(new Error('합성 EIO (tmp rm 거절)'), { code: 'EIO' }); // 최초 오류와 별개의 객체 B
        throw h.rmError;
      }
    }
    return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
  };
  h.restore = () => {
    (fsp as { open: unknown }).open = realOpen;
    (fsp as { rename: unknown }).rename = realRename;
    (fsp as { rm: unknown }).rm = realRm;
  };
  return h;
}

test('최초 저장 오류 A(tmp 부분 기록 ENOSPC)가 tmp 정리 rm 오류 B(EIO)에 가려지지 않고 A 객체가 그대로 전달되며, 부분 tmp는 잔류하되 원고·sentinel 불변이고, 해제만으로 자동 저장·정리가 없으며, 새 명시 저장은 정상 저장한다', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'loreweave-first-error-'));
  const chapters = join(root, 'chapters');
  await mkdir(chapters);
  const target = join(chapters, '001.md');
  const sentinel = join(chapters, 'sentinel.txt');
  const sentinelBytes = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');
  const original = Buffer.from('\uFEFF---\r\nid: syn-1\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');
  await writeFile(target, original);
  await writeFile(sentinel, sentinelBytes);
  const read0 = await readChapter(root, '001.md');
  assert.equal(read0.hash, sha(original));
  const failedText = '\uFEFF---\r\nid: syn-1\r\n---\r\n실패할 저장 본문\r\n';
  const recoverText = '\uFEFF---\r\nid: syn-1\r\n---\r\n복구 뒤 새 본문\r\n한글 CRLF 유지\r\n';
  const h = hook(target);
  try {
    let caught: unknown;
    let returned: unknown = 'not-returned';
    try {
      returned = await writeChapter(root, '001.md', failedText, read0.hash);
    } catch (e) {
      caught = e;
    }
    assert.equal(returned, 'not-returned', '성공(saved) 반환 0');
    assert.ok(h.enospc && h.rmError && h.enospc !== h.rmError, '최초 오류 A와 정리 오류 B는 별개 객체다');
    assert.equal(caught, h.enospc, '호출자는 최초 저장 오류 A를 그대로 받는다');
    assert.notEqual(caught, h.rmError, 'B가 A를 가리지 않았다');
    assert.deepEqual({ opens: h.opens, writes: h.writes, enospcFailed: h.enospcFailed, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms }, { opens: 1, writes: 1, enospcFailed: 1, syncs: 0, closes: 1, renames: 0, tmpRms: 1 }, 'tmp open·write(ENOSPC)·close 각 1, sync 0, rename 0, 정확 tmp rm 시도 1');
    // 실제 부분 tmp가 잔류한다 (rm이 거절됐으므로) — 잔류 없음을 주장하지 않는다
    assert.ok(h.partialBytes && h.partialBytes.length > 0 && h.partialBytes.length < h.intendedBytes, '부분 기록이 0보다 크고 전체보다 짧다');
    const leftovers = (await readdir(chapters)).filter((n) => n !== '001.md' && n !== 'sentinel.txt');
    console.log(`관측: rm 거절 뒤 잔류 tmp = ${JSON.stringify(leftovers)} (자동 정리 정책은 만들지 않음)`);
    assert.equal(leftovers.length, 1, '실패한 tmp 한 개가 잔류한다');
    const tmpFile = join(chapters, leftovers[0]!);
    assert.deepEqual(await readDisk(tmpFile), h.partialBytes, '잔류 tmp는 실제 부분 바이트다');
    assert.deepEqual(await readDisk(target), original, '기존 원고 Buffer 불변');
    assert.equal(sha(await readDisk(target)), read0.hash, '기존 원고 hash 불변');
    assert.equal((await readChapter(root, '001.md')).text, original.toString('utf8'));
    assert.deepEqual(await readDisk(sentinel), sentinelBytes, 'sentinel 불변');
    // 해제만으로는 자동 저장·자동 정리가 없다 (유한 양보 뒤 계수·파일 snapshot과 비교)
    const snap = { opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms };
    h.fail = false;
    h.failRm = false;
    await yieldTasks();
    assert.deepEqual({ opens: h.opens, writes: h.writes, syncs: h.syncs, closes: h.closes, renames: h.renames, tmpRms: h.tmpRms }, snap, '해제 뒤 유한 양보 동안 open·write·sync·close·rename·rm 증가 0');
    assert.deepEqual(await readDisk(target), original, '해제만으로 원고가 바뀌지 않았다');
    assert.deepEqual(await readDisk(tmpFile), h.partialBytes, '해제만으로 잔류 tmp가 정리되지도 바뀌지도 않았다');
    // 새 명시 저장은 기존 hash로 완전한 새 본문을 저장한다 (앞선 실패 tmp와 별개)
    const result = await writeChapter(root, '001.md', recoverText, read0.hash);
    assert.equal(result.status, 'saved');
    assert.deepEqual({ opens: h.opens, syncs: h.syncs, renames: h.renames }, { opens: 2, syncs: 1, renames: 1 }, '새 저장은 실제 sync·rename 1회씩');
    const finalBytes = await readDisk(target);
    assert.deepEqual(finalBytes, Buffer.from(recoverText, 'utf8'), '의도한 복구 원문 그대로 (BOM/CRLF/frontmatter/한글)');
    if (result.status === 'saved') assert.equal(result.hash, sha(finalBytes), '반환 hash가 실제 Buffer 해시와 일치');
    assert.ok(!finalBytes.includes(Buffer.from('실패할 저장 본문', 'utf8')), '실패한 저장 본문이 섞이지 않았다');
    assert.deepEqual(await readDisk(tmpFile), h.partialBytes, '앞선 실패 tmp는 별개로 그대로 남아 있다');
    assert.deepEqual(await readDisk(sentinel), sentinelBytes);
  } finally {
    h.restore();
    await (realRm as (p: string, o: object) => Promise<void>)(root, { recursive: true, force: true }); // 이 테스트가 만든 독점 폴더만 정리한다
  }
});
