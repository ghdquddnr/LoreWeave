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

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  registerIpc();
  registerAppearanceIpc(() => app.getPath('userData'));
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
