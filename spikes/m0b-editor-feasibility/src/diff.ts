// 원본과 재직렬화 결과의 차이를 줄 단위로 찾고 유형을 붙인다 (M0-PLAN §5 diff 유형 분류).

import { detectEol } from './envelope.ts';

export type DiffKind = 'bom' | 'eol' | 'blank-lines' | 'escape' | 'whitespace' | 'text-loss' | 'other';

export interface Hunk {
  kind: DiffKind;
  /** 원본 기준 1부터 시작하는 줄 번호 */
  line: number;
  expected: string[];
  actual: string[];
}

export interface DiffResult {
  kinds: DiffKind[];
  hunks: Hunk[];
}

const BOM = '\uFEFF';
const SPACE = /[\s\u200B]/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00A0', '#39': "'" };

function unescape(s: string): string {
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, name: string) => ENTITIES[name]!);
}

function classifyHunk(expected: string[], actual: string[]): DiffKind {
  const nonBlank = (ls: string[]) => ls.filter((l) => l.trim() !== '').join('\n');
  const e = nonBlank(expected);
  const a = nonBlank(actual);
  if (e === a) return 'blank-lines';
  if (unescape(a) === e || unescape(e) === a) return 'escape';
  if (e.replace(SPACE, '') === a.replace(SPACE, '')) return 'whitespace';
  const ec = unescape(e).replace(SPACE, '');
  const ac = unescape(a).replace(SPACE, '');
  if (ec === ac) return 'escape';
  return ac.length < ec.length ? 'text-loss' : 'other';
}

const MAX_CELLS = 4_000_000;

function lineHunks(a: string[], b: string[]): Omit<Hunk, 'kind'>[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return [{ line: 1, expected: a, actual: b }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const hunks: Omit<Hunk, 'kind'>[] = [];
  let cur: Omit<Hunk, 'kind'> | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (cur) hunks.push(cur);
      cur = null;
      i++;
      j++;
      continue;
    }
    cur ??= { line: i + 1, expected: [], actual: [] };
    if (j >= m || (i < n && dp[i + 1]![j]! >= dp[i]![j + 1]!)) cur.expected.push(a[i++]!);
    else cur.actual.push(b[j++]!);
  }
  if (cur) hunks.push(cur);
  return hunks;
}

export function classifyDiff(expected: string, actual: string): DiffResult {
  if (expected === actual) return { kinds: [], hunks: [] };
  const kinds = new Set<DiffKind>();
  if (expected.startsWith(BOM) !== actual.startsWith(BOM)) kinds.add('bom');
  const e = expected.replace(/^\uFEFF/, '');
  const a = actual.replace(/^\uFEFF/, '');
  if (detectEol(e) !== detectEol(a)) kinds.add('eol');
  const hunks = lineHunks(e.replace(/\r\n?/g, '\n').split('\n'), a.replace(/\r\n?/g, '\n').split('\n')).map(
    (h) => ({ ...h, kind: classifyHunk(h.expected, h.actual) }),
  );
  for (const h of hunks) kinds.add(h.kind);
  return { kinds: [...kinds], hunks };
}
