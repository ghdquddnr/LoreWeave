// IME·성능 재확인용 최소 Electron 창. 개발/미리보기 서버의 페이지를 그대로 연다.
// 사용: electron electron/main.cjs [URL]   (기본: 검증 패널)

const { app, BrowserWindow } = require('electron');

// performance.memory를 정확한 값으로 (측정용)
app.commandLine.appendSwitch('enable-precise-memory-info');

const url = process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'http://localhost:5173/';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(url);
});

app.on('window-all-closed', () => app.quit());
