import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { registerAppearanceIpc, showWhenRendererReady, windowBackground } from './appearance.ts';
import { guardWindowClose, registerIpc } from './ipc.ts';

// 모든 renderer를 sandbox로 실행한다 (창별 설정을 빠뜨려도 적용됨). ready 전에 호출해야 한다
app.enableSandbox();

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    // 첫 페인트 전의 색. 보이는 시점은 renderer가 테마를 적용한 첫 화면을 알릴 때다 (showWhenRendererReady)
    backgroundColor: await windowBackground(app.getPath('userData')),
    title: 'LoreWeave',
    // 앱 아이콘 (Windows ICO 6프레임). 저장소 resources/에서 읽는다: 실행 중인 창·작업표시줄에 쓰이고, 설치 파일 아이콘은 아직 배포 기반이 없어 이 변경의 범위가 아니다
    icon: join(__dirname, '../../resources/app-icon.ico'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  showWhenRendererReady(win);
  guardWindowClose(win);

  // 앱 밖으로 나가는 탐색과 새 창은 막는다. https 링크만 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });

  // 개발 서버(electron-vite dev)는 Electron을 기본 앱으로 명시 실행한 개발 흐름(`electron .`)에서만 읽는다: 그때 process.defaultApp이 true다.
  // 폴더형 실행본(electron.exe를 앱 경로 인자 없이 실행, resources/app)은 defaultApp이 undefined라서, 환경에서 ELECTRON_RENDERER_URL을 상속받아도 외부 개발 서버를 읽지 않고 빌드된 renderer를 연다.
  // (isPackaged나 실행 파일 이름에 기대지 않는다: 폴더형 실행본에서 isPackaged가 false로 관측됐다. 이 값은 새 우회 스위치가 아니라 Electron이 알려 주는 실행 형태다)
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (process.defaultApp === true && !app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  // 종료할 때 OS 낮·밤 구독과 처리기를 거둔다
  app.once('will-quit', registerAppearanceIpc(() => app.getPath('userData')));
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
