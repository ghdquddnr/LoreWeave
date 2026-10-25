// .txt 장편을 화로 나누기 (M6-PLAN 2절). 지어낸 문장만 쓴다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterText, decodeText, isSceneBreak, naturalCompare, sampleChapters, sanitizeLine, splitChapters, splitLines, visibleChars } from '../../scripts/lib/import-txt.ts';
import { parseC3 } from '../../src/core/manuscript/c3.ts';
import { splitEnvelope } from '../../src/core/manuscript/envelope.ts';
import { visibleLines } from '../../src/core/manuscript/lines.ts';

test('인코딩: UTF-8은 그대로, 아니면 CP949로 읽는다', () => {
  assert.deepEqual(decodeText(new TextEncoder().encode('\uFEFF한글')), { text: '한글', encoding: 'utf-8' });
  // "한글"의 CP949 바이트
  assert.deepEqual(decodeText(Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb])), { text: '한글', encoding: 'cp949' });
});

test('줄 나누기: CRLF, CR, NEL을 모두 줄바꿈으로, 줄 끝 공백은 뺀다', () => {
  assert.deepEqual(splitLines('가  \r\n나\r다\u0085라'), ['가', '나', '다', '라']);
});

test('서식 기호: 제목·인용·구분선·강조로 읽히지 않게 바꾸고 글자 수는 그대로', () => {
  const lines = ['# 제목처럼', '> 인용처럼', '---', '**강조**처럼', '[상태창] 레벨 : 3'];
  const safe = lines.map(sanitizeLine);
  assert.deepEqual(safe, ['＃ 제목처럼', '＞ 인용처럼', '－－－', '＊＊강조＊＊처럼', '[상태창] 레벨 : 3']);
  assert.deepEqual(safe.map(visibleChars), lines.map(visibleChars));
  // 원고 형식으로 읽어도 모든 글자가 보이는 줄에 남는다
  const text = chapterText(1, safe);
  const visible = visibleLines(parseC3(splitEnvelope(text).body)).join('');
  for (const l of safe) assert.ok(visible.includes(l.trim()), l);
});

test('장면 구분 줄: 기호만 3개 이상', () => {
  assert.ok(isSceneBreak('＊＊＊＊'));
  assert.ok(isSceneBreak('  ======  '));
  assert.ok(isSceneBreak('◆ ◆ ◆'));
  assert.ok(!isSceneBreak('...'.slice(0, 2)));
  assert.ok(!isSceneBreak('"......"'.replace(/"/g, '') + '가'));
  assert.ok(!isSceneBreak(''));
});

test('화 나누기: 권 경계에서 항상 끊고, 목표의 80%를 넘은 뒤 빈 줄·장면 구분에서, 130%를 넘으면 문단 끝에서', () => {
  const para = (n: number) => '가'.repeat(n);
  const volume1 = [para(30), para(30), '', para(30), para(30), '＊＊＊', para(10)];
  const volume2 = [para(50), para(50), para(50)];
  const chapters = splitChapters([volume1, volume2], { target: 100 });
  // 권 1: 30+30 → 빈 줄(60, 80% 미만이라 계속) → 30+30=120 → 장면 구분에서 끊음 → 나머지 10
  // 권 2: 50+50=100 (130 미만, 경계 없음) → 150 ≥ 130 → 끊음
  assert.deepEqual(
    chapters.map((c) => c.reduce((n, l) => n + visibleChars(l), 0)),
    [123, 10, 150],
  );
  assert.ok(chapters.every((c) => c[0]!.trim() && c.at(-1)!.trim()));
});

test('화 파일: 제목 줄과 원문, 빈 줄은 셋 이상이면 하나로', () => {
  assert.equal(chapterText(7, ['가', '', '', '', '나']), '# 7화\n\n가\n\n나\n');
});

test('권 순서: 숫자는 숫자로', () => {
  assert.deepEqual(['책 10권.txt', '책 2권.txt', '책 1권.txt', '책 12권(完).txt'].sort(naturalCompare), ['책 1권.txt', '책 2권.txt', '책 10권.txt', '책 12권(完).txt']);
});

test('측정할 화: 2화부터 마지막 화까지 고르게, 겹치지 않게', () => {
  const files = Array.from({ length: 265 }, (_, i) => `${String(i + 1).padStart(3, '0')}.md`);
  const picked = sampleChapters(files, 20);
  assert.equal(picked.length, 20);
  assert.equal(picked[0], '002.md');
  assert.equal(picked.at(-1), '265.md');
  assert.equal(new Set(picked).size, 20);
  assert.deepEqual(sampleChapters(files.slice(0, 5), 20), files.slice(1, 5));
});
