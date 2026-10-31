// 원고 색인 저장소 (M2-PLAN 3절). `node:sqlite`를 쓰는 곳은 이 모듈 하나뿐이다.
// 원고에서 다시 만들 수 있는 정보만 담는다. 형식 버전이 다르거나 파일이 깨졌으면 지우고 새로 만든다.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chapterNumber } from '../core/project/chapters.ts';

/** 색인 형식 버전. 표나 담는 글자의 규칙이 바뀌면 올린다 (기존 색인은 지우고 다시 만든다) */
const SCHEMA_VERSION = 1;
export const INDEX_DIR = '.loreweave';
const INDEX_FILE = 'index.db';

const SCHEMA = `
  CREATE TABLE chapters (
    file TEXT PRIMARY KEY,
    num INTEGER,
    title TEXT NOT NULL,
    id TEXT,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL
  );
  CREATE TABLE lines (
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    text TEXT NOT NULL,
    norm TEXT NOT NULL,
    PRIMARY KEY (file, line)
  ) WITHOUT ROWID;
`;

export interface IndexedChapter {
  file: string;
  title: string;
  id: string | null;
  mtimeMs: number;
  size: number;
}

export interface LineHit {
  file: string;
  title: string;
  line: number;
  text: string;
  /** 검색 당시 앞·뒤 줄의 글 (null은 화의 처음·끝). 결과로 이동할 때 본문이 바뀌었어도 같은 발생을 식별하는 데 쓴다 */
  prev: string | null;
  next: string | null;
}

export class ManuscriptIndex {
  private constructor(private readonly db: DatabaseSync) {
    // 색인은 다시 만들 수 있다. 커밋마다 디스크 동기화(fsync)를 기다리지 않도록 WAL + NORMAL로 둔다.
    // 갑자기 꺼져도 WAL은 파일을 깨뜨리지 않고 마지막 커밋 일부만 잃는다 (다음 동기화가 다시 맞춘다)
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  /** `<root>/.loreweave/index.db`를 연다. 버전이 다르거나 열 수 없으면 새로 만든다 */
  static open(root: string): ManuscriptIndex {
    const dir = join(root, INDEX_DIR);
    mkdirSync(dir, { recursive: true });
    // 색인은 다시 만들 수 있으므로 버전 관리에서 뺀다
    writeFileSync(join(dir, '.gitignore'), `${INDEX_FILE}*\n`);
    const path = join(dir, INDEX_FILE);
    let existing: DatabaseSync | null = null;
    try {
      existing = new DatabaseSync(path);
      const { user_version } = existing.prepare('PRAGMA user_version').get() as { user_version: number };
      if (user_version === SCHEMA_VERSION) {
        existing.prepare('SELECT count(*) FROM lines').get(); // 깨진 파일이면 여기서 실패한다
        return new ManuscriptIndex(existing);
      }
    } catch {
      // 깨졌거나 다른 형식이다. 아래에서 새로 만든다
    }
    // 열린 채로 지우면 Windows가 파일을 잠가 실패하므로 먼저 닫는다
    try {
      existing?.close();
    } catch {
      // 이미 닫혔거나 열리지 않았다
    }
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return new ManuscriptIndex(db);
  }

  close(): void {
    this.db.close();
  }

  chapters(): Map<string, IndexedChapter> {
    const rows = this.db.prepare('SELECT file, title, id, mtime_ms AS mtimeMs, size FROM chapters').all();
    return new Map(rows.map((r) => [String(r['file']), r as unknown as IndexedChapter]));
  }

  /** 화 하나의 줄들을 통째로 바꾼다 */
  replaceChapter(chapter: IndexedChapter, lines: { text: string; norm: string }[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM lines WHERE file = ?').run(chapter.file);
      this.db
        .prepare('INSERT OR REPLACE INTO chapters (file, num, title, id, mtime_ms, size) VALUES (?, ?, ?, ?, ?, ?)')
        .run(chapter.file, chapterNumber(chapter.file), chapter.title, chapter.id, chapter.mtimeMs, chapter.size);
      const insert = this.db.prepare('INSERT INTO lines (file, line, text, norm) VALUES (?, ?, ?, ?)');
      lines.forEach((l, i) => insert.run(chapter.file, i, l.text, l.norm));
    });
  }

  removeChapter(file: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM lines WHERE file = ?').run(file);
      this.db.prepare('DELETE FROM chapters WHERE file = ?').run(file);
    });
  }

  /** norm(정규화한 글자)에 needle이 들어 있는 줄. 화 순서(번호 → 이름), 줄 순서로 limit개까지 */
  search(needle: string, limit: number): { total: number; hits: LineHit[] } {
    const { total } = this.db.prepare('SELECT count(*) AS total FROM lines WHERE instr(norm, ?) > 0').get(needle) as {
      total: number;
    };
    const hits = this.db
      .prepare(
        `SELECT l.file, c.title, l.line, l.text,
                (SELECT p.text FROM lines p WHERE p.file = l.file AND p.line = l.line - 1) AS prev,
                (SELECT n.text FROM lines n WHERE n.file = l.file AND n.line = l.line + 1) AS next
         FROM lines l JOIN chapters c ON c.file = l.file
         WHERE instr(l.norm, ?) > 0
         ORDER BY c.num IS NULL, c.num, l.file, l.line
         LIMIT ?`,
      )
      .all(needle, limit) as unknown as LineHit[];
    return { total, hits };
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
