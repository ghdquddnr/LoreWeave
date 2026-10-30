// 줄 단위 차이(저장 충돌 비교)와 사용자 오류 문구 정리.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapseContext, diffLines, diffStats, MAX_DIFF_CELLS } from '../../src/core/diff.ts';
import { friendlyError } from '../../src/renderer/src/userError.ts';

const text = (ops: ReturnType<typeof diffLines>) => ops!.map((o) => `${o.type === 'same' ? ' ' : o.type === 'del' ? '-' : '+'}${o.text}`);

test('diffLines: 같은 줄·내 쪽에만 있는 줄(-)·디스크에만 있는 줄(+)을 맞춘다', () => {
  assert.deepEqual(text(diffLines(['a', 'b'], ['a', 'b'])), [' a', ' b']);
  assert.deepEqual(text(diffLines(['a', 'b', 'c'], ['a', 'X', 'c'])), [' a', '-b', '+X', ' c']);
  assert.deepEqual(text(diffLines(['a'], [])), ['-a']);
  assert.deepEqual(text(diffLines([], ['a', 'b'])), ['+a', '+b']);
  // 중간에 줄이 더해지고 지워진 경우: 같은 줄은 어긋나지 않는다
  assert.deepEqual(text(diffLines(['1', '2', '3', '4', '5'], ['1', 'x', '3', '4', 'y', '5'])), [' 1', '-2', '+x', ' 3', ' 4', '+y', ' 5']);
  // 빈 줄과 중복 줄
  assert.deepEqual(text(diffLines(['a', '', 'a'], ['a', 'a'])), [' a', '-', ' a']);
  assert.deepEqual(diffStats(diffLines(['a', 'b', 'c'], ['a', 'X', 'c'])!), { removed: 1, added: 1 });
});

test('diffLines: 되돌리면 원래 줄이 나온다 (적용하면 한쪽이 다른 쪽이 된다)', () => {
  const a = ['시작', '', '내가 쓴 줄', '같은 줄', '마지막'];
  const b = ['시작', '디스크가 바꾼 줄', '같은 줄', '새 줄', '마지막'];
  const ops = diffLines(a, b)!;
  assert.deepEqual(ops.filter((o) => o.type !== 'add').map((o) => o.text), a, '같음+지움 = 내 쪽');
  assert.deepEqual(ops.filter((o) => o.type !== 'del').map((o) => o.text), b, '같음+더함 = 디스크 쪽');
});

test('diffLines: 너무 큰 비교는 null', () => {
  const big = Math.ceil(Math.sqrt(MAX_DIFF_CELLS)) + 10;
  const a = Array.from({ length: big }, (_, i) => `a${i}`);
  const b = Array.from({ length: big }, (_, i) => `b${i}`);
  assert.equal(diffLines(a, b), null);
});

test('collapseContext: 바뀐 줄 둘레만 남기고 같은 줄 구간은 접는다', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const b = [...a];
  b[10] = 'CHANGED';
  const rows = collapseContext(diffLines(a, b)!, 2);
  assert.deepEqual(rows.map((r) => (r.type === 'gap' ? `gap${r.count}` : `${r.type}:${r.text}`)), ['gap8', 'same:l8', 'same:l9', 'del:l10', 'add:CHANGED', 'same:l11', 'same:l12', 'gap7']);
});

test('friendlyError: IPC 문구·파일 시스템 코드·절대 경로는 기본 안내에서 빠지고 기술 상세에만 남는다', () => {
  const ipc = new Error("Error invoking remote method 'appearance:update': Error: EISDIR: illegal operation on a directory, open 'C:\\Users\\HONG\\AppData\\Local\\Temp\\ud\\settings.json.tmp'");
  const f = friendlyError(ipc);
  assert.doesNotMatch(f.summary, /Error invoking|EISDIR|C:\\|settings\.json|AppData/);
  assert.match(f.summary, /위치를 사용할 수 없습니다/);
  assert.match(f.detail, /EISDIR/);
  assert.match(f.detail, /C:\\Users/);

  const eperm = friendlyError(new Error("Error invoking remote method 'chapter:write': Error: EPERM: operation not permitted, rename 'D:\\원고\\002.md.tmp' -> 'D:\\원고\\002.md'"));
  assert.doesNotMatch(eperm.summary, /EPERM|D:\\|rename/);
  assert.match(eperm.summary, /파일에 쓸 수 없습니다/);
  assert.match(eperm.detail, /EPERM/);

  // 이미 사람이 읽는 문장은 그대로 쓰고 상세는 비운다
  const plain = friendlyError(new Error('원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다'));
  assert.deepEqual(plain, { summary: '원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다', detail: '' });
  assert.deepEqual(friendlyError('API 키가 없습니다'), { summary: 'API 키가 없습니다', detail: '' });
  // 알 수 없는 기술 메시지: 일반 안내 + 상세
  const unknown = friendlyError(new Error('ECONNRESET at Socket.onClose C:\\x\\y.js:10'));
  assert.doesNotMatch(unknown.summary, /ECONNRESET|C:\\/);
  assert.match(unknown.detail, /ECONNRESET/);
  assert.equal(friendlyError(null).summary, '예상하지 못한 오류가 발생했습니다');
});
