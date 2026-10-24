# M0-A: AI Feasibility Spike

AI가 웹소설의 연속성 오류를 얼마나 정확하게 찾는지, 어떤 context 전략이 적합한지 검증하는 실험.
**제품 코드가 아니다.** 결과(벤치마크, 평가 기준, 보고서)만 남기고 코드는 버린다.

가설, 전략, 성공/실패 기준: [`docs/M0-PLAN.md`](../../docs/M0-PLAN.md#m0-a-ai-feasibility-spike) (실행 전 고정)

## 진행 상태

- [x] 벤치마크 설계: 설정집, 화별 플롯, 오류·함정 배치표
- [x] 사용자 검수: 설계
- [x] 본문 15화 작성 (화당 공백 포함 약 1,050~1,350자)
- [x] `ground-truth.json` 작성 (모든 인용문 원문 일치 검증)
- [x] 사용자 검수: 본문 + ground truth (blind cold-read 30/30 일치, 라벨 밖 오류 0, 함정 오탐 0 → 2026-10-24 확정)
- [x] 평가 하네스 (`evaluate.ts`, 테스트 12개)
- [x] 전략 구현 (dev 튜닝 생략, 프롬프트 동결: REPORT.md 참고)
- [x] 실행: 6개 전략 × 2개 모델 × 3회 (`results/summary.md`)
- [x] [`REPORT.md`](REPORT.md)

## 벤치마크 (`benchmark/`)

| 파일 | 평가 입력 | 내용 |
|---|---|---|
| `world-bible.md` | ❌ | canon 설정집 |
| `plot.md` | ❌ | 화별 플롯과 오류/함정 위치 |
| `error-plan.md` | ❌ | 오류 30개, 함정 10개, 분할, echo 규칙 |
| `chapters/ch01.md` … `ch15.md` | ✅ | 본문 (모델이 보는 유일한 입력) |
| `ground-truth.json` | ❌ | 정확한 원문 구간이 포함된 정답 |
