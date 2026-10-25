import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { costUsd, estimateExtractionCost, estimateExtractionTokens } from '../../src/core/ai/cost.ts';
import { EXTRACT_SYSTEM, extractionInput, mergeExtractions, parseExtraction, splitForExtraction } from '../../src/core/ai/extraction.ts';
import { checkQuotes, locateQuote } from '../../src/core/ai/locate.ts';
import { DEFAULT_MODEL, modelInfo } from '../../src/core/ai/models.ts';
import { parseC3 } from '../../src/core/manuscript/c3.ts';
import { splitEnvelope } from '../../src/core/manuscript/envelope.ts';
import { visibleLines } from '../../src/core/manuscript/lines.ts';

test('추출 프롬프트는 M0-A에서 검증한 문구와 같다 (sha256 앞 12자리)', () => {
  assert.equal(createHash('sha256').update(EXTRACT_SYSTEM).digest('hex').slice(0, 12), 'fa2971c6f7e8');
});

test('기본 모델은 gpt-6-luna', () => {
  assert.equal(DEFAULT_MODEL, 'gpt-6-luna');
  assert.throws(() => modelInfo('gpt-unknown'), /알 수 없는 모델/);
});

test('비용: 캐시 토큰은 전체 입력에서 빼고 따로 매긴다 (이중 계산 없음)', () => {
  // M0-A 장부 실제 기록: luna 입력 67, 출력 16 → $0.0000147
  assert.equal(costUsd('gpt-6-luna', { inputTokens: 67, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 16 }).toFixed(7), '0.0000147');
  // 입력 1000 중 캐시 읽기 300, 캐시 쓰기 200 → 일반 500
  const sol = costUsd('gpt-6.1-sol', { inputTokens: 1000, cachedTokens: 300, cacheWriteTokens: 200, outputTokens: 100 });
  assert.equal(sol.toFixed(6), ((500 * 2 + 300 * 0.1 + 200 * 2.5 + 100 * 10) / 1e6).toFixed(6));
});

test('예상 비용은 M0-A 추출 호출 45회의 최대 사용량보다 크다 (상한)', () => {
  const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
  const chars = readdirSync(M0A).map((f) => visibleLines(parseC3(splitEnvelope(readFileSync(join(M0A, f), 'utf8')).body)).join('\n').length);
  const smallest = estimateExtractionTokens(Math.min(...chars));
  assert.ok(smallest.input >= 1255, `입력 상한 ${smallest.input}`);
  assert.ok(smallest.output >= 2269, `출력 상한 ${smallest.output}`);
  // luna로 M0-A 한 화 상한은 M3 기준(화당 $0.005) 안
  assert.ok(estimateExtractionCost('gpt-6-luna', Math.max(...chars)) < 0.005);
});

test('추출 입력: 화 번호와 보이는 줄', () => {
  assert.equal(extractionInput('012.md', ['# 12화', '', '본문']), '<chapter n="12">\n# 12화\n\n본문\n</chapter>');
  assert.equal(extractionInput('외전.md', ['본문']), '<chapter n="0">\n본문\n</chapter>');
});

test('응답 형식 검사', () => {
  const ok = { summary: '요약', entities: [{ name: '김민수', aliases: ['민수'] }], facts: [{ entity: '김민수', predicate: '나이', value: '20', quote: '스무 살' }] };
  assert.deepEqual(parseExtraction(ok), ok);
  assert.throws(() => parseExtraction({ summary: '요약', entities: [], facts: [{ entity: '김민수' }] }), /facts\[0\]/);
  assert.throws(() => parseExtraction({ entities: [], facts: [] }), /summary/);
  assert.throws(() => parseExtraction(null), /객체가 아님/);
});

const lines = ['# 1화', '', '"야, 김민수! 거기서 뭐 하냐?"', '', '성진은 민수 옆에 털썩 앉았다. 둘 다 스무 살이었다. 대학생이 된 첫날이었다.'];

test('인용 찾기: 그대로, 줄 번호와 원래 위치', () => {
  const at = locateQuote(lines, '둘 다 스무 살이었다.');
  assert.ok(at);
  assert.equal(at.line, 4);
  assert.equal(lines[4]!.slice(at.start, at.end), '둘 다 스무 살이었다.');
});

