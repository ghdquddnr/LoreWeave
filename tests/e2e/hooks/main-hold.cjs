// E2E 전용 main 프로세스 훅 (제품 코드가 아니다): main-hold-entry.cjs가 제품 main보다 먼저 불러, 제품이 ipcMain.handle로 처리기를 등록하기 전에 감싼다.
// 그래서 자동 재열기의 첫 chapter:read 요청이 오기 전에 장벽이 이미 있다 (page 연결이 느려도 순서가 보장된다).
// globalThis.__hold에 상태를 두고, 테스트는 app.evaluate로 읽고 푼다.
const { ipcMain } = require('electron');
const g = globalThis;
g.__hold = { armed: true, held: false, readCalls: 0, searchCalls: 0, searchDone: 0, release: undefined };
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (channel === 'chapter:read') {
    return handle(channel, async (...args) => {
      g.__hold.readCalls++;
      if (g.__hold.armed) {
        g.__hold.armed = false; // 첫 읽기 하나만 붙잡는다
        g.__hold.held = true;
        await new Promise((resolve) => (g.__hold.release = resolve));
        g.__hold.held = false;
      }
      return listener(...args);
    });
  }
  if (channel === 'chapters:search') {
    return handle(channel, async (...args) => {
      g.__hold.searchCalls++; // 이 호출이 main에 도달했다 = renderer의 beforeSearch가 끝나고 IPC가 갔다
      try {
        return await listener(...args);
      } finally {
        g.__hold.searchDone++; // 응답을 돌려주기 직전
      }
    });
  }
  return handle(channel, listener);
};
