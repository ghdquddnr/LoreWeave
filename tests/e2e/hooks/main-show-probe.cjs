// E2E 전용 main 프로세스 훅 (제품 코드가 아니다): 창이 보이는 순간(show)의 renderer 상태를 읽어 globalThis.__shows에 남긴다.
// "첫 프레임 전에 테마가 적용됐는가"를 보기 위한 읽기 전용 관측이다. executeJavaScript는 show 직후의 DOM을 읽는다.
const { app } = require('electron');
const g = globalThis;
g.__shows = [];
app.on('browser-window-created', (_event, win) => {
  win.on('show', () => {
    const entry = { backgroundColor: win.getBackgroundColor(), dom: null };
    g.__shows.push(entry);
    win.webContents
      .executeJavaScript(
        `JSON.stringify({ theme: document.documentElement.dataset.theme, scheme: document.documentElement.dataset.scheme, msFont: document.documentElement.dataset.msFont ?? null, bodyBg: getComputedStyle(document.body).backgroundColor, rendered: (document.getElementById('root')?.childElementCount ?? 0) > 0, fonts: document.fonts.status })`,
      )
      .then((v) => (entry.dom = JSON.parse(v)));
  });
});
