// 입력 지연·로드·붙여넣기·스크롤 측정 (M0-PLAN §3, §5). 결과: results/perf.md
// production 빌드를 미리보기 서버로 띄우고, 설치된 Chrome과 Electron에서 같은 페이지를 번갈아 잰다.
// 사용: tsx src/run-perf.ts [--runs 5]   (측정 중 창이 열린다. 다른 무거운 작업은 멈춘다)

import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron, chromium, type Page } from 'playwright';
import { build, createServer, preview } from 'vite';
import { PERF_SIZES, perfText } from '../corpus/cases.ts';
import type { LoadTiming, PerfApi } from './perf.tsx';

const RUNS = Number(process.argv[process.argv.indexOf('--runs') + 1] || 5);
const POSITIONS = ['start', 'middle', 'end'] as const;
const LOAD_COMBOS = ['custom-c3', 'official-c1', 'community-c1'];
const KEYS = 40;
const KEY_GAP_MS = 60;
const PASTE_CHARS = 20_000;
const root = fileURLToPath(new URL('..', import.meta.url));

type Target = 'chrome' | 'electron';
type Position = (typeof POSITIONS)[number];

interface TypingRun {
  target: Target;
  size: number;
  position: Position;
  run: number;
  load: LoadTiming;
  latencies: number[];
  /** 입력한 글자 수만큼 문서가 바뀌었나 (질문 4·7) */
  textOk: boolean;
  paste?: { ms: number; undoMs: number; textOk: boolean; undoOk: boolean };
  scrollGaps?: number[];
  heapMb: number | null;
  errors: string[];
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const median = (xs: number[]) => percentile(xs, 50);
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(x < 10 ? 1 : 0) : '-');
const range = (xs: number[]) => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`;

async function openPerf(page: Page, base: string, size: number, combo: string): Promise<LoadTiming> {
  await page.goto(`${base}/perf.html?size=${size}&combo=${combo}`);
  await page.waitForFunction(() => (window.__perf?.load?.loadMs ?? 0) > 0, null, { timeout: 180_000 });
  return page.evaluate(() => window.__perf.load!);
}

/** 페이지 안에서 실행한다. fn은 직렬화되므로 바깥 변수를 쓸 수 없다. */
const perf = <T>(page: Page, fn: (api: PerfApi) => T | Promise<T>) =>
  page.evaluate(`(${fn.toString()})(window.__perf)`) as Promise<T>;

async function typingRun(page: Page, base: string, target: Target, size: number, position: Position, run: number): Promise<TypingRun> {
  const load = await openPerf(page, base, size, 'custom-c3');
  await page.evaluate((p) => window.__perf.caret(p), position);
  // TipTap의 focus()는 다음 프레임에 포커스를 옮긴다. 그 전에 누른 키는 에디터에 들어가지 않으므로 기다린다
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') && !!getSelection()?.anchorNode);
  const before = await perf(page, (api) => api.textLength());
  await perf(page, (api) => void (api.latencies = []));
  let expected = 0;
  for (let i = 0; i < KEYS; i++) {
    if (i % 20 === 19) await page.keyboard.press('Enter');
    else if (i % 10 === 9) {
      await page.keyboard.press('Backspace');
      expected--;
    } else {
      await page.keyboard.press(String.fromCharCode(97 + (i % 26)));
      expected++;
    }
    await page.waitForTimeout(KEY_GAP_MS);
  }
  await page.waitForTimeout(300);
  const latencies = await perf(page, (api) => api.latencies);
  const textOk = (await perf(page, (api) => api.textLength())) - before === expected;
  const result: TypingRun = { target, size, position, run, load, latencies, textOk, heapMb: null, errors: [] };

  if (position === 'middle') {
    const text = perfText(PASTE_CHARS);
    // 히스토리는 500ms 안의 변경을 한 단계로 묶는다. 붙여넣기만 따로 취소되는지 보려고 그 이상 기다린다
    await page.waitForTimeout(700);
    const beforePaste = await perf(page, (api) => api.textLength());
    const ms = await page.evaluate((t) => window.__perf.paste(t), text);
    const afterPaste = await perf(page, (api) => api.textLength());
    const undoMs = await perf(page, (api) => api.undo());
    const afterUndo = await perf(page, (api) => api.textLength());
    result.paste = { ms, undoMs, textOk: afterPaste > beforePaste + PASTE_CHARS * 0.9, undoOk: afterUndo === beforePaste };
    result.scrollGaps = await perf(page, (api) => api.scroll());
  }
  result.heapMb = await perf(page, (api) => api.heapMb());
  result.errors = await perf(page, (api) => api.errors);
  return result;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
}

/** 질문 1: 50만 자 입력 중 CPU 프로파일 (보고하는 수치와 별도 실행, 개발 서버라 이름이 남아 있다). 자체 시간 상위 함수 */
async function profileTop(page: Page, devBase: string): Promise<string[]> {
  await page.goto(`${devBase}/perf.html?size=500000`);
  await page.waitForFunction(() => (window.__perf?.load?.loadMs ?? 0) > 0, null, { timeout: 180_000 });
  await page.evaluate(() => window.__perf.caret('middle'));
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press(String.fromCharCode(97 + i));
    await page.waitForTimeout(KEY_GAP_MS);
  }
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as {
    profile: { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[] };
  };
  const msPerSample = (profile.endTime - profile.startTime) / 1000 / profile.samples.length;
  const self = new Map<string, number>();
  for (const n of profile.nodes) {
    const { functionName, url, lineNumber } = n.callFrame;
    if (!n.hitCount || ['(idle)', '(program)', '(garbage collector)'].includes(functionName)) continue;
    const where = url.replace(/^.*node_modules\/(?:\.vite\/deps\/)?/, '').replace(/\?.*$/, '');
    const key = `${functionName || '(anonymous)'} @ ${where}:${lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + n.hitCount * msPerSample);
  }
  const total = (name: string) =>
    profile.nodes.filter((n) => n.callFrame.functionName === name).reduce((s, n) => s + (n.hitCount ?? 0), 0) * msPerSample;
  const js = [...self.values()].reduce((s, ms) => s + ms, 0);
  return [
    `합계 (20키): JS ${js.toFixed(0)}ms, (program: 브라우저 내부 작업) ${total('(program)').toFixed(0)}ms, GC ${total('(garbage collector)').toFixed(0)}ms`,
    ...[...self.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, ms]) => `${ms.toFixed(0)}ms ${k}`),
  ];
}

