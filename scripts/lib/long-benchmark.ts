// 150화 긴 시험 원고 만들기 (M5-PLAN 1절). 순수 함수만 둔다 (생성 호출은 scripts/gen-long-benchmark.ts).
//   - M0-A 원래 화 k는 10k − 9번째 (1, 11, …, 141). 그 사이와 15화 뒤에 중간 화 9개씩, 모두 135개
//   - 중간 화는 설정집·플롯을 따르고 의도적인 오류를 넣지 않는다. 정답표는 화 번호만 바꾼다

export const TOTAL_CHAPTERS = 150;
export const ORIGINAL_CHAPTERS = 15;
export const FILLERS_PER_GAP = 9;

export const originalPosition = (k: number) => 10 * k - 9;
export const isOriginalPosition = (n: number) => n % 10 === 1 && n <= originalPosition(ORIGINAL_CHAPTERS);

/** 중간 화 n이 놓인 자리: 원래 화 before 뒤, after 앞(15화 뒤면 null), 그 사이 index번째(1~9) */
export function gapOf(n: number): { before: number; after: number | null; index: number } {
  if (n < 1 || n > TOTAL_CHAPTERS || isOriginalPosition(n)) throw new Error(`중간 화가 아닙니다: ${n}`);
  const before = Math.floor((n - 1) / 10) + 1;
  return { before, after: before < ORIGINAL_CHAPTERS ? before + 1 : null, index: n - originalPosition(before) };
}

export const fillerPositions = () => Array.from({ length: TOTAL_CHAPTERS }, (_, i) => i + 1).filter((n) => !isOriginalPosition(n));

export const chapterFile = (n: number) => `${String(n).padStart(3, '0')}.md`;

/**
 * 150화를 저장소에는 파일 하나(chapters.json, { "001.md": 본문, … })로 둔다.
 * 파일 150개를 한 PR에 올리면 리뷰 도구가 거부하기 때문이다. 측정할 때 chapters/로 풀어 쓴다.
 */
export const PACKED_FILE = 'chapters.json';

export function packChapters(files: Record<string, string>): string {
  const names = Object.keys(files).sort();
  const expected = Array.from({ length: TOTAL_CHAPTERS }, (_, i) => chapterFile(i + 1));
  if (names.join() !== expected.join()) throw new Error(`화 ${TOTAL_CHAPTERS}개가 모두 있어야 묶을 수 있습니다 (지금 ${names.length}개)`);
  return JSON.stringify(Object.fromEntries(names.map((n) => [n, files[n]!])), null, 1) + '\n';
}

export function unpackChapters(json: string): Record<string, string> {
  const files = JSON.parse(json) as Record<string, string>;
  if (Object.keys(files).length !== TOTAL_CHAPTERS) throw new Error(`${PACKED_FILE}에 화가 ${Object.keys(files).length}개 있습니다`);
  return files;
}

export interface PlotChapter {
  n: number;
  title: string;
  /** 플롯에 적힌 날짜 그대로 (예: 2007-05-25, 2008-07) */
  date: string;
}

