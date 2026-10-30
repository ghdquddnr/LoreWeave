// E2E 진단 기록 (선택). 환경 변수 E2E_DIAG_DIR에 폴더를 주면, 불안정한 실패를 다시 볼 수 있게 다음을 그 폴더에 남긴다:
//   - fake-openai.log: 가짜 OpenAI 서버의 listen·연결·요청·소켓 오류·종료 (포트별)
//   - app-<시각>-<pid>.log: 띄운 앱 프로세스의 stdout·stderr·종료 시각
//   - fail.log: 테스트가 남긴 실패 순간의 화면 상태 (검색 결과 요약 등)
// 기본(변수 없음)은 아무것도 쓰지 않는다. 테스트의 통과·실패 판정이나 대기 시간은 바꾸지 않는다 (재시도·대기 늘리기 장치가 아니다).
// 기록은 best-effort다: 폴더가 없으면 만들고, 그래도 쓸 수 없으면(경로가 파일, 권한, 지워짐) 조용히 건너뛴다.
// 진단 장애가 테스트 결과·원래 오류·서버 동작을 바꾸지 않게 한다. 앱 stderr에는 경로가 들어갈 수 있다. 저장소 밖 폴더를 쓴다.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 진단 기록 폴더 (호출할 때마다 환경 변수를 읽는다). 없으면 null */
export function diagDir(): string | null {
  return process.env['E2E_DIAG_DIR'] || null;
}

/** 한 줄을 남긴다. 쓰지 못해도 던지지 않는다. 썼으면 true */
export function diag(file: string, line: string): boolean {
  const dir = diagDir();
  if (!dir) return false;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, file), `${new Date().toISOString()} ${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 실패 순간의 상태를 남긴다 (best-effort). describe가 실패해도 던지지 않으므로, 부른 쪽은 원래 오류를 그대로 다시 던질 수 있다 */
export async function diagFailure(file: string, describe: () => Promise<string>): Promise<void> {
  if (!diagDir()) return;
  let line: string;
  try {
    line = await describe();
  } catch (e) {
    line = `(상태를 읽지 못함: ${e instanceof Error ? e.message : String(e)})`;
  }
  diag(file, line);
}

/** diagProbe의 결과: null = 진단 꺼짐(읽지 않음), value = 읽음, unavailable = 읽다가 실패(원래 테스트의 판정에는 영향 없음) */
export type Probe<T> = { value: T } | { unavailable: string } | null;

/**
 * 테스트 흐름 중간에서 상태를 읽는다. E2E_DIAG_DIR가 없으면 read를 부르지 않고 null을 돌려준다.
 * 단 async 함수라 꺼져 있어도 Promise를 돌려주므로 `await diagProbe(...)`는 microtask 양보를 만든다.
 * 그래서 테스트 흐름 중간의 호출은 `diagDir() ? await diagProbe(...) : null`로 감싸, 꺼져 있으면 await 자체를 평가하지 않게 한다.
 * 켜져 있으면 읽는다: 이 읽기는 입력·저장 사이에 browser 왕복을 더하므로 스케줄링에 영향을 줄 수 있다 (진단을 켠 실행은 끈 실행과 완전히 같다고 볼 수 없다).
 * 읽기가 실패해도 던지지 않고 unavailable로 남겨 원래 action·assert의 결과를 가리지 않는다.
 */
export async function diagProbe<T>(read: () => Promise<T>): Promise<Probe<T>> {
  if (!diagDir()) return null;
  try {
    return { value: await read() };
  } catch (e) {
    return { unavailable: e instanceof Error ? e.message : String(e) };
  }
}

/** fail.log에 쓸 문자열. 꺼져 있어 읽지 않은 것과 읽지 못한 것을 구분한다 */
export function describeProbe<T>(probe: Probe<T>): string {
  if (probe === null) return 'off';
  return 'value' in probe ? JSON.stringify(probe.value) : `unavailable(${probe.unavailable})`;
}
