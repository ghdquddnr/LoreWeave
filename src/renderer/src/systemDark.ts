// OS 낮·밤 값 저장소. main.tsx가 bootstrap을 요청하기 **전에** 만들어 변경 알림을 바로 구독한다:
// bootstrap 응답이 늦게 오는 동안 도착한 알림이 (React 마운트 전이라) 소실되지 않게 하고,
// 알림과 bootstrap 값 중 main이 붙인 차례(seq)가 큰 것을 최신으로 쓴다.

import type { LoreweaveApi } from '../../preload/api.ts';

export interface SystemDarkStore {
  get(): boolean;
  /** bootstrap 응답의 값. 이미 더 새로운 알림을 받았으면 무시한다 */
  seed(systemDark: boolean, seq: number): void;
  subscribe(listener: () => void): () => void;
  /** 구독을 거둔다 (창이 닫힐 때) */
  dispose(): void;
}

export function createSystemDarkStore(api: LoreweaveApi['appearance']): SystemDarkStore {
  let value = false;
  let seq = -1;
  const listeners = new Set<() => void>();
  const off = api.onSystemDarkChange((change) => {
    if (change.seq < seq) return;
    seq = change.seq;
    if (change.systemDark === value) return;
    value = change.systemDark;
    for (const l of [...listeners]) l();
  });
  return {
    get: () => value,
    seed(systemDark, nextSeq) {
      if (nextSeq < seq) return; // 응답보다 새로운 알림이 먼저 도착했다
      seq = nextSeq;
      value = systemDark;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    dispose() {
      off();
      listeners.clear();
    },
  };
}
