// 사용자에게 보이는 오류 문구. Electron IPC가 붙이는 "Error invoking remote method '…': Error: …", 파일 시스템 코드(EPERM·EISDIR 등), 절대 경로는
// 기본 안내에 쓰지 않고, 필요할 때만 펼치는 "기술 상세"로 분리한다. 문구는 사실만 말한다 (저장됨·손실 불가를 보장하지 않는다).

export interface FriendlyError {
  /** 기본 안내 (한 줄, 경로·코드·IPC 문구 없음) */
  summary: string;
  /** 기술 상세 원문. 기본 안내만으로 충분하면 빈 문자열 */
  detail: string;
}

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;
/** 기술 문구(코드·경로·영문 시스템 메시지)가 들어 있는가 */
const TECHNICAL = /Error invoking|\b(?:E[A-Z]{3,}|HPE_[A-Z_]+)\b|[A-Za-z]:[\\/]|\\\\|operation not permitted|illegal operation|no such file/;
/** 기술 문구가 시작되는 자리 (그 앞까지가 사람이 쓴 설명) */
const TECH_START = /\b(?:E[A-Z]{3,}|HPE_[A-Z_]+)\b|[A-Za-z]:[\\/]|\\\\|operation not permitted|permission denied|illegal operation|no such file/;

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
  // 사람이 읽는 한국어 문장이고 기술 문구가 없으면 그대로 쓴다. 영문 시스템 메시지(예: ByteString 변환 오류)는 기본 안내에서 빼고 상세로 보낸다
  if (!TECHNICAL.test(raw) && /[가-힣]/.test(cleaned)) return { summary: cleaned, detail: '' };
  // 사람이 쓴 한국어 설명이 앞에 있으면 그것을 기본 안내로 쓴다 (기술 문구가 시작되기 전까지). 없으면 알려진 코드의 안내, 그것도 없으면 일반 안내
  const cut = cleaned.search(TECH_START);
  const lead = (cut === -1 ? cleaned : cleaned.slice(0, cut)).replace(/[\s:：,;(（-]+$/u, '').trim();
  const known = KNOWN.find(([re]) => re.test(raw));
  const summary = /[가-힣]/.test(lead) && lead.length >= 4 ? lead : known ? known[1] : fallback;
  return { summary, detail: raw };
}
