// M10 같은 입력 반복 검사 (M10-PLAN.md 3·4절). 측정 스크립트(scripts/m10-repeat.ts)와 테스트가 함께 쓴다.
// 제품 판단 프롬프트(DETECT_SYSTEM)·사실 고르기(prepareCheck)·모델(gpt-6-luna)을 그대로 쓰고, 같은 검사 요청을 회차마다 다시 보낸다.
//   1) 두 데이터셋을 저장소 밖 새 작업 폴더에 복사한다: M4 시험 원고(14화, 4회)와 M8 복사본(20화, 2회). 원본에는 쓰지 않는다
//   2) 회마다 복사본에서 제품 prepareCheck로 요청을 만들어 그때 기록과 대조한다(m9-preflight.ts. M4는 당시 평가기 출력이 없어 순서 대조 생략).
//      그와 별도로 같은 데이터셋의 모든 회차가 화 순서까지 같은 요청인지 fingerprint로 서로 비교한다 (회차 사이 동일성)
//   3) 보낼 요청마다 비용 상한(callCostBound)을 더해 완주 상한을 계산한다 (재시도 0 / 최대 1). 단계 중단 상한($1.20)과 따로 적는다
//   4) 승인 ID와 --run이 있을 때만 이 실험 전용 단계 장부(m10-repeat)를 열고, 여섯 회차를 시작한 적이 없을 때만 연결한다
//   5) 첫 호출 전에 모든 회·모든 화를 다시 확인하고, 확인한 요청을 그대로 보낸다. 화마다 보내기 직전에도 다시 확인한다
//   6) M4 4회 → 겹치지 않는 두 쌍(1+2, 3+4)을 제품 합치기 규칙으로 합쳐 관문을 본다. 하나라도 미달이면 실제 원고는 0회다
//   7) 실제 원고 2회 → 회별·합친 결과의 자동 집계와 사람 판정 틀만 만든다. 최종 판정은 사람이 한다
// 공유 중단·취소·재시작 금지는 M9 사실 더하기 runner(predicate-run.ts)와 같은 장치를 쓴다.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DETECT_SCHEMA, DETECT_SYSTEM } from '../../src/core/ai/detection.ts';
import { chapterNumber } from '../../src/core/project/chapters.ts';
import { MAX_OUTPUT_TOKENS, type AiClient } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { prepareCheck, runPreparedCheck, type PreparedCheck } from '../../src/main/checker.ts';
import { toPredictions } from '../export-predictions.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';
import { mergedPredictions, mergeRuns, storedRun } from './merge-runs.ts';
import { analysesFingerprint, filesFingerprint, preflight, publicSummary, requestFingerprint, sha256, type PreflightReport } from './m9-preflight.ts';
import { copyProject, inside, M9_MODEL, overlapReason, projectFiles, realPath } from './m9-run.ts';
import { haltGate, sentObserver } from './predicate-run.ts';
import { callCostBound, withReservation, type ReservedLedger } from './reserve.ts';
import { StageLedger, StageLedgerError, stageReason, type StageDef } from './stage-ledger.ts';

/** 이 실험의 단계 장부. 끝난 M9 장부(m9-detect2, m9p-predicate)와 다른 ID다. 한도는 고정이다 */
export const M10_STAGE = { id: 'm10-repeat', limitUsd: 1.2 } as const;
/** 판단 프롬프트는 제품 detect-1 그대로다. 복사본 ai.db에 남는 검사 버전만 구분한다 (기준 복사본의 detect-1 기록과 섞이지 않게) */
export const M10_PROMPT = { system: DETECT_SYSTEM, version: 'detect-1+m10-repeat' } as const;
/** 데이터셋마다 고정한 회 수 */
export const M10_RUNS = { m4: 4, real: 2 } as const;
/** M4 관문에서 합치는 겹치지 않는 두 쌍 */
export const M4_PAIRS = [
  ['m4-1', 'm4-2'],
  ['m4-3', 'm4-4'],
] as const;
/** 재시도 (요청마다 최대 1회, 네트워크·429만). SDK 재시도는 0 */
export const M10_RETRIES = 1;
const APPROVAL = /^[a-z0-9][a-z0-9-]{5,80}$/;

type Label = keyof typeof M10_RUNS;

export interface DatasetOptions {
  baseline: string;
  /** 기준 평가기 출력. null이면 화·인용 순서 대조를 건너뛰고 skipped로 남긴다 (M4) */
  predictions: string | null;
  targets: string[];
}

