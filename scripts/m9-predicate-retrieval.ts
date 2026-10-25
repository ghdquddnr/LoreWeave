// M9 후속 가설의 오프라인 retrieval 계산 (M9-FOLLOWUP.md). API를 부르지 않는다. 저장된 ai.db는 읽기 전용으로만 연다.
//   pnpm tsx scripts/m9-predicate-retrieval.ts <프로젝트 폴더> <정답표 폴더> [--json <출력 파일>]
//   - 프로젝트 폴더: .loreweave/ai.db에 분석과 검사 기록이 있는 폴더 (예: M9 작업 폴더의 snapshot/). 검사 기록이 있는 화를 대상으로 한다
//   - 정답표 폴더: ground-truth.json과 chapters/가 있는 폴더 (M4는 spikes/m0a-ai-feasibility/benchmark, 실제 원고는 M8 복사본)
// 출력은 화 번호와 수만 담는다 (원문·인물명·인용 없음). 실제 원고 경로는 저장소 밖이어야 하며 출력에 남기지 않는다.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { candidateFacts, CHECK_BATCH_SIZE, type PriorAnalysis } from '../src/core/ai/detection.ts';
import type { Entity } from '../src/core/ai/extraction.ts';
import { chapterNumber } from '../src/core/project/chapters.ts';
import { loadChapters, loadGroundTruth } from '../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { evaluate } from '../spikes/m0a-ai-feasibility/src/evaluate.ts';
import type { Predictions } from '../spikes/m0a-ai-feasibility/src/schema.ts';
import { withPredicateMatches } from './lib/predicate-addition.ts';

type Row = Record<string, unknown>;
type Analysis = { entities: Entity[]; facts: PriorAnalysis['facts'] };

/** 저장된 분석 전부와 검사 기록이 있는 화 (읽기 전용) */
export function loadProject(root: string): { analyses: Map<string, Analysis>; checked: string[] } {
  const db = new DatabaseSync(join(root, '.loreweave', 'ai.db'), { readOnly: true });
  try {
    const all = (sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as Row[];
    const analyses = new Map<string, Analysis>();
    for (const a of all('SELECT id, file FROM analyses ORDER BY file')) {
      const id = Number(a['id']);
      analyses.set(String(a['file']), {
        entities: all('SELECT name, aliases FROM entities WHERE analysis_id = ? ORDER BY ord', id).map((e) => ({ name: String(e['name']), aliases: JSON.parse(String(e['aliases'])) as string[] })),
        facts: all('SELECT entity, predicate, value, quote FROM facts WHERE analysis_id = ? ORDER BY ord', id).map((f) => ({
          entity: String(f['entity']),
          predicate: String(f['predicate']),
          value: String(f['value']),
          quote: String(f['quote']),
        })),
      });
    }
    return { analyses, checked: all('SELECT file FROM checks ORDER BY file').map((c) => String(c['file'])) };
  } finally {
    db.close();
  }
}

export interface ChapterCount {
  chapter: number;
  base: number;
  added: number;
  batchesBase: number;
  batchesPlus: number;
}

/** 이름 기준(base)과 속성 이름 더하기(plus)의 검사 입력을 화마다 만들어 평가기 retrieval을 센다 */
export function compare(root: string, gtDir: string) {
  const { analyses, checked } = loadProject(root);
  const files = [...analyses.keys()].filter((f) => chapterNumber(f) !== null).sort((a, b) => chapterNumber(a)! - chapterNumber(b)!);
  const perChapter: ChapterCount[] = [];
  const base: Predictions = { run_id: 'base', strategy: 'name', model: '-', chapters: [] };
  const plus: Predictions = { run_id: 'plus', strategy: 'name+predicate', model: '-', chapters: [] };
  const batches = (n: number) => Math.max(1, Math.ceil(n / CHECK_BATCH_SIZE));
  for (const file of checked) {
    const n = chapterNumber(file)!;
    const target = analyses.get(file)!;
    const priors: PriorAnalysis[] = files.filter((f) => chapterNumber(f)! < n).map((f) => ({ chapter: chapterNumber(f)!, ...analyses.get(f)! }));
    const named = candidateFacts(target.entities, priors);
    const added = withPredicateMatches(target, priors);
    base.chapters.push({ target_chapter: n, context: named.map((f) => ({ chapter: f.chapter, text: f.quote })), findings: [] });
    plus.chapters.push({ target_chapter: n, context: added.facts.map((f) => ({ chapter: f.chapter, text: f.quote })), findings: [] });
    perChapter.push({ chapter: n, base: named.length, added: added.added, batchesBase: batches(named.length), batchesPlus: batches(added.facts.length) });
  }
  const gt = loadGroundTruth(gtDir);
  const chapters = loadChapters(gtDir);
  const retrieval = (p: Predictions) => {
    const r = evaluate(p, gt, chapters).retrieval;
    return { retrieved: r.retrieved, known: r.known, notRetrieved: Object.entries(r.per_error).filter(([, v]) => !v).map(([k]) => k).sort() };
  };
  const rb = retrieval(base);
  const rp = retrieval(plus);
  return {
    chapters: perChapter.length,
    facts: { base: perChapter.reduce((s, c) => s + c.base, 0), plus: perChapter.reduce((s, c) => s + c.base + c.added, 0) },
    batches: { base: perChapter.reduce((s, c) => s + c.batchesBase, 0), plus: perChapter.reduce((s, c) => s + c.batchesPlus, 0) },
    retrieval: { base: rb, plus: rp, newlyRetrieved: rb.notRetrieved.filter((id) => !rp.notRetrieved.includes(id)), lost: rp.notRetrieved.filter((id) => !rb.notRetrieved.includes(id)) },
    perChapter,
  };
}

if (require.main === module) {
  const [root, gtDir] = process.argv.slice(2);
  const i = process.argv.indexOf('--json');
  if (!root || !gtDir) {
    console.error('사용: pnpm tsx scripts/m9-predicate-retrieval.ts <프로젝트 폴더> <정답표 폴더> [--json <출력 파일>]');
    process.exit(1);
  }
  const r = compare(resolve(root), resolve(gtDir));
  const line = (k: 'base' | 'plus') => `${k}: 사실 ${r.facts[k]}개, 묶음 ${r.batches[k]}, retrieval ${r.retrieval[k].retrieved}/${r.retrieval[k].known} (미검색 ${r.retrieval[k].notRetrieved.join(',') || '없음'})`;
  console.log(`검사한 화 ${r.chapters}개`);
  console.log(line('base'));
  console.log(line('plus'));
  console.log(`새로 검색됨 ${r.retrieval.newlyRetrieved.join(',') || '없음'} · 빠짐 ${r.retrieval.lost.join(',') || '없음'}`);
  if (i !== -1 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, JSON.stringify(r, null, 1) + '\n');
}
