// AI 분석·검사 버튼과 진행 상황 (M3-PLAN 1절, M4-PLAN 1절). 작가가 누를 때만 실행한다.
//   - 처음 한 번: 원고가 OpenAI로 전송된다는 안내에 동의받는다
//   - 여러 화 분석, 이 화 검사: 예상 비용(상한)을 보여 주고 확인받는다
//   - 진행 중: n/전체, 지금까지 비용, [취소]

import { useEffect, useState } from 'react';
import type { AnalysisState, AnalyzeProgress, CheckOutcome, CheckPlan } from '../../preload/api.ts';

const api = window.loreweave;

interface Props {
  file: string | null;
  states: Record<string, AnalysisState>;
  consent: boolean;
  /** 분석 전에 현재 화를 저장한다 (분석은 저장된 파일을 읽는다) */
  beforeAnalyze(): Promise<unknown>;
  onAnalyzed(): void;
  onNeedKey(): void;
}

type Dialog =
  | { kind: 'consent'; then(): Promise<void> }
  | { kind: 'confirm'; files: string[]; costUsd: number; chars: number }
  | { kind: 'check'; file: string; plan: CheckPlan };

type Result = { kind: 'analysis'; progress: AnalyzeProgress } | { kind: 'check'; outcome: CheckOutcome };

export function AnalysisBar({ file, states, consent, beforeAnalyze, onAnalyzed, onNeedKey }: Props) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState<'analysis' | 'check' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = Object.entries(states)
    .filter(([, s]) => s !== 'fresh')
    .map(([f]) => f);

  useEffect(() => api.ai.onProgress(setProgress), []);

  const execute = async (kind: 'analysis' | 'check', work: () => Promise<Result>) => {
    setDialog(null);
    setRunning(kind);
    setError(null);
    setProgress(null);
    setResult(null);
    try {
      await beforeAnalyze();
      setResult(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
      onAnalyzed();
    }
  };

  const analyze = (files: string[]) => execute('analysis', async () => ({ kind: 'analysis', progress: await api.ai.analyze(files) }));
  const check = (target: string) => execute('check', async () => ({ kind: 'check', outcome: await api.ai.runCheck(target) }));

  /** 키와 전송 동의를 확인한 뒤 next를 한다 */
  const start = async (next: () => Promise<void>) => {
    setError(null);
    if (!(await api.ai.status()).hasKey) return onNeedKey();
    if (!consent) return setDialog({ kind: 'consent', then: next });
    await next();
  };

  const startAnalysis = (files: string[], many: boolean) => {
    if (files.length === 0) return;
    void start(async () => {
      if (!many) return analyze(files);
      const { costUsd, chars } = await api.ai.estimate(files);
      setDialog({ kind: 'confirm', files, costUsd, chars });
    });
  };

  const startCheck = (target: string) =>
    void start(async () => {
      await beforeAnalyze();
      try {
        setDialog({ kind: 'check', file: target, plan: await api.ai.planCheck(target) });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  return (
    <div className="analysis">
      <div className="row">
        <button type="button" disabled={!!running || !file} onClick={() => file && startAnalysis([file], false)}>
          이 화 분석
        </button>
        <button type="button" disabled={!!running || pending.length === 0} onClick={() => startAnalysis(pending, true)}>
          남은 화 분석 ({pending.length})
        </button>
        <button type="button" disabled={!!running || !file} onClick={() => file && startCheck(file)}>
          이 화 검사
        </button>
      </div>
      {running && (
        <p className="muted" role="status">
          {running === 'check' && (!progress || progress.done === progress.total)
            ? '검사 중…'
            : `${running === 'check' ? '검사 전 분석' : '분석'} 중 ${progress?.done ?? 0}/${progress?.total ?? '…'}`}
          {progress && ` · $${progress.costUsd.toFixed(4)}`}{' '}
          <button type="button" className="link" onClick={() => void api.ai.cancel()}>
            취소
          </button>
        </p>
      )}
      {!running && result?.kind === 'analysis' && (
        <p className={result.progress.stopped || result.progress.failed.length ? 'warning' : 'muted'} role="status">
          화 {result.progress.done}개 분석 · ${result.progress.costUsd.toFixed(4)}
          {result.progress.stopped && ` · 멈춤: ${result.progress.stopped}`}
          {result.progress.failed.length > 0 && ` · 실패 ${result.progress.failed.map((f) => `${f.file} (${f.message})`).join(', ')}`}
        </p>
      )}
      {!running && result?.kind === 'check' && (
        <p className={result.outcome.stopped ? 'warning' : 'muted'} role="status">
          {result.outcome.checked
            ? `검사 완료: 문제 가능성 ${result.outcome.findings}개`
            : `검사하지 못함: ${result.outcome.stopped}`}
          {` · $${result.outcome.costUsd.toFixed(4)}`}
          {result.outcome.analysis && ` · 먼저 분석한 화 ${result.outcome.analysis.done}개`}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {dialog?.kind === 'consent' && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="원고 전송 안내">
            <h2>원고가 OpenAI로 전송됩니다</h2>
            <p>
              AI 분석이나 검사를 하면 그 화의 본문과 앞 화에서 뽑은 사실(원문 인용 포함)이 OpenAI로 전송되고, 비용은 작가의 OpenAI 계정에
              청구됩니다. 버튼을 누를 때만 보냅니다.
            </p>
            <div className="row end">
              <button type="button" onClick={() => setDialog(null)}>
                취소
              </button>
              <button
                type="button"
                onClick={() =>
                  void (async () => {
                    const next = dialog.then;
                    setDialog(null);
                    await api.ai.setConsent(true);
                    onAnalyzed();
                    await next();
                  })()
                }
              >
                동의하고 계속
              </button>
            </div>
          </section>
        </div>
      )}
      {dialog?.kind === 'confirm' && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="분석 확인">
            <h2>화 {dialog.files.length}개를 분석할까요?</h2>
            <p>
              본문 {dialog.chars.toLocaleString()}자 · 예상 비용 최대 ${dialog.costUsd.toFixed(4)}
            </p>
            <p className="muted">예상 비용은 넉넉하게 잡은 상한입니다. 실제 비용은 분석이 끝난 뒤 보여 줍니다.</p>
            <div className="row end">
              <button type="button" onClick={() => setDialog(null)}>
                취소
              </button>
              <button type="button" onClick={() => void analyze(dialog.files)}>
                분석
              </button>
            </div>
          </section>
        </div>
      )}
      {dialog?.kind === 'check' && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="검사 확인">
            <h2>이 화를 앞 화 {dialog.plan.priors}개와 비교할까요?</h2>
            {dialog.plan.analyze.length > 0 ? (
              <p>
                먼저 화 {dialog.plan.analyze.length}개를 분석합니다 ({dialog.plan.analyze.join(', ')}). 분석과 검사의 예상 비용 최대 $
                {dialog.plan.costUsd.toFixed(4)}
              </p>
            ) : (
              <p>예상 비용 최대 ${dialog.plan.costUsd.toFixed(4)}</p>
            )}
            <p className="muted">결과는 "문제 가능성"입니다. 의도한 설정 변화일 수 있으니 근거를 보고 판단하세요.</p>
            <div className="row end">
              <button type="button" onClick={() => setDialog(null)}>
                취소
              </button>
              <button type="button" onClick={() => void check(dialog.file)}>
                검사
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
