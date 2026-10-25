// OpenAI 클라이언트와 설정. 네트워크 없이 fetch를 바꿔 끼워 요청 모양, 사용량, 오류 문구를 확인한다.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AiError, createOpenAiClient } from '../../src/main/ai-client.ts';
import { readSettings, updateSettings } from '../../src/main/settings.ts';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; requests: { url: string; body: unknown }[] } {
  const requests: { url: string; body: unknown }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetch: fn, requests };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });

const responseBody = (status: string, text: string) => ({
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  status,
  model: 'gpt-6-luna-2026-09',
  incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
  usage: {
    input_tokens: 1200,
    input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
    output_tokens: 900,
    output_tokens_details: { reasoning_tokens: 200 },
    total_tokens: 2100,
  },
});

const call = {
  model: 'gpt-6-luna',
  system: '시스템',
  user: '<chapter n="1">본문</chapter>',
  schema: { name: 'chapter_extraction', schema: { type: 'object' } },
};

test('json: 요청 모양 (Structured Outputs strict, 추론 low)과 사용량 해석', async () => {
  const f = fakeFetch(() => json(200, responseBody('completed', '{"summary":"요약"}')));
  const result = await createOpenAiClient('sk-test', { fetch: f.fetch }).json(call);
  assert.deepEqual(result.data, { summary: '요약' });
  assert.equal(result.modelVersion, 'gpt-6-luna-2026-09');
  assert.deepEqual(result.usage, { inputTokens: 1200, cachedTokens: 300, cacheWriteTokens: 100, outputTokens: 900 });
  const body = f.requests[0]!.body as Record<string, unknown>;
  assert.match(f.requests[0]!.url, /\/responses$/);
  assert.equal(body['model'], 'gpt-6-luna');
  assert.deepEqual(body['input'], [
    { role: 'system', content: '시스템' },
    { role: 'user', content: '<chapter n="1">본문</chapter>' },
  ]);
  assert.deepEqual(body['text'], { format: { type: 'json_schema', name: 'chapter_extraction', schema: { type: 'object' }, strict: true } });
  assert.deepEqual(body['reasoning'], { effort: 'low' });
});

test('json: 끝나지 않은 응답은 incomplete 오류 (사용량은 함께 남긴다)', async () => {
  const f = fakeFetch(() => json(200, responseBody('incomplete', '{"summ')));
  await assert.rejects(createOpenAiClient('sk-test', { fetch: f.fetch }).json(call), (e: unknown) => {
    assert.ok(e instanceof AiError);
    assert.equal(e.kind, 'incomplete');
    assert.equal((e as AiError & { usage: { outputTokens: number } }).usage.outputTokens, 900);
    return true;
  });
});

const errorBody = (message: string) => ({ error: { message, type: 'error', code: null, param: null } });

test('오류 문구: 401 키, 404 모델, 429 한도, 연결 실패', async () => {
  const cases: [number, AiError['kind'], RegExp][] = [
    [401, 'auth', /API 키가 올바르지 않습니다/],
    [404, 'model', /모델을 쓸 수 없습니다/],
    [429, 'rate-limit', /한도나 잔액/],
  ];
  for (const [status, kind, message] of cases) {
    const f = fakeFetch(() => json(status, errorBody('x')));
    await assert.rejects(createOpenAiClient('sk-test', { fetch: f.fetch, maxRetries: 0 }).check('gpt-6-luna'), (e: unknown) => {
      assert.ok(e instanceof AiError);
      assert.equal(e.kind, kind);
      assert.match(e.message, message);
      return true;
    });
  }
  const offline = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(createOpenAiClient('sk-test', { fetch: offline.fetch, maxRetries: 0 }).check('gpt-6-luna'), (e: unknown) => {
    assert.ok(e instanceof AiError);
    return e.kind === 'network';
  });
});

test('check: 모델 조회만 한다 (생성 호출 없음)', async () => {
  const f = fakeFetch(() => json(200, { id: 'gpt-6-luna', object: 'model', created: 0, owned_by: 'openai' }));
  await createOpenAiClient('sk-test', { fetch: f.fetch }).check('gpt-6-luna');
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0]!.url, /\/models\/gpt-6-luna$/);
});

test('설정: 기본값, 모르는 모델은 기본 모델로, 깨진 파일은 기본값, 바꾼 값은 합쳐 저장', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loreweave-settings-'));
  try {
    assert.deepEqual(await readSettings(dir), { lastProject: null, aiModel: 'gpt-6-luna', aiSendConsent: false });
    await writeFile(join(dir, 'settings.json'), '{ 깨짐');
    assert.equal((await readSettings(dir)).aiModel, 'gpt-6-luna');
    await updateSettings(dir, { lastProject: 'D:/원고' });
    await updateSettings(dir, { aiModel: 'gpt-6.1-sol' });
    assert.deepEqual(await readSettings(dir), { lastProject: 'D:/원고', aiModel: 'gpt-6.1-sol', aiSendConsent: false });
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ aiModel: 'gpt-unknown' }));
    assert.equal((await readSettings(dir)).aiModel, 'gpt-6-luna');
    assert.doesNotMatch(await readFile(join(dir, 'settings.json'), 'utf8'), /key/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
