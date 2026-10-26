// E2E용 가짜 OpenAI 서버. 앱은 OpenAI SDK의 표준 설정(OPENAI_BASE_URL)으로 이 서버를 부른다.
// 제품 코드에는 테스트 전용 장치가 없다.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { diag, diagDir } from './diag.ts';

export interface FakeRequest {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeOpenAi {
  baseUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

/** reply: Responses API 호출마다 돌려줄 추출 결과 (JSON으로 직렬화해 output_text에 넣는다) */
export async function startFakeOpenAi(reply: (user: string) => unknown): Promise<FakeOpenAi> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as { input?: { role: string; content: string }[] }) : null;
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/responses')) {
      const user = body?.input?.find((m) => m.role === 'user')?.content ?? '';
      res.end(
        JSON.stringify({
          id: 'resp_fake',
          object: 'response',
          created_at: 0,
          status: 'completed',
          model: 'gpt-6-luna-fake',
          output: [
            {
              type: 'message',
              id: 'msg_fake',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: JSON.stringify(reply(user)), annotations: [] }],
            },
          ],
          usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 800, total_tokens: 1800 },
        }),
      );
      return;
    }
    res.end(JSON.stringify({ id: 'gpt-6-luna', object: 'model', created: 0, owned_by: 'openai' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  if (diagDir) {
    const log = (m: string) => diag('fake-openai.log', `${port} ${m}`);
    log('listening');
    server.on('connection', (s) => {
      log('connection');
      s.on('error', (e: Error) => log(`socket-error ${e.message}`));
    });
    server.on('request', (r) => log(`request ${r.method} ${r.url}`));
    server.on('clientError', (e) => log(`client-error ${e.message}`));
    server.on('close', () => log('close'));
  }
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
