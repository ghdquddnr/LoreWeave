// 프로젝트 안의 화(챕터) 파일 규칙 (M1-PLAN 4절, DECISIONS "M1 범위").
// 화 순서는 파일 이름 앞의 번호다. frontmatter는 원문을 보존하고 최상위 `key: value`만 읽는다.

import { joinEnvelope, splitEnvelope } from '../manuscript/envelope.ts';

export const CHAPTERS_DIR = 'chapters';

const CHAPTER_FILE = /^[^\\/:*?"<>|]+\.md$/;
const LEADING_NUMBER = /^(\d+)/;

/** 화 파일로 다룰 수 있는 이름인가 (경로 구분자나 Windows 금지 문자가 없는 `.md`) */
export function isChapterFileName(name: string): boolean {
  return CHAPTER_FILE.test(name) && name !== '.md';
}

export function chapterNumber(file: string): number | null {
  const m = LEADING_NUMBER.exec(file);
  return m ? Number(m[1]) : null;
}

/** 번호가 있는 파일은 번호 순 (`9.md` < `010.md`), 번호가 없는 파일은 그 뒤에 이름 순 */
export function sortChapterFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const na = chapterNumber(a);
    const nb = chapterNumber(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na === null && nb !== null) return 1;
    if (na !== null && nb === null) return -1;
    return a.localeCompare(b, 'ko');
  });
}

/** 가장 큰 번호 + 1, 3자리 0 채움 (1000화부터는 4자리) */
export function nextChapterFile(files: string[]): string {
  const max = Math.max(0, ...files.map((f) => chapterNumber(f) ?? 0));
  return `${String(max + 1).padStart(3, '0')}.md`;
}

/** frontmatter의 최상위 `key: value`만 읽는다. 따옴표로 감싼 값은 따옴표를 뗀다. */
export function readFrontmatterFields(frontmatter: string | null): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of (frontmatter ?? '').split('\n')) {
    const m = /^([^\s#:-][^\s:]*):\s*(.*)$/.exec(line);
    if (!m || m[2] === '') continue;
    fields[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

export interface ChapterInfo {
  title: string;
  id: string | null;
}

/** 표시 이름: frontmatter `title` → 본문의 첫 `# ` 제목 → 파일 이름 */
export function chapterInfo(raw: string, file: string): ChapterInfo {
  const { envelope, body } = splitEnvelope(raw);
  const fields = readFrontmatterFields(envelope.frontmatter);
  const heading = /^#{1,6} (.+)$/m.exec(body)?.[1]?.trim();
  return { title: fields['title'] || heading || file.replace(/\.md$/, ''), id: fields['id'] || null };
}

/**
 * frontmatter의 최상위 필드 하나를 바꾼 파일 내용 (중복 id 재발급용). 본문과 BOM·줄바꿈 방식은 그대로다.
 * 필드가 없으면 닫는 `---` 앞에 넣고, frontmatter가 없으면 맨 앞에 만든다.
 */
export function setFrontmatterField(raw: string, key: string, value: string): string {
  const { envelope, body } = splitEnvelope(raw);
  const line = `${key}: ${value}`;
  let frontmatter: string;
  if (envelope.frontmatter === null) {
    frontmatter = `---\n${line}\n---\n`;
  } else {
    const lines = envelope.frontmatter.split('\n');
    const at = lines.findIndex((l, i) => i > 0 && l.startsWith(`${key}:`));
    if (at !== -1) lines[at] = line;
    else lines.splice(lines.lastIndexOf('---'), 0, line);
    frontmatter = lines.join('\n');
  }
  return joinEnvelope({ ...envelope, frontmatter }, body);
}

/** 새 화 파일 내용: 최소 frontmatter + 빈 본문 (저장하면 마지막 개행이 붙는다) */
export function newChapterText(id: string, title: string): string {
  return `---\nid: ${id}\ntitle: ${title}\n---\n\n`;
}

/** 같은 id를 쓰는 파일 묶음 (파일 복사로 생긴 중복). M1은 경고만 한다 */
export function findDuplicateIds(chapters: { file: string; id: string | null }[]): string[][] {
  const byId = new Map<string, string[]>();
  for (const { file, id } of chapters) if (id) byId.set(id, [...(byId.get(id) ?? []), file]);
  return [...byId.values()].filter((files) => files.length > 1);
}
