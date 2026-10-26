// 현재 화의 연속성 검사 결과 (M4-PLAN 1절). 항상 "문제 가능성"으로 보여 준다. 판단은 작가가 한다.
//   - 이 화 문장을 누르면 그 문장으로, 근거를 누르면 그 화의 그 문장으로 이동한다
//   - 이 화 문장은 저장된 위치를 믿지 않고 지금 본문에서 다시 찾는다 (검사 뒤 고쳤을 수 있다)
//   - [무시]한 결과는 다시 검사해도 숨는다

import { useEffect, useRef, useState } from 'react';
import { CATEGORY_LABELS, CHECK_BATCH_SIZE, MIN_CONFIDENCE } from '../../core/ai/detection.ts';
import { locateQuote, type QuoteLocation } from '../../core/ai/locate.ts';
import type { CheckState, StoredCheck, StoredFinding } from '../../preload/api.ts';

const api = window.loreweave;

/** 인용을 따옴표로 감싸 보여 준다. 대사처럼 이미 따옴표로 감싸여 있으면 그대로 둔다 */
const quoted = (quote: string) => (/^["“'‘「『].*["”'’」』]$/s.test(quote.trim()) ? quote.trim() : `“${quote}”`);

interface Props {
  file: string;
  /** 이 패널을 띄운 프로젝트의 token. 읽기·무시 요청에 함께 보낸다 (다른 프로젝트가 열린 뒤의 요청은 main이 거절한다) */
  projectToken: number;
  /** 프로젝트를 바꾸는 중. main은 이미 새 프로젝트일 수 있어, 이 패널의 조작(무시·이동)을 받지 않는다 */
  locked: boolean;
  state: CheckState | undefined;
  /** 분석·검사가 끝날 때마다 바뀐다 (다시 읽기) */
  version: number;
  currentLines(): string[] | null;
  onJump(at: QuoteLocation): void;
  /** 다른 화(근거)의 문장으로 이동 */
  onOpenEvidence(file: string, at: QuoteLocation): void;
}

export function IssuesPanel({ file, projectToken, locked, state, version, currentLines, onJump, onOpenEvidence }: Props) {
  /**
   * 보이는 검사 결과와, 그 결과를 읽은 화·조회 차례(seq). 화를 바꾸면 새 결과가 올 때까지 이전 화의 결과를 보이지 않는다.
   * 같은 화를 다시 읽는 동안(무시·검사 뒤)에는 보이되 무시는 받지 않는다 (결과 번호 ord는 그 조회의 결과에만 맞다)
   */
  const [loaded, setLoaded] = useState<{ file: string; seq: number; check: StoredCheck | null } | null>(null);
  /** 마지막 조회의 차례. 늦게 온 이전 조회의 성공·실패는 화면에 적용하지 않는다 */
  const seq = useRef(0);
  const [latest, setLatest] = useState(0);
  const [failed, setFailed] = useState<{ seq: number; message: string } | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [showLow, setShowLow] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  /** 무시 실패. 그 결과의 화에서만 보인다 */
  const [error, setError] = useState<{ file: string; message: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const mine = ++seq.current;
    setLatest(mine);
    setMissing(null);
    // 거절·실패도 받는다: 지금 조회의 실패는 안내와 [다시 읽기]로 보이고, 이전 조회(다른 화·다른 프로젝트)의 실패는 조용히 버린다
    api.ai.checkResult(file, projectToken).then(
      (c) => mine === seq.current && setLoaded({ file, seq: mine, check: c }),
      (e: Error) => mine === seq.current && setFailed({ seq: mine, message: e.message }),
    );
  }, [file, projectToken, version, reload]);
  const check = loaded?.file === file ? loaded.check : undefined;
  const loadError = failed?.seq === latest ? failed.message : null;
  /** 보이는 결과가 이 화의 마지막 조회 결과다 (무시를 받는다) */
  const ready = !locked && loaded !== null && loaded.file === file && loaded.seq === latest;

  useEffect(() => {
    setShowDismissed(false);
    setShowLow(false);
  }, [file]);

  const jump = (quote: string) => {
    if (locked) return;
    const at = locateQuote(currentLines() ?? [], quote);
    setMissing(at ? null : quote);
    if (at) onJump(at);
  };

  const dismiss = (f: StoredFinding) => {
    // 누른 순간에도 확인한다: 화를 바꾸거나 다시 읽기 시작한 뒤의 이전 결과로는 보내지 않는다
    if (!ready || loaded.seq !== seq.current) return;
    const target = loaded.file;
    void api.ai.dismiss(target, f.ord, projectToken).then(
      () => setReload((n) => n + 1),
      (e: Error) => setError({ file: target, message: e.message }),
    );
  };

  // 무시한 결과와 확신도가 낮은 결과는 숨긴다 (각각 [보기]로 볼 수 있다)
  const low = (f: StoredFinding) => f.confidence < MIN_CONFIDENCE;
  const shown = check?.findings.filter((f) => (showDismissed || !f.dismissed) && (showLow || !low(f))) ?? [];
  const dismissed = check?.findings.filter((f) => f.dismissed).length ?? 0;
  const lowCount = check?.findings.filter((f) => !f.dismissed && low(f)).length ?? 0;
  const visible = check?.findings.filter((f) => !f.dismissed && !low(f)).length ?? 0;

  return (
    <section className="issues" aria-label="문제 가능성">
      <h2>문제 가능성{visible > 0 ? ` (${visible})` : ''}</h2>
      {loadError && (
        <p className="error">
          검사 결과를 읽지 못했습니다: {loadError}{' '}
          <button type="button" className="link" onClick={() => setReload((n) => n + 1)}>
            다시 읽기
          </button>
        </p>
      )}
      {check === undefined && !loadError && <p className="muted">불러오는 중…</p>}
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
          {error?.file === file && <p className="error">{error.message}</p>}
          {visible === 0 && <p>찾은 문제 가능성이 없습니다.</p>}
          <ul>
            {shown.map((f) => (
              <li key={f.ord} className={f.dismissed || low(f) ? 'issue dismissed' : 'issue'}>
                <span className="issue-head">
                  <span className="category">{CATEGORY_LABELS[f.category]}</span>
                  <span className="muted" title="AI가 모순이라고 판단한 정도 (보조 정보)">
                    확신 {f.confidence.toFixed(1)}
                  </span>
                  {f.dismissed ? (
                    <span className="muted">무시함</span>
                  ) : (
                    <button type="button" className="link" disabled={!ready} onClick={() => dismiss(f)}>
                      무시
                    </button>
                  )}
                </span>
                <span className="claim">{f.claim}</span>
                <button type="button" className="quote" title="이 화의 이 문장으로 이동" disabled={locked} onClick={() => jump(f.target.quote)}>
                  이 화: {quoted(f.target.quote)}
                </button>
                {f.evidence.map((e, i) => (
                  <button
                    type="button"
                    key={i}
                    className="quote evidence"
                    title={`${e.chapter}화의 이 문장으로 이동`}
                    disabled={locked}
                    onClick={() => onOpenEvidence(e.file, e)}
                  >
                    {e.chapter}화: {quoted(e.quote)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
          {lowCount > 0 && (
            <button type="button" className="link" onClick={() => setShowLow((v) => !v)}>
              {showLow ? '확신이 낮은 결과 숨기기' : `확신이 낮아 숨긴 결과 ${lowCount}개 보기`}
            </button>
          )}
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
