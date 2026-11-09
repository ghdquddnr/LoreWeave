// 현재 화의 연속성 검사 결과 (M4-PLAN 1절). 항상 "문제 가능성"으로 보여 준다. 판단은 작가가 한다.
//   - 이 화 문장을 누르면 그 문장으로, 근거를 누르면 그 화의 그 문장으로 이동한다
//   - 이 화 문장은 저장된 위치를 믿지 않고 지금 본문에서 다시 찾는다 (검사 뒤 고쳤을 수 있다)
//   - [무시]한 결과는 다시 검사해도 숨는다

import { useEffect, useRef, useState } from 'react';
import { CATEGORY_LABELS, CHECK_BATCH_SIZE, MIN_CONFIDENCE } from '../../core/ai/detection.ts';
import { locateQuote, type QuoteLocation } from '../../core/ai/locate.ts';
import type { CheckState, StoredCheck, StoredFinding } from '../../preload/api.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { friendlyError, friendlyReadError } from './userError.ts';

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
  /** at이 null이면 지금 본문에 인용이 없다: 이전 선택만 접는다 */
  onJump(at: QuoteLocation | null): void;
  /** 다른 화(근거)의 문장으로 이동. 위치는 그 화의 지금 본문에서 quote로 다시 찾는다 */
  onOpenEvidence(file: string, quote: string): void;
  /**
   * 본문에 밑줄·거터 점으로 표시할 문장들 (표시 전용). 최신 검사 결과이고(state가 fresh) 지금 보이는 결과만 낸다.
   * 오래된(stale) 결과는 확정 오류처럼 보이지 않게 밑줄을 내지 않는다. 에디터가 지금 본문에서 다시 찾아 찾은 것만 그린다
   */
  onMarks(quotes: string[]): void;
  /** 무시가 저장됐다 (탐색기 배지 숫자를 다시 읽는다) */
  onDismissed(): void;
}

/** 이 화 문장이 지금 본문에서 어디에 있는가: 검사 때와 같은 줄(ok) · 다른 줄에서 실제로 찾음(moved) · 찾을 수 없음(missing) */
type Place = 'ok' | 'moved' | 'missing' | 'unknown';

