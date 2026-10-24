// 성능 측정 페이지 (M0-PLAN §3 입력 지연·로드, §5 지표). src/run-perf.ts가 Playwright로 조작한다.
// 주소: /perf.html?size=20000&combo=custom-c3
// 제품과 같은 조건: React + @tiptap/react, StrictMode 없음, shouldRerenderOnTransaction: false.

import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { createRoot } from 'react-dom/client';
import { baseExtensions } from './editor/extensions.ts';
import { split } from './envelope.ts';
import type { PMNode } from './roundtrip.ts';
import { COMBOS } from './serializers/index.ts';

export interface LoadTiming {
  chars: number;
  blocks: number;
  fetchMs: number;
  parseMs: number;
  /** 에디터 생성부터 첫 화면이 그려질 때까지 */
  renderMs: number;
  /** 파싱 + 렌더 (사용자가 기다리는 구간에서 파일 읽기 제외) */
  loadMs: number;
  serializeMs: number;
  /** 측정이 끝났을 때 화면에 있는 블록 수 (blocks와 같아야 렌더가 끝난 것) */
  domBlocks: number;
}

export interface PerfApi {
  load: LoadTiming | null;
  /** 키 입력(keydown) → 다음 프레임까지 걸린 시간 (ms) */
  latencies: number[];
  errors: string[];
  caret(position: 'start' | 'middle' | 'end'): void;
  textLength(): number;
  heapMb(): number | null;
  /** 붙여넣기 → 다음 프레임 (ms) */
  paste(text: string): Promise<number>;
  /** 실행 취소 → 다음 프레임 (ms) */
  undo(): Promise<number>;
  /** 문서 처음부터 끝까지 120프레임 동안 스크롤. 프레임 간격 목록 (ms) */
  scroll(): Promise<number[]>;
}

declare global {
  interface Window {
    __perf: PerfApi;
  }
}

const params = new URLSearchParams(location.search);
const size = Number(params.get('size') ?? 20000);
const combo = COMBOS.find((c) => c.id === (params.get('combo') ?? 'custom-c3'))!;
const converter = combo.create();
const status = document.getElementById('status')!;

/** 다음 프레임이 그려진 직후 (rAF 다음 태스크) */
const afterNextFrame = () =>
  new Promise<number>((resolve) =>
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(performance.now());
      channel.port2.postMessage(0);
    }),
  );

const api: PerfApi = {
  load: null,
  latencies: [],
  errors: [],
  caret: () => {},
  textLength: () => 0,
  heapMb: () => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? memory.usedJSHeapSize / 1024 / 1024 : null;
  },
  paste: async () => 0,
  undo: async () => 0,
  scroll: async () => [],
};
window.__perf = api;
window.addEventListener('error', (e) => api.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => api.errors.push(String(e.reason)));

function attach(editor: Editor) {
  const dom = editor.view.dom;
  dom.addEventListener(
    'keydown',
    (e) => {
      const start = e.timeStamp;
      afterNextFrame().then((t) => api.latencies.push(t - start));
    },
    true,
  );
  api.textLength = () => editor.state.doc.textContent.length;
  api.caret = (position) => {
    const sizeOf = editor.state.doc.content.size;
    const target = position === 'start' ? 1 : position === 'end' ? sizeOf - 1 : Math.floor(sizeOf / 2);
    editor.chain().focus().setTextSelection(target).scrollIntoView().run();
  };
  api.paste = async (text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const start = performance.now();
    dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return (await afterNextFrame()) - start;
  };
  api.undo = async () => {
    const start = performance.now();
    editor.commands.undo();
    return (await afterNextFrame()) - start;
  };
  api.scroll = async () => {
    const root = document.scrollingElement!;
    root.scrollTop = 0;
    const step = (root.scrollHeight - root.clientHeight) / 120;
    const gaps: number[] = [];
    let last = await afterNextFrame();
    for (let i = 0; i < 120; i++) {
      root.scrollTop += step;
      const now = await afterNextFrame();
      gaps.push(now - last);
      last = now;
    }
    return gaps;
  };
}

/** 에디터가 문서에 붙고 그 다음 프레임이 그려진 시점을 로드 완료로 본다. */
async function markLoaded(editor: Editor, started: number) {
  let painted = await afterNextFrame();
  while (!editor.view.dom.isConnected) painted = await afterNextFrame();
  const t0 = performance.now();
  converter.serialize(editor.getJSON() as PMNode);
  const serializeMs = performance.now() - t0;
  const load = api.load!;
  api.load = {
    ...load,
    renderMs: painted - started,
    loadMs: load.parseMs + painted - started,
    serializeMs,
    domBlocks: editor.view.dom.childElementCount,
  };
  status.textContent = `${combo.id} ${size}자 로드 ${api.load.loadMs.toFixed(0)}ms`;
}

function Perf({ doc, started }: { doc: PMNode; started: number }) {
  const editor = useEditor({
    extensions: baseExtensions(),
    content: doc,
    enableInputRules: false,
    enablePasteRules: false,
    shouldRerenderOnTransaction: false,
    onCreate: ({ editor }) => {
      attach(editor);
      void markLoaded(editor, started);
    },
  });
  return <EditorContent editor={editor} />;
}

async function main() {
  const t0 = performance.now();
  const raw = await (await fetch(`/perf/${size}.md`)).text();
  const t1 = performance.now();
  const doc = converter.parse(split(raw).body);
  const t2 = performance.now();
  api.load = {
    chars: raw.length,
    blocks: doc.content?.length ?? 0,
    fetchMs: t1 - t0,
    parseMs: t2 - t1,
    renderMs: 0,
    loadMs: 0,
    serializeMs: 0,
    domBlocks: 0,
  };
  createRoot(document.getElementById('root')!).render(<Perf doc={doc} started={performance.now()} />);
}

main().catch((e) => api.errors.push(String(e)));
