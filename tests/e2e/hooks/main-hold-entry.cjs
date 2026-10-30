// E2E 전용 시작 파일: 훅을 먼저 불러온 뒤 제품 main을 불러온다. 제품의 __dirname 기준 경로는 그대로다.
require('./main-hold.cjs');
require('../../../out/main/index.js');
