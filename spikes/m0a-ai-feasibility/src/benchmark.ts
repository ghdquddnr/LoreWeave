import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundTruth } from './schema.ts';

export const BENCHMARK_DIR = join(import.meta.dirname, '..', 'benchmark');
export const CHAPTER_COUNT = 15;

/** Raw chapter texts, keyed by chapter number (1-based). */
export function loadChapters(dir = BENCHMARK_DIR): Map<number, string> {
  const chapters = new Map<number, string>();
  for (let n = 1; n <= CHAPTER_COUNT; n++) {
    const file = join(dir, 'chapters', `ch${String(n).padStart(2, '0')}.md`);
    chapters.set(n, readFileSync(file, 'utf8'));
  }
  return chapters;
}

export function loadGroundTruth(dir = BENCHMARK_DIR): GroundTruth {
  return JSON.parse(readFileSync(join(dir, 'ground-truth.json'), 'utf8')) as GroundTruth;
}
