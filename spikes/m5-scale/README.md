# M5 긴 시험 원고 (150화)

검사 입력 상한을 재기 위한 시험 원고다 ([M5 계획](../../docs/M5-PLAN.md)). 제품 코드가 이 폴더를 읽지 않는다.

## 구성 (`benchmark/`)

생성 결과: 중간 화 135개, 화당 1,525~2,848자(평균 2,106자), 생성 비용 $0.173 (프롬프트를 고치기 전 버린 샘플 3개 $0.004 별도).

| 파일 | 내용 |
|---|---|
| `chapters.json` | 150화를 하나로 묶은 것 (`{ "001.md": 본문, … }`). 원래 화 k(M0-A)는 `10k − 9`번째(001, 011, …, 141), 나머지 135개는 생성한 중간 화. 파일 150개를 한 PR에 올리면 리뷰 도구가 거부해서 묶었다 |
| `ground-truth.json` | M0-A 정답표(오류 30개, 함정 10개)의 화 번호만 바꾼 것. 중간 화에는 정답이 없다 |
| `generation.jsonl` | 중간 화마다 프롬프트 버전, 모델, 사용량, 비용, 시간, 요약 |

- 원래 화는 본문을 바꾸지 않았다. 첫 줄 "# 3화. MT"의 번호만 새 자리("# 21화. MT")로 바꿨다.
- 중간 화는 `gpt-6-luna`로 만들었다 (프롬프트 `filler-2`, `scripts/lib/long-benchmark.ts`).
  - 입력: 설정집과 화별 플롯(오류 계획 줄과 평가용 안내는 뺌), 이 화의 자리와 날짜, 같은 사이에 먼저 쓴 중간 화 요약
  - 규칙: 설정을 그대로 따르고, 뒤 원작 화의 사건은 쓰지 않고, 설정집에 없는 고정 설정(사는 곳 등)은 새로 정하지 않는다
  - 의도적인 오류는 넣지 않았다. 그래도 생성한 글이라 설정과 다른 내용이 섞였을 수 있다. 측정에서 정답표에 없는 결과가 나오면 근거 화를 보고 따로 센다

## 풀기

```bash
corepack pnpm tsx scripts/unpack-long-benchmark.ts <출력 폴더>   # chapters/NNN.md와 ground-truth.json
```

푼 폴더는 앱에서 원고 폴더로 열 수 있고, 채점기의 벤치마크 폴더로 줄 수 있다.

## 다시 만들기

```bash
corepack pnpm ai-script scripts/gen-long-benchmark.ts --dry-run   # 예상 비용만
corepack pnpm ai-script scripts/gen-long-benchmark.ts --budget 0.6
```

앱 [설정]에 저장한 API 키를 쓴다 (`scripts/lib/stored-key.ts`). 작업 폴더 `benchmark/chapters/`(저장소에 넣지 않음)에 없는 중간 화만 만들고, 150화가 다 되면 `chapters.json`으로 묶는다. 같은 입력이라도 모델 출력은 매번 다르다.

## 채점

```bash
corepack pnpm --dir spikes/m0a-ai-feasibility evaluate <predictions.json이 있는 폴더> <푼 폴더>
```
