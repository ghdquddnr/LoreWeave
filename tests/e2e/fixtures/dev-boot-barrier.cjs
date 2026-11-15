// 테스트 전용 시작 장벽 (제품 코드가 아니다; dev-server-boot.test.ts가 `electron-vite dev --entry`로만 지정한다).
// 제품 main(out/main/index.js)을 require하기 *전에* Electron의 실제 userData 경로가 기대한 합성 임시 경로인지 확인한다.
// 어긋나거나 기대값이 없으면 제품 main을 불러오지 않고 종료한다 → 제품의 설정(settings.json)·최근 프로젝트·키 읽기/쓰기가 시작되지 않는다.
// 보장 범위: "제품 main 실행 경계"까지다. Electron/Chromium 자체의 초기화(프로필 파일 생성 등)는 이 장벽보다 먼저 일어나며 막지 못한다.
const { appendFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { app } = require('electron');

const norm = (p) => (typeof p === 'string' && p !== '' ? resolve(p).toLowerCase() : '');
const logPath = process.env.LW_BARRIER_LOG;
const log = (event, extra = {}) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ t: Date.now(), event, ...extra }) + '\n');
};

const expected = process.env.LW_EXPECT_USERDATA ?? '';
const actual = app.getPath('userData'); // ready 이전에도 --user-data-dir 값이 반영된다
const ok = norm(expected) !== '' && norm(actual) === norm(expected);
log('barrier-check', { actual, expected, ok });
if (!ok) {
  log('barrier-refuse');
  process.exit(87); // 제품 main을 require하지 않는다
}
log('barrier-pass');
require(join(__dirname, '..', '..', '..', 'out', 'main', 'index.js'));
log('product-main-required');
