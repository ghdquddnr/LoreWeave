// 현재 화에서 AI가 뽑은 사실 (M3-PLAN 1절). 인용을 누르면 그 줄로 이동한다.
// 이동할 때는 저장된 줄 번호를 그대로 믿지 않고 지금 본문에서 인용을 다시 찾는다 (분석 뒤 본문이 바뀌었을 수 있다).

import { useEffect, useState } from 'react';
import { locateQuote, type QuoteLocation } from '../../core/ai/locate.ts';
import type { AnalysisState, StoredAnalysis } from '../../preload/api.ts';

const api = window.loreweave;

interface Props {
  file: string;
  /** 이 패널을 띄운 프로젝트의 token. 읽기 요청에 함께 보낸다 (다른 프로젝트가 열린 뒤의 요청은 main이 거절한다) */
  projectToken: number;
  /** 프로젝트를 바꾸는 중. 이 패널의 이동을 받지 않는다 */
  locked: boolean;
  state: AnalysisState | undefined;
  /** 분석이 끝날 때마다 바뀐다 (다시 읽기) */
  version: number;
  currentLines(): string[] | null;
  /** at이 null이면 지금 본문에 인용이 없다: 이전 선택만 접는다 */
  onJump(at: QuoteLocation | null): void;
}

export function FactsPanel({ file, projectToken, locked, state, version, currentLines, onJump }: Props) {
  /** 보이는 분석과 그 분석을 읽은 화. 화를 바꾼 직후(새 결과를 읽기 전)에도 이전 화의 분석을 보이지 않는다 */
  const [loaded, setLoaded] = useState<{ file: string; analysis: StoredAnalysis | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFailed(null);
    // 거절·실패도 받는다: 지금 조회의 실패는 안내와 [다시 읽기]로 보이고, 이전 조회(다른 화·다른 프로젝트)의 실패는 조용히 버린다
    api.ai.analysis(file, projectToken).then(
      (a) => !cancelled && setLoaded({ file, analysis: a }),
      (e: Error) => !cancelled && setFailed(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [file, projectToken, version, reload]);
  const analysis = loaded?.file === file ? loaded.analysis : undefined;

  const jump = (quote: string) => {
    if (locked) return;
    const at = locateQuote(currentLines() ?? [], quote);
    setMissing(at ? null : quote);
    onJump(at);
  };

  const byEntity = new Map<string, StoredAnalysis['facts']>();
  for (const f of analysis?.facts ?? []) byEntity.set(f.entity, [...(byEntity.get(f.entity) ?? []), f]);

  /** 사실의 인용이 지금 본문에서 어디에 있는가: 분석 때와 같은 줄 · 다른 줄에서 실제로 찾음(MOVED) · 찾을 수 없음(MISSING) */
  const placeOf = (fact: StoredAnalysis['facts'][number]): 'ok' | 'moved' | 'missing' | 'unknown' => {
    const lines = currentLines();
    if (!lines) return 'unknown';
    const at = locateQuote(lines, fact.quote);
    return !at ? 'missing' : at.line === fact.line ? 'ok' : 'moved';
  };

  return (
    <aside className="facts" aria-label="AI가 찾은 사실">
      <h2>
        <button type="button" className="sec-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> <span>AI가 찾은 사실</span>
        </button>
      </h2>
      <div className="sec-body" hidden={!open}>
        {failed && (
          <p className="error" role="alert">
            <span aria-hidden="true">✕</span> 분석 결과를 읽지 못했습니다: {failed}{' '}
            <button type="button" className="link" onClick={() => setReload((n) => n + 1)}>
              다시 읽기
            </button>
          </p>
        )}
        {analysis === undefined && !failed && <p className="muted">불러오는 중…</p>}
        {analysis === null && <p className="muted">아직 분석하지 않은 화입니다. 왼쪽의 [이 화 분석]을 누르세요.</p>}
        {analysis && (
          <>
            <p className="muted">
              {analysis.model}
              {(analysis.chunks ?? 1) > 1 && ` · ${analysis.chunks}조각으로 나눠 추출`} · {new Date(analysis.createdAt).toLocaleString()}
            </p>
            {state === 'stale' && (
              <p className="warning">
                <span aria-hidden="true">◐</span> 분석한 뒤 본문이 바뀌었습니다. 다시 분석하면 최신 내용이 반영됩니다.
              </p>
            )}
            {analysis.droppedQuotes > 0 && <p className="muted">본문에서 인용을 찾을 수 없어 버린 사실 {analysis.droppedQuotes}개</p>}
            {missing && (
              <p className="warning">
                <span className="chip chip-missing">MISSING</span> 지금 본문에서 이 인용을 찾을 수 없습니다: “{missing}”
              </p>
            )}
            <details>
              <summary>요약</summary>
              <p>{analysis.summary}</p>
            </details>
            {[...byEntity].map(([entity, facts]) => (
              <section key={entity} className="entity">
                <h3>{entity}</h3>
                <ul>
                  {facts.map((f, i) => {
                    const place = placeOf(f);
                    return (
                      <li key={i}>
                        <span className="fact">
                          <span className="attr">{f.predicate}</span>
                          <span className="sep">: </span>
                          <span className="val">{f.value}</span>
                        </span>
                        <span className="quote-row">
                          <button type="button" className="quote" title="본문에서 이 문장으로 이동" disabled={locked} onClick={() => jump(f.quote)}>
                            “{f.quote}”
                          </button>
                          {place === 'moved' && (
                            <span className="chip chip-moved" title="분석 때와 다른 줄에서 지금 본문의 이 문장을 찾았습니다">
                              MOVED
                            </span>
                          )}
                          {place === 'missing' && (
                            <span className="chip chip-missing" title="지금 본문에서 이 문장을 찾을 수 없습니다">
                              MISSING
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {analysis.facts.length === 0 && <p className="muted">뽑은 사실이 없습니다.</p>}
          </>
        )}
      </div>
    </aside>
  );
}
