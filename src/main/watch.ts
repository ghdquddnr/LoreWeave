// `chapters/` 폴더 감시 (M1-PLAN 4절). 알림을 빨리 주는 보조 수단이다.
// Windows의 fs.watch는 이벤트가 중복·누락될 수 있어, 덮어쓰기 방지는 쓰기 직전 해시 비교가 맡는다.

import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { CHAPTERS_DIR, isChapterFileName } from '../core/project/chapters.ts';

const DEBOUNCE_MS = 150;

/**
 * 화 파일이 바뀔 때마다(같은 파일의 연속 이벤트는 묶어서) onChange를 부른다. 반환값으로 감시를 멈춘다.
 * 실행 중에 감시가 오류로 닫히면 onError를 부른다 (이후의 바깥 변경은 알려지지 않는다). chapters 폴더가 아직 없어 감시를 만들지 못한 것은 오류가 아니다.
 */
export function watchChapters(root: string, onChange: (file: string) => void, onError?: (error: Error) => void): () => void {
  const timers = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher;
  try {
    watcher = watch(join(root, CHAPTERS_DIR), (_event, name) => {
      const file = name?.toString();
      if (!file || !isChapterFileName(file)) return;
      clearTimeout(timers.get(file));
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          onChange(file);
        }, DEBOUNCE_MS),
      );
    });
  } catch (error) {
    // chapters 폴더가 아직 없다(ENOENT)는 정상 초기 상태다: 새 화를 만들 때 다시 시작한다.
    // 그 밖의 생성 실패(권한·시스템 한도)는 감시 없이 열리는 것이므로 알린다 (이후 바깥 변경을 놓칠 수 있다)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError?.(error as Error);
    return () => {};
  }
  watcher.on('error', (error) => {
    watcher.close();
    onError?.(error);
  });
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
