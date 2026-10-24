// AI 분석 버튼과 진행 상황 (M3-PLAN 1절). 작가가 누를 때만 분석한다.
//   - 처음 한 번: 원고가 OpenAI로 전송된다는 안내에 동의받는다
//   - 여러 화: 예상 비용(상한)을 보여 주고 확인받는다
//   - 진행 중: n/전체, 지금까지 비용, [취소]

import { useEffect, useState } from 'react';
import type { AnalysisState, AnalyzeProgress } from '../../preload/api.ts';

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

type Dialog = { kind: 'consent'; files: string[]; many: boolean } | { kind: 'confirm'; files: string[]; costUsd: number; chars: number };

export function AnalysisBar({ file, states, consent, beforeAnalyze, onAnalyzed, onNeedKey }: Props) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = Object.entries(states)
    .filter(([, s]) => s !== 'fresh')
    .map(([f]) => f);

  useEffect(() => api.ai.onProgress(setProgress), []);

  const run = async (files: string[]) => {
    setDialog(null);
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      await beforeAnalyze();
      setProgress(await api.ai.analyze(files));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      onAnalyzed();
    }
  };

  /** 여러 화면 예상 비용을 확인받는다 */
  const confirmOrRun = async (files: string[], many: boolean) => {
    if (!many) return run(files);
    const { costUsd, chars } = await api.ai.estimate(files);
    setDialog({ kind: 'confirm', files, costUsd, chars });
  };

  const start = async (files: string[], many: boolean) => {
    setError(null);
    if (files.length === 0) return;
    if (!(await api.ai.status()).hasKey) return onNeedKey();
    if (!consent) return setDialog({ kind: 'consent', files, many });
    await confirmOrRun(files, many);
  };

  return (
    <div className="analysis">
      <div className="row">
        <button type="button" disabled={running || !file} onClick={() => file && void start([file], false)}>
          이 화 분석
        </button>
        <button type="button" disabled={running || pending.length === 0} onClick={() => void start(pending, true)}>
          남은 화 분석 ({pending.length})
        </button>
      </div>
      {running && progress && (
        <p className="muted" role="status">
          분석 중 {progress.done}/{progress.total} · ${progress.costUsd.toFixed(4)}{' '}
          <button type="button" className="link" onClick={() => void api.ai.cancel()}>
            취소
          </button>
        </p>
      )}
      {!running && progress && (
        <p className={progress.stopped || progress.failed.length ? 'warning' : 'muted'} role="status">
          화 {progress.done}개 분석 · ${progress.costUsd.toFixed(4)}
          {progress.stopped && ` · 멈춤: ${progress.stopped}`}
          {progress.failed.length > 0 && ` · 실패 ${progress.failed.map((f) => `${f.file} (${f.message})`).join(', ')}`}
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {dialog?.kind === 'consent' && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="원고 전송 안내">
            <h2>원고가 OpenAI로 전송됩니다</h2>
            <p>
              AI 분석을 하면 분석하는 화의 본문이 OpenAI로 전송되고, 비용은 작가의 OpenAI 계정에 청구됩니다. 분석은 버튼을 누를 때만 합니다.
            </p>
            <div className="row end">
              <button type="button" onClick={() => setDialog(null)}>
                취소
              </button>
              <button
                type="button"
                onClick={() =>
                  void (async () => {
                    await api.ai.setConsent(true);
                    onAnalyzed();
                    await confirmOrRun(dialog.files, dialog.many);
                  })()
                }
              >
                동의하고 분석
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
              <button type="button" onClick={() => void run(dialog.files)}>
                분석
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
