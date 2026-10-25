import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundTruth } from './schema.ts';

export const BENCHMARK_DIR = join(import.meta.dirname, '..', 'benchmark');
export const CHAPTER_COUNT = 15;

/**
 * Raw chapter texts, keyed by chapter number (1-based).
 * Reads every `chapters/chNN.md` or `chapters/NNN.md` (M5 long benchmark uses the latter).
 */
export function loadChapters(dir = BENCHMARK_DIR): Map<number, string> {
  const chapters = new Map<number, string>();
  for (const name of readdirSync(join(dir, 'chapters'))) {
    const m = /^(?:ch)?(\d+)\.md$/.exec(name);
    if (m) chapters.set(Number(m[1]), readFileSync(join(dir, 'chapters', name), 'utf8'));
  }
  if (dir === BENCHMARK_DIR && chapters.size !== CHAPTER_COUNT) throw new Error(`expected ${CHAPTER_COUNT} chapters, found ${chapters.size}`);
  return chapters;
}

export function loadGroundTruth(dir = BENCHMARK_DIR): GroundTruth {
  return JSON.parse(readFileSync(join(dir, 'ground-truth.json'), 'utf8')) as GroundTruth;
}
