// M9 기준 입력 대조 (M9-PLAN 4절). 유료 호출 전에, 이번에 보낼 검사 요청이 M8 검사 때와 같은지 로컬에서 확인한다.
// 모델을 부르지 않는다. 기준 폴더(M8 복사본의 스냅숏)는 읽기만 하고, 작업 폴더(스냅숏의 복사본)의 저장된 분석으로 요청을 만든다.
//
// 자료는 세 가지로 나눈다. 공개 기록에는 이 구분과 집계만 남기고, 화별 fingerprint는 작업 폴더(저장소 밖)에만 쓴다.
//   - recorded (M8 검사 때 저장된 기록): checks의 화 해시·사실 수·시각, check_inputs의 앞 화 해시, calls의 검사 호출 수·입력 토큰
//   - reconstructed (재구성): 사실의 인물·속성·값·인용과 순서, 묶음, detectionInput 문자열.
//     M8 당시 요청 자체는 저장되지 않았다. "검사 뒤 앞 화·이 화를 다시 분석하지 않았다"는 가정 아래에서만 같다.
//     이 가정은 분석 시각이 검사 시각보다 앞서는지로 확인하지만, 시각은 증명이 아니라 정황이다.
//     평가기 출력(predictions.json)의 화·인용 순서도 같은 저장 분석에서 나중에 만든 것이라 독립 기록이 아니다.
//   - unknown (불명): M8이 실제로 보낸 바이트. 저장된 기록이 없다

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/core/ai/detection.ts';
import { chapterNumber } from '../../src/core/project/chapters.ts';
import type { AiStore } from '../../src/main/ai-db.ts';
import { prepareCheck, type PreparedCheck } from '../../src/main/checker.ts';
import { chapterFileNames } from '../../src/main/project-files.ts';
import { inputTokenBound } from './reserve.ts';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export type Item =
  | 'target-hash'
  | 'inputs'
  | 'fact-count'
  | 'provenance'
  | 'order'
  | 'batches'
  | 'call-tokens'
  | 'work-analyses';

/** 항목마다 어떤 종류의 자료로 확인했는가 */
export const ITEM_BASIS: Record<Item, 'recorded' | 'reconstructed'> = {
  'target-hash': 'recorded',
  inputs: 'recorded',
  'fact-count': 'recorded',
  provenance: 'recorded',
  batches: 'recorded',
  'call-tokens': 'recorded',
  order: 'reconstructed',
  'work-analyses': 'reconstructed',
};

export interface ChapterResult {
  file: string;
  ok: boolean;
  /** 맞지 않은 항목과 이유 (원문 없음) */
  failures: { item: Item; reason: string }[];
  /** 비공개: 이번 요청 전체의 fingerprint (실행 직전에 다시 비교한다) */
  fingerprint: string | null;
  batches: number;
  facts: number;
}

export interface PreflightReport {
  ok: boolean;
  chapters: ChapterResult[];
  /** 기준이 없거나 읽을 수 없어 대조하지 못한 이유 */
  missing: string[];
}

interface Row {
  [k: string]: unknown;
}
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];

/** 요청 전체의 fingerprint: 이 화 본문 줄, 순서 있는 사실 전체(화·인물·속성·값·인용), 묶음 경계, 묶음마다 보낼 입력 */
export function requestFingerprint(p: PreparedCheck): string {
  return sha256(
    JSON.stringify({
      file: p.file,
      targetHash: p.target.hash,
      target: p.target.lines,
      inputs: p.inputs,
      facts: p.facts.map((f) => [f.chapter, f.entity, f.predicate, f.value, f.quote]),
      batches: p.batches.map((b) => b.length),
      users: p.users,
    }),
  );
}

/** 저장된 분석 전체의 fingerprint (작업 폴더가 대조 중이나 실행 직전에 바뀌지 않았는지 본다) */
export async function analysesFingerprint(root: string, store: AiStore): Promise<string> {
  const files = await chapterFileNames(root);
  return sha256(
    JSON.stringify(
      files.map((f) => {
        const a = store.analysis(f);
        return a ? [f, a.contentHash, a.entities, a.facts.map((x) => [x.entity, x.predicate, x.value, x.quote])] : [f, null];
      }),
    ),
  );
}