export function IssuesPanel({ file, projectToken, locked, state, version, currentLines, onJump, onOpenEvidence, onMarks, onDismissed }: Props) {
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
  /** 무시 실패. 실패한 요청이 누른 그 결과(화·프로젝트·검사 결과)가 아직 보이는 동안에만 보인다 */
  const [error, setError] = useState<{ file: string; ctx: number; message: string; undo: boolean } | null>(null);
  /** 결과의 문맥 세대: 화·프로젝트·검사 결과(version)가 바뀔 때만 오른다. 무시 뒤의 다시 읽기로는 오르지 않는다 */
  const ctxRef = useRef(0);
  const [ctx, setCtx] = useState(0);
  /** 마지막 무시 요청의 차례. 안내는 마지막 요청의 결과만 따른다 (늦게 끝난 이전 요청이 최신 상태를 바꾸지 않는다) */
  const dismissSeq = useRef(0);
  /** 무시 취소 요청의 대기 (무시 취소만 소유한다: 응답을 기다리는 동안 무시 취소는 다시 받지 않는다. 다른 무시·그 재조회가 이 대기를 풀지 않는다) */
  const [undoPending, setUndoPending] = useState<number | null>(null);
  const undoRef = useRef<number | null>(null);
  const [reload, setReload] = useState(0);
  /** 패널 제목의 접기 버튼: 항상 살아있어 [다시 읽기]가 사라질 때 포커스를 받는다 */
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setCtx(++ctxRef.current);
    // 화·프로젝트·검사 결과가 바뀌면 이전 취소 요청의 대기는 이 결과와 상관없다 (그 늦은 응답은 아래 차례·문맥 비교로 버린다)
    undoRef.current = null;
    setUndoPending(null);
  }, [file, projectToken, version]);

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
    onJump(at);
  };

  /** 무시(undo=false) 또는 무시 취소(undo=true). 같은 검증·차례·문맥 규칙을 쓰고, 한 번에 하나만 보낸다 */
  const changeDismissal = (f: StoredFinding, undo: boolean) => {
    // 누른 순간에도 확인한다: 화를 바꾸거나 다시 읽기 시작한 뒤의 이전 결과로는 보내지 않는다
    // 무시 취소는 대기 중이면 다시 받지 않는다. 무시는 이전처럼 겹쳐 보낼 수 있고, 안내는 마지막 요청(무시·취소 공통)을 따른다
    if (!ready || loaded.seq !== seq.current || (undo && undoRef.current !== null)) return;
    const target = loaded.file;
    const mine = ++dismissSeq.current;
    const at = ctxRef.current;
    if (undo) {
      undoRef.current = mine;
      setUndoPending(mine);
    }
    const done = () => {
      if (undo && undoRef.current === mine) {
        undoRef.current = null;
        setUndoPending(null);
      }
    };
    const request = undo ? api.ai.undismiss(target, f.ord, projectToken) : api.ai.dismiss(target, f.ord, projectToken);
    void request.then(
      () => {
        done();
        // 저장은 성공했으니 다시 읽고 배지를 갱신한다. 이전 실패 안내는 같은 결과에서 마지막 요청이 성공했을 때만 거둔다
        if (mine === dismissSeq.current) setError((cur) => (cur?.ctx === at ? null : cur));
        setReload((n) => n + 1);
        onDismissed();
      },
      // 마지막 요청이고, 누른 결과의 문맥(화·프로젝트·검사 결과)이 아직 같을 때만 안내한다 (화를 거치거나 새로 읽은 뒤의 늦은 실패는 버린다)
      (e: Error) => {
        done();
        if (mine === dismissSeq.current && at === ctxRef.current) setError({ file: target, ctx: at, message: e.message, undo });
      },
    );
  };
  const dismiss = (f: StoredFinding) => changeDismissal(f, false);
  const undismiss = (f: StoredFinding) => changeDismissal(f, true);

  // 무시한 결과와 확신도가 낮은 결과는 숨긴다 (각각 [보기]로 볼 수 있다)
  const low = (f: StoredFinding) => f.confidence < MIN_CONFIDENCE;
  const shown = check?.findings.filter((f) => (showDismissed || !f.dismissed) && (showLow || !low(f))) ?? [];
  const dismissed = check?.findings.filter((f) => f.dismissed).length ?? 0;
  // 확신이 낮아 숨긴 결과: 무시 필터를 통과한 것만 센다. 무시한 낮은 확신 결과는 [무시한 결과 보기]를 켠 뒤에 이 버튼으로 이어진다 (무시를 숨긴 동안 그 결과는 무시 쪽 수에만 들어가, 두 버튼의 수가 같은 결과를 함께 세지 않는다)
  const lowCount = check?.findings.filter((f) => low(f) && (showDismissed || !f.dismissed)).length ?? 0;
  const visible = check?.findings.filter((f) => !f.dismissed && !low(f)).length ?? 0;

  const placeOf = (f: StoredFinding): Place => {
    const lines = currentLines();
    if (!lines) return 'unknown';
    const at = locateQuote(lines, f.target.quote);
    return !at ? 'missing' : at.line === f.target.line ? 'ok' : 'moved';
  };

  // 본문에 표시할 문장: 최신 검사 결과(fresh)이고 이 화의 마지막 조회 결과이며 지금 보이는 것만
  const markQuotes = state === 'fresh' && ready && check ? shown.filter((f) => !f.dismissed).map((f) => f.target.quote) : [];
  const markKey = markQuotes.join('\n');
  useEffect(() => {
    onMarks(markQuotes);
    // markQuotes는 markKey로 비교한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markKey]);
  useEffect(() => () => onMarks([]), []);

  return (
    <section className="issues" aria-label="문제 가능성">
      <h2 aria-label={`문제 가능성${visible > 0 ? ` (${visible})` : ''}`}>
        <button ref={toggle} type="button" className="sec-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> <span>문제 가능성</span>
        </button>
        {visible > 0 && (
          <span className="count-badge" aria-hidden="true">
            {visible}
          </span>
        )}
      </h2>
      <div className="sec-body" hidden={!open}>
        {loadError && (
          <p className="error" role="alert">
            <ErrorNote
              prefix="검사 결과를 읽지 못했습니다"
              error={friendlyReadError(loadError)}
              onRetry={() => {
                // 누른 [다시 읽기]는 읽는 동안 사라진다: 포커스가 이 오류 안내 안에 있었다면 패널의 살아있는 접기 버튼으로 옮긴다 (그 밖의 포커스는 건드리지 않아 늦은 응답이 빼앗지 않는다)
                if (document.activeElement instanceof HTMLElement && document.activeElement.closest('section.issues .error-note')) toggle.current?.focus();
                setReload((n) => n + 1);
              }}
              retryLabel="다시 읽기"
            />
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
            {state === 'stale' && (
              <p className="warning">
                <span aria-hidden="true">◐</span> 검사한 뒤 이 화나 앞 화의 본문이 바뀌었습니다. 다시 검사하면 최신 내용으로 비교합니다.
              </p>
            )}
            {check.dropped > 0 && <p className="muted">원고에서 문장을 찾을 수 없어 버린 결과 {check.dropped}개</p>}
            {missing && (
              <p className="warning">
                <span className="chip chip-missing">MISSING</span> 지금 본문에서 이 문장을 찾을 수 없습니다: {quoted(missing)}
              </p>
            )}
            {error?.file === file && error.ctx === ctx && (
              <p className="error" role="alert">
                <ErrorNote error={friendlyError(error.message)} prefix={error.undo ? '무시를 취소하지 못했습니다' : undefined} hint={error.undo ? '무시한 상태 그대로입니다. 다시 눌러 볼 수 있습니다' : undefined} />
              </p>
            )}
            {check.findings.length === 0 && (
              <p>
                이번 검사에서 찾은 문제 가능성이 없습니다.{' '}
                <span className="muted">놓친 문제가 있을 수 있어, 문제가 없다는 뜻은 아닙니다.</span>
              </p>
            )}
            {check.findings.length > 0 && shown.length === 0 && (
              <p>현재 표시할 결과가 없습니다. 숨긴 결과는 아래 버튼으로 볼 수 있습니다.</p>
            )}
            <ul className="cards">
              {shown.map((f) => {
                const place = placeOf(f);
                return (
                  <li key={f.ord} className={`issue-card${f.dismissed ? ' dismissed' : ''}${low(f) ? ' low' : ''}${state === 'stale' ? ' stale' : ''}`}>
                    <span className="issue-head">
                      <span className="warn-square" aria-hidden="true" />
                      <span className="category">{CATEGORY_LABELS[f.category]}</span>
                      <span className="conf" title="AI가 모순이라고 판단한 정도 (보조 정보)">
                        확신 {f.confidence.toFixed(1)}
                      </span>
                      {low(f) && !f.dismissed && <span className="chip">확신 낮음</span>}
                      {state === 'stale' && <span className="chip chip-stale">옛 결과</span>}
                      {f.dismissed ? (
                        <>
                          <span className="chip">무시함</span>
                          <button type="button" className="link" disabled={!ready || undoPending !== null} onClick={() => undismiss(f)}>
                            무시 취소
                          </button>
                        </>
                      ) : (
                        <button type="button" className="link" disabled={!ready} onClick={() => dismiss(f)}>
                          무시
                        </button>
                      )}
                    </span>
                    <span className="claim">{f.claim}</span>
                    <span className="quote-well">
                      {/* 칩은 버튼 밖 형제로 둔다: 버튼의 접근 이름(이 화: “문장”)이 상태에 따라 바뀌지 않게 */}
                      <span className="quote-row">
                        <button type="button" className="quote target" title="이 화의 이 문장으로 이동" disabled={locked} onClick={() => jump(f.target.quote)}>
                          <span className="q-label">이 화:</span> {quoted(f.target.quote)}
                        </button>
                        {place === 'moved' && (
                          <span className="chip chip-moved" title="검사 때와 다른 줄에서 지금 본문의 이 문장을 찾았습니다">
                            MOVED
                          </span>
                        )}
                        {place === 'missing' && (
                          <span className="chip chip-missing" title="지금 본문에서 이 문장을 찾을 수 없습니다">
                            MISSING
                          </span>
                        )}
                      </span>
                      {f.evidence.map((e, i) => (
                        <button
                          type="button"
                          key={i}
                          className="quote evidence"
                          title={`${e.chapter}화의 이 문장으로 이동`}
                          disabled={locked}
                          onClick={() => onOpenEvidence(e.file, e.quote)}
                        >
                          <span className="q-label">{e.chapter}화:</span> {quoted(e.quote)}
                        </button>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
            {(lowCount > 0 || showLow) && (
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
      </div>
    </section>
  );
}
