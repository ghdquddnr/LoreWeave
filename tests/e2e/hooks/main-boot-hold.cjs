// E2E 전용 main 프로세스 훅 (제품 코드가 아니다): appearance:bootstrap 응답의 전달을 붙잡아 "응답 스냅샷을 만든 뒤 전달 전에 OS 낮·밤이 바뀌는" 순서를 결정적으로 만든다 (합성 스케줄 제어).
// globalThis.__boot = { hold, held, snapshotDark, release }. hold가 true일 때 다음 bootstrap 하나를 붙잡고, 테스트가 release()로 푼다.
const { ipcMain } = require('electron');
const g = globalThis;
g.__boot = { hold: true, held: false, snapshotDark: null, release: undefined };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (channel !== 'appearance:bootstrap') return handle(channel, listener);
  return handle(channel, async (...args) => {
    const result = await listener(...args); // 스냅샷은 여기서 만들어졌다
    if (g.__boot.hold) {
      g.__boot.hold = false;
      g.__boot.snapshotDark = result.systemDark;
      g.__boot.held = true;
      await new Promise((resolve) => {
        g.__boot.release = () => {
          g.__boot.held = false;
          resolve();
        };
      });
    }
    return result;
  });
};
