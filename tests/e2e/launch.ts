// E2E 공통: 빌드된 앱을 임시 사용자 데이터 폴더로 띄운다 (사용자의 실제 설정을 건드리지 않음).

import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** 창을 닫는다 (renderer가 저장을 마치고 답할 때까지 기다림) */
export async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
}

/** 앱을 강제로 죽인다 (저장 기회 없음). Windows에서는 자식 프로세스까지 트리 전체를 끝낸다 */
export async function killApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
  await exited;
  // 죽은 앱과의 연결을 정리한다 (안 하면 테스트 프로세스가 끝나지 않는다)
  await app.close().catch(() => {});
}
