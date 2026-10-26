// 프로젝트를 바꿔도 진행 중인 분석·검사의 저장소는 그 작업이 끝날 때까지 열려 있다 (src/main/ipc.ts).
// 실제 ipc.ts(transpile)·analyzer·checker·AiStore와 임시 프로젝트 두 개를 쓰고, Electron·설정·키·API 클라이언트만 가짜로 바꾼다.

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import ts from 'typescript';
import { AiError, type AiClient, type JsonCall } from '../../src/main/ai-client.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { analyzeChapters } from '../../src/main/analyzer.ts';
import { checkChapter } from '../../src/main/checker.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
const usage = { inputTokens: 1200, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 300 };
const extraction = { summary: '새 요약', entities: [{ name: '김민수', aliases: ['민수'] }], facts: [{ entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' }] };
const finding = { category: 'age', target_quote: '"스물두 살입니다."', claim: '모순', evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }], confidence: 0.9 };

let tmp: string;
/** 테스트가 연 저장소 (끝나면 닫히지 않은 것을 닫고 폴더를 지운다) */
let opened: { closed: boolean; store: AiStore }[] = [];
let A: string;
let B: string;

function makeProject(dir: string) {
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  for (const n of ['01', '02', '03']) copyFileSync(join(M0A, `ch${n}.md`), join(dir, 'chapters', `0${n}.md`));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'loreweave-ipc-store-'));
  A = join(tmp, 'A');
  B = join(tmp, 'B');
  makeProject(A);
  makeProject(B);
});

afterEach(() => {
  for (const o of opened) if (!o.closed) o.store.close();
  opened = [];
  rmSync(tmp, { recursive: true, force: true });
});

/** 요청마다 테스트가 풀어 주는 API 클라이언트 */
function deferredClient() {
  const pending: { call: JsonCall; resolve(data: unknown): void; reject(e: unknown): void }[] = [];
  const client: AiClient = {
    async check() {},
    json: (call) =>
      new Promise((resolve, reject) =>
        pending.push({ call, resolve: (data) => resolve({ data, usage, modelVersion: 'fake', latencyMs: 1 }), reject }),
      ),
  };
  return { client, pending };
}

