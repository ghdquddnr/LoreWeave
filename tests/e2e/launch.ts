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

/** 정상 창닫기가 이 시간 안에 끝나지 않으면(저장 거절·충돌 취소 등으로 창이 남음) 정리 실패로 보고 이 테스트의 앱만 강제로 끝낸다 */
export const CLOSE_LIMIT_MS = 20_000;

/** 정리(closeWindow)가 한도를 넘겨 강제 종료한 기록. 테스트 파일이 끝날 때 한 번에 실패로 보고한다 (원래 assertion 실패는 가리지 않는다) */
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
 * 기다림에는 한도가 있다: 창이 저장 거절·충돌로 남으면 이 테스트가 띄운 앱 프로세스(PID)만 강제로 끝내고, 그 사실을 기록한다.
 * 한도 초과는 삼키지 않는다: 파일 끝에서 별도 실패로 보고된다. 이미 닫힌 앱에는 아무것도 하지 않는다 (중복 호출 안전).
 * 호출한 쪽이 던질 수 있는 try/finally 안의 원래 오류는 이 함수가 던지지 않으므로 그대로 보존된다.
 */
export async function closeWindow(app: ElectronApplication, limitMs = CLOSE_LIMIT_MS): Promise<void> {
  const child = liveProcess(app);
  if (!child) return;
  const closed = new Promise<boolean>((resolve) => app.once('close', () => resolve(true)));
  const request = app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), limitMs);
  });
  const done = await Promise.race([closed, limit]);
  clearTimeout(timer);
  if (done) return;
  const pid = child.pid;
  const message = `closeWindow: ${limitMs}ms 안에 창이 닫히지 않았다 (저장 거절·충돌 등으로 창이 남은 것으로 보임). 이 테스트의 앱 pid=${pid}만 강제 종료한다`;
  diag(`cleanup-${Date.now()}-${pid}.log`, message);
  console.error(message);
  cleanupFailures.push(message);
  await killApp(app);
  await request;
}

/** 앱을 강제로 죽인다 (저장 기회 없음). Windows에서는 자식 프로세스까지 트리 전체를 끝낸다 */
export async function killApp(app: ElectronApplication): Promise<void> {
  const child = liveProcess(app);
  if (child) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch {
      // 그 사이 스스로 끝났을 수 있다: exit 이벤트로 확인한다
    }
    await exited;
  }
  // 죽은 앱과의 연결을 정리한다 (안 하면 테스트 프로세스가 끝나지 않는다)
  await app.close().catch(() => {});
}
