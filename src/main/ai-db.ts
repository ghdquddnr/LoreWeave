// AI 분석·검사 결과 저장소 (M3-PLAN 3절, M4-PLAN 3절). 다시 만들려면 비용이 드는 정보라 검색 색인과 규칙이 다르다.
//   - 번호 붙은 마이그레이션으로 형식을 바꾼다. 결과를 지우지 않는다
//   - WAL + synchronous = FULL
//   - 깨진 파일은 지우지 않고 ai.db.broken-<시각>으로 옮긴 뒤 새로 만든다
//   - 이 앱보다 새 버전이 만든 파일이면 열지 않는다 (덮어쓰지 않도록)
// `node:sqlite`를 쓰는 곳은 이 모듈과 index-db.ts 둘뿐이다.

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Usage } from '../core/ai/cost.ts';
import type { Category } from '../core/ai/detection.ts';
import type { Entity } from '../core/ai/extraction.ts';
import type { LocatedFact } from '../core/ai/locate.ts';
import type { LocatedFinding } from '../core/ai/verify.ts';
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
  // 2: 호출에 걸린 시간 (at은 호출이 끝난 시각). 이전 기록은 NULL
  `ALTER TABLE calls ADD COLUMN latency_ms INTEGER;`,
  // 3: 연속성 검사 (M4). calls.kind는 'extract' | 'check', 이전 기록은 NULL(추출)
  `
  ALTER TABLE calls ADD COLUMN kind TEXT;
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    file TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    model_version TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    fact_count INTEGER NOT NULL,
    dropped INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE check_inputs (
    check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    content_hash TEXT NOT NULL
  );
  CREATE TABLE findings (
    check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    category TEXT NOT NULL,
    claim TEXT NOT NULL,
    confidence REAL NOT NULL,
    target_quote TEXT NOT NULL,
    target_key TEXT NOT NULL,
    line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_col INTEGER NOT NULL
  );
  CREATE TABLE finding_evidence (
    check_id INTEGER NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    finding_ord INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    file TEXT NOT NULL,
    chapter INTEGER NOT NULL,
    quote TEXT NOT NULL,
    line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_col INTEGER NOT NULL
  );
  CREATE TABLE dismissals (
    file TEXT NOT NULL,
    category TEXT NOT NULL,
    target_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (file, category, target_key)
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

/** 저장할 검사 결과. key는 무시 목록과 맞춰 볼 이 화 문장의 정규화한 글자 */
export interface NewCheck {
  file: string;
  contentHash: string;
  model: string;
  modelVersion: string;
  promptVersion: string;
  factCount: number;
  dropped: number;
  costUsd: number;
  createdAt: string;
  inputs: { file: string; contentHash: string }[];
  findings: (LocatedFinding & { key: string })[];
}

export interface StoredFinding extends LocatedFinding {
  ord: number;
  key: string;
  dismissed: boolean;
}

export interface StoredCheck extends Omit<NewCheck, 'findings'> {
  findings: StoredFinding[];
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
  logCall(call: {
    at: string;
    file: string | null;
    model: string;
    ok: boolean;
    usage: Usage;
    costUsd: number;
    latencyMs: number;
    kind?: 'extract' | 'check';
  }): void {
    const u = call.usage;
    this.db
      .prepare(
        `INSERT INTO calls (at, file, model, ok, input_tokens, cached_tokens, cache_write_tokens, output_tokens, cost_usd, latency_ms, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.at,
        call.file,
        call.model,
        call.ok ? 1 : 0,
        u.inputTokens,
        u.cachedTokens,
        u.cacheWriteTokens,
        u.outputTokens,
        call.costUsd,
        call.latencyMs,
        call.kind ?? 'extract',
      );
  }

  /** 화의 이전 검사를 바꾼다 (이력은 두지 않는다). 무시 목록은 그대로 둔다 */
  saveCheck(c: NewCheck): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM checks WHERE file = ?').run(c.file);
      const { lastInsertRowid: id } = this.db
        .prepare(
          `INSERT INTO checks (file, content_hash, model, model_version, prompt_version, fact_count, dropped, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(c.file, c.contentHash, c.model, c.modelVersion, c.promptVersion, c.factCount, c.dropped, c.costUsd, c.createdAt);
      const input = this.db.prepare('INSERT INTO check_inputs (check_id, file, content_hash) VALUES (?, ?, ?)');
      for (const i of c.inputs) input.run(id, i.file, i.contentHash);
      const finding = this.db.prepare(
        `INSERT INTO findings (check_id, ord, category, claim, confidence, target_quote, target_key, line, start_col, end_col)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const evidence = this.db.prepare(
        `INSERT INTO finding_evidence (check_id, finding_ord, ord, file, chapter, quote, line, start_col, end_col)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      c.findings.forEach((f, i) => {
        finding.run(id, i, f.category, f.claim, f.confidence, f.target.quote, f.key, f.target.line, f.target.start, f.target.end);
        f.evidence.forEach((e, j) => evidence.run(id, i, j, e.file, e.chapter, e.quote, e.line, e.start, e.end));
      });
    });
  }

  check(file: string): StoredCheck | null {
    const row = this.db.prepare('SELECT * FROM checks WHERE file = ?').get(file);
    if (!row) return null;
    const id = row['id'];
    const evidence = this.db
      .prepare('SELECT * FROM finding_evidence WHERE check_id = ? ORDER BY finding_ord, ord')
      .all(id)
      .map((e) => ({
        findingOrd: Number(e['finding_ord']),
        file: String(e['file']),
        chapter: Number(e['chapter']),
        quote: String(e['quote']),
        line: Number(e['line']),
        start: Number(e['start_col']),
        end: Number(e['end_col']),
      }));
    const dismissed = this.db.prepare('SELECT 1 FROM dismissals WHERE file = ? AND category = ? AND target_key = ?');
    return {
      file,
      contentHash: String(row['content_hash']),
      model: String(row['model']),
      modelVersion: String(row['model_version']),
      promptVersion: String(row['prompt_version']),
      factCount: Number(row['fact_count']),
      dropped: Number(row['dropped']),
      costUsd: Number(row['cost_usd']),
      createdAt: String(row['created_at']),
      inputs: this.db
        .prepare('SELECT file, content_hash FROM check_inputs WHERE check_id = ? ORDER BY file')
        .all(id)
        .map((i) => ({ file: String(i['file']), contentHash: String(i['content_hash']) })),
      findings: this.db
        .prepare('SELECT * FROM findings WHERE check_id = ? ORDER BY ord')
        .all(id)
        .map((f) => {
          const ord = Number(f['ord']);
          const category = String(f['category']) as Category;
          const key = String(f['target_key']);
          return {
            ord,
            category,
            claim: String(f['claim']),
            confidence: Number(f['confidence']),
            key,
            dismissed: dismissed.get(file, category, key) !== undefined,
            target: { quote: String(f['target_quote']), line: Number(f['line']), start: Number(f['start_col']), end: Number(f['end_col']) },
            evidence: evidence.filter((e) => e.findingOrd === ord).map(({ findingOrd: _, ...e }) => e),
          };
        }),
    };
  }

  /** 화마다 마지막 검사 때의 본문 해시와 근거로 넘긴 앞 화의 해시 */
  checkedHashes(): Map<string, { contentHash: string; inputs: { file: string; contentHash: string }[] }> {
    const out = new Map<string, { contentHash: string; inputs: { file: string; contentHash: string }[] }>();
    const ids = new Map<number, string>();
    for (const r of this.db.prepare('SELECT id, file, content_hash FROM checks').all()) {
      out.set(String(r['file']), { contentHash: String(r['content_hash']), inputs: [] });
      ids.set(Number(r['id']), String(r['file']));
    }
    for (const r of this.db.prepare('SELECT check_id, file, content_hash FROM check_inputs').all()) {
      out.get(ids.get(Number(r['check_id']))!)?.inputs.push({ file: String(r['file']), contentHash: String(r['content_hash']) });
    }
    return out;
  }

  /** 같은 화, 같은 종류, 같은 문장의 결과를 앞으로 숨긴다 */
  dismiss(file: string, category: Category, targetKey: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO dismissals (file, category, target_key, created_at) VALUES (?, ?, ?, ?)').run(file, category, targetKey, at);
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