export interface M10Options {
  m4: DatasetOptions;
  real: DatasetOptions;
  /** 새로 만들 작업 폴더 (이미 있으면 멈춘다) */
  work: string;
  repoRoot: string;
  /** false면 대조와 상한 계산만 한다 (기본). connect를 부르지 않는다 */
  run: boolean;
  approval?: string;
  ledgerDir?: string;
  /** 테스트용 단계 (기본 M10_STAGE) */
  stage?: Omit<StageDef, 'approval'>;
  connect(): Promise<AiClient> | AiClient;
  signal?: AbortSignal;
  /** M4 합친 한 쌍의 관문 판정 (기본은 m4-score.ts의 scoreM4: test ≥ 17/20, Precision ≥ 85%, 화당 오탐 ≤ 0.3) */
  scoreM4(label: string, predictions: Predictions, checkedChapters: number): { pass: boolean } & Record<string, unknown>;
  /** 기록만 하는 회별 M4 채점 (판정에 쓰지 않는다) */
  recordM4(label: string, predictions: Predictions, checkedChapters: number): Record<string, unknown>;
  /** 실제 원고 한 회(또는 합친 결과)의 자동 집계 (사람 판정 전) */
  scoreReal(label: string, predictions: Predictions): Record<string, unknown>;
  log?(line: string): void;
}

export interface ChapterPlan {
  file: string;
  ok: boolean;
  reason: string | null;
  facts: number;
  batches: number;
  /** 비공개 (작업 폴더에만) */
  fingerprint: string | null;
  /** 이 화 요청들의 비용 상한 합 (재시도 0) */
  boundUsd: number;
  maxCallBoundUsd: number;
}

export interface BudgetPlan {
  calls: { m4: number; real: number; total: number };
  maxAttempts: number;
  maxOutputTokens: number;
  /** 요청별 callCostBound의 정확한 합 */
  completionBoundUsd: { retries0: number; retries1: number };
  perRunBoundUsd: Record<string, number>;
  maxCallBoundUsd: { m4: number; real: number };
  /** 동시에 진행할 수 있는 예약의 최댓값 (묶음 동시 2 × 가장 비싼 호출) */
  maxInFlightUsd: number;
  stageLimitUsd: number;
  /** 완주 상한이 단계 중단 상한 안에 드는가. 아니면 한도 안 완주를 보장하지 않는다 */
  completionGuaranteed: boolean;
}

export interface M10Result {
  stage: 'refused' | 'preflight-failed' | 'preflight-ok' | 'stopped' | 'm4-failed' | 'done';
  reason: string | null;
  connected: boolean;
  preflight: { label: string; base: ReturnType<typeof publicSummary>; plan: { chapters: number; passed: number; facts: number; batches: number } }[];
  /** 회차 사이 동일성: 같은 데이터셋의 모든 회차가 화 순서까지 같은 요청인가 */
  crossRun: { m4: string | null; real: string | null } | null;
  budget: BudgetPlan | null;
  ledger: ReservedLedger | null;
  stageSummary: ReturnType<StageLedger['summary']> | null;
  m4Runs: unknown[];
  m4Pairs: unknown[];
  realRuns: unknown[];
  realMerged: unknown | null;
}

/** 화 순서를 포함한 회차 요청 전체의 fingerprint (비공개) */
export const runFingerprint = (plans: Pick<ChapterPlan, 'file' | 'fingerprint'>[]) => sha256(JSON.stringify(plans.map((p) => [p.file, p.fingerprint])));

/** 같은 데이터셋의 회차들이 화 순서까지 같은 요청인가. 다르면 그 이유 (공개해도 되는 화 이름·회차만) */
export function crossRunReason(runs: { label: string; plans: Pick<ChapterPlan, 'file' | 'fingerprint'>[] }[]): string | null {
  const first = runs[0];
  if (!first) return '회차가 없습니다';
  for (const r of runs.slice(1)) {
    if (JSON.stringify(r.plans.map((p) => p.file)) !== JSON.stringify(first.plans.map((p) => p.file))) return `${r.label}: 화 순서가 ${first.label}와 다릅니다`;
    for (const [i, p] of r.plans.entries()) {
      if (!p.fingerprint || p.fingerprint !== first.plans[i]!.fingerprint) return `${r.label} ${p.file}: 요청이 ${first.label}와 다릅니다`;
    }
    if (runFingerprint(r.plans) !== runFingerprint(first.plans)) return `${r.label}: 회차 요청이 ${first.label}와 다릅니다`;
  }
  return null;
}

