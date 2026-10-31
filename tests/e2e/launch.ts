// E2E 공통: 빌드된 앱을 임시 사용자 데이터 폴더로 띄운다 (사용자의 실제 설정을 건드리지 않음).

import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { diag, diagDir } from './diag.ts';

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `loreweave-${prefix}-`));
}

/**
 * env: 앱에 더할 환경 변수 (예: 가짜 OpenAI 서버 주소 OPENAI_BASE_URL)
 * entry: 앱 시작 파일 (기본 '.' = package.json의 main). 제품보다 먼저 main 프로세스 훅을 걸어야 하는 테스트가 훅을 불러온 뒤 제품 main을 불러오는 얇은 시작 파일을 넘긴다
 */
export async function launch(userData: string, env: Record<string, string> = {}, entry = '.'): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [entry, `--user-data-dir=${userData}`],
    env: { ...(process.env as Record<string, string>), ...env },
  });
  if (diagDir()) {
    // 진단 기록(선택): 이 앱 프로세스의 출력과 종료 시각 (다음 실행과 겹쳤는지 볼 수 있다)
    const proc = app.process();
    const file = `app-${Date.now()}-${proc.pid}.log`;
    diag(file, `launch pid=${proc.pid} extraEnv=${Object.keys(env).join(',')}`);
    proc.stdout?.on('data', (d: Buffer) => diag(file, `out ${d.toString().trimEnd()}`));
    proc.stderr?.on('data', (d: Buffer) => diag(file, `err ${d.toString().trimEnd()}`));
    proc.on('exit', (code) => diag(file, `exit ${code}`));
  }
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** 폴더 선택 창 대신 dir을 고른 것으로 한다 */
export async function stubFolderDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, dir);
}

/** 이 앱의 아직 살아 있는 프로세스. 이미 닫힌 앱(연결이 정리되어 process()가 던짐)이면 null */
function liveProcess(app: ElectronApplication) {
  try {
    const child = app.process();
    return child.exitCode === null && child.signalCode === null ? child : null;
  } catch {
    return null;
  }
}

/**
 * 정리의 모든 대기 경계의 한도(ms). 전체 정리 시간은 closeMs + (killMs + exitMs + exitMs) + connMs + evalMs 이하다.
 * closeMs: 정상 창닫기 (저장 거절·충돌 취소 등으로 창이 남으면 한도 뒤 강제 종료) / killMs: 종료 명령 / exitMs: 종료 확인 대기 / connMs: Playwright 연결 닫기 / evalMs: 남은 창닫기 요청
 */
export interface CleanupOptions {
  closeMs: number;
  killMs: number;
  exitMs: number;
  connMs: number;
  evalMs: number;
  /** 이 pid만 끝내는 명령 (기본: Windows `taskkill /pid <pid> /T /F`, 그 밖에는 SIGKILL). 시험이 실패를 흉내 낼 때 바꾼다 */
  kill?: (pid: number, timeoutMs: number) => void;
  /** pid가 살아 있는지 (기본: signal 0) */
  isAlive?: (pid: number) => boolean;
}
export const CLEANUP_LIMITS: CleanupOptions = { closeMs: 20_000, killMs: 5_000, exitMs: 5_000, connMs: 5_000, evalMs: 2_000 };

const defaultKill = (pid: number, timeoutMs: number) => {
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: timeoutMs });
  else process.kill(pid, 'SIGKILL');
};
const defaultAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** 한도 안에 끝나면 true, 아니면 false. 타이머는 항상 지운다. promise의 늦은 거절은 삼킨다 (정리 중 이미 관심 밖) */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** 정리 결과. exited는 실제 종료(exit 이벤트 또는 pid 소멸)를 확인했을 때만 true */
export interface TerminateResult {
  pid: number | undefined;
  commandError: string | null;
  exited: boolean;
  connectionClosed: boolean;
  notes: string[];
}

/**
 * 이 앱의 프로세스만 끝낸다 (이름으로 끝내지 않는다). 종료 명령, 종료 확인, 연결 닫기가 각각 한도를 가진다.
 * 명령이 실패해도 종료로 치지 않는다: exit 이벤트나 pid 소멸을 확인해야 exited=true. 확인하지 못하면 그 사실을 notes에 남기고, 살아 있는 자식이 runner를 붙잡지 않게 stdio를 끊고 unref한다.
 */