test('인용 찾기: 공백 개수, 둥근 따옴표, 생략 표시, 앞뒤 따옴표는 같게 본다', () => {
  assert.equal(locateQuote(lines, '둘 다  스무   살이었다.')?.line, 4);
  assert.equal(locateQuote(lines, '“야, 김민수! 거기서 뭐 하냐?”')?.line, 2);
  const elided = locateQuote(lines, '성진은 민수 옆에 … 대학생이 된 첫날이었다.');
  assert.ok(elided);
  assert.equal(lines[4]!.slice(elided.start, elided.end), lines[4]);
  assert.equal(locateQuote(lines, '"둘 다 스무 살이었다"')?.line, 4);
});

test('인용 찾기: 글자가 다르거나, 순서가 다르거나, 두 줄에 걸치면 없는 것으로 본다', () => {
  assert.equal(locateQuote(lines, '둘 다 스물한 살이었다.'), null);
  assert.equal(locateQuote(lines, '대학생이 된 첫날이었다 … 성진은 민수 옆에'), null);
  assert.equal(locateQuote(lines, '거기서 뭐 하냐? 성진은'), null);
  assert.equal(locateQuote(lines, '  '), null);
});

test('인용 찾기: NFD 본문', () => {
  const nfd = ['그는 민수다'.normalize('NFD')];
  const at = locateQuote(nfd, '민수다');
  assert.ok(at);
  assert.equal(nfd[0]!.slice(at.start, at.end).normalize('NFC'), '민수다');
});

test('인용문 존재 검사: 본문에 없는 인용의 사실은 버린다', () => {
  const result = checkQuotes(
    {
      summary: '',
      entities: [],
      facts: [
        { entity: '김민수', predicate: '나이', value: '20', quote: '둘 다 스무 살이었다.' },
        { entity: '김민수', predicate: '나이', value: '21', quote: '민수는 스물한 살이었다.' },
      ],
    },
    lines,
  );
  assert.deepEqual(result.facts.map((f) => [f.value, f.line]), [['20', 4]]);
  assert.deepEqual(result.dropped.map((f) => f.value), ['21']);
});

test('나눠 추출: 짧은 화는 한 조각, 긴 화는 maxChars를 넘은 뒤 빈 줄에서, 빈 줄이 없으면 두 배에서 끊는다', () => {
  assert.deepEqual(splitForExtraction(['짧은 화', '', '본문'], 100), [['짧은 화', '', '본문']]);
  const p = (n: number) => '가'.repeat(n);
  const chunks = splitForExtraction([p(60), p(50), '', p(60), '', p(30)], 100);
  assert.deepEqual(chunks.map((c) => c.join('\n').replace(/\n+$/, '')), [`${p(60)}\n${p(50)}`, `${p(60)}\n\n${p(30)}`]);
  // 빈 줄 없이 길면 두 배(200)를 넘는 줄에서 끊는다
  const solid = splitForExtraction([p(90), p(90), p(90), p(90)], 100);
  assert.deepEqual(solid.map((c) => c.length), [3, 1]);
  // 모든 줄이 어느 조각엔가 그대로 들어간다
  const lines = [p(60), p(50), '', p(60), '', p(30)];
  assert.deepEqual(splitForExtraction(lines, 100).flat(), lines);
});

test('나눠 추출: M0-A 화(합성 원고)는 모두 한 조각이라 지금과 같다', () => {
  const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
  for (const f of readdirSync(M0A)) {
    const lines = visibleLines(parseC3(splitEnvelope(readFileSync(join(M0A, f), 'utf8')).body));
    assert.equal(splitForExtraction(lines).length, 1, f);
  }
});

test('조각 합치기: 인물은 이름으로 합쳐 별칭을 모으고, 같은 사실은 하나만, 요약은 잇는다', () => {
  const merged = mergeExtractions([
    { summary: '앞.', entities: [{ name: '김민수', aliases: ['민수'] }], facts: [{ entity: '김민수', predicate: '나이', value: '20', quote: 'q1' }] },
    {
      summary: ' 뒤. ',
      entities: [
        { name: '김민수', aliases: ['민수', '김 대표', '김민수'] },
        { name: '이지현', aliases: [] },
      ],
      facts: [
        { entity: '김민수', predicate: '나이', value: '20', quote: 'q1' },
        { entity: '김민수', predicate: '학과', value: '전자', quote: 'q2' },
      ],
    },
  ]);
  assert.equal(merged.summary, '앞. 뒤.');
  assert.deepEqual(merged.entities, [
    { name: '김민수', aliases: ['민수', '김 대표'] },
    { name: '이지현', aliases: [] },
  ]);
  assert.deepEqual(merged.facts.map((f) => f.quote), ['q1', 'q2']);
});