async function main() {
  console.log('production 빌드');
  await build({ root, logLevel: 'warn' });
  const server = await preview({ root, preview: { port: 4173, strictPort: true }, logLevel: 'warn' });
  const base = 'http://localhost:4173';

  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-precise-memory-info'] });
  const chromePage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [fileURLToPath(new URL('../electron/main.cjs', import.meta.url)), `${base}/perf.html?size=5000`],
  });
  const electronPage = await app.firstWindow();
  const pages: Record<Target, Page> = { chrome: chromePage, electron: electronPage };
  const versions = {
    chrome: browser.version(),
    electron: await app.evaluate(({ app }) => `${app.getVersion()} (Chromium ${process.versions.chrome})`),
  };

  const typing: TypingRun[] = [];
  for (let run = 0; run < RUNS; run++) {
    // 질문 5: 대상을 번갈아 실행해 워밍업·캐시가 한쪽에 유리하지 않게 한다
    const order: Target[] = run % 2 === 0 ? ['chrome', 'electron'] : ['electron', 'chrome'];
    for (const size of PERF_SIZES) {
      for (const position of POSITIONS) {
        for (const target of order) {
          const r = await typingRun(pages[target], base, target, size, position, run);
          typing.push(r);
          console.log(`run ${run} ${target} ${size} ${position}: load ${fmt(r.load.loadMs)}ms p95 ${fmt(percentile(r.latencies, 95))}ms`);
        }
      }
    }
  }

  const loads: { combo: string; size: number; run: number; load: LoadTiming }[] = [];
  for (let run = 0; run < RUNS; run++) {
    const order = LOAD_COMBOS.map((_, i) => LOAD_COMBOS[(i + run) % LOAD_COMBOS.length]!);
    for (const size of PERF_SIZES) {
      for (const combo of order) loads.push({ combo, size, run, load: await openPerf(chromePage, base, size, combo) });
    }
  }

  const dev = await createServer({ root, server: { port: 5174, strictPort: true }, logLevel: 'warn' });
  await dev.listen();
  const profile = await profileTop(chromePage, 'http://localhost:5174');
  await dev.close();

  await app.close();
  await browser.close();
  await server.close();

  const dir = new URL('../results/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('perf.json', dir), JSON.stringify({ versions, typing, loads, profile }, null, 1) + '\n');
  writeFileSync(new URL('perf.md', dir), report(versions, typing, loads, profile) +'\n');
  console.log('results/perf.md');
  process.exit(0);
}

