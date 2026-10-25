// 연속성 탐지 규칙 (M4-PLAN 1·2·4절): 프롬프트, 앞 화 사실 고르기, 입력 형식, 응답 형식, 결과 검증, 검사 예상 비용.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { costUsd, estimateCheckCost, estimateCheckTokens } from '../../src/core/ai/cost.ts';
import {
  attributeKey,
  candidateFacts,
  CATEGORIES,
  CATEGORY_LABELS,
  DETECT_SYSTEM,
  detectionInput,
  entityNames,
  parseDetection,
  sameEntity,
  selectFacts,
  SELECTIONS,
  type Finding,
  type PriorAnalysis,
} from '../../src/core/ai/detection.ts';
import { mergeFindings, quoteKey, verifyFindings, type PriorLines } from '../../src/core/ai/verify.ts';

test('탐지 프롬프트는 M0-A에서 검증한 문구와 같다 (sha256 앞 12자리)', () => {
  assert.equal(createHash('sha256').update(DETECT_SYSTEM).digest('hex').slice(0, 12), '53207cd406ae');
});

test('종류마다 화면 이름이 있다', () => {
  for (const c of CATEGORIES) assert.ok(CATEGORY_LABELS[c]);
});

test('이름 맞추기: 2글자 이상, 한쪽이 다른 쪽을 포함하면 같은 인물', () => {
  assert.deepEqual(entityNames([{ name: '김민수', aliases: ['민수', '민', ' 민수 '] }, { name: '박성진', aliases: [] }]), ['김민수', '민수', '박성진']);
  assert.ok(sameEntity('민수', '김민수'));
  assert.ok(!sameEntity('민', '김민수'));
  assert.ok(!sameEntity('민수', '성진'));
});

const priors: PriorAnalysis[] = [
  {
    chapter: 2,
    entities: [{ name: '이지현', aliases: ['지현 선배'] }],
    facts: [{ entity: '이지현', predicate: '학년', value: '4학년', quote: '지현은 4학년이었다.' }],
  },
  {
    chapter: 1,
    entities: [
      { name: '김민수', aliases: ['민수'] },
      { name: '박성진', aliases: ['성진'] },
    ],
    facts: [
      { entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' },
      { entity: '박성진', predicate: '고향', value: '부산', quote: '부산에서 수원으로 올라왔다.' },
    ],
  },
];

test('앞 화 사실 고르기: 검사할 화에 나오는 인물(별칭 포함)의 사실만, 화 순서대로', () => {
  const facts = candidateFacts([{ name: '민수', aliases: [] }, { name: '지현 선배', aliases: [] }], priors);
  assert.deepEqual(
    facts.map((f) => [f.chapter, f.entity, f.value]),
    [
      [1, '김민수', '스무 살'],
      [2, '이지현', '4학년'],
    ],
  );
  assert.deepEqual(candidateFacts([{ name: '오태식', aliases: [] }], priors), []);
});

test('검사 입력: M0-A B 전략과 같은 형식', () => {
  const facts = candidateFacts([{ name: '김민수', aliases: [] }], priors);
  assert.equal(
    detectionInput('003.md', ['# 3화. MT', '', '민수는 스물두 살입니다.'], facts),
    [
      '# 참고 자료 (이전 화)',
      '<facts chapter="1">',
      '- 김민수 | 나이 | 스무 살 | 원문: "둘 다 스무 살이었다."',
      '</facts>',
      '',
      '# 검사 대상: 3화',
      '<chapter n="3">',
      '# 3화. MT',
      '',
      '민수는 스물두 살입니다.',
      '</chapter>',
    ].join('\n'),
  );
  assert.match(detectionInput('003.md', ['본문'], []), /^# 참고 자료 \(이전 화\)\n\(없음\)\n/);
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  category: 'age',
  target_quote: '민수는 스물두 살입니다.',
  claim: '1화에서는 스무 살이다.',
  evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }],
  confidence: 0.9,
  ...over,
});

test('응답 형식 검사: 모르는 종류, 정수가 아닌 화 번호는 거부하고, 확신도는 0~1로 자른다', () => {
  assert.deepEqual(parseDetection({ findings: [finding()] }), [finding()]);
  assert.deepEqual(parseDetection({ findings: [] }), []);
  assert.equal(parseDetection({ findings: [finding({ confidence: 1.4 })] })[0]!.confidence, 1);
  assert.throws(() => parseDetection({ findings: [{ ...finding(), category: 'weather' }] }), /category/);
  assert.throws(() => parseDetection({ findings: [finding({ evidence: [{ chapter: 1.5, quote: 'x' }] })] }), /evidence\[0\]/);
  assert.throws(() => parseDetection({ findings: [{ ...finding(), confidence: 'high' }] }), /confidence/);
  assert.throws(() => parseDetection({}), /findings/);
});

const targetLines = ['# 3화. MT', '', '"민수는 스물두 살입니다." 지현이 말했다.'];
const priorLines: PriorLines = new Map([
  [1, { file: '001.md', lines: ['# 1화', '', '성진은 민수 옆에 앉았다. 둘 다 스무 살이었다.'] }],
  [2, { file: '002.md', lines: ['# 2화', '', '지현은 4학년이었다.'] }],
]);

test('결과 검증: 이 화 문장과 근거 문장의 위치를 붙인다', () => {
  const { findings, dropped } = verifyFindings([finding()], targetLines, priorLines);
  assert.equal(dropped.length, 0);
  const [f] = findings;
  assert.ok(f);
  assert.equal(targetLines[f.target.line]!.slice(f.target.start, f.target.end), '민수는 스물두 살입니다.');
  assert.deepEqual(f.evidence.map((e) => [e.file, e.chapter, e.line]), [['001.md', 1, 2]]);
  const e = f.evidence[0]!;
  assert.equal(priorLines.get(1)!.lines[e.line]!.slice(e.start, e.end), '둘 다 스무 살이었다.');
});

