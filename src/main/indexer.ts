// 화 파일 → 색인 (M2-PLAN 3절). 폴더를 열 때 바뀐 화만 다시 읽고, 저장·바깥 변경 때 한 화씩 갱신한다.
// 색인이 담는 글자는 에디터와 같은 파서·줄 규칙(core)으로 만든다.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseC3 } from '../core/manuscript/c3.ts';
import { splitEnvelope } from '../core/manuscript/envelope.ts';
import { visibleLines } from '../core/manuscript/lines.ts';
import { CHAPTERS_DIR, chapterInfo } from '../core/project/chapters.ts';
import { findMatches, normalizeForSearch, type MatchRange } from '../core/search.ts';
import type { ManuscriptIndex } from './index-db.ts';
import { chapterFileNames, decodeUtf8 } from './project-files.ts';

export const SEARCH_LIMIT = 500;

export interface SearchHit {
  file: string;
  title: string;
  /** 본문 줄 번호 (0부터) */
  line: number;
  text: string;
  matches: MatchRange[];
}

export interface SearchResult {
  /** 찾은 줄 수 (hits는 앞의 SEARCH_LIMIT개까지) */
  total: number;
  hits: SearchHit[];
}

/** 화 하나를 글자로 색인한다. mtime·size는 디스크 파일의 값 */
export function indexChapterText(index: ManuscriptIndex, file: string, text: string, mtimeMs: number, size: number): void {
  const lines = visibleLines(parseC3(splitEnvelope(text).body)).map((t) => ({ text: t, norm: normalizeForSearch(t) }));
  index.replaceChapter({ file, ...chapterInfo(text, file), mtimeMs, size }, lines);
}

/**
 * 디스크에서 다시 읽어 색인한다. 없어졌거나 UTF-8이 아니면 색인에서 뺀다.
 * isCurrent: 읽는 사이 더 나중 갱신이 시작됐다면 false를 돌려준다 — 그러면 이 (옛) 읽기의 결과는 색인에 쓰지 않는다
 */
export async function reindexChapter(index: ManuscriptIndex, root: string, file: string, isCurrent: () => boolean = () => true): Promise<void> {
  const path = join(root, CHAPTERS_DIR, file);
  try {
    const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
    if (!isCurrent()) return;
    const text = decodeUtf8(bytes);
    if (text === null) index.removeChapter(file);
    else indexChapterText(index, file, text, info.mtimeMs, info.size);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (isCurrent()) index.removeChapter(file);
  }
}

/** 폴더와 색인을 맞춘다: (mtime, size)가 다른 화만 다시 읽고, 사라진 화는 뺀다 */
export async function syncIndex(
  index: ManuscriptIndex,
  root: string,
  /** 화를 다시 읽기 시작할 때 부른다. 돌려주는 isCurrent가 false면 (그 사이 더 나중 색인 작업이 있어) 그 읽기의 결과는 색인에 쓰지 않는다 */
  begin: (file: string) => () => boolean = () => () => true,
): Promise<{ reindexed: number; removed: number }> {
  const indexed = index.chapters();
  const files = await chapterFileNames(root);
  let reindexed = 0;
  for (const file of files) {
    const info = await stat(join(root, CHAPTERS_DIR, file));
    const known = indexed.get(file);
    indexed.delete(file);
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) continue;
    await reindexChapter(index, root, file, begin(file));
    reindexed++;
  }
  // 폴더 목록을 잡은 뒤 다시 만들어졌을 수 있으니 바로 빼지 않고 지금 디스크를 다시 본다: 없으면 reindexChapter가 색인에서 빼고(ENOENT), 새로 있으면 최신 본문을 색인한다.
  // 표(begin)도 받으므로 그 사이 watcher나 저장이 더 최신 본문을 색인했다면 이 정리는 건너뛴다
  for (const file of indexed.keys()) await reindexChapter(index, root, file, begin(file));
  return { reindexed, removed: indexed.size };
}

export function searchIndex(index: ManuscriptIndex, query: string): SearchResult {
  const needle = normalizeForSearch(query);
  if (!needle) return { total: 0, hits: [] };
  const { total, hits } = index.search(needle, SEARCH_LIMIT);
  return { total, hits: hits.map((h) => ({ ...h, matches: findMatches(h.text, query) })) };
}
