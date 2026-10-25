// 현재 화에서 AI가 뽑은 사실 (M3-PLAN 1절). 인용을 누르면 그 줄로 이동한다.
// 이동할 때는 저장된 줄 번호를 그대로 믿지 않고 지금 본문에서 인용을 다시 찾는다 (분석 뒤 본문이 바뀌었을 수 있다).

import { useEffect, useState } from 'react';
import { locateQuote, type QuoteLocation } from '../../core/ai/locate.ts';
import type { AnalysisState, StoredAnalysis } from '../../preload/api.ts';

const api = window.loreweave;

interface Props {
  file: string;
  state: AnalysisState | undefined;
  /** 분석이 끝날 때마다 바뀐다 (다시 읽기) */
  version: number;
  currentLines(): string[] | null;
  onJump(at: QuoteLocation): void;
}

export function FactsPanel({ file, state, version, currentLines, onJump }: Props) {
  const [analysis, setAnalysis] = useState<StoredAnalysis | null | undefined>(undefined);
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(undefined);
    void api.ai.analysis(file).then((a) => !cancelled && setAnalysis(a));
    return () => {
      cancelled = true;
    };
  }, [file, version]);

  const jump = (quote: string) => {
    const at = locateQuote(currentLines() ?? [], quote);
    setMissing(at ? null : quote);
    if (at) onJump(at);
  };

  const byEntity = new Map<string, StoredAnalysis['facts']>();
  for (const f of analysis?.facts ?? []) byEntity.set(f.entity, [...(byEntity.get(f.entity) ?? []), f]);

  return (
    <aside className="facts" aria-label="AI가 찾은 사실">
      <h2>AI가 찾은 사실</h2>
      {analysis === undefined && <p className="muted">불러오는 중…</p>}
      {analysis === null && <p className="muted">아직 분석하지 않은 화입니다. 왼쪽의 [이 화 분석]을 누르세요.</p>}
      {analysis && (
        <>
          <p className="muted">
            {analysis.model} · {new Date(analysis.createdAt).toLocaleString()}
          </p>
          {state === 'stale' && <p className="warning">분석한 뒤 본문이 바뀌었습니다. 다시 분석하면 최신 내용이 반영됩니다.</p>}
          {analysis.droppedQuotes > 0 && (
            <p className="muted">본문에서 인용을 찾을 수 없어 버린 사실 {analysis.droppedQuotes}개</p>
          )}
          {missing && <p className="warning">지금 본문에서 이 인용을 찾을 수 없습니다: “{missing}”</p>}
          <details>
            <summary>요약</summary>
            <p>{analysis.summary}</p>
          </details>
          {[...byEntity].map(([entity, facts]) => (
            <section key={entity} className="entity">
              <h3>{entity}</h3>
              <ul>
                {facts.map((f, i) => (
                  <li key={i}>
                    <span className="fact">
                      {f.predicate}: {f.value}
                    </span>
                    <button type="button" className="quote" title="본문에서 이 문장으로 이동" onClick={() => jump(f.quote)}>
                      “{f.quote}”
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {analysis.facts.length === 0 && <p className="muted">뽑은 사실이 없습니다.</p>}
        </>
      )}
    </aside>
  );
}
