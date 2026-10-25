// M9 detect-2 측정 실행 (M9-PLAN 4·5절). 스크립트(scripts/m9-detect2.ts)와 테스트가 함께 쓴다.
// 데이터셋은 실제 원고(real, M8 복사본 20화, 2회)와 합성 원고(m4, M4 시험 원고 15화, 3회)다. 두 데이터셋의 모든 회차가 저장소 밖 단계 장부 하나(stage-ledger.ts)의
// 한도 $1.2를 함께 쓴다.
//   1) 기준 폴더를 작업 폴더의 snapshot/에 복사한다. 복사 전후로 원본 바이트가 같은지 본다 (원본에는 쓰지 않는다)
//   2) 실행마다 snapshot/을 run-N/으로 복사하고, 각 복사본에서 20화 전부를 기준과 대조한다 (m9-preflight.ts)
//   3) 하나라도 맞지 않거나 기준이 없으면 여기서 멈춘다. API 클라이언트는 만들지도 않는다 (connect를 부르지 않는다)
//   4) 통과하고 --run일 때만 단계 장부를 열고(잠금), 이번 회차를 시작한 적이 없을 때만 connect()로 클라이언트를 만들어 장부 예약을 씌운다
//   5) 화마다 요청을 다시 만들어 대조 때의 fingerprint와 같을 때만 detect-2로 보낸다. 다르면 멈춘다
// 화별 fingerprint와 결과(원문 포함)는 작업 폴더(저장소 밖)에만 쓴다.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AiStore } from '../../src/main/ai-db.ts';
import type { AiClient } from '../../src/main/ai-client.ts';
import { prepareCheck, runPreparedCheck, type PreparedCheck } from '../../src/main/checker.ts';
import { toPredictions } from '../export-predictions.ts';
import { DETECT2_SYSTEM, DETECT2_VERSION } from './detect2.ts';
import { analysesFingerprint, filesFingerprint, preflight, publicSummary, requestFingerprint, type PreflightReport } from './m9-preflight.ts';
import { withReservation, type ReservedLedger } from './reserve.ts';
import { M9_STAGE, StageLedger, StageLedgerError, stageReason, type StageDef } from './stage-ledger.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';

export const M9_MODEL = 'gpt-6-luna';
/** M9 단계 한도 (USD). 실제 원고 2회와 M4 3회가 이 한도를 함께 쓴다 (M9-PLAN 5절). 단계 장부에 고정한다 */
export const M9_STAGE_LIMIT_USD = M9_STAGE.limitUsd;
/** 실행 횟수 상한 (계획은 2회) */
export const M9_MAX_RUNS = 10;

export interface M9Options {
  /** 데이터셋 이름. 회차 이름이 `${label}-N`이 된다 (real, m4) */
  label: string;
  /** 기준 폴더: M8 복사본 또는 M4 시험 원고 (읽기만 한다) */
  baseline: string;
  /** 새로 만들 작업 폴더 (이미 있으면 멈춘다) */
  work: string;
  /**
   * 기준의 평가기 출력 경로 (predictions.json). 화·인용 순서 대조에 쓴다.
   * null이면 그 항목을 건너뛰고 대조 결과에 skipped로 남긴다 (M4는 당시 평가기 출력이 남아 있지 않다)
   */
  predictions: string | null;
  /** 검사할 화 (기준에 검사 기록이 있는 화) */
  targets: string[];
  runs: number;
  /** 단계 장부 폴더 (저장소·기준·작업 폴더 밖). run일 때 필요하고, 그때만 연다 */
  ledgerDir?: string;
  /** 단계 정의 (테스트용. 기본 M9_STAGE, 한도는 그보다 클 수 없다) */
  stage?: StageDef;
  /** false면 대조만 하고 끝낸다 */
  run: boolean;
  /** 회차가 끝날 때마다 그 회 예측으로 부른다 (M4 채점). 돌려준 값은 결과의 scores에 남긴다 */
  afterRun?(run: string, predictions: Predictions): unknown;
  /** 대조를 통과했을 때만 부른다. SDK 재시도를 끈 클라이언트를 돌려줘야 한다 */
  connect(): Promise<AiClient> | AiClient;
  /** 저장소 폴더. 기준과 작업 폴더가 이 안에 있으면 멈춘다 */
  repoRoot: string;
  log?(line: string): void;
}

