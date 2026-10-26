// E2E 진단 기록 (선택). 환경 변수 E2E_DIAG_DIR에 폴더를 주면, 불안정한 실패를 다시 볼 수 있게 다음을 그 폴더에 남긴다:
//   - fake-openai.log: 가짜 OpenAI 서버의 listen·연결·요청·소켓 오류·종료 (포트별)
//   - app-<시각>-<pid>.log: 띄운 앱 프로세스의 stdout·stderr·종료 시각
//   - fail.log: 테스트가 남긴 실패 순간의 화면 상태 (검색 결과 요약 등)
// 기본(변수 없음)은 아무것도 쓰지 않는다. 테스트의 통과·실패 판정이나 대기 시간은 바꾸지 않는다 (재시도·대기 늘리기 장치가 아니다).
// 앱 stderr에는 경로가 들어갈 수 있다. 저장소 밖 폴더를 쓴다.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const diagDir: string | null = process.env['E2E_DIAG_DIR'] || null;

export function diag(file: string, line: string): void {
  if (!diagDir) return;
  appendFileSync(join(diagDir, file), `${new Date().toISOString()} ${line}\n`);
}