/** 실제 ipc.ts를 불러온다. 열리는 AiStore마다 닫혔는지 센다 */
function loadIpc(client: AiClient) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  const choose: string[] = [];
  const stores: { root: string; store: AiStore; closed: boolean }[] = [];
  const real = createRequire(__filename);
  const fakes: Record<string, unknown> = {
    electron: {
      app: { getPath: () => join(tmp, 'user-data') },
      ipcMain: { handle: (k: string, fn: (e: unknown, ...a: unknown[]) => unknown) => handlers.set(k, fn) },
      BrowserWindow: { fromWebContents: () => ({}) },
      dialog: { showOpenDialog: async () => ({ filePaths: [choose.shift()!], canceled: false }) },
    },
    '../preload/api.ts': { CHANNELS: new Proxy({}, { get: (_t, k) => k }) },
    './settings.ts': { readSettings: async () => ({ aiSendConsent: true, aiModel: 'gpt-6-luna' }), updateSettings: async () => {} },
    './secrets.ts': { loadApiKey: async () => 'fake-key' },
    './watch.ts': { watchChapters: () => () => {} },
    './index-db.ts': { INDEX_DIR: '.loreweave', ManuscriptIndex: { open: () => ({ close() {} }) } },
    './indexer.ts': { syncIndex: async () => {} },
    './ai-client.ts': { createOpenAiClient: () => client, toAiError: (e: unknown) => e },
    './ai-db.ts': {
      AiStore: {
        open: (root: string) => {
          const store = AiStore.open(root);
          const entry = { root, store, closed: false };
          const close = store.close.bind(store);
          store.close = () => {
            entry.closed = true;
            close();
          };
          stores.push(entry);
          opened.push(entry);
          return store;
        },
      },
    },
    './analyzer.ts': real('../../src/main/analyzer.ts'),
    './checker.ts': real('../../src/main/checker.ts'),
    './project-files.ts': real('../../src/main/project-files.ts'),
  };
  const source = readFileSync(join(__dirname, '../../src/main/ipc.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { registerIpc(): void } };
  new Function('require', 'module', 'exports', code)((k: string) => fakes[k] ?? (k.startsWith('.') ? real(join(__dirname, '../../src/main', k)) : real(k)), mod, mod.exports);
  mod.exports.registerIpc();
  const event = { sender: { send() {} } };
  let token = 0;
  return {
    stores,
    open: async (dir: string) => {
      choose.push(dir);
      token = ((await handlers.get('projectChoose')!(event)) as { token: number }).token;
    },
    analyze: (files: string[]) => (handlers.get('aiAnalyze')!(event, files, token) as Promise<{ stopped: string | null; done: number }>),
    check: (file: string) => (handlers.get('aiRunCheck')!(event, file, token) as Promise<{ checked: boolean; stopped: string | null }>),
  };
}

const until = async (cond: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
  assert.ok(cond(), '기다린 조건이 오지 않았습니다');
};

/** 프로젝트의 ai.db를 따로 열어 읽는다 (없으면 null) */
function readDb(dir: string) {
  try {
    const db = new DatabaseSync(join(dir, '.loreweave', 'ai.db'), { readOnly: true });
    try {
      return {
        calls: db.prepare('SELECT file, ok, cost_usd FROM calls ORDER BY id').all() as { file: string; ok: number; cost_usd: number }[],
        summaries: (db.prepare('SELECT file, summary FROM analyses ORDER BY file').all() as { file: string; summary: string }[]).map((r) => `${r.file}:${r.summary}`),
        checks: (db.prepare('SELECT file, created_at FROM checks ORDER BY file').all() as { file: string; created_at: string }[]).map((r) => `${r.file}:${r.created_at}`),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** A에 기존 분석(요약 "기존")을 저장해 둔다 */
async function seedAnalysis(dir: string) {
  const store = AiStore.open(dir);
  try {
    const client: AiClient = { async check() {}, json: async () => ({ data: { ...extraction, summary: '기존' }, usage, modelVersion: 'fake', latencyMs: 1 }) };
    await analyzeChapters(['001.md', '002.md', '003.md'], { root: dir, store, client, model: 'gpt-6-luna', signal: new AbortController().signal });
  } finally {
    store.close();
  }
}

/** A에 기존 검사(경고 1개)를 저장해 둔다 */
async function seedCheck(dir: string) {
  const store = AiStore.open(dir);
  try {
    const client: AiClient = {
      async check() {},
      json: async (c) => ({ data: c.schema.name === 'chapter_extraction' ? extraction : { findings: [finding] }, usage, modelVersion: 'fake', latencyMs: 1 }),
    };
    const r = await checkChapter('003.md', { root: dir, store, client, model: 'gpt-6-luna', signal: new AbortController().signal });
    assert.equal(r.checked, true);
  } finally {
    store.close();
  }
}

for (const [name, finish, ok] of [
  ['늦은 성공', (p: { resolve(d: unknown): void }) => p.resolve(extraction), 1],
  ['늦은 실패 (usage 있음)', (p: { reject(e: unknown): void }) => p.reject(Object.assign(new AiError('응답이 끝나지 않았습니다', 'incomplete'), { usage })), 0],
] as const) {
  test(`분석 중 프로젝트 전환 (${name}): 이미 보낸 요청의 비용은 원래 프로젝트 DB에 남고, 기존 분석은 그대로이며, 새 프로젝트 DB는 깨끗하고, 원래 저장소는 끝나면 닫힌다`, { timeout: 20_000 }, async () => {
    await seedAnalysis(A);
    const before = readDb(A)!;
    const { client, pending } = deferredClient();
    const ipc = loadIpc(client);
    await ipc.open(A);
    const run = ipc.analyze(['001.md']).then((v) => v, (e: Error) => e.message);
    await until(() => pending.length === 1);
    await ipc.open(B);
    finish(pending[0] as never);
    const outcome = await run;
    assert.equal((outcome as { stopped: string }).stopped, '취소했습니다');
    const after = readDb(A)!;
    // 기존 분석은 그대로, 호출 기록은 하나 더 (원래 DB에)
    assert.deepEqual(after.summaries, before.summaries);
    assert.equal(after.calls.length, before.calls.length + 1);
    assert.equal(after.calls.at(-1)!.ok, ok);
    assert.ok(after.calls.at(-1)!.cost_usd > 0);
    // 새 프로젝트에는 옛 비용·결과가 없다
    const b = readDb(B);
    assert.ok(b === null || (b.calls.length === 0 && b.summaries.length === 0));
    // 작업이 쓴 A의 저장소는 끝난 뒤 닫혔다
    const jobStore = ipc.stores.find((s) => s.root === A)!;
    assert.equal(jobStore.closed, true);
    assert.equal(pending.length, 1);
  });
}

test('검사 중 프로젝트 전환: 늦은 성공을 저장하지 않고 기존 검사는 그대로, 호출 비용은 원래 DB에 남고, 원래 저장소는 끝나면 닫힌다', { timeout: 20_000 }, async () => {
  await seedCheck(A);
  const before = readDb(A)!;
  const { client, pending } = deferredClient();
  const ipc = loadIpc(client);
  await ipc.open(A);
  const run = ipc.check('003.md');
  await until(() => pending.length === 1);
  await ipc.open(B);
  pending[0]!.resolve({ findings: [finding] });
  const outcome = await run;
  assert.equal(outcome.checked, false);
  assert.equal(outcome.stopped, '취소했습니다');
  const after = readDb(A)!;
  assert.deepEqual(after.checks, before.checks);
  assert.equal(after.calls.length, before.calls.length + 1);
  const b = readDb(B);
  assert.ok(b === null || (b.calls.length === 0 && b.checks.length === 0));
  assert.equal(ipc.stores.find((s) => s.root === A)!.closed, true);
});

test('여러 번 전환하고 같은 프로젝트를 다시 열어도, 작업 저장소는 그 작업이 끝날 때 한 번만 닫히고, 지금 열린 저장소는 열려 있으며, 다음 작업이 진행된다', { timeout: 20_000 }, async () => {
  await seedAnalysis(A);
  const before = readDb(A)!;
  const { client, pending } = deferredClient();
  const ipc = loadIpc(client);
  await ipc.open(A);
  const run = ipc.analyze(['001.md']);
  await until(() => pending.length === 1);
  await ipc.open(B);
  await ipc.open(A);
  // 작업이 끝나기 전에는 새 작업을 받지 않는다 (단일 진입)
  await assert.rejects(ipc.analyze(['002.md']), /이미 분석 중/);
  pending[0]!.resolve(extraction);
  await run;
  const job = ipc.stores[0]!;
  assert.equal(job.root, A);
  assert.equal(job.closed, true);
  assert.equal(readDb(A)!.calls.length, before.calls.length + 1);
  assert.deepEqual(readDb(A)!.summaries, before.summaries);
  // 다시 연 A에서 다음 작업이 진행되고, 지금 저장소에 기록된다
  const next = ipc.analyze(['002.md']);
  await until(() => pending.length === 2);
  pending[1]!.resolve({ ...extraction, summary: '다음 작업' });
  const r = await next;
  assert.equal(r.stopped, null);
  assert.ok(readDb(A)!.summaries.includes('002.md:다음 작업'));
  const current = ipc.stores.at(-1)!;
  assert.equal(current.root, A);
  assert.equal(current.closed, false);
});

test('작업이 실패해도 전환으로 떨어진 저장소는 닫히고, 다음 요청은 새 프로젝트 저장소를 쓴다', { timeout: 20_000 }, async () => {
  const { client, pending } = deferredClient();
  const ipc = loadIpc(client);
  await ipc.open(A);
  const run = ipc.analyze(['001.md']).then((v) => v, (e: Error) => e.message);
  await until(() => pending.length === 1);
  await ipc.open(B);
  pending[0]!.reject(new AiError('API 키가 올바르지 않습니다.', 'auth'));
  await run;
  assert.equal(ipc.stores.find((s) => s.root === A)!.closed, true);
  const next = ipc.analyze(['001.md']);
  await until(() => pending.length === 2);
  pending[1]!.resolve(extraction);
  await next;
  assert.ok(readDb(B)!.summaries.includes('001.md:새 요약'));
  assert.equal(readDb(A)!.summaries.length, 0);
});
