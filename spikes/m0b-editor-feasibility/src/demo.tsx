// 수동 검증 패널: 원본 / 에디터 / 저장 결과 / 차이 (M0-PLAN §2).
// 성능 측정과 같은 조건을 위해 StrictMode는 쓰지 않는다.

import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CorpusCase } from '../corpus/cases.ts';
import { classifyDiff } from './diff.ts';
import { baseExtensions } from './editor/extensions.ts';
import { join, split } from './envelope.ts';
import type { Converter, PMNode } from './roundtrip.ts';
import { COMBOS, throughEditor } from './serializers/index.ts';

/** 보이지 않는 문자를 기호로 바꾸고 줄 끝에 ↵를 붙인다. */
function visible(text: string): string {
  return text
    .replace(/\uFEFF/g, '[BOM]')
    .replace(/\r/g, '␍')
    .replace(/\t/g, '⇥')
    .replace(/\u00A0/g, '⍽')
    .replace(/\u200B/g, '[ZWSP]')
    .replace(/\u3000/g, '□')
    .replace(/ +$/gm, (m) => '·'.repeat(m.length))
    .replace(/\n/g, '↵\n');
}

function Demo() {
  const [cases, setCases] = useState<CorpusCase[]>([]);
  const [caseId, setCaseId] = useState('blank-single');
  const [comboId, setComboId] = useState(COMBOS[0]!.id);
  const [raw, setRaw] = useState('');
  const [doc, setDoc] = useState<PMNode | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const converters = useRef(new Map<string, Converter>());

  const converter = useMemo(() => {
    let c = converters.current.get(comboId);
    if (!c) {
      c = throughEditor(COMBOS.find((x) => x.id === comboId)!.create());
      converters.current.set(comboId, c);
    }
    return c;
  }, [comboId]);

  const editor = useEditor({
    extensions: baseExtensions(),
    enableInputRules: false,
    enablePasteRules: false,
    shouldRerenderOnTransaction: false,
    onUpdate: ({ editor }) => {
      setDoc(editor.getJSON() as PMNode);
      setDirty(true);
    },
  });

  useEffect(() => {
    fetch('/corpus.json')
      .then((r) => r.json())
      .then((data: CorpusCase[]) => setCases(data));
  }, []);

  useEffect(() => {
    const c = cases.find((x) => x.id === caseId);
    if (c) setRaw(c.raw);
  }, [cases, caseId]);

  const { envelope, body } = useMemo(() => split(raw), [raw]);

  useEffect(() => {
    if (!editor) return;
    try {
      editor.commands.setContent(converter.parse(body), { emitUpdate: false });
      setDoc(editor.getJSON() as PMNode);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setDirty(false);
  }, [editor, converter, body]);

  const output = useMemo(() => (doc ? join(envelope, converter.serialize(doc)) : ''), [doc, envelope, converter]);
  const saved = dirty ? output : raw;
  const diff = useMemo(() => classifyDiff(raw, output), [raw, output]);
  const paragraphs = doc?.content?.length ?? 0;
  const groups = [...new Set(cases.map((c) => c.group))];

  return (
    <>
      <header>
        <label>
          사례{' '}
          <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {cases
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          변환기 · 규약{' '}
          <select value={comboId} onChange={(e) => setComboId(e.target.value)}>
            {COMBOS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <span className="status">
          {error ? (
            <span className="fail">변환 오류: {error}</span>
          ) : (
            <>
              변환기 출력 {diff.kinds.length === 0 ? <span className="ok">byte 동일</span> : <span className="fail">차이 {diff.kinds.join(', ')}</span>}
              {' · '}블록 {paragraphs}개{' · '}
              {dirty ? '수정됨: 변환기 출력으로 저장' : '수정 안 함: 원본 바이트 그대로 저장 (dirty flag)'}
            </>
          )}
        </span>
      </header>
      <main>
        <section>
          <h2>원본 (편집하면 에디터에 다시 읽음) — {cases.find((c) => c.id === caseId)?.note}</h2>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
        </section>
        <section>
          <h2>에디터 (왼쪽 선 하나 = 블록 하나)</h2>
          <EditorContent editor={editor} />
        </section>
        <section>
          <h2>저장 결과</h2>
          <pre>{visible(saved)}</pre>
        </section>
        <section>
          <h2>
            차이: 원본 → 변환기 출력 <span className="legend">· 줄 끝 공백 ⍽ NBSP □ 전각 공백 ⇥ 탭 ␍ CR ↵ 줄 끝</span>
          </h2>
          <div>
            {diff.hunks.length === 0 && <p className="legend">차이 없음</p>}
            {diff.hunks.map((h, i) => (
              <div className="hunk" key={i}>
                <div>
                  {h.line}행 <span className="kind">{h.kind}</span>
                </div>
                <pre className="exp">{visible(h.expected.join('\n')) || '(없음)'}</pre>
                <pre className="act">{visible(h.actual.join('\n')) || '(없음)'}</pre>
              </div>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Demo />);