test('결과 검증: 이 화에 없는 문장, 앞 화에 없는 근거만 가진 결과는 버리고, 없는 근거는 뺀다', () => {
  const { findings, dropped } = verifyFindings(
    [
      finding({ target_quote: '민수는 스물세 살입니다.' }),
      finding({ evidence: [{ chapter: 1, quote: '민수는 스물한 살이었다.' }] }),
      // 앞 화가 아닌 화(검사하는 화 자신, 뒤 화)를 근거로 든 것
      finding({ evidence: [{ chapter: 3, quote: '민수는 스물두 살입니다.' }] }),
      finding({ evidence: [{ chapter: 9, quote: '둘 다 스무 살이었다.' }, { chapter: 1, quote: '둘 다 스무 살이었다.' }] }),
    ],
    targetLines,
    priorLines,
  );
  assert.equal(dropped.length, 3);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.evidence.map((e) => e.chapter), [1]);
});

test('검사 예상 비용은 M0-A 검사 호출의 최대 사용량보다 크고, luna 검사 한 번은 $0.005 안이다', () => {
  // M0-A B 전략 검사 84회: 입력 토큰 ≤ 0.87×글자 수, 출력 최대 890토큰, 입력 최대 18,282자
  for (const chars of [2444, 10000, 18282]) {
    const t = estimateCheckTokens(chars);
    assert.ok(t.input >= 0.87 * chars);
    assert.ok(t.output >= 890);
  }
  assert.ok(estimateCheckCost('gpt-6-luna', 18282) < 0.005);
  // 상한은 같은 사용량의 실제 비용 계산과 같은 단가를 쓴다
  const t = estimateCheckTokens(5000);
  assert.equal(estimateCheckCost('gpt-6.1-sol', 5000), costUsd('gpt-6.1-sol', { inputTokens: t.input, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: t.output }));
});

test('무시 키: 공백, 따옴표 모양, 감싼 따옴표는 같게 보고 글자가 다르면 다르다', () => {
  assert.equal(quoteKey('"스물두  살입니다."'), quoteKey('스물두 살입니다.'));
  assert.equal(quoteKey('“스물두 살입니다.”'), '스물두 살입니다.');
  assert.notEqual(quoteKey('스물두 살입니다.'), quoteKey('스물세 살입니다.'));
});

test('속성 키: 괄호 안 내용과 공백은 같게 본다', () => {
  assert.equal(attributeKey({ entity: '김민수', predicate: '나이 (2008년)' }), attributeKey({ entity: '김민수', predicate: '나이' }));
  assert.notEqual(attributeKey({ entity: '김민수', predicate: '나이' }), attributeKey({ entity: '이지현', predicate: '나이' }));
});

test('사실 줄이기: 전부 / 첫 값과 최신 값 / 최근 N개 / 둘을 합친 것 (화 순서는 지킨다)', () => {
  const f = (chapter: number, entity: string, predicate: string, value: string) => ({ chapter, entity, predicate, value, quote: `${chapter}화 ${value}` });
  const facts = [
    f(1, '김민수', '나이', '20'),
    f(1, '김민수', '학과', '전자공학과'),
    f(2, '김민수', '나이 (2007)', '20'),
    f(3, '이지현', '학과', '경영학과'),
    f(4, '김민수', '나이', '21'),
    f(5, '이지현', '습관', '왼손잡이'),
  ];
  const values = (xs: typeof facts) => xs.map((x) => `${x.chapter}:${x.value}`);
  assert.equal(selectFacts(facts, 'all'), facts);
  // 민수 나이는 1화(처음)와 4화(최신)만, 2화는 뺀다
  assert.deepEqual(values(selectFacts(facts, 'first-latest')), ['1:20', '1:전자공학과', '3:경영학과', '4:21', '5:왼손잡이']);
  assert.deepEqual(values(selectFacts(facts, 'recent', 2)), ['4:21', '5:왼손잡이']);
  // 상한 4 → 속성 2개: 가장 최근에 언급된 지현 습관(5화)과 민수 나이(4화)
  assert.deepEqual(values(selectFacts(facts, 'first-latest-recent', 4)), ['1:20', '4:21', '5:왼손잡이']);
  for (const s of SELECTIONS) assert.ok(selectFacts(facts, s, 4).length <= (s === 'all' || s === 'first-latest' ? facts.length : 4));
});

test('결과 합치기: 같은 종류·같은 문장은 하나로, 근거는 겹치지 않게 모으고 확신도는 높은 쪽', () => {
  const base = { category: 'age' as const, claim: '첫 설명', key: '스물두 살입니다.', target: { quote: '스물두 살입니다.', line: 2, start: 1, end: 10 } };
  const ev = (chapter: number, line: number) => ({ file: `00${chapter}.md`, chapter, quote: 'q', line, start: 0, end: 1 });
  const merged = mergeFindings([
    { ...base, confidence: 0.6, evidence: [ev(1, 2)] },
    { ...base, claim: '두 번째 설명', confidence: 0.9, evidence: [ev(1, 2), ev(2, 5)] },
    { ...base, category: 'number' as const, confidence: 0.5, evidence: [ev(1, 3)] },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.claim, '첫 설명');
  assert.equal(merged[0]!.confidence, 0.9);
  assert.deepEqual(merged[0]!.evidence.map((e) => [e.chapter, e.line]), [[1, 2], [2, 5]]);
});
