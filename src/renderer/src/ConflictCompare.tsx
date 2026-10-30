// 저장 충돌의 "내 화면 ↔ 디스크" 차이 보기 (DESIGN P4). 읽기 전용이다: 이 비교를 근거로 파일에 쓰지 않는다.
// 쓰기는 충돌 안내의 [내 것으로 덮어쓰기]가 하며, 그것은 watcher가 알린 가장 최근 디스크 해시(expectedHash)로 확인해 오래된 비교 화면과 상관없이 덮어쓰지 못한다.
//   - 디스크 쪽은 열 때와 watcher가 새 해시를 알릴 때마다 다시 읽는다 (지연된 이전 읽기는 번호로 버린다)
//   - 비교하는 동안 계속 쓴 내용은 내 쪽만 다시 계산한다 (조용해진 뒤)
//   - 디스크 파일이 지워졌거나 UTF-8이 아니어서 읽을 수 없으면 비교하지 않고 이유를 알린다

import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Doc } from '../../core/manuscript/doc.ts';
import { collapseContext, diffLines, diffStats, type DiffOp } from '../../core/diff.ts';
import { openManuscript } from '../../core/manuscript/index.ts';
import { visibleLines } from '../../core/manuscript/lines.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { type FriendlyError, friendlyError } from './userError.ts';

interface Props {
  file: string;
  projectToken: number;
  /** watcher가 알린 가장 최근 디스크 해시 (이보다 오래된 읽기는 "다시 불러오는 중"으로 보인다) */
  diskHash: string;
  editor: Editor;
}

type View =
  | { kind: 'loading' }
  | { kind: 'error'; error: FriendlyError }
  | { kind: 'ready'; diskHash: string; disk: string[]; mine: string[]; ops: DiffOp[] | null };

const show = (text: string) => (text === '' ? '(빈 줄)' : text);

export function ConflictCompare({ file, projectToken, diskHash, editor }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { text, hash } = await window.loreweave.chapters.read(file, projectToken);
      if (mine !== seq.current) return;
      const disk = visibleLines(openManuscript(text).doc);
      const current = visibleLines(editor.getJSON() as Doc);
      setView({ kind: 'ready', diskHash: hash, disk, mine: current, ops: diffLines(current, disk) });
    } catch (e) {
      if (mine === seq.current) setView({ kind: 'error', error: friendlyError(e, '디스크의 이 화를 읽지 못했습니다') });
    }
  }, [file, projectToken, editor]);

  // 열 때, 그리고 watcher가 디스크 변경을 다시 알릴 때마다 디스크 쪽을 다시 읽는다
  useEffect(() => {
    void load();
  }, [load, diskHash]);

  // 비교하는 동안 계속 쓴 내용: 내 쪽만 다시 계산한다
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const current = visibleLines(editor.getJSON() as Doc);
        setView((v) => (v.kind === 'ready' ? { ...v, mine: current, ops: diffLines(current, v.disk) } : v));
      }, 400);
    };
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
      if (timer) clearTimeout(timer);
      seq.current++;
    };
  }, [editor]);

  const copyMine = async () => {
    const current = view.kind === 'ready' ? view.mine : visibleLines(editor.getJSON() as Doc);
    try {
      await navigator.clipboard.writeText(current.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const stale = view.kind === 'ready' && view.diskHash !== diskHash;
  const stats = view.kind === 'ready' && view.ops ? diffStats(view.ops) : null;

  return (
    <section className="compare" aria-label="내 화면과 디스크의 차이">
      <header>
        <strong>내 화면 ↔ 디스크 차이</strong>
        {stats && (
          <span className="muted">
            {' '}
            · 내 화면에만 {stats.removed}줄 · 디스크에만 {stats.added}줄
          </span>
        )}
        <span className="compare-actions">
          <button type="button" className="link" onClick={() => void load()}>
            다시 비교
          </button>
          <button type="button" className="link" onClick={() => void copyMine()}>
            내 내용 복사
          </button>
          {copied && <span className="muted"> 복사했습니다</span>}
        </span>
      </header>
      <p className="muted">
        읽기 전용 비교입니다. <span className="diff-del-label">− 내 화면에만 있는 줄</span>은 디스크 내용을 불러오면, <span className="diff-add-label">+ 디스크에만 있는 줄</span>은 내 것으로 덮어쓰면 사라집니다.
        고르기 전에 [내 내용 복사]로 지금 화면의 글을 따로 보관할 수 있습니다.
      </p>
      {view.kind === 'loading' && <p className="muted">디스크 내용을 읽는 중…</p>}
      {view.kind === 'error' && (
        <p className="error" role="alert">
          <ErrorNote error={view.error} onRetry={() => void load()} retryLabel="다시 비교" />
        </p>
      )}
      {stale && <p className="warning">디스크가 다시 바뀌었습니다. 다시 불러오는 중입니다 (아래 비교는 이전 내용입니다).</p>}
      {view.kind === 'ready' &&
        (view.ops === null ? (
          <p className="warning">화가 너무 길어 줄 단위 비교를 생략했습니다. 위 [내 내용 복사]로 내 글을 보관한 뒤 고르세요.</p>
        ) : stats && stats.removed === 0 && stats.added === 0 ? (
          <p className="muted">보이는 본문은 같습니다. frontmatter나 줄바꿈처럼 보이지 않는 부분이 다를 수 있습니다.</p>
        ) : (
          <ol className="diff" aria-label="줄별 차이">
            {collapseContext(view.ops).map((row, i) =>
              row.type === 'gap' ? (
                <li key={i} className="diff-gap">
                  … 같은 줄 {row.count}개
                </li>
              ) : (
                <li key={i} className={`diff-${row.type}`}>
                  <span className="diff-mark" aria-label={row.type === 'del' ? '내 화면에만 있음' : row.type === 'add' ? '디스크에만 있음' : '같음'}>
                    {row.type === 'del' ? '−' : row.type === 'add' ? '+' : ' '}
                  </span>
                  <span className="diff-text">{show(row.text)}</span>
                </li>
              ),
            )}
          </ol>
        ))}
    </section>
  );
}
