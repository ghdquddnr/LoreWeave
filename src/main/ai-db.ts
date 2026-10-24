// AI 분석 결과 저장소 (M3-PLAN 3절). 다시 만들려면 비용이 드는 정보라 검색 색인과 규칙이 다르다.
//   - 번호 붙은 마이그레이션으로 형식을 바꾼다. 결과를 지우지 않는다
//   - WAL + synchronous = FULL
//   - 깨진 파일은 지우지 않고 ai.db.broken-<시각>으로 옮긴 뒤 새로 만든다
//   - 이 앱보다 새 버전이 만든 파일이면 열지 않는다 (덮어쓰지 않도록)
// `node:sqlite`를 쓰는 곳은 이 모듈과 index-db.ts 둘뿐이다.

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Usage } from '../core/ai/cost.ts';
import type { Entity } from '../core/ai/extraction.ts';
import type { LocatedFact } from '../core/ai/locate.ts';
import { INDEX_DIR } from './index-db.ts';

const AI_FILE = 'ai.db';

/** 순서대로 한 번씩 적용한다. 이미 배포된 항목은 고치지 말고 새 항목을 더한다 */
const MIGRATIONS: string[] = [
  // 1: 분석 결과와 호출 기록
  `
  CREATE TABLE analyses (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    summary TEXT NOT NULL,
    dropped_quotes INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE entities (
    analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL
  );
  CREATE TABLE facts (
    analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    entity TEXT NOT NULL,
    predicate TEXT NOT NULL,
    value TEXT NOT NULL,
    quote TEXT NOT NULL,
    line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_col INTEGER NOT NULL
  );
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    file TEXT,
    model TEXT NOT NULL,
    ok INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL
  );
  `,
];

export interface StoredAnalysis {
  file: string;
  contentHash: string;
  model: string;
  modelVersion: string;
  promptVersion: string;
  summary: string;
  droppedQuotes: number;
  costUsd: number;
  createdAt: string;
  entities: Entity[];
  facts: LocatedFact[];
}

export class AiStore {
  private constructor(
    private readonly db: DatabaseSync,
    /** 깨진 파일을 옮겼으면 옮긴 경로 (사용자에게 알린다) */
    readonly recoveredFrom: string | null,
  ) {}

  static open(root: string, now = () => new Date()): AiStore {
    const dir = join(root, INDEX_DIR);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, AI_FILE);
    try {
      return new AiStore(AiStore.migrate(new DatabaseSync(path)), null);
    } catch (e) {
      if (e instanceof NewerFormatError) throw e;
      // 깨진 파일: 지우지 않고 옮겨 둔다
      const broken = `${path}.broken-${now().toISOString().replace(/[:.]/g, '-')}`;
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) renameSync(path + suffix, broken + suffix);
      return new AiStore(AiStore.migrate(new DatabaseSync(path)), broken);
    }
  }

  private static migrate(db: DatabaseSync): DatabaseSync {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version > MIGRATIONS.length) throw new NewerFormatError(version);
      for (let v = version; v < MIGRATIONS.length; v++) {
        db.exec('BEGIN');
        try {
          db.exec(MIGRATIONS[v]!);
          db.exec(`PRAGMA user_version = ${v + 1}`);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      db.prepare('SELECT count(*) FROM analyses').get(); // 깨진 파일이면 여기서 실패한다
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  /** 화의 이전 분석을 바꾼다 (이력은 두지 않는다) */
  saveAnalysis(a: StoredAnalysis): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM analyses WHERE file = ?').run(a.file);
      const { lastInsertRowid: id } = this.db
        .prepare(
          `INSERT INTO analyses (file, content_hash, model, model_version, prompt_version, summary, dropped_quotes, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(a.file, a.contentHash, a.model, a.modelVersion, a.promptVersion, a.summary, a.droppedQuotes, a.costUsd, a.createdAt);
      const entity = this.db.prepare('INSERT INTO entities (analysis_id, ord, name, aliases) VALUES (?, ?, ?, ?)');
      a.entities.forEach((e, i) => entity.run(id, i, e.name, JSON.stringify(e.aliases)));
      const fact = this.db.prepare(
        'INSERT INTO facts (analysis_id, ord, entity, predicate, value, quote, line, start_col, end_col) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      a.facts.forEach((f, i) => fact.run(id, i, f.entity, f.predicate, f.value, f.quote, f.line, f.start, f.end));
    });
  }

  /** 화마다 마지막 분석 때의 본문 해시 */
  analyzedHashes(): Map<string, string> {
    const rows = this.db.prepare('SELECT file, content_hash FROM analyses').all();
    return new Map(rows.map((r) => [String(r['file']), String(r['content_hash'])]));
  }

  analysis(file: string): StoredAnalysis | null {
    const row = this.db.prepare('SELECT * FROM analyses WHERE file = ?').get(file);
    if (!row) return null;
    const id = row['id'];
    return {
      file,
      contentHash: String(row['content_hash']),
      model: String(row['model']),
      modelVersion: String(row['model_version']),
      promptVersion: String(row['prompt_version']),
      summary: String(row['summary']),
      droppedQuotes: Number(row['dropped_quotes']),
      costUsd: Number(row['cost_usd']),
      createdAt: String(row['created_at']),
      entities: this.db
        .prepare('SELECT name, aliases FROM entities WHERE analysis_id = ? ORDER BY ord')
        .all(id)
        .map((e) => ({ name: String(e['name']), aliases: JSON.parse(String(e['aliases'])) as string[] })),
      facts: this.db
        .prepare('SELECT entity, predicate, value, quote, line, start_col, end_col FROM facts WHERE analysis_id = ? ORDER BY ord')
        .all(id)
        .map((f) => ({
          entity: String(f['entity']),
          predicate: String(f['predicate']),
          value: String(f['value']),
          quote: String(f['quote']),
          line: Number(f['line']),
          start: Number(f['start_col']),
          end: Number(f['end_col']),
        })),
    };
  }

  /** 호출마다 남긴다. 실패한 호출도 사용량이 있으면 비용이 든 것이다 */
  logCall(call: { at: string; file: string | null; model: string; ok: boolean; usage: Usage; costUsd: number }): void {
    const u = call.usage;
    this.db
      .prepare(
        `INSERT INTO calls (at, file, model, ok, input_tokens, cached_tokens, cache_write_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(call.at, call.file, call.model, call.ok ? 1 : 0, u.inputTokens, u.cachedTokens, u.cacheWriteTokens, u.outputTokens, call.costUsd);
  }

  /** 이 프로젝트에서 지금까지 쓴 비용 (USD) */
  totalCost(): number {
    const { total } = this.db.prepare('SELECT coalesce(sum(cost_usd), 0) AS total FROM calls').get() as { total: number };
    return total;
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

export class NewerFormatError extends Error {
  constructor(version: number) {
    super(`더 새 버전의 LoreWeave가 만든 분석 파일입니다 (형식 ${version}). 앱을 업데이트하세요.`);
  }
}
