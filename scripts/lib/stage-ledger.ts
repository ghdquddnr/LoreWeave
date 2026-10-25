// M9 단계 장부 (M9-PLAN 5절). 실제 원고 20화 2회와 M4 15화 3회가 저장소 밖 파일 하나에 예약·지출을 함께 남긴다.
//   - 단계 ID와 한도는 코드에 고정한다 (M9_STAGE). 장부 파일의 ID·한도가 다르면 열지 않는다. 명령줄로 한도나 잔액을 넘기지 않는다
//   - 잠금: 장부를 여는 동안 ledger.lock을 배타적으로 만든다 (이미 있으면 다른 실행 중이거나 지난 실행이 비정상 종료한 것이므로 열지 않는다).
//     잠금은 자동으로 풀지 않는다. 실행 중인 프로세스가 없는지 사람이 확인한 뒤 직접 지운다
//   - 예약은 보내기 전에 파일에 남긴다 (임시 파일에 쓰고 fsync한 뒤 이름 바꾸기). 정산도 같은 방식이다
//   - 다시 열 때 정산되지 않은 예약은 실제로 보냈는지 알 수 없으므로 예약액 전부를 지출로 바꾼다 (unknown). 풀어 주지 않는다
//   - 회차(label, 예: real-1, m4-2)는 한 번만 시작할 수 있다. 멈추거나 비정상 종료한 회차를 자동으로 다시 하지 않는다

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetRefused, type Budget, type Reservation, type ReservedLedger } from './reserve.ts';

export const M9_STAGE = { id: 'm9-detect2', limitUsd: 1.2 } as const;

export interface StageDef {
  id: string;
  limitUsd: number;
  /** 이 장부를 쓰도록 승인한 감독 승인 ID. 장부를 처음 만들 때 남기고, 다시 열 때 다르면 열지 않는다 (M9 장부에는 없다) */
  approval?: string;
}

type EntryState = 'reserved' | 'settled' | 'unknown';
interface Entry {
  id: number;
  run: string;
  at: string;
  reservedUsd: number;
  state: EntryState;
  /** settled일 때 usage로 정산한 값. unknown이면 reservedUsd를 지출로 본다 */
  spentUsd: number | null;
}
type RunState = 'started' | 'done' | 'stopped' | 'interrupted';
interface StageFile {
  version: 1;
  stageId: string;
  limitUsd: number;
  approval?: string;
  createdAt: string;
  runs: Record<string, { state: RunState; startedAt: string; endedAt: string | null; reason: string | null }>;
  entries: Entry[];
}

export class StageLedgerError extends Error {}

/** 단계 정의가 올바른가. 아니면 그 이유 (한도는 M9_STAGE보다 클 수 없다) */
export function stageReason(stage: StageDef): string | null {
  if (!/^[a-z0-9-]+$/.test(stage.id)) return '단계 ID는 영문 소문자·숫자·-만 씁니다';
  if (!Number.isFinite(stage.limitUsd) || stage.limitUsd <= 0 || stage.limitUsd > M9_STAGE.limitUsd) return `단계 한도는 0보다 크고 $${M9_STAGE.limitUsd} 이하여야 합니다`;
  return null;
}

const entrySpent = (e: Entry) => (e.state === 'settled' ? e.spentUsd! : e.reservedUsd);

export class StageLedger implements Budget {
  private refused: string | null = null;
  private current: string | null = null;
  private readonly mine = new Map<Reservation, Entry>();
  private closed = false;

  private constructor(
    private readonly dir: string,
    private readonly data: StageFile,
    private readonly now: () => Date,
  ) {}