/** 폴더 안 파일 바이트 전체의 fingerprint (복사 중 원본이 바뀌지 않았는지 본다) */
export function filesFingerprint(paths: string[]): string {
  return sha256(JSON.stringify(paths.map((p) => [p, sha256(readFileSync(p))])));
}

export interface PreflightOptions {
  /** M8 기록을 읽을 기준 폴더 (스냅숏, 읽기만 한다) */
  baselineRoot: string;
  /** 요청을 만들 작업 폴더와 그 저장소 */
  workRoot: string;
  workStore: AiStore;
  /** 기준 폴더의 평가기 출력 (화·인용 순서, 재구성 자료). 없으면 order 항목은 실패한다 */
  predictions: { chapters: { target_chapter: number; context: { chapter: number; text: string }[] }[] } | null;
  /** 대조할 화. 기준에 검사 기록이 없는 화가 있으면 실패한다 */
  targets: string[];
}

export async function preflight(o: PreflightOptions): Promise<PreflightReport> {
  const missing: string[] = [];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(join(o.baselineRoot, '.loreweave', 'ai.db'), { readOnly: true });
  } catch (e) {
    return { ok: false, chapters: [], missing: [`기준 ai.db를 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}`] };
  }
  try {
    const chapters: ChapterResult[] = [];
    for (const file of o.targets) {
      const failures: ChapterResult['failures'] = [];
      const fail = (item: Item, reason: string) => failures.push({ item, reason });
      const [check] = rows(db, 'SELECT * FROM checks WHERE file = ?', file);
      if (!check) {
        missing.push(`기준에 ${file}의 검사 기록이 없습니다`);
        chapters.push({ file, ok: false, failures: [{ item: 'target-hash', reason: '검사 기록 없음' }], fingerprint: null, batches: 0, facts: 0 });
        continue;
      }
      const prepared = await prepareCheck(file, { root: o.workRoot, store: o.workStore });
      if (typeof prepared === 'string') {
        chapters.push({ file, ok: false, failures: [{ item: 'work-analyses', reason: prepared }], fingerprint: null, batches: 0, facts: 0 });
        continue;
      }
      const checkId = Number(check['id']);
      const checkedAt = String(check['created_at']);

      // recorded: 이 화 본문 해시
      if (prepared.target.hash !== String(check['content_hash'])) fail('target-hash', '이 화 파일 해시가 검사 기록과 다름');

      // recorded: 앞 화 목록과 분석할 때의 화 파일 해시
      const recordedInputs = rows(db, 'SELECT file, content_hash FROM check_inputs WHERE check_id = ? ORDER BY file', checkId).map((r) => ({
        file: String(r['file']),
        contentHash: String(r['content_hash']),
      }));
      const workInputs = [...prepared.inputs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
      if (JSON.stringify(recordedInputs) !== JSON.stringify(workInputs)) fail('inputs', '앞 화 목록이나 앞 화 해시가 검사 기록과 다름');

      // recorded: 사실 수
      if (prepared.facts.length !== Number(check['fact_count'])) fail('fact-count', `사실 수 ${prepared.facts.length} ≠ 기록 ${Number(check['fact_count'])}`);

      // recorded(시각): 이 화와 앞 화의 분석이 검사보다 먼저 저장됐는가. 아니면 검사 뒤 다시 분석해 내용이 바뀌었을 수 있다
      for (const f of [file, ...prepared.priors]) {
        const [a] = rows(db, 'SELECT created_at, content_hash FROM analyses WHERE file = ?', f);
        if (!a) fail('provenance', `기준에 ${f} 분석이 없음`);
        else if (!(String(a['created_at']) < checkedAt)) fail('provenance', `${f} 분석이 검사 뒤에 저장됨`);
      }

      // recorded: 검사 호출 수 = 묶음 수, 호출마다 기록된 입력 토큰이 이번 입력의 상한 안에 드는가 (정황 확인이지 동일성 증명은 아님)
      const calls = rows(db, "SELECT ok, input_tokens FROM calls WHERE file = ? AND kind = 'check' ORDER BY id", file);
      if (calls.some((c) => Number(c['ok']) !== 1)) fail('batches', '기준에 실패한 검사 호출이 있음');
      if (calls.length !== prepared.batches.length) fail('batches', `묶음 ${prepared.batches.length} ≠ 기록된 검사 호출 ${calls.length}`);
      const bounds = prepared.users.map((user) => inputTokenBound({ system: DETECT_SYSTEM, user, schema: DETECT_SCHEMA })).sort((a, b) => a - b);
      const recorded = calls.map((c) => Number(c['input_tokens'])).sort((a, b) => a - b);
      if (recorded.length === bounds.length && recorded.some((t, i) => t > bounds[i]!)) fail('call-tokens', '기록된 입력 토큰이 이번 입력의 상한보다 큼');

      // reconstructed: 평가기 출력의 화·인용 순서
      const exported = o.predictions?.chapters.find((c) => c.target_chapter === chapterNumber(file));
      if (!exported) fail('order', '평가기 출력에 이 화가 없음');
      else if (JSON.stringify(exported.context.map((c) => [c.chapter, c.text])) !== JSON.stringify(prepared.facts.map((f) => [f.chapter, f.quote])))
        fail('order', '사실의 화·인용 순서가 평가기 출력과 다름');

      // reconstructed: 작업 폴더의 분석이 기준 폴더의 분석과 같은가 (사실의 인물·속성·값·인용 전체)
      for (const f of [file, ...prepared.priors]) {
        const [a] = rows(db, 'SELECT id, content_hash FROM analyses WHERE file = ?', f);
        const w = o.workStore.analysis(f);
        if (!a || !w) continue;
        const base = rows(db, 'SELECT entity, predicate, value, quote FROM facts WHERE analysis_id = ? ORDER BY ord', Number(a['id'])).map((r) => [
          String(r['entity']),
          String(r['predicate']),
          String(r['value']),
          String(r['quote']),
        ]);
        const ents = rows(db, 'SELECT name, aliases FROM entities WHERE analysis_id = ? ORDER BY ord', Number(a['id'])).map((r) => [
          String(r['name']),
          JSON.parse(String(r['aliases'])) as string[],
        ]);
        const same =
          String(a['content_hash']) === w.contentHash &&
          JSON.stringify(base) === JSON.stringify(w.facts.map((x) => [x.entity, x.predicate, x.value, x.quote])) &&
          JSON.stringify(ents) === JSON.stringify(w.entities.map((e) => [e.name, e.aliases]));
        if (!same) fail('work-analyses', `${f} 분석이 기준과 다름`);
      }

      chapters.push({ file, ok: failures.length === 0, failures, fingerprint: requestFingerprint(prepared), batches: prepared.batches.length, facts: prepared.facts.length });
    }
    return { ok: missing.length === 0 && chapters.length > 0 && chapters.every((c) => c.ok), chapters, missing };
  } finally {
    db.close();
  }
}

/** 공개해도 되는 집계 (화 번호·항목·수만, 원문·fingerprint 없음) */
export function publicSummary(r: PreflightReport) {
  const byItem: Partial<Record<Item, number>> = {};
  for (const c of r.chapters) for (const f of c.failures) byItem[f.item] = (byItem[f.item] ?? 0) + 1;
  return {
    ok: r.ok,
    chapters: r.chapters.length,
    passed: r.chapters.filter((c) => c.ok).length,
    batches: r.chapters.reduce((n, c) => n + c.batches, 0),
    failuresByItem: byItem,
    missing: r.missing.length,
    basis: ITEM_BASIS,
    unknown: ['M8이 실제로 보낸 요청 바이트 (저장 기록 없음)'],
  };
}
