// 사용자에게 보이는 오류 문구. Electron IPC가 붙이는 "Error invoking remote method '…': Error: …", 파일 시스템 코드(EPERM·EISDIR 등), 절대 경로는
// 기본 안내에 쓰지 않고, 필요할 때만 펼치는 "기술 상세"로 분리한다. 문구는 사실만 말한다 (저장됨·손실 불가를 보장하지 않는다).

export interface FriendlyError {
  /** 기본 안내 (한 줄, 경로·코드·IPC 문구 없음) */
  summary: string;
  /** 기술 상세 원문. 기본 안내만으로 충분하면 빈 문자열 */
  detail: string;
}

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;
/** 절대 경로 (Windows 드라이브·UNC·유닉스 루트) */
const PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private)\/)[^\s'"`]*/g;
const TECHNICAL = /(?:Error invoking|\b(?:E[A-Z]{3,}|HPE_[A-Z_]+)\b|[A-Za-z]:[\\/]|\\\\|operation not permitted|illegal operation|no such file)/;

const KNOWN: [RegExp, string][] = [
  [/EPERM|EACCES|operation not permitted|permission denied/i, '파일에 쓸 수 없습니다. 읽기 전용이거나 다른 프로그램이 파일을 쓰고 있을 수 있습니다'],
  [/EBUSY|resource busy/i, '다른 프로그램이 파일을 사용 중입니다'],
  [/ENOSPC/i, '저장 공간이 부족합니다'],
  [/EROFS/i, '읽기 전용 위치라 쓸 수 없습니다'],
  [/EISDIR|ENOTDIR|ENOENT|illegal operation on a directory|no such file/i, '파일이나 폴더 위치를 사용할 수 없습니다'],
  [/EMFILE|ENFILE/i, '열려 있는 파일이 너무 많습니다'],
];

export function friendlyError(error: unknown, fallback = '예상하지 못한 오류가 발생했습니다'): FriendlyError {
  const raw = (error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '')).trim();
  const cleaned = raw.replace(IPC_PREFIX, '').trim();
  if (!TECHNICAL.test(raw)) return { summary: cleaned || fallback, detail: '' };
  const known = KNOWN.find(([re]) => re.test(raw));
  // 기술 문구가 섞인 메시지에서 사람이 읽을 부분(경로·코드를 뺀 문장)이 남으면 그것을 쓴다
  const readable = cleaned.replace(PATH, '').replace(/\b(?:E[A-Z]{3,}|HPE_[A-Z_]+)\b:?/g, '').replace(/\s{2,}/g, ' ').trim();
  const summary = known ? known[1] : /[가-힣]/.test(readable) && !TECHNICAL.test(readable) ? readable : fallback;
  return { summary, detail: raw };
}
