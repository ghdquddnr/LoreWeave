// 쓸 수 있는 모델과 단가 (M3-PLAN 4절, DECISIONS "M3 범위").
// 단가: OpenAI 가격표, Standard 등급, 입력 272K 이하, 1M 토큰당 USD. 2026-10-24 확인 (DECISIONS "M0-A 실행 조건").

export interface ModelInfo {
  id: string;
  label: string;
  /** 1M 토큰당 USD */
  price: { input: number; cachedInput: number; cacheWrite: number; output: number };
}

export const PRICES_CHECKED = '2026-10-24';

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'gpt-6-luna',
    label: 'gpt-6-luna (기본, 저렴)',
    price: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  },
  {
    id: 'gpt-6.1-sol',
    label: 'gpt-6.1-sol (정확, 약 20배 비쌈)',
    price: { input: 2.0, cachedInput: 0.1, cacheWrite: 2.5, output: 10.0 },
  },
];

export const DEFAULT_MODEL = 'gpt-6-luna';

export function modelInfo(id: string): ModelInfo {
  const model = MODELS.find((m) => m.id === id);
  if (!model) throw new Error(`알 수 없는 모델: ${id}`);
  return model;
}
