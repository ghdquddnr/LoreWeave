// E2E 전용 시작 파일: bootstrap 응답 지연 훅을 먼저 불러온 뒤 제품 main을 불러온다.
require('./main-boot-hold.cjs');
require('../../../out/main/index.js');