export interface M9Result {
  stage: 'refused' | 'preflight-failed' | 'preflight-ok' | 'stopped' | 'done';
  reason: string | null;
  preflight: ReturnType<typeof publicSummary>[];
  ledger: ReservedLedger | null;
  connected: boolean;
  /** 단계 장부의 회차별 집계 (공개 가능) */
  stageSummary: ReturnType<StageLedger['summary']> | null;
  scores: unknown[];
}

/** p가 root 안(같은 폴더 포함)에 있는가. 드라이브가 다르면 relative가 절대 경로를 돌려주므로 밖이다 */
const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * 실제 경로 (junction·symlink를 따라간 경로). 아직 없는 경로는 가장 가까운 기존 부모의 실제 경로에 나머지를 붙인다.
 * Windows에서는 대소문자를 구분하지 않으므로 비교용으로 소문자로 맞춘다
 */
export function realPath(p: string): string {
  let existing = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  const real = join(realpathSync.native(existing), ...rest);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** 저장소·기준·작업·장부 폴더가 서로 겹치지 않는가. 겹치면 그 이유 */
export function overlapReason(repoRoot: string, baseline: string, work: string, ledgerDir?: string): string | null {
  const repo = realPath(repoRoot);
  const base = realPath(baseline);
  const w = realPath(work);
  const both = (a: string, b: string) => inside(a, b) || inside(b, a);
  if (both(repo, base)) return '기준 폴더는 저장소 밖에 있어야 합니다';
  if (both(repo, w)) return '작업 폴더는 저장소 밖에 있어야 합니다';
  if (both(base, w)) return '작업 폴더와 기준 폴더는 서로 안에 있으면 안 됩니다';
  if (ledgerDir !== undefined) {
    const l = realPath(ledgerDir);
    if (both(repo, l)) return '장부 폴더는 저장소 밖에 있어야 합니다';
    if (both(base, l) || both(w, l)) return '장부 폴더는 기준·작업 폴더와 서로 안에 있으면 안 됩니다';
  }
  return null;
}

/** 실행 횟수가 올바른가. 아니면 그 이유 (한도는 단계 장부에 고정돼 있어 받지 않는다) */
export function optionsReason(runs: number): string | null {
  if (!Number.isInteger(runs) || runs < 1 || runs > M9_MAX_RUNS) return `실행 횟수는 1~${M9_MAX_RUNS}의 정수여야 합니다`;
  return null;
}

/** 기준 폴더에서 복사할 파일: chapters/의 화 파일과 .loreweave/ai.db(와 WAL 파일) */
function projectFiles(root: string): string[] {
  const chapters = readdirSync(join(root, 'chapters')).map((f) => join(root, 'chapters', f));
  const db = ['ai.db', 'ai.db-wal', 'ai.db-shm'].map((f) => join(root, '.loreweave', f)).filter((p) => existsSync(p));
  return [...chapters.sort(), ...db];
}

function copyProject(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  cpSync(join(from, 'chapters'), join(to, 'chapters'), { recursive: true });
  mkdirSync(join(to, '.loreweave'), { recursive: true });
  for (const f of ['ai.db', 'ai.db-wal', 'ai.db-shm']) if (existsSync(join(from, '.loreweave', f))) cpSync(join(from, '.loreweave', f), join(to, '.loreweave', f));
}

export async function runM9(o: M9Options): Promise<M9Result> {
  const log = o.log ?? (() => {});
  const result: M9Result = { stage: 'refused', reason: null, preflight: [], ledger: null, connected: false, stageSummary: null, scores: [] };
  const refuse = (reason: string) => ({ ...result, reason });
  // 폴더를 만들거나 쓰기 전에 모두 확인한다
  const bad = optionsReason(o.runs);
  if (bad) return refuse(bad);
  if (!/^[a-z0-9]+$/.test(o.label)) return refuse('데이터셋 이름은 영문 소문자·숫자만 씁니다');
  if (o.run && !o.ledgerDir) return refuse('실행에는 단계 장부 폴더가 필요합니다');
  const badStage = stageReason(o.stage ?? M9_STAGE);
  if (badStage) return refuse(badStage);
  if (!existsSync(o.baseline)) return refuse('기준 폴더가 없습니다');
  let overlap: string | null;
  try {
    overlap = overlapReason(o.repoRoot, o.baseline, o.work, o.ledgerDir);
  } catch (e) {
    return refuse(`폴더의 실제 경로를 확인할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (overlap) return refuse(overlap);
  try {
    lstatSync(o.work);
    return refuse('작업 폴더가 이미 있습니다. 새 폴더를 지정하세요');
  } catch {
    // 없어야 한다 (끊어진 링크도 있는 것으로 본다)
  }
  if (!existsSync(join(o.baseline, '.loreweave', 'ai.db'))) return refuse('기준 폴더에 .loreweave/ai.db가 없습니다');
  if (o.predictions !== null && !existsSync(o.predictions)) return refuse('기준 평가기 출력(predictions.json)이 없습니다');
  if (o.targets.length === 0) return refuse('검사할 화가 없습니다');

  // 1) 스냅숏. 복사하는 동안 원본이 바뀌었으면 멈춘다
  const before = filesFingerprint(projectFiles(o.baseline));
  const snapshot = join(o.work, 'snapshot');
  copyProject(o.baseline, snapshot);
  if (filesFingerprint(projectFiles(o.baseline)) !== before) return refuse('복사하는 동안 기준 폴더가 바뀌었습니다');
  const predictions = o.predictions === null ? null : (JSON.parse(readFileSync(o.predictions, 'utf8')) as Parameters<typeof preflight>[0]['predictions']);

  // 2) 실행마다 복사본을 만들고 전부 대조한다
  const runs: { root: string; store: AiStore; report: PreflightReport; analyses: string }[] = [];
  let ledger: StageLedger | null = null;
  try {
    for (let r = 1; r <= o.runs; r++) {
      const root = join(o.work, `run-${r}`);
      copyProject(snapshot, root);
      const store = AiStore.open(root);
      const analysesBefore = await analysesFingerprint(root, store);
      const report = await preflight({ baselineRoot: snapshot, workRoot: root, workStore: store, predictions, skipOrder: o.predictions === null, targets: o.targets });
      if ((await analysesFingerprint(root, store)) !== analysesBefore) report.ok = false;
      runs.push({ root, store, report, analyses: analysesBefore });
      result.preflight.push(publicSummary(report));
      // 비공개 기록: 화별 fingerprint와 실패 이유 (원문 없음, 작업 폴더에만)
      writeFileSync(join(o.work, `preflight-run-${r}.json`), JSON.stringify(report, null, 2) + '\n');
      log(`run-${r} 대조: ${report.chapters.filter((c) => c.ok).length}/${report.chapters.length}화 일치${report.ok ? '' : ' (불일치 있음)'}`);
    }
    if (runs.length !== o.runs || !runs.every((r) => r.report.ok)) return { ...result, stage: 'preflight-failed', reason: '기준 입력과 맞지 않는 화가 있어 호출하지 않았습니다' };
    if (!o.run) return { ...result, stage: 'preflight-ok' };

    // 3) 대조를 통과했을 때만 단계 장부를 연다 (잠금). 이번 회차를 이미 시작한 적이 있으면 연결하지 않는다
    const labels = runs.map((_, i) => `${o.label}-${i + 1}`);
    try {
      ledger = StageLedger.open(o.ledgerDir!, o.stage ?? M9_STAGE);
    } catch (e) {
      if (e instanceof StageLedgerError) return refuse(e.message);
      throw e;
    }
    const stageLedger = ledger;
    const done = (stage: M9Result['stage'], reason: string | null) => ({
      ...result,
      stage,
      reason,
      ledger: stageLedger.snapshot(),
      stageSummary: stageLedger.summary(),
    });
    const used = stageLedger.cannotStart(labels);
    if (used) return { ...done('refused', used), ledger: null };
    if (stageLedger.committed() >= stageLedger.limitUsd) return { ...done('refused', '단계 한도를 이미 다 썼습니다'), ledger: null };

    const client = withReservation(await o.connect(), { model: M9_MODEL, budget: stageLedger, retries: 1 });
    result.connected = true;

    /** 대조 때와 같은 요청을 다시 만든다. 다르면 그 이유 */
    const verify = async (i: number, run: (typeof runs)[number], file: string): Promise<PreparedCheck | string> => {
      if ((await analysesFingerprint(run.root, run.store)) !== run.analyses) return `run-${i + 1}: 대조 뒤 분석이 바뀌었습니다`;
      const prepared = await prepareCheck(file, { root: run.root, store: run.store });
      const expected = run.report.chapters.find((c) => c.file === file)?.fingerprint;
      if (typeof prepared === 'string' || !expected || requestFingerprint(prepared) !== expected) return `run-${i + 1} ${file}: 요청이 대조 때와 다릅니다`;
      return prepared;
    };
    // 4) 첫 호출 전에, 연결하는 동안 바뀐 것이 없는지 모든 실행·모든 화를 다시 확인한다 (여기서 확인한 요청을 그대로 보낸다)
    const verified: PreparedCheck[][] = [];
    for (const [i, run] of runs.entries()) {
      const list: PreparedCheck[] = [];
      for (const file of o.targets) {
        const v = await verify(i, run, file);
        if (typeof v === 'string') return done('stopped', v);
        list.push(v);
      }
      verified.push(list);
    }
    const signal = new AbortController().signal;
    for (const [i, run] of runs.entries()) {
      const label = labels[i]!;
      stageLedger.startRun(label);
      for (const [j, file] of o.targets.entries()) {
        // 5) 화마다 보내기 직전에도 다시 확인한다 (앞 화를 보내는 동안 바뀌었을 수 있다)
        const again = await verify(i, run, file);
        if (typeof again === 'string') {
          stageLedger.finishRun(label, 'stopped', again);
          return done('stopped', again);
        }
        const outcome = await runPreparedCheck(verified[i]![j]!, {
          root: run.root,
          store: run.store,
          client,
          model: M9_MODEL,
          signal,
          prompt: { system: DETECT2_SYSTEM, version: DETECT2_VERSION },
        });
        log(`${label} ${file}: 결과 ${outcome.findings}개 (숨김 ${outcome.lowConfidence}) · 단계 누적 $${stageLedger.committed().toFixed(4)}`);
        if (outcome.stopped) {
          const reason = `run-${i + 1} ${file}: ${outcome.stopped}`;
          stageLedger.finishRun(label, 'stopped', reason);
          return done('stopped', reason);
        }
      }
      stageLedger.finishRun(label, 'done');
      const out = join(o.work, `run-${i + 1}`, 'eval');
      mkdirSync(out, { recursive: true });
      run.store.close();
      const { predictions: p, usage } = toPredictions(join(run.root, '.loreweave', 'ai.db'), `m9-detect2-${label}`);
      writeFileSync(join(out, 'predictions.json'), JSON.stringify(p, null, 2) + '\n');
      writeFileSync(join(out, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
      if (o.afterRun) result.scores.push(o.afterRun(label, p as Predictions));
      run.store = AiStore.open(run.root);
    }
    return done('done', null);
  } finally {
    for (const r of runs) r.store.close();
    ledger?.close();
  }
}