export async function terminateApp(app: ElectronApplication, opts: Partial<CleanupOptions> = {}): Promise<TerminateResult> {
  const o = { ...CLEANUP_LIMITS, ...opts };
  const kill = o.kill ?? defaultKill;
  const alive = o.isAlive ?? defaultAlive;
  const child = liveProcess(app);
  const result: TerminateResult = { pid: undefined, commandError: null, exited: true, connectionClosed: true, notes: [] };
  if (child) {
    result.pid = child.pid;
    const pid = child.pid!;
    let onExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => child.once('exit', (onExit = () => resolve())));
    const waitExit = async () => (await within(exited, o.exitMs)) || !alive(pid);
    try {
      kill(pid, o.killMs);
    } catch (e) {
      result.commandError = `종료 명령 실패: ${(e as Error).message}`;
      result.notes.push(result.commandError);
    }
    let ok = await waitExit();
    if (!ok && result.commandError === null) result.notes.push('종료 명령은 성공했지만 종료를 확인하지 못했다');
    if (!ok) {
      // 이 앱의 자식 핸들로 한 번 더 (같은 pid만)
      try {
        child.kill('SIGKILL');
      } catch (e) {
        result.notes.push(`자식 핸들 SIGKILL 실패: ${(e as Error).message}`);
      }
      ok = await waitExit();
    }
    if (onExit) child.off('exit', onExit);
    result.exited = ok;
    if (!ok) {
      result.notes.push(`pid=${pid} 종료를 확인하지 못했다 (고아 가능성: 종료됐다고 보지 않는다)`);
      // 이 자식이 runner를 붙잡지 않게 한다
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
  }
  // 죽은 앱과의 Playwright 연결을 닫는다. 안 닫히면 그 사실을 남긴다
  if (!(await within(app.close(), o.connMs))) {
    result.connectionClosed = false;
    result.notes.push(`Playwright 연결 닫기가 ${o.connMs}ms 안에 끝나지 않았다`);
  }
  return result;
}

/** 정리가 한도를 넘기거나 종료를 확인하지 못한 기록. 테스트 파일이 끝날 때 한 번에 실패로 보고한다 (원래 assertion 실패는 가리지 않는다) */
const cleanupFailures: string[] = [];
/** 기록을 가져가며 비운다 (정리 한도 동작을 직접 확인하는 테스트용) */
export function takeCleanupFailures(): string[] {
  return cleanupFailures.splice(0);
}
after(() => {
  if (cleanupFailures.length > 0) throw new Error(`E2E 정리 실패 ${cleanupFailures.length}건: ${cleanupFailures.join(' | ')}`);
});

/**
 * 창을 닫는다 (renderer가 저장을 마치고 답할 때까지 기다림).
 * 모든 대기에 한도가 있다. 창이 저장 거절·충돌로 남으면 한도 뒤 이 테스트가 띄운 앱 프로세스(pid)만 강제로 끝내고(terminateApp), 그 사실과 종료 확인 여부를 기록한다.
 * 한도 초과·종료 미확인은 삼키지 않는다: 파일 끝에서 별도 실패로 보고된다. 이 함수는 던지지 않으므로 호출한 finally 안의 원래 오류는 보존된다.
 * 이미 닫힌 앱·중복 호출에는 아무것도 하지 않는다.
 */
export async function closeWindow(app: ElectronApplication, limits: number | Partial<CleanupOptions> = {}): Promise<void> {
  const opts = typeof limits === 'number' ? { closeMs: limits } : limits;
  const o = { ...CLEANUP_LIMITS, ...opts };
  const child = liveProcess(app);
  if (!child) return;
  const pid = child.pid;
  let onClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => app.once('close', (onClose = () => resolve())));
  const request = app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const done = await within(closed, o.closeMs);
  if (onClose) app.off('close', onClose);
  if (done) {
    await within(request, o.evalMs);
    return;
  }
  const lines = [`closeWindow: ${o.closeMs}ms 안에 창이 닫히지 않았다 (저장 거절·충돌 등으로 창이 남은 것으로 보임). 이 테스트의 앱 pid=${pid}만 끝낸다`];
  const result = await terminateApp(app, opts);
  if (!(await within(request, o.evalMs))) lines.push(`창닫기 요청이 ${o.evalMs}ms 안에 끝나지 않았다 (무시하고 계속)`);
  lines.push(...result.notes, `종료 확인=${result.exited ? '예' : '아니오'}, 연결 닫기=${result.connectionClosed ? '예' : '아니오'}`);
  const message = lines.join('; ');
  diag(`cleanup-${Date.now()}-${pid}.log`, message);
  console.error(message);
  cleanupFailures.push(message);
}

/** 앱을 강제로 죽인다 (저장 기회 없음). 한도 안에서 이 앱의 프로세스 트리만 끝내며, 종료를 확인하지 못하면 던진다 */
export async function killApp(app: ElectronApplication, opts: Partial<CleanupOptions> = {}): Promise<void> {
  const result = await terminateApp(app, opts);
  if (!result.exited) throw new Error(`killApp: pid=${result.pid} 종료를 확인하지 못했다: ${result.notes.join('; ')}`);
}
