// 변환기 × 규약 조합을 코퍼스 전체에 돌려 results/roundtrip.{json,md}를 쓴다.
// 사용: tsx src/run-roundtrip.ts

import './dom.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadCorpus, type CorpusCase } from '../corpus/cases.ts';
import type { DiffKind } from './diff.ts';
import { checkCase, type CaseResult } from './roundtrip.ts';
import { COMBOS, throughEditor, type Combo } from './serializers/index.ts';

const KINDS: DiffKind[] = ['bom', 'eol', 'blank-lines', 'escape', 'whitespace', 'text-loss', 'other'];

interface ComboResult {
  combo: Omit<Combo, 'create'>;
  cases: (CaseResult & { group: string; exception?: string })[];
}

function run(combo: Combo, corpus: CorpusCase[]): ComboResult {
  const converter = throughEditor(combo.create());
  const cases = corpus.map((c) => ({ ...checkCase(converter, c.id, c.raw), group: c.group, exception: c.exception }));
  const { create: _, ...meta } = combo;
  return { combo: meta, cases };
}

const pct = (n: number, d: number) => (d === 0 ? '-' : `${Math.round((100 * n) / d)}%`);
const show = (lines: string[]) =>
  lines.length === 0 ? '(없음)' : lines.slice(0, 3).map((l) => JSON.stringify(l).slice(0, 70)).join(' ⏎ ');

function summarize(results: ComboResult[], corpus: CorpusCase[]): string {
  const out: string[] = [];
  const scored = (r: ComboResult) => r.cases.filter((c) => !c.exception);
  out.push('# Round-trip 결과', '');
  out.push(`- 코퍼스 ${corpus.length}개 (문서화된 예외 ${corpus.filter((c) => c.exception).length}개는 비율에서 제외)`);
  out.push('- byte 동일: `s(p(x)) == x`, 멱등: `s(p(s(p(x)))) == s(p(x))`, 국소성: 글자가 있는 문단 하나를 고쳤을 때 나머지가 `s(p(x))`와 같은 문단 비율');
  out.push('- 공백 문단: 에디터 안에서 공백·NBSP만 든 문단 수 (빈 줄이 보이지 않는 글자로 남는 경우. 코퍼스에 진짜 NBSP 줄이 1개 있다)');
  out.push('- 생성: `pnpm roundtrip` (자동 생성 파일, 직접 고치지 않는다)', '');
  out.push('| 조합 | byte 동일 | 멱등 | 국소성 | 공백 문단 | 변환 오류 | ' + KINDS.join(' | ') + ' |');
  out.push('|---|---|---|---|---|---|' + KINDS.map(() => '---').join('|') + '|');
  for (const r of results) {
    const cs = scored(r);
    const paragraphs = cs.reduce((s, c) => s + c.paragraphs, 0);
    const nonLocal = cs.reduce((s, c) => s + c.nonLocal.length, 0);
    const kindCounts = KINDS.map((k) => cs.filter((c) => c.diff.kinds.includes(k)).length);
    out.push(
      `| ${r.combo.label} | ${pct(cs.filter((c) => c.exact).length, cs.length)} | ${pct(cs.filter((c) => c.idempotent).length, cs.length)} | ${pct(paragraphs - nonLocal, paragraphs)} | ${cs.reduce((s, c) => s + c.whitespaceOnly, 0)} | ${cs.filter((c) => c.error).length} | ${kindCounts.join(' | ')} |`,
    );
  }
  out.push('', '유형 열은 그 유형의 차이가 하나라도 있는 사례 수다.', '');

  const groups = [...new Set(corpus.map((c) => c.group))];
  out.push('## 그룹별 byte 동일', '');
  out.push('| 그룹 | ' + results.map((r) => r.combo.label).join(' | ') + ' |');
  out.push('|---|' + results.map(() => '---').join('|') + '|');
  for (const g of groups) {
    const cells = results.map((r) => {
      const cs = scored(r).filter((c) => c.group === g);
      return `${cs.filter((c) => c.exact).length}/${cs.length}`;
    });
    out.push(`| ${g} | ${cells.join(' | ')} |`);
  }

  out.push('', '## 실패 사례 (첫 번째 차이)', '');
  for (const r of results) {
    const failed = scored(r).filter((c) => !c.exact || !c.idempotent || c.nonLocal.length > 0);
    out.push(`### ${r.combo.label} — ${failed.length}개`, '');
    if (failed.length === 0) continue;
    out.push('| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |', '|---|---|---|---|---|---|');
    for (const c of failed) {
      const h = c.diff.hunks[0];
      const cell = (s: string) => s.replace(/\|/g, '\\|');
      out.push(
        `| ${c.id} | ${c.error ? `오류: ${cell(c.error)}` : c.diff.kinds.join(', ') || '-'} | ${c.idempotent ? '○' : '×'} | ${c.nonLocal.length}/${c.paragraphs} | ${h ? cell(show(h.expected)) : ''} | ${h ? cell(show(h.actual)) : ''} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

const corpus = loadCorpus();
const results = COMBOS.map((combo) => run(combo, corpus));
const dir = new URL('../results/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('roundtrip.json', dir), JSON.stringify(results, null, 1) + '\n');
writeFileSync(new URL('roundtrip.md', dir), summarize(results, corpus) + '\n');
for (const r of results) {
  const cs = r.cases.filter((c) => !c.exception);
  console.log(`${r.combo.id.padEnd(14)} byte 동일 ${cs.filter((c) => c.exact).length}/${cs.length}`);
}
process.exit(0);