function report(
  versions: Record<Target, string>,
  typing: TypingRun[],
  loads: { combo: string; size: number; load: LoadTiming }[],
  profile: string[],
): string {
  const out: string[] = [];
  const targets: Target[] = ['chrome', 'electron'];
  const runP95 = (rs: TypingRun[]) => rs.map((r) => percentile(r.latencies, 95));
  const select = (t: Target, size: number, pos?: Position) =>
    typing.filter((r) => r.target === t && r.size === size && (!pos || r.position === pos));
  const worstP95 = (t: Target, size: number) => Math.max(...POSITIONS.map((p) => median(runP95(select(t, size, p)))));

  out.push('# 성능 측정 결과', '');
  out.push(`- 생성: \`pnpm perf\` (자동 생성 파일). 실행 ${RUNS}회, 대상을 번갈아 실행`);
  out.push(`- 환경: ${cpus()[0]?.model.trim()} × ${cpus().length}, RAM ${(totalmem() / 2 ** 30).toFixed(0)}GB, Windows ${release()}`);
  out.push(`- Chrome ${versions.chrome} / Electron ${versions.electron}. production 빌드, 창 1400×900, StrictMode 없음`);
  out.push('- 변환기: (c) 직접 작성 · C3 (로드 비교 표 제외). 원고: M0-A 챕터 반복 (C3라 빈 줄도 블록)');
  out.push(`- 입력 지연: keydown 이벤트 시각 → 다음 프레임이 그려진 직후. 실행마다 ${KEYS}키 (영문 글자, Backspace, Enter) ${KEY_GAP_MS}ms 간격`);
  out.push('- 한글 IME 조합 입력은 자동화할 수 없어 여기 포함되지 않는다 (manual/CHECKLIST.md)', '');

  out.push('## 판정 (M0-PLAN §3)', '');
  out.push('| 기준 | Chrome | Electron | 판정 |', '|---|---|---|---|');
  const verdict = (ok: boolean, fail = !ok) => (ok ? '충족' : fail ? '미달' : '경계');
  for (const size of [5000, 20000]) {
    const v = targets.map((t) => worstP95(t, size));
    out.push(`| 입력 지연 p95 < 50ms (${size}자, 위치별 중앙값 중 최댓값) | ${fmt(v[0]!)}ms | ${fmt(v[1]!)}ms | ${verdict(v.every((x) => x < 50))} |`);
  }
  {
    const v = targets.map((t) => worstP95(t, 100000));
    out.push(`| 입력 지연 p95 < 100ms, 200ms 초과 시 실패 (100000자) | ${fmt(v[0]!)}ms | ${fmt(v[1]!)}ms | ${verdict(v.every((x) => x < 100), v.some((x) => x > 200))} |`);
  }
  {
    const v = targets.map((t) => median(select(t, 20000).map((r) => r.load.loadMs)));
    out.push(`| 로드 < 1초 (20000자, 파싱 + 첫 렌더) | ${fmt(v[0]!)}ms | ${fmt(v[1]!)}ms | ${verdict(v.every((x) => x < 1000))} |`);
  }
  const textBad = typing.filter((r) => !r.textOk).length;
  const domBad = typing.filter((r) => r.load.domBlocks !== r.load.blocks).length;
  const pasteBad = typing.filter((r) => r.paste && (!r.paste.textOk || !r.paste.undoOk)).length;
  const errors = typing.flatMap((r) => r.errors);
  out.push('', `- 검증 (질문 4·7): 렌더된 블록 수 불일치 ${domBad}/${typing.length}회, 입력 글자 수 불일치 ${textBad}/${typing.length}회, 붙여넣기·실행 취소 불일치 ${pasteBad}회, 페이지 오류 ${errors.length}건${errors.length ? ` (${[...new Set(errors)].slice(0, 3).join('; ')})` : ''}`);
  out.push('- 50만 자는 기준 밖 참고값이다.', '');

  out.push('## 입력 지연 (ms): 실행별 p95의 중앙값 [범위], p50·p99 중앙값', '');
  out.push('| 글자 수 | 블록 | 위치 | Chrome p95 | Chrome p50 / p99 | Electron p95 | Electron p50 / p99 |', '|---|---|---|---|---|---|---|');
  for (const size of PERF_SIZES) {
    for (const pos of POSITIONS) {
      const cells = targets.map((t) => {
        const rs = select(t, size, pos);
        const p95s = runP95(rs);
        return `${fmt(median(p95s))} [${range(p95s)}] | ${fmt(median(rs.map((r) => percentile(r.latencies, 50))))} / ${fmt(median(rs.map((r) => percentile(r.latencies, 99))))}`;
      });
      out.push(`| ${size} | ${select('chrome', size)[0]?.load.blocks ?? '-'} | ${pos} | ${cells.join(' | ')} |`);
    }
  }

  out.push('', '## 로드·붙여넣기·스크롤·메모리 (중앙값 [범위])', '');
  out.push('| 글자 수 | 대상 | 로드 (파싱 + 렌더) | 파싱 | 저장 직렬화 | 2만 자 붙여넣기 | 실행 취소 | 스크롤 프레임 p95 | 50ms 넘는 프레임 | JS 힙 MB |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const size of PERF_SIZES) {
    for (const t of targets) {
      const rs = select(t, size);
      const mid = rs.filter((r) => r.paste);
      const loadMs = rs.map((r) => r.load.loadMs);
      const gaps = mid.flatMap((r) => r.scrollGaps ?? []);
      out.push(
        `| ${size} | ${t} | ${fmt(median(loadMs))} [${range(loadMs)}] | ${fmt(median(rs.map((r) => r.load.parseMs)))} | ${fmt(median(rs.map((r) => r.load.serializeMs)))} | ${fmt(median(mid.map((r) => r.paste!.ms)))} [${range(mid.map((r) => r.paste!.ms))}] | ${fmt(median(mid.map((r) => r.paste!.undoMs)))} | ${fmt(percentile(gaps, 95))} | ${gaps.filter((g) => g > 50).length}/${gaps.length} | ${fmt(median(rs.map((r) => r.heapMb ?? NaN)))} |`,
      );
    }
  }

  out.push('', '## 변환기별 로드 (Chrome, 중앙값 [범위] ms)', '');
  out.push('| 글자 수 | ' + LOAD_COMBOS.join(' | ') + ' |', '|---|' + LOAD_COMBOS.map(() => '---').join('|') + '|');
  for (const size of PERF_SIZES) {
    const cells = LOAD_COMBOS.map((c) => {
      const xs = loads.filter((l) => l.combo === c && l.size === size).map((l) => l.load.loadMs);
      return `${fmt(median(xs))} [${range(xs)}]`;
    });
    out.push(`| ${size} | ${cells.join(' | ')} |`);
  }

  out.push('', '## 병목 (질문 1): 50만 자 문서 중간에서 20키 입력 중 CPU 프로파일', '');
  out.push('프로파일을 켠 별도 실행이며 위 수치에 포함되지 않는다. 개발 서버(축소 안 함)에서 측정. 자체 시간 상위 함수:', '');
  for (const line of profile) out.push(`- ${line}`);
  return out.join('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
