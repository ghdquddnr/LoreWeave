// M9 후속 실험: 같은 속성 이름의 앞 화 사실 더하기 (M9-FOLLOWUP.md "개선 가설"). 측정 스크립트(scripts/m9-predicate.ts)와 테스트가 함께 쓴다.
// 제품의 사실 고르기(candidateFacts)·판단 프롬프트(detect-1)·화면은 바꾸지 않는다. 판단 프롬프트는 detect-1, 모델은 gpt-6-luna로 고정한다.
//   1) 두 데이터셋을 저장소 밖 새 작업 폴더에 복사한다: M4 시험 원고(14화, 3회)와 M8 복사본(20화, 2회). 원본에는 쓰지 않는다
//   2) 회마다 복사본에서 제품 prepareCheck로 기준 요청을 만들어 그때 기록과 대조하고(m9-preflight.ts),
//      같은 저장 분석에 withPredicateMatches(predicate-addition.ts)를 적용한 추가 요청을 만들어 다음을 확인한다:
//      기존 사실 보존·순서, 중복 없음, 화 순서, 400개 묶음 경계, 묶음마다의 입력(detectionInput). 두 요청의 fingerprint는 작업 폴더에만 남긴다
//   3) 승인 ID와 --run이 있을 때만 이 실험 전용 단계 장부를 열고(M9 장부와 다른 ID), 다섯 회차를 시작한 적이 없을 때만 연결한다
//   4) 첫 호출 전에 모든 회·모든 화의 분석·기준·추가 요청을 다시 확인하고, 확인한 추가 요청을 그대로 보낸다. 화마다 보내기 직전에도 다시 확인한다
//   5) M4 3회를 먼저 하고 회마다 기준 8로 자동 채점한다. 하나라도 미달이면 실제 원고 회차는 시작하지 않는다
//   6) 실제 원고 2회 뒤에는 자동 집계(기존 12개 고정 judge, 새 입력 기준 judge 기록)와 사람 판정 틀만 만든다. 최종 판정은 사람이 한다
// 중간 실패·취소는 그 회차를 멈추고 실험 전체를 끝낸다. 시작한 회차는 다시 하지 않는다 (재시작 중복 방지).
// 공유 중단: 묶음 하나라도 실패가 확정되면(재시도까지 소진, 인증·모델·한도·응답 형식 오류, 예산 거절) 또는 밖에서 취소하면,
//   그 뒤로는 새 묶음·재시도·다음 화·다음 회차를 보내지 않는다. 이미 보낸 요청은 끝까지 기다려 정산한다 (취소면 신호로 끊고, usage를 모르면 예약액을 지출로 남긴다).
//   제품 checker는 묶음 하나가 실패해도 나머지 묶음을 보낸 뒤 실패를 돌려주므로, 이 게이트는 runner의 클라이언트에만 씌운다 (제품 동작은 그대로).

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_BATCH_SIZE, DETECT_SYSTEM, detectionInput, parseDetection, type PriorFact } from '../../src/core/ai/detection.ts';
import { chapterNumber } from '../../src/core/project/chapters.ts';
import { AiError, type AiClient, type JsonCall, type JsonResult } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { prepareCheck, runPreparedCheck, type PreparedCheck } from '../../src/main/checker.ts';
import { toPredictions } from '../export-predictions.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';
import { analysesFingerprint, filesFingerprint, preflight, publicSummary, requestFingerprint, type PreflightReport } from './m9-preflight.ts';
import { copyProject, inside, M9_MODEL, overlapReason, projectFiles, realPath } from './m9-run.ts';
import { withPredicateMatches } from './predicate-addition.ts';
import { withReservation, type ReservedLedger } from './reserve.ts';
import { StageLedger, StageLedgerError, stageReason, type StageDef } from './stage-ledger.ts';

