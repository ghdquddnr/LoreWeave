// E2E 진단 기록(tests/e2e/diag.ts)과 가짜 OpenAI 서버(tests/e2e/fake-openai.ts)의 회귀. Electron 없이 확인한다.
//   - 진단을 켜도 꺼도 잘못된 HTTP 요청에 같은 오류 응답을 주고 연결을 닫는다 (clientError 기본 처리 보존)
//   - 진단 폴더가 없거나, 경로가 파일이거나, 지워져도 기록이 던지지 않고, 원래 결과·원래 오류가 그대로다

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { diag, diagFailure } from '../e2e/diag.ts';
import { defaultClientError, startFakeOpenAi } from '../e2e/fake-openai.ts';

let tmp: string;
const saved = process.env['E2E_DIAG_DIR'];
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'loreweave-diag-'));
});
afterEach(async () => {
  if (saved === undefined) delete process.env['E2E_DIAG_DIR'];
  else process.env['E2E_DIAG_DIR'] = saved;
  await rm(tmp, { recursive: true, force: true });
});
const setDiag = (dir: string | null) => {
  if (dir === null) delete process.env['E2E_DIAG_DIR'];
  else process.env['E2E_DIAG_DIR'] = dir;
};

/** 가짜 서버에 원시 바이트를 보내고, 서버가 연결을 닫을 때까지 받은 것을 돌려준다 (닫지 않으면 5초 뒤 실패) */
async function rawExchange(baseUrl: string, payload: string): Promise<string> {
  const socket = connect(Number(new URL(baseUrl).port), '127.0.0.1');
  let data = '';
  socket.on('data', (d) => (data += d));
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write(payload);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`서버가 연결을 닫지 않았습니다 (받은 것: ${JSON.stringify(data)})`));
    }, 5000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return data;
}

async function malformed(dir: string | null) {
  setDiag(dir);
  const fake = await startFakeOpenAi(() => ({}));
  try {
    const response = await rawExchange(fake.baseUrl, 'INVALID HTTP\r\n\r\n');
    // 서버는 그 뒤에도 정상 요청에 답한다
    const ok = await fetch(`${fake.baseUrl}/models/gpt-6-luna`).then((r) => r.status);
    return { statusLine: response.split('\r\n')[0], ok };
  } finally {
    await fake.close();
  }
}

test('잘못된 HTTP 요청: 진단을 켜도 꺼도 같은 400 응답을 주고 연결을 닫으며, 서버는 계속 답한다. 켜면 기록이 남는다', async () => {
  const off = await malformed(null);
  const on = await malformed(join(tmp, 'on'));
  assert.deepEqual(off, { statusLine: 'HTTP/1.1 400 Bad Request', ok: 200 });
  assert.deepEqual(on, off);
  const log = readFileSync(join(tmp, 'on', 'fake-openai.log'), 'utf8');
  assert.match(log, /client-error/);
  assert.match(log, /request GET \/v1\/models\/gpt-6-luna/);
});

test('진단 장애: 경로가 파일이면 기록은 실패하지만 던지지 않고, 가짜 서버의 잘못된 요청 처리와 정상 응답도 그대로다', async () => {
  const file = join(tmp, 'not-a-dir');
  writeFileSync(file, 'x');
  assert.equal((setDiag(file), diag('fail.log', 'x')), false);
  assert.deepEqual(await malformed(file), { statusLine: 'HTTP/1.1 400 Bad Request', ok: 200 });
});

test('진단 폴더: 없으면 만들어 기록하고, 도중에 지워져도 다시 만들어 기록하며 던지지 않는다', () => {
  const dir = join(tmp, 'missing', 'nested');
  setDiag(dir);
  assert.equal(diag('fail.log', 'first'), true);
  rmSync(join(tmp, 'missing'), { recursive: true, force: true });
  assert.equal(diag('fail.log', 'second'), true);
  assert.match(readFileSync(join(dir, 'fail.log'), 'utf8'), /second/);
  setDiag(null);
  assert.equal(diag('fail.log', 'off'), false);
  assert.equal(existsSync(join(tmp, 'off')), false);
});

