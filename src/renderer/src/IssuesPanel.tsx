// 현재 화의 연속성 검사 결과 (M4-PLAN 1절). 항상 "문제 가능성"으로 보여 준다. 판단은 작가가 한다.
//   - 이 화 문장을 누르면 그 문장으로, 근거를 누르면 그 화의 그 문장으로 이동한다
//   - 이 화 문장은 저장된 위치를 믿지 않고 지금 본문에서 다시 찾는다 (검사 뒤 고쳤을 수 있다)
//   - [무시]한 결과는 다시 검사해도 숨는다

import { useEffect, useState } from 'react';
import { CATEGORY_LABELS, CHECK_BATCH_SIZE } from '../../core/ai/detection.ts';
import { locateQuote, type QuoteLocation } from '../../core/ai/locate.ts';
import type { CheckState, StoredCheck, StoredFinding } from '../../preload/api.ts';

const api = window.loreweave;

/** 인용을 따옴표로 감싸 보여 준다. 대사처럼 이미 따옴표로 감싸여 있으면 그대로 둔다 */
const quoted = (quote: string) => (/^["“'‘「『].*["”'’」』]$/s.test(quote.trim()) ? quote.trim() : `“${quote}”`);

interface Props {
  file: string;
  state: CheckState | undefined;
  /** 분석·검사가 끝날 때마다 바뀐다 (다시 읽기) */
  version: number;
  currentLines(): string[] | null;
  onJump(at: QuoteLocation): void;
  /** 다른 화(근거)의 문장으로 이동 */
  onOpenEvidence(file: string, at: QuoteLocation): void;
}

export function IssuesPanel({ file, state, version, currentLines, onJump, onOpenEvidence }: Props) {
  const [check, setCheck] = useState<StoredCheck | null | undefined>(undefined);
  const [showDismissed, setShowDismissed] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMissing(null);
    void api.ai.checkResult(file).then((c) => !cancelled && setCheck(c));
    return () => {
      cancelled = true;
    };
  }, [file, version, reload]);

  useEffect(() => setShowDismissed(false), [file]);

  const jump = (quote: string) => {
    const at = locateQuote(currentLines() ?? [], quote);
    setMissing(at ? null : quote);
    if (at) onJump(at);
  };

  const dismiss = (f: StoredFinding) =>
    void api.ai.dismiss(file, f.ord).then(
      () => setReload((n) => n + 1),
      (e: Error) => setError(e.message),
    );

  const shown = check?.findings.filter((f) => showDismissed || !f.dismissed) ?? [];
  const dismissed = check?.findings.filter((f) => f.dismissed).length ?? 0;

  return (
    <section className="issues" aria-label="문제 가능성">
      <h2>문제 가능성{check && check.findings.length - dismissed > 0 ? ` (${check.findings.length - dismissed})` : ''}</h2>
      {check === undefined && <p className="muted">불러오는 중…</p>}
      {check === null && <p className="muted">아직 검사하지 않은 화입니다. 왼쪽의 [이 화 검사]를 누르면 앞 화들과 비교합니다.</p>}
      {check && (
        <>
          <p className="muted">
            앞 화 {check.inputs.length}개의 사실 {check.factCount}개와 비교
            {check.factCount > CHECK_BATCH_SIZE && ` (${Math.ceil(check.factCount / CHECK_BATCH_SIZE)}번 나눠 검사)`} · {check.model} ·{' '}
            {new Date(check.createdAt).toLocaleString()}
          </p>
          {state === 'stale' && <p className="warning">검사한 뒤 이 화나 앞 화의 본문이 바뀌었습니다. 다시 검사하면 최신 내용으로 비교합니다.</p>}
          {check.dropped > 0 && <p className="muted">원고에서 문장을 찾을 수 없어 버린 결과 {check.dropped}개</p>}
          {missing && <p className="warning">지금 본문에서 이 문장을 찾을 수 없습니다: {quoted(missing)}</p>}
          {error && <p className="error">{error}</p>}
          {check.findings.length - dismissed === 0 && <p>찾은 문제 가능성이 없습니다.</p>}
          <ul>
            {shown.map((f) => (
              <li key={f.ord} className={f.dismissed ? 'issue dismissed' : 'issue'}>
                <span className="issue-head">
                  <span className="category">{CATEGORY_LABELS[f.category]}</span>
                  <span className="muted" title="AI가 모순이라고 판단한 정도 (보조 정보)">
                    확신 {f.confidence.toFixed(1)}
                  </span>
                  {f.dismissed ? (
                    <span className="muted">무시함</span>
                  ) : (
                    <button type="button" className="link" onClick={() => dismiss(f)}>
                      무시
                    </button>
                  )}
                </span>
                <span className="claim">{f.claim}</span>
                <button type="button" className="quote" title="이 화의 이 문장으로 이동" onClick={() => jump(f.target.quote)}>
                  이 화: {quoted(f.target.quote)}
                </button>
                {f.evidence.map((e, i) => (
                  <button
                    type="button"
                    key={i}
                    className="quote evidence"
                    title={`${e.chapter}화의 이 문장으로 이동`}
                    onClick={() => onOpenEvidence(e.file, e)}
                  >
                    {e.chapter}화: {quoted(e.quote)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          {dismissed > 0 && (
            <button type="button" className="link" onClick={() => setShowDismissed((v) => !v)}>
              {showDismissed ? '무시한 결과 숨기기' : `무시한 결과 ${dismissed}개 보기`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