/** 이 실험의 단계 장부. M9 detect-2 장부(m9-detect2)와 다른 ID다. 한도는 단계 장부의 상한($1.2) 안에서 고정한다 */
export const PREDICATE_STAGE = { id: 'm9p-predicate', limitUsd: 1.2 } as const;
/** 판단 프롬프트는 제품 detect-1 그대로다. 복사본 ai.db에 남는 검사 버전만 구분한다 */
export const PREDICATE_PROMPT = { system: DETECT_SYSTEM, version: 'detect-1+predicate-match' } as const;
/** 데이터셋마다 고정한 회 수 */
export const PREDICATE_RUNS = { m4: 3, real: 2 } as const;
/** M8에서 지정 근거가 입력에 있던 12개 (spikes/m8-real/results.json의 seeds[].retrieved). judge 회귀 비교의 고정 분모 */
export const FIXED_JUDGE_SET = ['S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S11', 'S12', 'S14', 'S15', 'S19', 'S20'] as const;
/** 승인 ID 모양 (감독이 정한다, 예: m9p-predicate-20261026-0100) */
const APPROVAL = /^[a-z0-9][a-z0-9-]{5,80}$/;

type Label = keyof typeof PREDICATE_RUNS;

export interface DatasetOptions {
  baseline: string;
  /** 기준 평가기 출력. null이면 화·인용 순서 대조를 건너뛰고 skipped로 남긴다 (M4) */
  predictions: string | null;
  targets: string[];
}

export interface M4Gate {
  pass: boolean;
}

export interface PredicateOptions {
  m4: DatasetOptions;
  real: DatasetOptions;
  /** 새로 만들 작업 폴더 (이미 있으면 멈춘다) */
  work: string;
  repoRoot: string;
  /** false면 대조만 한다 (기본). connect를 부르지 않는다 */
  run: boolean;
  /** 감독 승인 ID. run일 때 필요하고 장부에 묶는다 */
  approval?: string;
  /** 이 실험 전용 단계 장부 폴더. run일 때 필요하다 */
  ledgerDir?: string;
  /** 테스트용 단계 (기본 PREDICATE_STAGE). 승인 ID는 approval로 붙인다 */
  stage?: Omit<StageDef, 'approval'>;
  connect(): Promise<AiClient> | AiClient;
  /** 밖에서 취소하는 신호 (CLI는 Ctrl+C). 취소하면 진행 중 요청을 끊고 새 요청을 보내지 않는다 */
  signal?: AbortSignal;
  /** M4 한 회 채점 (기준 8). 기본은 m4-score.ts의 scoreM4 */
  scoreM4(label: string, predictions: Predictions, checkedChapters: number): M4Gate & Record<string, unknown>;
  /** 실제 원고 한 회 자동 집계 (사람 판정 전). 기본은 realSummary */
  scoreReal(label: string, predictions: Predictions): Record<string, unknown>;
  log?(line: string): void;
}

/**
 * 공유 중단 뒤 보내지 않은 요청.
 * 예약 장부 안쪽(inner)에서 던질 때만 usage 0을 붙여, 이미 잡은 예약을 비용 0으로 정산한다 (보내지 않았으므로 비용이 없다).
 * checker까지 올라갈 때는 usage를 떼어, 보내지 않은 요청이 호출 기록에 남지 않게 한다
 */
export class Halted extends AiError {
  readonly usage?: { inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number };
  constructor(
    readonly reason: string,
    settleAsNotSent = false,
  ) {
    super(`중단했습니다: ${reason}`, 'other');
    if (settleAsNotSent) this.usage = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  }
}

/**
 * 공유 중단 게이트. inner는 예약 장부(withReservation) 안쪽에 씌워 재시도도 막고, outer는 바깥에 씌워 예약 전에 막는다.
 * 실패가 확정되는 곳은 outer다 (재시도를 다 쓴 뒤의 오류, 예산 거절, 응답 형식 오류)
 */
