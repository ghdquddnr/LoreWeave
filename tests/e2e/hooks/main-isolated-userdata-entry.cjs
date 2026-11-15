// E2E 전용 시작 파일 (제품 번들에 들어가지 않는다): 제품 main을 불러오기 전에 이 테스트가 mkdtemp로 만든 독점 새 userData를 강제하고 증거를 남긴다.
// 환경 변수 LW_TEST_USERDATA(테스트가 넘긴 절대 경로)가 없거나, 임시 폴더 밖이거나, 존재하지 않거나, 비어 있지 않으면 제품 main을 불러오지 않고 종료한다.
// 순서(모두 동기): 경로 검증 → app.setPath('userData') → getPath 동등성 확인 → 증거 파일 기록 → 그 다음에만 out/main/index.js를 불러온다.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fail(reason) {
  process.stderr.write(`[isolated-entry] ${reason}\n`);
  app.exit(2);
  throw new Error(reason); // app.exit 뒤 아래(제품 main)로 내려가지 않는다
}

const dir = process.env.LW_TEST_USERDATA;
if (!dir) fail('LW_TEST_USERDATA가 없다');
if (!path.isAbsolute(dir)) fail(`절대 경로가 아니다: ${dir}`);
const real = fs.realpathSync(dir);
const tmp = fs.realpathSync(os.tmpdir());
if (!(real.startsWith(tmp + path.sep) && real !== tmp)) fail(`임시 폴더 안의 하위 폴더가 아니다: ${real}`);
if (!fs.statSync(real).isDirectory()) fail('폴더가 아니다');
const before = fs.readdirSync(real);
if (before.length !== 0) fail(`비어 있지 않은 폴더다: ${before.join(',')}`);

app.setPath('userData', real);
if (path.resolve(app.getPath('userData')) !== path.resolve(real)) fail(`getPath('userData') 불일치: ${app.getPath('userData')}`);

fs.writeFileSync(
  path.join(real, '.isolated-entry-evidence.json'),
  JSON.stringify({ stage: 'before-product-main', pid: process.pid, userData: app.getPath('userData'), entriesBefore: before, at: Date.now() }),
);
require('../../../out/main/index.js');
