// 줄 단위 차이 (저장 충돌의 "내 화면 ↔ 디스크" 비교용). 최장 공통 부분 수열(LCS)로 같은 줄을 맞추고, 나머지를 지운 줄(del)·더한 줄(add)로 낸다.
// 앞뒤 공통 줄은 먼저 걷어내 표를 줄인다. 표가 너무 크면 null (호출한 쪽이 "너무 길어 줄 단위 비교를 생략"으로 알린다).

export type DiffOp = { type: 'same' | 'del' | 'add'; text: string };

/** 비교할 두 쪽(공통 앞뒤를 뺀 뒤)의 줄 수 곱이 이 값을 넘으면 비교하지 않는다 */
export const MAX_DIFF_CELLS = 6_000_000;

/** a(내 쪽) → b(디스크 쪽): a에만 있으면 del, b에만 있으면 add */
export function diffLines(a: string[], b: string[]): DiffOp[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_DIFF_CELLS) return null;

  // lcs[i][j] = midA[i..], midB[j..]의 LCS 길이
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = a.slice(0, start).map((text) => ({ type: 'same' as const, text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ type: 'same', text: midA[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) ops.push({ type: 'del', text: midA[i++]! });
    else ops.push({ type: 'add', text: midB[j++]! });
  }
  while (i < n) ops.push({ type: 'del', text: midA[i++]! });
  while (j < m) ops.push({ type: 'add', text: midB[j++]! });
  for (const text of a.slice(endA)) ops.push({ type: 'same', text });
  return ops;
}

export type DiffRow = DiffOp | { type: 'gap'; count: number };

/** 바뀐 줄 둘레 context줄만 남기고, 같은 줄이 이어지는 구간은 gap 한 줄로 접는다 */
export function collapseContext(ops: DiffOp[], context = 2): DiffRow[] {
  const keep = ops.map((op) => op.type !== 'same');
  const near = keep.map((_, i) => {
    for (let d = -context; d <= context; d++) if (keep[i + d]) return true;
    return false;
  });
  const rows: DiffRow[] = [];
  let hidden = 0;
  ops.forEach((op, i) => {
    if (near[i]) {
      if (hidden > 0) rows.push({ type: 'gap', count: hidden });
      hidden = 0;
      rows.push(op);
    } else hidden++;
  });
  if (hidden > 0) rows.push({ type: 'gap', count: hidden });
  return rows;
}

/** 바뀐 줄 수 */
export function diffStats(ops: DiffOp[]): { removed: number; added: number } {
  return { removed: ops.filter((o) => o.type === 'del').length, added: ops.filter((o) => o.type === 'add').length };
}