export function haltGate(signal: AbortSignal) {
  let reason: string | null = null;
  const halted = () => reason ?? (signal.aborted ? '취소' : null);
  const inner = (client: AiClient): AiClient => ({
    check: (m) => client.check(m),
    json(call: JsonCall): Promise<JsonResult> {
      const why = halted();
      return why ? Promise.reject(new Halted(why, true)) : client.json(call);
    },
  });
  const outer = (client: AiClient): AiClient => ({
    check: (m) => client.check(m),
    async json(call: JsonCall): Promise<JsonResult> {
      const why = halted();
      if (why) throw new Halted(why);
      let result: JsonResult;
      try {
        result = await client.json(call);
      } catch (e) {
        if (e instanceof Halted) throw new Halted(e.reason);
        reason ??= e instanceof Error ? e.message : String(e);
        throw e;
      }
      // 응답 형식이 틀리면 checker가 그 묶음을 실패로 돌려준다. 그 전에 다른 묶음을 더 보내지 않도록 여기서 멈춘다
      try {
        parseDetection(result.data);
      } catch (e) {
        reason ??= `응답 형식 오류: ${e instanceof Error ? e.message : String(e)}`;
      }
      return result;
    },
  });
  return { inner, outer, halted };
}

export interface ChapterPlan {
  file: string;
  ok: boolean;
  reason: string | null;
  baseFacts: number;
  added: number;
  batchesBase: number;
  batchesPlus: number;
  /** 비공개 (작업 폴더에만) */
  baseFingerprint: string | null;
  plusFingerprint: string | null;
}

export interface PredicateResult {
  stage: 'refused' | 'preflight-failed' | 'preflight-ok' | 'stopped' | 'm4-failed' | 'done';
  reason: string | null;
  connected: boolean;
  preflight: { label: string; base: ReturnType<typeof publicSummary>; addition: ReturnType<typeof additionSummary> }[];
  ledger: ReservedLedger | null;
  stageSummary: ReturnType<StageLedger['summary']> | null;
  m4Scores: unknown[];
  realSummaries: unknown[];
}

/** 추가 요청이 기준 요청의 사실을 모두, 같은 순서로 품고 있는가. 중복·화 순서·400개 경계도 본다. 어긋나면 그 이유 */
export function additionReason(base: PriorFact[], plus: PriorFact[], batches: PriorFact[][], size = CHECK_BATCH_SIZE): string | null {
  const key = (f: PriorFact) => JSON.stringify([f.chapter, f.entity, f.predicate, f.value, f.quote]);
  const keys = plus.map(key);
  if (new Set(keys).size !== keys.length) return '추가 요청에 같은 사실이 두 번 있습니다';
  if (new Set(base.map(key)).size !== base.length) return '기준 요청에 같은 사실이 두 번 있습니다';
  for (let i = 1; i < plus.length; i++) if (plus[i]!.chapter < plus[i - 1]!.chapter) return '추가 요청의 화 순서가 어긋났습니다';
  // 기준 사실이 같은 순서로 모두 들어 있는가 (부분 수열)
  let j = 0;
  for (const k of keys) if (j < base.length && k === key(base[j]!)) j++;
  if (j !== base.length) return '기준 요청의 사실이 빠졌거나 순서가 바뀌었습니다';
  const expected = plus.length > size ? Math.ceil(plus.length / size) : 1;
  if (batches.length !== expected) return `묶음 수 ${batches.length} ≠ ${expected}`;
  if (batches.some((b, i) => b.length !== (i < expected - 1 ? size : plus.length - size * (expected - 1)))) return '400개 묶음 경계가 어긋났습니다';
  if (JSON.stringify(batches.flat().map(key)) !== JSON.stringify(keys)) return '묶음을 이은 사실이 추가 요청과 다릅니다';
  return null;
}

/** 기준 요청(제품 prepareCheck)과 같은 저장 분석으로 추가 요청을 만든다. 모델을 부르지 않는다 */
export function buildPredicateCheck(base: PreparedCheck, store: AiStore): PreparedCheck | string {
  const target = store.analysis(base.file);
  if (!target) return `${base.file} 분석이 없습니다`;
  const priors = base.priors.map((f) => {
    const a = store.analysis(f)!;
    return { chapter: chapterNumber(f)!, entities: a.entities, facts: a.facts };
  });
  const { facts } = withPredicateMatches(target, priors);
  const size = CHECK_BATCH_SIZE;
  const batches = facts.length > size ? Array.from({ length: Math.ceil(facts.length / size) }, (_, i) => facts.slice(i * size, (i + 1) * size)) : [facts];
  const why = additionReason(base.facts, facts, batches, size);
  if (why) return why;
  return { ...base, facts, batches, users: batches.map((b) => detectionInput(base.file, base.target.lines, b)) };
}