test('실패 기록: 상태 읽기가 실패하거나 기록할 수 없어도 원래 오류를 그대로 다시 던질 수 있다', async () => {
  const original = new Error('원래 실패');
  const rethrowWithDiag = async () => {
    try {
      throw original;
    } catch (e) {
      await diagFailure('fail.log', async () => {
        throw new Error('화면을 읽지 못함');
      });
      throw e;
    }
  };
  for (const dir of [join(tmp, 'ok'), join(tmp, 'file'), null]) {
    if (dir?.endsWith('file')) writeFileSync(dir, 'x');
    setDiag(dir);
    await assert.rejects(rethrowWithDiag(), (e) => e === original);
  }
  assert.match(readFileSync(join(tmp, 'ok', 'fail.log'), 'utf8'), /상태를 읽지 못함: 화면을 읽지 못함/);
});

// ---- 검토 반영: 서버 쪽 연결 파괴와 진행 중 응답 보존 (Node 기본 socketOnError와 같아야 한다)

/** 송신을 끝내지 않는(allowHalfOpen) 클라이언트가 잘못된 요청을 보낸 뒤, fake.close가 클라이언트 도움 없이 끝나는가 */
async function halfOpen(dir: string | null) {
  setDiag(dir);
  const fake = await startFakeOpenAi(() => ({}));
  const socket = connect({ port: Number(new URL(fake.baseUrl).port), host: '127.0.0.1', allowHalfOpen: true });
  let data = '';
  socket.on('data', (d) => (data += d));
  socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const ended = new Promise<void>((resolve) => socket.once('end', () => resolve()));
  socket.write('INVALID HTTP\r\n\r\n');
  await ended;
  // 클라이언트는 end하지 않는다. 서버가 연결을 파괴하지 않으면 close가 끝나지 않는다
  let timer: NodeJS.Timeout | undefined;
  const closed = await Promise.race([
    fake.close().then(() => true),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 5000))),
  ]);
  clearTimeout(timer);
  socket.destroy();
  if (!closed) await fake.close();
  return { statusLine: data.split('\r\n')[0], serverClosed: closed };
}

test('송신을 끝내지 않는 클라이언트: 진단을 켜도 꺼도 400을 받고, 서버가 연결을 파괴해 fake.close가 끝난다', async () => {
  const off = await halfOpen(null);
  const on = await halfOpen(join(tmp, 'half'));
  assert.deepEqual(off, { statusLine: 'HTTP/1.1 400 Bad Request', serverClosed: true });
  assert.deepEqual(on, off);
});

/** 응답이 헤더를 보낸 채 진행 중일 때 같은 연결에 잘못된 요청이 오면: 400을 덧붙이지 않고 연결을 끊는다 */
async function inFlightParserError(withHandler: boolean) {
  let release = () => {};
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    release = () => res.end();
  });
  if (withHandler) server.on('clientError', (e: NodeJS.ErrnoException, s: Socket) => defaultClientError(e, s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
  let data = '';
  socket.on('error', () => {});
  const gotPartial = new Promise<void>((resolve) =>
    socket.on('data', (d) => {
      data += d;
      if (data.includes('partial')) resolve();
    }),
  );
  // 처리기가 연결을 끊지 않으면 멈추지 않고 실패한다 (5초)
  let guard: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    guard = setTimeout(() => {
      socket.destroy();
      reject(new Error('서버가 연결을 끊지 않았습니다'));
    }, 5000);
    socket.once('close', () => {
      clearTimeout(guard);
      resolve();
    });
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  await gotPartial;
  socket.write('INVALID HTTP\r\n\r\n');
  try {
    await closed;
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { started: data.startsWith('HTTP/1.1 200'), partial: data.includes('partial'), appended400: data.includes('HTTP/1.1 400') };
}

test('진행 중인 응답 뒤의 잘못된 요청: 기록 처리기(defaultClientError)가 Node 기본과 같게 400을 덧붙이지 않고 연결을 끊는다', async () => {
  const node = await inFlightParserError(false);
  const ours = await inFlightParserError(true);
  assert.deepEqual(node, { started: true, partial: true, appended400: false });
  assert.deepEqual(ours, node);
});