/** 요청 하나의 묶음마다 비용 상한 */
export const requestBounds = (p: PreparedCheck) => p.users.map((user) => callCostBound(M9_MODEL, { system: M10_PROMPT.system, user, schema: DETECT_SCHEMA }, MAX_OUTPUT_TOKENS));

/** 회차별 계획으로 예산 계획을 만든다 (호출 0) */
export function budgetPlan(runs: { label: string; dataset: Label; plans: ChapterPlan[] }[], stageLimitUsd: number): BudgetPlan {
  const calls = { m4: 0, real: 0, total: 0 };
  const perRunBoundUsd: Record<string, number> = {};
  const maxCall = { m4: 0, real: 0 };
  let total = 0;
  for (const r of runs) {
    const batches = r.plans.reduce((n, p) => n + p.batches, 0);
    calls[r.dataset] += batches;
    calls.total += batches;
    perRunBoundUsd[r.label] = r.plans.reduce((n, p) => n + p.boundUsd, 0);
    total += perRunBoundUsd[r.label]!;
    maxCall[r.dataset] = Math.max(maxCall[r.dataset], ...r.plans.map((p) => p.maxCallBoundUsd));
  }
  const retries1 = total * (1 + M10_RETRIES);
  return {
    calls,
    maxAttempts: calls.total * (1 + M10_RETRIES),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    completionBoundUsd: { retries0: total, retries1 },
    perRunBoundUsd,
    maxCallBoundUsd: maxCall,
    maxInFlightUsd: 2 * Math.max(maxCall.m4, maxCall.real),
    stageLimitUsd,
    completionGuaranteed: retries1 <= stageLimitUsd,
  };
}

interface RunCopy {
  label: string;
  dataset: Label;
  root: string;
  store: AiStore;
  analyses: string;
  report: PreflightReport;
  plans: ChapterPlan[];
}