/** plot.md의 "## 3화 — MT (2007-05-25)" 제목들 */
export function parsePlot(plot: string): PlotChapter[] {
  const out: PlotChapter[] = [];
  for (const m of plot.matchAll(/^## (\d+)화 — (.+?) \((.+?)\)\s*$/gm)) out.push({ n: Number(m[1]), title: m[2]!, date: m[3]! });
  return out;
}

/**
 * 생성 입력에서 오류 계획을 뺀다: 평가용 안내(인용 블록), "[오류 Exx]" 줄, 설정 줄 끝의 "— …오류…" 메모.
 * 설정 자체(예: "술을 전혀 못 마신다")는 남긴다.
 */
export function canonOnly(doc: string): string {
  return doc
    .split('\n')
    .filter((line) => !line.startsWith('>') && !/^\s*- \*\*\[오류/.test(line))
    .map((line) => line.replace(/\s*—\s*[^—]*오류[^—]*$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 플롯 날짜 "2007-05-25" 또는 "2008-07"(그 달 1일로 봄) */
function parseDate(date: string): Date {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(date);
  if (!m) throw new Error(`플롯 날짜를 읽을 수 없습니다: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? '1')));
}

/** 중간 화의 날짜: 앞뒤 원래 화 날짜 사이를 10등분한 자리 (15화 뒤는 석 달 동안) */
export function fillerDate(n: number, plot: PlotChapter[]): string {
  const { before, after, index } = gapOf(n);
  const from = parseDate(plot.find((p) => p.n === before)!.date);
  const to = after === null ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 3, from.getUTCDate())) : parseDate(plot.find((p) => p.n === after)!.date);
  const at = new Date(from.getTime() + ((to.getTime() - from.getTime()) * index) / (FILLERS_PER_GAP + 1));
  return `${at.getUTCFullYear()}년 ${at.getUTCMonth() + 1}월 ${at.getUTCDate()}일`;
}

/** 원래 화의 제목 줄 "# 3화. MT"를 새 번호로 */
export function renumberHeading(text: string, n: number): string {
  if (!/^# \d+화\./.test(text)) throw new Error('원래 화의 첫 줄이 "# N화." 형식이 아닙니다');
  return text.replace(/^# \d+화\./, `# ${n}화.`);
}

interface QuoteSet {
  chapter: number;
  quotes: string[];
}
interface GroundTruth {
  version: number;
  notes: string;
  errors: ({ target: QuoteSet; sources: QuoteSet[]; distance: number } & Record<string, unknown>)[];
  traps: ({ chapter: number } & Record<string, unknown>)[];
}

/** M0-A 정답표의 화 번호를 150화 위치로 바꾼다. 거리(distance)도 새 번호로 다시 센다 */
export function renumberGroundTruth(gt: GroundTruth): GroundTruth {
  const at = (k: number) => originalPosition(k);
  return {
    ...gt,
    notes: `${gt.notes} | M5: 원래 화 k를 150화 중 10k−9번째에 두고 화 번호만 바꿈. 중간 화(그 밖의 번호)는 정답이 없음.`,
    errors: gt.errors.map((e) => {
      const target = { ...e.target, chapter: at(e.target.chapter) };
      const sources = e.sources.map((s) => ({ ...s, chapter: at(s.chapter) }));
      return { ...e, target, sources, distance: target.chapter - Math.max(...sources.map((s) => s.chapter)) };
    }),
    traps: gt.traps.map((t) => ({ ...t, chapter: at(t.chapter) })),
  };
}

export const FILLER_PROMPT_VERSION = 'filler-2';

export const FILLER_SYSTEM = `당신은 장편 웹소설 『미래전자』의 보조 작가다. 원작 화 사이에 들어갈 중간 화를 한 편 쓴다.

규칙
1. 설정집의 사실(이름, 나이, 학과, 직업·직책, 인물 관계, 날짜, 장소, 출신지, 습관·체질, 생사)을 그대로 따른다. 설정집과 다른 내용을 만들지 않는다.
2. 나이는 설정집의 세는 나이 규칙을 따른다. 이 화가 속한 해의 나이를 쓴다.
3. 이 화의 날짜는 주어진 두 원작 화 사이다. 그보다 뒤에 일어날 사건(뒤 원작 화의 내용)은 쓰지 않는다. 이미 일어난 사건은 언급할 수 있다.
4. 원작 화의 큰 사건을 다시 쓰지 않는다. 그 사이의 일상, 작은 일, 인물 사이의 대화를 쓴다.
5. 새 인물은 이름 없는 단역이나, 설정집 인물과 이름·역할이 겹치지 않는 사람만 쓴다.
6. 설정집의 사실을 자연스럽게 다시 언급해도 된다.
7. 설정집에 없는 고정 설정(사는 곳, 가족 구성, 학교 밖 소속 등)은 새로 정하지 말고 구체적으로 쓰지 않는다.
8. 이 화의 날짜는 주어진 날짜 무렵이다. 계절, 학사 일정(개강, 시험, 방학)이 그 날짜와 맞아야 하고, 같은 사이에 먼저 쓴 중간 화보다 뒤의 일이다.
9. 분량은 2,500~3,500자, 문단 15~30개. 대사를 포함한다.

출력
- title: 짧은 화 제목 (번호 없이)
- paragraphs: 문단 배열. 문단 안에 줄바꿈을 넣지 않는다. 제목 줄은 넣지 않는다.
- summary: 이 화에서 일어난 일 두 문장`;

export const FILLER_SCHEMA = {
  name: 'filler_chapter',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      paragraphs: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
    },
    required: ['title', 'paragraphs', 'summary'],
    additionalProperties: false,
  },
} as const;

export interface Filler {
  title: string;
  paragraphs: string[];
  summary: string;
}

export function fillerInput(
  n: number,
  canon: { worldBible: string; plot: string },
  plot: PlotChapter[],
  earlier: { n: number; summary: string }[],
): string {
  const { before, after, index } = gapOf(n);
  const a = plot.find((p) => p.n === before)!;
  const b = after === null ? null : plot.find((p) => p.n === after)!;
  const place = b
    ? `원작 ${before}화 「${a.title}」(${a.date}) 뒤, 원작 ${after}화 「${b.title}」(${b.date}) 앞. 그 사이에 들어가는 중간 화 ${FILLERS_PER_GAP}개 중 ${index}번째.`
    : `원작 마지막 화인 ${before}화 「${a.title}」(${a.date}) 뒤, 2009년 1~3월. 후일담 중간 화 ${FILLERS_PER_GAP}개 중 ${index}번째.`;
  return [
    '# 설정집',
    canon.worldBible,
    '',
    '# 원작 화별 플롯',
    canon.plot,
    '',
    `# 쓸 화: 전체 ${n}화`,
    place,
    `이 화의 날짜: ${fillerDate(n, plot)} 무렵`,
    earlier.length ? `같은 사이에 먼저 쓴 중간 화:\n${earlier.map((e) => `- ${e.n}화: ${e.summary}`).join('\n')}` : '같은 사이에 먼저 쓴 중간 화: 없음',
  ].join('\n');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseFiller(value: unknown): Filler {
  if (!isRecord(value) || typeof value['title'] !== 'string' || typeof value['summary'] !== 'string' || !Array.isArray(value['paragraphs'])) {
    throw new Error('중간 화 형식이 다릅니다');
  }
  // 원고 형식(한 줄 = 한 문단)에서 제목·인용·구분선·강조로 읽히는 기호는 뺀다
  const paragraphs = (value['paragraphs'] as unknown[]).map((p) => {
    if (typeof p !== 'string') throw new Error('중간 화 형식이 다릅니다: 문단');
    const text = p.replace(/\s*\n+\s*/g, ' ').replace(/\*/g, '').trim();
    return text === '---' ? '' : text.replace(/^(#+|>)\s*/, '');
  });
  return { title: value['title'].trim(), summary: value['summary'].trim(), paragraphs: paragraphs.filter(Boolean) };
}

/** M0-A 화와 같은 모양: 제목 줄, 빈 줄, 문단마다 빈 줄 */
export function fillerFileText(n: number, filler: Filler): string {
  return `# ${n}화. ${filler.title}\n\n${filler.paragraphs.join('\n\n')}\n`;
}
