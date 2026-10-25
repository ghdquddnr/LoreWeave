// .txt 장편을 화 파일로 나누기 (M6-PLAN 2절). 순수 함수만 둔다 (파일 읽기·쓰기는 scripts/import-txt.ts).
//   - UTF-8이 아니면 CP949(EUC-KR)로 읽는다 (Node 내장 TextDecoder)
//   - 원고 형식(C3)에서 제목·인용·구분선·강조로 읽힐 기호는 비슷한 전각 기호로 바꾼다 (글자가 보이는 줄에서 빠지지 않게)
//   - 권 경계에서는 항상 끊고, 권 안에서는 약 target자(공백 제외)마다 빈 줄 → 장면 구분 줄 → 문단 끝 순서로 끊는다

/** UTF-8로 읽을 수 있으면 UTF-8, 아니면 CP949 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'cp949' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'cp949' };
  }
}

/** 줄로 나눈다. CRLF, CR, LF, NEL(U+0085), 줄 구분자(U+2028)를 모두 줄바꿈으로 본다. 줄 끝 공백은 뺀다 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).map((l) => l.replace(/\s+$/, ''));
}

/** C3에서 원고 글자가 아닌 서식으로 읽힐 기호를 전각 기호로 바꾼다. 글자 수는 그대로다 */
export function sanitizeLine(line: string): string {
  let out = line.replace(/\*/g, '＊');
  if (/^-{3,}$/.test(out.trim())) out = out.replace(/-/g, '－');
  return out.replace(/^(\s*)#/, '$1＃').replace(/^(\s*)>/, '$1＞');
}

/** 공백을 뺀 글자 수 */
export const visibleChars = (s: string) => s.replace(/\s/g, '').length;

/** 장면 구분 줄: 글자 없이 기호만 3개 이상 (*** ---- ==== ◆◆◆ 등) */
export const isSceneBreak = (line: string) => /^[\s\p{P}\p{S}＊－]{3,}$/u.test(line) && visibleChars(line) >= 3;

export interface SplitOptions {
  /** 한 화의 목표 글자 수 (공백 제외) */
  target: number;
}

/**
 * 권(줄 배열)들을 화(줄 배열)들로 나눈다.
 * 목표의 80%를 넘으면 빈 줄이나 장면 구분 줄에서 끊고, 130%를 넘으면 문단 끝에서 끊는다.
 */
export function splitChapters(volumes: string[][], { target }: SplitOptions): string[][] {
  const chapters: string[][] = [];
  for (const volume of volumes) {
    let current: string[] = [];
    let count = 0;
    const cut = () => {
      while (current.length && !current[current.length - 1]!.trim()) current.pop();
      while (current.length && !current[0]!.trim()) current.shift();
      if (current.some((l) => l.trim())) chapters.push(current);
      current = [];
      count = 0;
    };
    for (const line of volume) {
      current.push(line);
      count += visibleChars(line);
      const atBoundary = !line.trim() || isSceneBreak(line);
      if ((count >= target * 0.8 && atBoundary) || count >= target * 1.3) cut();
    }
    cut();
  }
  return chapters;
}

/** 화 파일: 제목 줄, 빈 줄, 원문 줄 (빈 줄이 셋 이상 이어지면 하나로) */
export function chapterText(n: number, lines: string[]): string {
  return `# ${n}화\n\n${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** 파일 이름 순서: 숫자는 숫자로 비교한다 ("2권" < "10권") */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'ko', { numeric: true });

/** 측정할 화 고르기 (M6-PLAN 2절): 2화부터 마지막 화까지 고르게 count개 */
export function sampleChapters(files: string[], count: number): string[] {
  const rest = files.slice(1);
  if (rest.length <= count) return rest;
  const picked = new Set<number>();
  for (let i = 0; i < count; i++) picked.add(Math.round((i * (rest.length - 1)) / (count - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => rest[i]!);
}