export function additionSummary(plans: ChapterPlan[]) {
  return {
    chapters: plans.length,
    passed: plans.filter((p) => p.ok).length,
    facts: { base: plans.reduce((n, p) => n + p.baseFacts, 0), added: plans.reduce((n, p) => n + p.added, 0) },
    batches: { base: plans.reduce((n, p) => n + p.batchesBase, 0), plus: plans.reduce((n, p) => n + p.batchesPlus, 0) },
    perChapter: plans.map((p) => ({ chapter: chapterNumber(p.file), baseFacts: p.baseFacts, added: p.added, batchesBase: p.batchesBase, batchesPlus: p.batchesPlus, ok: p.ok })),
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

export async function runPredicate(o: PredicateOptions): Promise<PredicateResult> {
  const log = o.log ?? (() => {});
  const result: PredicateResult = { stage: 'refused', reason: null, connected: false, preflight: [], ledger: null, stageSummary: null, m4Scores: [], realSummaries: [] };
  const refuse = (reason: string): PredicateResult => ({ ...result, stage: 'refused', reason });

  // 폴더를 만들거나 쓰기 전에 모두 확인한다
  const stage = o.stage ?? PREDICATE_STAGE;
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
    // 장부 폴더가 두 기준 폴더 어느 쪽 안에도 없어야 한다 (overlapReason은 기준 하나씩만 본다)
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
    // 1)·2) 데이터셋마다 스냅숏을 만들고, 회마다 복사본에서 기준·추가 요청을 대조한다
    for (const dataset of ['m4', 'real'] as const) {
      const d = o[dataset];
      const before = filesFingerprint(projectFiles(d.baseline));
      const snapshot = join(o.work, dataset, 'snapshot');
      copyProject(d.baseline, snapshot);
      if (filesFingerprint(projectFiles(d.baseline)) !== before) return refuse(`${dataset}: 복사하는 동안 기준 폴더가 바뀌었습니다`);
      const predictions = d.predictions === null ? null : JSON.parse(readFileSync(d.predictions, 'utf8'));
      for (let r = 1; r <= PREDICATE_RUNS[dataset]; r++) {
        const label = `${dataset}-${r}`;
        const root = join(o.work, dataset, `run-${r}`);
        copyProject(snapshot, root);
        const store = AiStore.open(root);
        const analyses = await analysesFingerprint(root, store);
        const report = await preflight({ baselineRoot: snapshot, workRoot: root, workStore: store, predictions, skipOrder: d.predictions === null, targets: d.targets });
        const plans: ChapterPlan[] = [];
        for (const file of d.targets) {
          const base = await prepareCheck(file, { root, store });
          const plus = typeof base === 'string' ? base : buildPredicateCheck(base, store);
          const ok = typeof base !== 'string' && typeof plus !== 'string';
          plans.push({
            file,
            ok,
            reason: typeof base === 'string' ? base : typeof plus === 'string' ? plus : null,
            baseFacts: typeof base === 'string' ? 0 : base.facts.length,
            added: ok ? (plus as PreparedCheck).facts.length - (base as PreparedCheck).facts.length : 0,
            batchesBase: typeof base === 'string' ? 0 : base.batches.length,
            batchesPlus: ok ? (plus as PreparedCheck).batches.length : 0,
            baseFingerprint: typeof base === 'string' ? null : requestFingerprint(base),
            plusFingerprint: ok ? requestFingerprint(plus as PreparedCheck) : null,
          });
        }
        if ((await analysesFingerprint(root, store)) !== analyses) report.ok = false;
        // 기준 요청의 fingerprint가 기준 대조 때와 같아야 한다
        for (const p of plans) if (p.baseFingerprint !== report.chapters.find((c) => c.file === p.file)?.fingerprint) Object.assign(p, { ok: false, reason: p.reason ?? '기준 요청이 대조 때와 다릅니다' });
        runs.push({ label, dataset, root, store, analyses, report, plans });
        result.preflight.push({ label, base: publicSummary(report), addition: additionSummary(plans) });
        writeFileSync(join(o.work, `preflight-${label}.json`), JSON.stringify({ report, plans }, null, 2) + '\n');
        log(`${label} 대조: 기준 ${report.chapters.filter((c) => c.ok).length}/${report.chapters.length}화, 추가 ${plans.filter((p) => p.ok).length}/${plans.length}화`);
      }
    }
    const expectedRuns = PREDICATE_RUNS.m4 + PREDICATE_RUNS.real;
    if (runs.length !== expectedRuns || !runs.every((r) => r.report.ok && r.plans.length > 0 && r.plans.every((p) => p.ok)))
      return { ...result, stage: 'preflight-failed', reason: '기준 입력이나 추가 요청이 맞지 않는 화가 있어 호출하지 않았습니다' };
    if (!o.run) return { ...result, stage: 'preflight-ok' };

    // 3) 이 실험 전용 장부를 연다. 다섯 회차 중 하나라도 시작한 적이 있으면 연결하지 않는다
    try {
      ledger = StageLedger.open(o.ledgerDir!, { ...stage, approval: o.approval });
    } catch (e) {
      if (e instanceof StageLedgerError) return refuse(e.message);
      throw e;
    }
    const stageLedger = ledger;
    const done = (s: PredicateResult['stage'], reason: string | null): PredicateResult => ({ ...result, stage: s, reason, ledger: stageLedger.snapshot(), stageSummary: stageLedger.summary() });
    const used = stageLedger.cannotStart(runs.map((r) => r.label));
    if (used) return { ...done('refused', used), ledger: null };
    if (stageLedger.committed() >= stageLedger.limitUsd) return { ...done('refused', '단계 한도를 이미 다 썼습니다'), ledger: null };

    // 밖의 취소를 runner 안의 신호로 잇는다. 이 신호로 진행 중 요청을 끊고, 게이트가 새 요청을 막는다
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (o.signal?.aborted) return done('stopped', '취소했습니다');
    o.signal?.addEventListener('abort', onAbort, { once: true });
    abortCleanup = () => o.signal?.removeEventListener('abort', onAbort);
    const gate = haltGate(controller.signal);
    const raw = await o.connect();
    result.connected = true;
    const client = gate.outer(withReservation(gate.inner(raw), { model: M9_MODEL, budget: stageLedger, retries: 1 }));

    /** 대조 때와 같은 분석·기준 요청·추가 요청인가. 같으면 추가 요청을 돌려준다 */
    const verify = async (run: RunCopy, file: string): Promise<PreparedCheck | string> => {
      if ((await analysesFingerprint(run.root, run.store)) !== run.analyses) return `${run.label}: 대조 뒤 분석이 바뀌었습니다`;
      const plan = run.plans.find((p) => p.file === file)!;
      const base = await prepareCheck(file, { root: run.root, store: run.store });
      if (typeof base === 'string' || requestFingerprint(base) !== plan.baseFingerprint) return `${run.label} ${file}: 기준 요청이 대조 때와 다릅니다`;
      const plus = buildPredicateCheck(base, run.store);
      if (typeof plus === 'string' || requestFingerprint(plus) !== plan.plusFingerprint) return `${run.label} ${file}: 추가 요청이 대조 때와 다릅니다`;
      return plus;
    };
    // 4) 첫 호출 전에 모든 회·모든 화를 다시 확인한다 (확인한 추가 요청을 그대로 보낸다)
    const verified = new Map<string, PreparedCheck>();
    for (const run of runs)
      for (const file of o[run.dataset].targets) {
        const v = await verify(run, file);
        if (typeof v === 'string') return done('stopped', v);
        verified.set(`${run.label}|${file}`, v);
      }

    const signal = controller.signal;
    /** 한 회차를 보낸다. 멈추면 그 이유 */
    const send = async (run: RunCopy): Promise<string | null> => {
      const before = gate.halted();
      if (before) return `${run.label}: ${before === '취소' ? '취소했습니다' : `중단했습니다 (${before})`}`;
      stageLedger.startRun(run.label);
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
        const outcome = await runPreparedCheck(verified.get(`${run.label}|${file}`)!, { root: run.root, store: run.store, client, model: M9_MODEL, signal, prompt: PREDICATE_PROMPT });
        log(`${run.label} ${file}: 결과 ${outcome.findings}개 (숨김 ${outcome.lowConfidence}) · 단계 누적 $${stageLedger.committed().toFixed(4)}`);
        // 게이트가 멈췄으면 checker가 저장했더라도 실패로 본다 (응답 형식 오류는 checker도 저장하지 않는다)
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
    const exportRun = (run: RunCopy): Predictions => {
      run.store.close();
      const { predictions, usage } = toPredictions(join(run.root, '.loreweave', 'ai.db'), `m9p-${run.label}`);
      const out = join(run.root, 'eval');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'predictions.json'), JSON.stringify(predictions, null, 2) + '\n');
      writeFileSync(join(out, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
      run.store = AiStore.open(run.root);
      return predictions as Predictions;
    };

    // 5) M4 3회. 회마다 기준 8로 채점하고, 하나라도 미달이면 실제 원고로 가지 않는다
    for (const run of runs.filter((r) => r.dataset === 'm4')) {
      const stopped = await send(run);
      if (stopped) return done('stopped', stopped);
      const score = o.scoreM4(run.label, exportRun(run), o.m4.targets.length);
      result.m4Scores.push(score);
      writeFileSync(join(o.work, 'm4-scores.json'), JSON.stringify(result.m4Scores, null, 2) + '\n');
      if (!score.pass) return done('m4-failed', `${run.label}이(가) 기준 8에 미달해 실제 원고 회차를 시작하지 않았습니다`);
    }
    // 6) 실제 원고 2회
    for (const run of runs.filter((r) => r.dataset === 'real')) {
      const stopped = await send(run);
      if (stopped) return done('stopped', stopped);
      result.realSummaries.push(o.scoreReal(run.label, exportRun(run)));
      writeFileSync(join(o.work, 'real-summaries.json'), JSON.stringify(result.realSummaries, null, 2) + '\n');
    }
    return done('done', null);
  } finally {
    abortCleanup();
    for (const r of runs) r.store.close();
    ledger?.close();
  }
}

/**
 * 실제 원고 한 회의 자동 집계 (사람 판정 전). 평가기의 scorer 결과로 센다:
 *   - judgeFixed12: 기존 고정 12개(FIXED_JUDGE_SET) 중 scorer가 찾은 수. 회귀 비교 기준은 ≥ 6/12 (사람 판정으로 확정)
 *   - judgeNew: 이번 입력에서 지정 근거가 들어간 오류를 분모로 한 기록 (기준 아님)
 * Recall·오탐 등 M9-PLAN 기준 1·2·4·5·7은 사람 판정 뒤에 센다. 여기서는 판정 틀만 만든다
 */
export function realSummary(
  label: string,
  report: { retrieval: { per_error: Record<string, boolean> }; findings: { label: string; error_id?: string; target_chapter: number; finding: { confidence: number } }[] },
) {
  const found = new Set(report.findings.filter((f) => f.label === 'tp').map((f) => f.error_id!));
  const retrievedNow = Object.entries(report.retrieval.per_error).filter(([, v]) => v).map(([k]) => k).sort();
  return {
    run: label,
    scorerFound: [...found].sort(),
    retrievedNow,
    judgeFixed12: { found: FIXED_JUDGE_SET.filter((id) => found.has(id)).length, total: FIXED_JUDGE_SET.length, regressionTarget: 6 },
    judgeNew: { found: retrievedNow.filter((id) => found.has(id)).length, total: retrievedNow.length, recordOnly: true },
    outsideGroundTruth: report.findings.filter((f) => f.label === 'unlabeled').map((f, i) => ({ id: `${label}-u${i + 1}`, chapter: f.target_chapter, verdict: '' })),
    humanJudgment: 'pending',
  };
}

/** M4 회차마다 E23(내용상 대체 근거 유입과 발견)을 사람이 판정할 틀 */
export function e23Template(label: string, scorerFound: boolean) {
  return { run: label, error: 'E23', scorerFound, contentEvidenceInInput: null as boolean | null, foundByContent: null as boolean | null, note: '' };
}