export async function runM10(o: M10Options): Promise<M10Result> {
  const log = o.log ?? (() => {});
  const result: M10Result = { stage: 'refused', reason: null, connected: false, preflight: [], crossRun: null, budget: null, ledger: null, stageSummary: null, m4Runs: [], m4Pairs: [], realRuns: [], realMerged: null };
  const refuse = (reason: string): M10Result => ({ ...result, stage: 'refused', reason });

  // 폴더를 만들거나 쓰기 전에 모두 확인한다
  const stage = o.stage ?? M10_STAGE;
  const badStage = stageReason(stage);
  if (badStage) return refuse(badStage);
  if (o.run) {
    if (!o.approval || !APPROVAL.test(o.approval)) return refuse('실행에는 감독 승인 ID가 필요합니다');
    if (!o.ledgerDir) return refuse('실행에는 이 실험 전용 단계 장부 폴더가 필요합니다');
  }
  for (const [name, d] of [['m4', o.m4], ['real', o.real]] as const) {
    if (!existsSync(join(d.baseline, '.loreweave', 'ai.db'))) return refuse(`${name} 기준 폴더에 .loreweave/ai.db가 없습니다`);
    if (d.predictions !== null && !existsSync(d.predictions)) return refuse(`${name} 기준 평가기 출력이 없습니다`);
    if (d.targets.length === 0) return refuse(`${name} 검사할 화가 없습니다`);
  }
  if (o.m4.predictions !== null) return refuse('M4는 당시 평가기 출력이 없어 순서 대조를 건너뛰어야 합니다 (predictions: null)');
  if (o.real.predictions === null) return refuse('실제 원고는 기준 평가기 출력으로 순서를 대조해야 합니다');
  try {
    for (const d of [o.m4, o.real]) {
      const why = overlapReason(o.repoRoot, d.baseline, o.work, o.run ? o.ledgerDir : undefined);
      if (why) return refuse(why);
    }
    if (o.run) for (const d of [o.m4, o.real]) if (inside(realPath(d.baseline), realPath(o.ledgerDir!))) return refuse('장부 폴더는 기준 폴더 밖에 있어야 합니다');
  } catch (e) {
    return refuse(`폴더의 실제 경로를 확인할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    lstatSync(o.work);
    return refuse('작업 폴더가 이미 있습니다. 새 폴더를 지정하세요');
  } catch {
    // 없어야 한다
  }

  const runs: RunCopy[] = [];
  let ledger: StageLedger | null = null;
  let abortCleanup = () => {};
  try {
    // 1)·2) 데이터셋마다 스냅숏을 만들고, 회마다 복사본에서 요청을 만들어 그때 기록과 대조한다
    for (const dataset of ['m4', 'real'] as const) {
      const d = o[dataset];
      const before = filesFingerprint(projectFiles(d.baseline));
      const snapshot = join(o.work, dataset, 'snapshot');
      copyProject(d.baseline, snapshot);
      if (filesFingerprint(projectFiles(d.baseline)) !== before) return refuse(`${dataset}: 복사하는 동안 기준 폴더가 바뀌었습니다`);
      const predictions = d.predictions === null ? null : JSON.parse(readFileSync(d.predictions, 'utf8'));
      for (let r = 1; r <= M10_RUNS[dataset]; r++) {
        const label = `${dataset}-${r}`;
        const root = join(o.work, dataset, `run-${r}`);
        copyProject(snapshot, root);
        const store = AiStore.open(root);
        const analyses = await analysesFingerprint(root, store);
        const report = await preflight({ baselineRoot: snapshot, workRoot: root, workStore: store, predictions, skipOrder: d.predictions === null, targets: d.targets });
        const plans: ChapterPlan[] = [];
        for (const file of d.targets) {
          const base = await prepareCheck(file, { root, store });
          const bounds = typeof base === 'string' ? [] : requestBounds(base);
          plans.push({
            file,
            ok: typeof base !== 'string',
            reason: typeof base === 'string' ? base : null,
            facts: typeof base === 'string' ? 0 : base.facts.length,
            batches: typeof base === 'string' ? 0 : base.batches.length,
            fingerprint: typeof base === 'string' ? null : requestFingerprint(base),
            boundUsd: bounds.reduce((n, b) => n + b, 0),
            maxCallBoundUsd: Math.max(0, ...bounds),
          });
        }
        if ((await analysesFingerprint(root, store)) !== analyses) report.ok = false;
        // 요청이 그때 기록과의 대조 때와 같아야 한다
        for (const p of plans) if (p.fingerprint !== report.chapters.find((c) => c.file === p.file)?.fingerprint) Object.assign(p, { ok: false, reason: p.reason ?? '요청이 대조 때와 다릅니다' });
        runs.push({ label, dataset, root, store, analyses, report, plans });
        result.preflight.push({
          label,
          base: publicSummary(report),
          plan: { chapters: plans.length, passed: plans.filter((p) => p.ok).length, facts: plans.reduce((n, p) => n + p.facts, 0), batches: plans.reduce((n, p) => n + p.batches, 0) },
        });
        writeFileSync(join(o.work, `preflight-${label}.json`), JSON.stringify({ report, plans }, null, 2) + '\n');
        log(`${label} 대조: ${report.chapters.filter((c) => c.ok).length}/${report.chapters.length}화`);
      }
    }
    // 회차 사이 동일성 (그때 기록과의 대조와 별개다. M4의 순서 대조 생략은 이것으로 대신하지 않는다)
    result.crossRun = {
      m4: crossRunReason(runs.filter((r) => r.dataset === 'm4')),
      real: crossRunReason(runs.filter((r) => r.dataset === 'real')),
    };
    result.budget = budgetPlan(runs, stage.limitUsd);
    writeFileSync(join(o.work, 'budget.json'), JSON.stringify(result.budget, null, 2) + '\n');
    const expectedRuns = M10_RUNS.m4 + M10_RUNS.real;
    if (runs.length !== expectedRuns || !runs.every((r) => r.report.ok && r.plans.length > 0 && r.plans.every((p) => p.ok)))
      return { ...result, stage: 'preflight-failed', reason: '그때 기록과 맞지 않는 화가 있어 호출하지 않았습니다' };
    if (result.crossRun.m4 || result.crossRun.real) return { ...result, stage: 'preflight-failed', reason: `회차 사이 요청이 다릅니다: ${result.crossRun.m4 ?? result.crossRun.real}` };
    if (!o.run) return { ...result, stage: 'preflight-ok' };

    // 4) 이 실험 전용 장부를 연다. 여섯 회차 중 하나라도 시작한 적이 있으면 연결하지 않는다
    try {
      ledger = StageLedger.open(o.ledgerDir!, { ...stage, approval: o.approval });
    } catch (e) {
      if (e instanceof StageLedgerError) return refuse(e.message);
      throw e;
    }
    const stageLedger = ledger;
    const done = (s: M10Result['stage'], reason: string | null): M10Result => ({ ...result, stage: s, reason, ledger: stageLedger.snapshot(), stageSummary: stageLedger.summary() });
    const used = stageLedger.cannotStart(runs.map((r) => r.label));
    if (used) return { ...done('refused', used), ledger: null };
    if (stageLedger.committed() >= stageLedger.limitUsd) return { ...done('refused', '단계 한도를 이미 다 썼습니다'), ledger: null };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (o.signal?.aborted) return done('stopped', '취소했습니다');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    abortCleanup = () => o.signal?.removeEventListener('abort', onAbort);
    const gate = haltGate(controller.signal);
    const raw = await o.connect();
    result.connected = true;
    const observer = sentObserver();
    const client = gate.outer(withReservation(gate.inner(observer.wrap(raw)), { model: M9_MODEL, budget: stageLedger, retries: M10_RETRIES, maxOutputTokens: MAX_OUTPUT_TOKENS }));
    const sentContexts = new Map<string, Map<number, { chapter: number; quote: string }[]>>();

    /** 대조 때와 같은 분석·요청인가. 같으면 그 요청을 돌려준다 */
    const verify = async (run: RunCopy, file: string): Promise<PreparedCheck | string> => {
      if ((await analysesFingerprint(run.root, run.store)) !== run.analyses) return `${run.label}: 대조 뒤 분석이 바뀌었습니다`;
      const plan = run.plans.find((p) => p.file === file)!;
      const base = await prepareCheck(file, { root: run.root, store: run.store });
      if (typeof base === 'string' || requestFingerprint(base) !== plan.fingerprint) return `${run.label} ${file}: 요청이 대조 때와 다릅니다`;
      return base;
    };
    // 5) 첫 호출 전에 모든 회·모든 화를 다시 확인한다 (확인한 요청을 그대로 보낸다)
    const verified = new Map<string, PreparedCheck>();
    for (const run of runs)
      for (const file of o[run.dataset].targets) {
        const v = await verify(run, file);
        if (typeof v === 'string') return done('stopped', v);
        verified.set(`${run.label}|${file}`, v);
      }

    const signal = controller.signal;
    const send = async (run: RunCopy): Promise<string | null> => {
      const before = gate.halted();
      if (before) return `${run.label}: ${before === '취소' ? '취소했습니다' : `중단했습니다 (${before})`}`;
      stageLedger.startRun(run.label);
      observer.reset();
      for (const file of o[run.dataset].targets) {
        const why = gate.halted();
        if (why) {
          const reason = `${run.label} ${file}: ${why === '취소' ? '취소했습니다' : `중단했습니다 (${why})`}`;
          stageLedger.finishRun(run.label, 'stopped', reason);
          return reason;
        }
        const again = await verify(run, file);
        if (typeof again === 'string') {
          stageLedger.finishRun(run.label, 'stopped', again);
          return again;
        }
        const prepared = verified.get(`${run.label}|${file}`)!;
        const outcome = await runPreparedCheck(prepared, { root: run.root, store: run.store, client, model: M9_MODEL, signal, prompt: M10_PROMPT });
        log(`${run.label} ${file}: 결과 ${outcome.findings}개 (숨김 ${outcome.lowConfidence}) · 단계 누적 $${stageLedger.committed().toFixed(4)}`);
        if (!outcome.stopped && !gate.halted()) {
          const ctx = observer.contextOf(prepared);
          if (typeof ctx === 'string') {
            stageLedger.finishRun(run.label, 'stopped', ctx);
            return `${run.label} ${ctx}`;
          }
          if (!sentContexts.has(run.label)) sentContexts.set(run.label, new Map());
          sentContexts.get(run.label)!.set(chapterNumber(file)!, ctx);
        }
        const halted = gate.halted();
        if (outcome.stopped || halted) {
          const reason = `${run.label} ${file}: ${outcome.stopped ?? `중단했습니다 (${halted})`}`;
          stageLedger.finishRun(run.label, 'stopped', reason);
          return reason;
        }
      }
      stageLedger.finishRun(run.label, 'done');
      return null;
    };
    /** 회차의 평가기 출력 (context는 이 회차에 실제로 넘긴 사실 목록). 실패하면 그 이유 */
    const exported = (run: RunCopy): Predictions | string => {
      run.store.close();
      try {
        const { predictions, usage } = toPredictions(join(run.root, '.loreweave', 'ai.db'), `m10-${run.label}`, 'all', { source: 'runner-sent', byChapter: sentContexts.get(run.label) ?? new Map() });
        const out = join(run.root, 'eval');
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'predictions.json'), JSON.stringify(predictions, null, 2) + '\n');
        writeFileSync(join(out, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
        return predictions as unknown as Predictions;
      } catch (e) {
        return `${run.label}: 평가기 출력을 만들 수 없습니다 (${e instanceof Error ? e.message : String(e)})`;
      } finally {
        run.store = AiStore.open(run.root);
      }
    };
    /** 두 회를 제품 합치기 규칙으로 합친 평가기 입력 (저장된 검증·합친 결과를 읽기 전용으로) */
    const merge = (label: string, a: RunCopy, b: RunCopy, pa: Predictions, pb: Predictions): Predictions => {
      const merged = mergeRuns([storedRun(join(a.root, '.loreweave', 'ai.db')), storedRun(join(b.root, '.loreweave', 'ai.db'))]);
      const p = mergedPredictions(label, pa, merged, [pb]);
      writeFileSync(join(o.work, `merged-${label}.json`), JSON.stringify(p, null, 2) + '\n');
      return p;
    };

    // 6) M4 4회, 회별 기록 → 겹치지 않는 두 쌍의 관문
    const m4Predictions = new Map<string, Predictions>();
    for (const run of runs.filter((r) => r.dataset === 'm4')) {
      const stopped = await send(run);
      if (stopped) return done('stopped', stopped);
      const p = exported(run);
      if (typeof p === 'string') return done('stopped', p);
      m4Predictions.set(run.label, p);
      result.m4Runs.push(o.recordM4(run.label, p, o.m4.targets.length));
      writeFileSync(join(o.work, 'm4-runs.json'), JSON.stringify(result.m4Runs, null, 2) + '\n');
    }
    let m4Pass = true;
    for (const [a, b] of M4_PAIRS) {
      const label = `${a}+${b}`;
      let p: Predictions;
      try {
        p = merge(label, runs.find((r) => r.label === a)!, runs.find((r) => r.label === b)!, m4Predictions.get(a)!, m4Predictions.get(b)!);
      } catch (e) {
        return done('stopped', `${label}: 합칠 수 없습니다 (${e instanceof Error ? e.message : String(e)})`);
      }
      const score = o.scoreM4(label, p, o.m4.targets.length);
      result.m4Pairs.push(score);
      m4Pass &&= score.pass;
    }
    writeFileSync(join(o.work, 'm4-pairs.json'), JSON.stringify(result.m4Pairs, null, 2) + '\n');
    if (!m4Pass) return done('m4-failed', 'M4 합친 두 쌍 중 관문에 미달한 것이 있어 실제 원고 회차를 시작하지 않았습니다');

    // 7) 실제 원고 2회 → 회별·합친 결과의 자동 집계
    const realPredictions: Predictions[] = [];
    for (const run of runs.filter((r) => r.dataset === 'real')) {
      const stopped = await send(run);
      if (stopped) return done('stopped', stopped);
      const p = exported(run);
      if (typeof p === 'string') return done('stopped', p);
      realPredictions.push(p);
      result.realRuns.push(o.scoreReal(run.label, p));
      writeFileSync(join(o.work, 'real-runs.json'), JSON.stringify(result.realRuns, null, 2) + '\n');
    }
    const [r1, r2] = runs.filter((r) => r.dataset === 'real');
    try {
      result.realMerged = o.scoreReal('real-1+real-2', merge('real-1+real-2', r1!, r2!, realPredictions[0]!, realPredictions[1]!));
    } catch (e) {
      return done('stopped', `real-1+real-2: 합칠 수 없습니다 (${e instanceof Error ? e.message : String(e)})`);
    }
    writeFileSync(join(o.work, 'real-merged.json'), JSON.stringify(result.realMerged, null, 2) + '\n');
    return done('done', null);
  } finally {
    abortCleanup();
    for (const r of runs) r.store.close();
    ledger?.close();
  }
}
