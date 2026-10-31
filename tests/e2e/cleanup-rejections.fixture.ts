// cleanup-bound.test.ts가 독립 subprocess로 실행하는 대역 시나리오 (이 파일은 *.test.ts가 아니므로 스스로는 돌지 않는다).
// 처리되지 않은 rejection은 프로세스를 죽이므로 별도 프로세스에서 확인한다. 존재할 수 없는 pid의 앱 대역이며 실프로세스를 만들지도 끝내지도 않는다.
// 결과는 stdout의 JSON 한 줄이다.

import { EventEmitter } from 'node:events';
import type { ElectronApplication } from 'playwright';
import { closeWindow, killApp, takeCleanupFailures, terminateApp } from './launch.ts';

const SMALL = { closeMs: 100, killMs: 20, exitMs: 20, connMs: 20, evalMs: 20 };

interface Setup {
  evaluate: 'reject' | 'throw' | 'ok';
  close: 'reject' | 'throw' | 'ok';
  /** 이미 닫힌 앱: process()가 던진다 */
  closed?: boolean;
  /** app.once가 동기로 던진다 */
  onceThrows?: boolean;
}
function fakeApp(s: Setup) {
  const emitter = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(child, { pid: 2_147_483_000, exitCode: null, signalCode: null, kill: () => undefined, unref: () => undefined, stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} } });
  const app = {
    process: () => {
      if (s.closed) throw new Error('connection disposed');
      return child;
    },
    once: (e: string, f: () => void) => {
      if (s.onceThrows) throw new Error('REVIEW_ONCE_THROW');
      return emitter.once(e, f);
    },
    off: (e: string, f: () => void) => emitter.off(e, f),
    evaluate: () => {
      if (s.evaluate === 'throw') throw new Error('REVIEW_EVALUATE_THROW');
      return s.evaluate === 'reject' ? Promise.reject(new Error('REVIEW_EVALUATE_REJECT')) : Promise.resolve();
    },
    close: () => {
      if (s.close === 'throw') throw new Error('REVIEW_CLOSE_THROW');
      return s.close === 'reject' ? Promise.reject(new Error('REVIEW_CLOSE_REJECT')) : Promise.resolve();
    },
  } as unknown as ElectronApplication;
  return { app, opts: { ...SMALL, kill: () => void child.emit('exit'), isAlive: () => false } };
}

/** finally 안에서 closeWindow를 부르는 테스트가 원래 오류를 잃지 않는지 */
async function preserved(s: Setup): Promise<{ original: boolean; failures: string[] }> {
  takeCleanupFailures();
  const f = fakeApp(s);
  let original = false;
  try {
    try {
      throw new Error('ORIGINAL_ASSERTION');
    } finally {
      await closeWindow(f.app, f.opts);
    }
  } catch (e) {
    original = (e as Error).message === 'ORIGINAL_ASSERTION';
  }
  return { original, failures: takeCleanupFailures() };
}

async function main() {
  const out: Record<string, unknown> = {};
  out['fastEvaluateReject'] = await preserved({ evaluate: 'reject', close: 'ok' });
  out['evaluateThrow'] = await preserved({ evaluate: 'throw', close: 'ok' });
  out['onceThrow'] = await preserved({ evaluate: 'ok', close: 'ok', onceThrows: true });
  out['closeReject'] = await preserved({ evaluate: 'reject', close: 'reject' });
  out['closeThrow'] = await preserved({ evaluate: 'ok', close: 'throw' });
  {
    const f = fakeApp({ evaluate: 'ok', close: 'reject', closed: true });
    const r = await terminateApp(f.app, f.opts);
    let killAppThrew = '';
    try {
      await killApp(f.app, f.opts);
    } catch (e) {
      killAppThrew = (e as Error).message;
    }
    out['closedCloseReject'] = { connectionClosed: r.connectionClosed, exited: r.exited, notes: r.notes, killAppThrew };
  }
  console.log(JSON.stringify(out));
}
void main();