  /** 장부를 연다 (없으면 만든다). 잠금을 얻지 못하거나 단계가 다르면 StageLedgerError */
  static open(dir: string, stage: StageDef = M9_STAGE, now: () => Date = () => new Date()): StageLedger {
    const bad = stageReason(stage);
    if (bad) throw new StageLedgerError(bad);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, 'ledger.lock');
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      throw new StageLedgerError(
        `장부가 잠겨 있습니다 (${lock}). 다른 실행이 쓰는 중이거나 지난 실행이 비정상 종료했습니다. 실행 중인 프로세스가 없음을 확인한 뒤 잠금 파일을 직접 지우세요`,
      );
    }
    writeSync(fd, `${process.pid} ${now().toISOString()}\n`);
    closeSync(fd);
    try {
      const path = join(dir, 'ledger.json');
      let data: StageFile;
      if (existsSync(path)) {
        data = JSON.parse(readFileSync(path, 'utf8')) as StageFile;
        if (data.version !== 1 || data.stageId !== stage.id || data.limitUsd !== stage.limitUsd)
          throw new StageLedgerError(`장부의 단계(${data.stageId}, $${data.limitUsd})가 이 실행의 단계(${stage.id}, $${stage.limitUsd})와 다릅니다`);
        if ((data.approval ?? null) !== (stage.approval ?? null)) throw new StageLedgerError('장부의 승인 ID가 이 실행의 승인 ID와 다릅니다');
      } else {
        data = { version: 1, stageId: stage.id, limitUsd: stage.limitUsd, ...(stage.approval ? { approval: stage.approval } : {}), createdAt: now().toISOString(), runs: {}, entries: [] };
      }
      const ledger = new StageLedger(dir, data, now);
      // 지난 실행이 정산하지 못한 예약: 보냈는지 모르므로 예약액 전부를 지출로 남긴다
      for (const e of data.entries) if (e.state === 'reserved') e.state = 'unknown';
      for (const r of Object.values(data.runs)) if (r.state === 'started') Object.assign(r, { state: 'interrupted', endedAt: now().toISOString(), reason: '비정상 종료' });
      ledger.write();
      return ledger;
    } catch (e) {
      unlinkSync(lock);
      throw e;
    }
  }

  /** 임시 파일에 쓰고 fsync한 뒤 이름을 바꾼다 (쓰다가 끊겨도 앞 내용이 남는다) */
  private write() {
    const path = join(this.dir, 'ledger.json');
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(this.data, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  private alive() {
    if (this.closed) throw new StageLedgerError('닫은 장부입니다');
  }

  get limitUsd() {
    return this.data.limitUsd;
  }

  /** 정산한 지출 + 지출로 남긴 예약 + 진행 중 예약 */
  committed(): number {
    return this.data.entries.reduce((n, e) => n + entrySpent(e), 0);
  }

  /** 이 회차들을 아직 시작한 적이 없으면 null, 있으면 그 이유 */
  cannotStart(labels: string[]): string | null {
    const used = labels.filter((l) => this.data.runs[l]);
    return used.length ? `이미 시작한 회차는 다시 하지 않습니다: ${used.map((l) => `${l}(${this.data.runs[l]!.state})`).join(', ')}` : null;
  }

  startRun(label: string) {
    this.alive();
    const why = this.cannotStart([label]);
    if (why) throw new StageLedgerError(why);
    if (this.current) throw new StageLedgerError(`진행 중인 회차가 있습니다: ${this.current}`);
    this.data.runs[label] = { state: 'started', startedAt: this.now().toISOString(), endedAt: null, reason: null };
    this.current = label;
    this.write();
  }

  finishRun(label: string, state: 'done' | 'stopped', reason: string | null = null) {
    this.alive();
    if (this.current !== label) throw new StageLedgerError(`진행 중인 회차가 아닙니다: ${label}`);
    if ([...this.mine.values()].some((e) => e.state === 'reserved')) throw new StageLedgerError('정산하지 않은 예약이 남아 있습니다');
    Object.assign(this.data.runs[label]!, { state, endedAt: this.now().toISOString(), reason });
    this.current = null;
    this.write();
  }

  reserve(need: number): Reservation {
    this.alive();
    if (!this.current) throw new StageLedgerError('회차를 시작하지 않고 예약할 수 없습니다');
    const committed = this.committed();
    if (this.refused) throw new BudgetRefused(this.data.limitUsd, committed, need);
    if (committed + need > this.data.limitUsd) {
      const refused = new BudgetRefused(this.data.limitUsd, committed, need);
      this.refused = refused.message;
      throw refused;
    }
    const entry: Entry = { id: this.data.entries.length + 1, run: this.current, at: this.now().toISOString(), reservedUsd: need, state: 'reserved', spentUsd: null };
    this.data.entries.push(entry);
    // 보내기 전에 파일에 남긴다. 쓰지 못하면 예약하지 않는다
    try {
      this.write();
    } catch (e) {
      this.data.entries.pop();
      throw e;
    }
    const r = { usd: need };
    this.mine.set(r, entry);
    return r;
  }

  settle(r: Reservation, spentUsd: number | null) {
    this.alive();
    const entry = this.mine.get(r);
    if (!entry || entry.state !== 'reserved') throw new StageLedgerError('이미 정산했거나 이 장부의 예약이 아닙니다');
    if (spentUsd !== null) Object.assign(entry, { state: 'settled', spentUsd: Math.max(spentUsd, 0) });
    else entry.state = 'unknown';
    this.write();
  }

  snapshot(): ReservedLedger {
    const e = this.data.entries;
    return {
      spent: e.filter((x) => x.state !== 'reserved').reduce((n, x) => n + entrySpent(x), 0),
      inFlight: e.filter((x) => x.state === 'reserved').reduce((n, x) => n + x.reservedUsd, 0),
      attempts: e.length,
      unknownUsage: e.filter((x) => x.state === 'unknown').length,
      refused: this.refused,
    };
  }

  /** 공개해도 되는 집계 (회차별 상태와 금액) */
  summary() {
    const byRun: Record<string, { state: RunState; attempts: number; spentUsd: number; unknown: number }> = {};
    for (const [label, r] of Object.entries(this.data.runs)) {
      const es = this.data.entries.filter((e) => e.run === label);
      byRun[label] = { state: r.state, attempts: es.length, spentUsd: es.reduce((n, e) => n + entrySpent(e), 0), unknown: es.filter((e) => e.state === 'unknown').length };
    }
    return { stageId: this.data.stageId, limitUsd: this.data.limitUsd, committedUsd: this.committed(), runs: byRun };
  }

  /** 잠금을 푼다. 정산하지 않은 예약은 지출로 남긴다 */
  close() {
    if (this.closed) return;
    for (const e of this.mine.values()) if (e.state === 'reserved') e.state = 'unknown';
    if (this.current) Object.assign(this.data.runs[this.current]!, { state: 'interrupted', endedAt: this.now().toISOString(), reason: '정상적으로 끝내지 않고 닫음' });
    this.write();
    this.closed = true;
    unlinkSync(join(this.dir, 'ledger.lock'));
  }
}
