# LoreWeave

지금부터 `LoreWeave`라는 오픈소스 데스크톱 애플리케이션을 개발하려고 한다.

현재 Git repository는 비어 있는 상태다.

이 프로젝트는 빠르게 완성하는 것이 목적이 아니다. 개인 포트폴리오이자 실제 사용자에게 도움이 될 수 있는 오픈소스 프로젝트로, 시간을 두고 단계적으로 개발할 예정이다.

따라서 처음부터 지나치게 많은 기능을 구현하거나 과도한 아키텍처를 도입하지 말고, 유지보수하기 쉬운 구조로 작은 단위부터 개발한다.

---

# 1. 프로젝트의 출발점

나는 웹소설을 자주 읽는다.

장기 연재 작품을 읽다 보면 다음과 같은 문제가 자주 발생한다.

- 등장인물 이름이 이전 회차와 달라짐
- 인물의 나이, 직업, 외모 등의 설정이 변경됨
- 이미 만난 인물인데 나중에 처음 만나는 것으로 묘사됨
- 죽거나 퇴장한 인물이 잘못 등장함
- 사건 발생 순서나 날짜가 맞지 않음
- 인물 관계 변화가 앞뒤 맥락과 맞지 않음
- 오래전에 만들어 놓은 복선이나 설정을 작가가 잊음
- 금액, 지분율, 직책 등의 숫자/정보가 변경됨
- 장기 연재로 인해 작가 자신도 과거 설정을 기억하기 어려워짐
- 마감에 쫓기면서 오탈자와 문맥 오류가 발생함

LoreWeave는 이러한 문제에서 출발한다.

하지만 AI가 소설을 대신 작성하는 서비스가 목적은 아니다.

핵심 철학은 다음과 같다.

> AI가 글을 대신 쓰는 것이 아니라, 사용자가 자신이 만든 세계와 맥락을 잊지 않도록 돕는다.

즉 LoreWeave는 단순한 AI Writer가 아니라

**Local-first AI-assisted Writing IDE**

를 지향한다.

---

# 2. 핵심 컨셉

VS Code가 소스코드를 단순 텍스트가 아니라

- Class
- Function
- Variable
- Reference
- Dependency

등의 구조로 이해하듯,

LoreWeave는 글을

- Character
- Relationship
- Event
- Timeline
- Location
- Organization
- Item
- Fact
- Story Thread / Foreshadowing

등의 구조로 이해하도록 하는 것이 장기적인 목표다.

예를 들어 사용자가 300화를 작성했을 때 AI가 과거 299화의 설정과 비교하여 다음과 같은 정보를 제공할 수 있어야 한다.

> Possible continuity error
>
> 300화에서 김민수와 이지현이 처음 만나는 것으로 묘사되어 있습니다.
> 하지만 두 인물은 72화에서 이미 만났습니다.
>
> [72화로 이동]

단, 이것은 장기 목표이며 처음부터 전부 구현하지 않는다.

---

# 3. 가장 중요한 설계 원칙

## Local First

사용자의 원고는 기본적으로 사용자의 컴퓨터에 존재한다.

LoreWeave 자체 서버에 원고를 저장하지 않는다.

초기 버전에는 다음 기능이 필요하지 않다.

- 회원가입
- 로그인
- 사용자 계정
- 중앙 서버
- Cloud Database
- 결제
- Subscription
- 자체 AI API 서버

가능하면 서버 없이 동작하는 독립적인 Desktop Application으로 만든다.

---

# 4. 원고의 Source of Truth

매우 중요한 원칙이다.

**원고의 Source of Truth는 SQLite가 아니라 Markdown 파일이다.**

예:

```text
my-novel/
├── project.md
├── chapters/
│   ├── 001.md
│   ├── 002.md
│   ├── 003.md
│   └── ...
├── notes/
├── assets/
└── .loreweave/
    ├── loreweave.db
    └── config.json
```

사용자가 LoreWeave를 더 이상 사용하지 않더라도 원고를 잃어서는 안 된다.

LoreWeave가 사라져도 사용자는 Markdown 파일을

- VS Code
- Obsidian
- 다른 Markdown Editor
- 일반 Text Editor

등에서 열 수 있어야 한다.

프로그램 자체의 proprietary format에 원고를 종속시키지 않는다.

---

# 5. Editor UX

파일은 Markdown으로 저장하지만 사용자가 Markdown 문법을 직접 작성하도록 강요하지 않는다.

일반 사용자는 개발자가 아니다.

따라서 실제 집필 화면은 Word나 일반적인 Rich Text Editor처럼 자연스러워야 한다.

사용자가 Markdown을 몰라도 글을 작성할 수 있어야 한다.

내부적으로 Markdown으로 serialize/deserialize한다.

Editor 기술은 향후 검토하되 다음 계열을 우선 고려할 수 있다.

- TipTap
- ProseMirror

Monaco Editor는 코드 편집에는 훌륭하지만 소설 집필 UX에는 적합하지 않을 가능성이 높다.

VS Code에서 참고하려는 것은 코드 편집 UX 자체보다

- Explorer
- Editor
- Inspector
- Command
- Navigation

같은 IDE의 정보 구조다.

---

# 6. Desktop Application

설치형 Desktop Application을 우선한다.

현재 가장 유력한 후보는 Electron이다.

웹 애플리케이션/SaaS를 우선하지 않는다.

초기에는 별도의 Spring Boot/FastAPI Backend Server를 만들지 않는다.

가능하다면

**Electron + TypeScript**

중심의 단일 애플리케이션으로 시작한다.

필요성이 명확해질 경우에만 별도 Backend Process를 고려한다.

---

# 7. SQLite의 역할

SQLite는 원고 저장소가 아니다.

SQLite는 원고에서 추출되거나 사용자가 관리하는 **구조화된 프로젝트 정보**를 저장한다.

예를 들어 향후 다음과 같은 정보를 관리할 수 있다.

- Characters
- Relationships
- Events
- Timeline
- Locations
- Organizations
- Items
- Facts
- Story Threads
- AI Analysis Result

예를 들어 AI가 원고에서

"김민수는 32세다."

라는 사실을 발견했다면 향후 다음과 같은 형태의 Fact로 관리할 수 있다.

```text
entity      : 김민수
predicate   : age
value       : 32
chapter     : 12
confidence  : 0.97
```

이후 다른 회차에서 충돌하는 정보가 발견되면 기존 Fact와 비교할 수 있다.

SQLite Schema는 실제 요구사항이 생길 때 점진적으로 설계한다.

처음부터 모든 Entity Schema를 만들지 않는다.

---

# 8. Character Relationship Graph

장기적으로 인물 관계를 ERD 또는 Skill Tree와 비슷한 Graph UI로 시각화하고 싶다.

예:

```text
김 회장
   │
 부자
   │
 김민수 ─── 연인 ─── 이지현
   │
  적대
   │
 박성진
```

Node를 클릭하면 해당 인물 정보를 확인할 수 있고,

Relationship을 선택하면 두 인물 관계와 관련된 주요 회차/사건을 확인할 수 있도록 한다.

관계는 단순한 static property가 아니라 시간에 따라 변할 수 있다.

예:

```text
STRANGER
  ↓
FRIEND
  ↓
BUSINESS_PARTNER
  ↓
ENEMY
```

하지만 이것 역시 초기 MVP에서 전부 구현하지 않는다.

---

# 9. Timeline

작품의 사건을 Timeline 형태로 볼 수 있도록 하는 것이 중요한 목표다.

예:

```text
2007
 │
 ├─ 03/02  대학 입학              3화
 ├─ 04/17  이지현 첫 만남        12화
 ├─ 08/21  미래전자 창업         31화
 │
2008
 │
 ├─ 02/11  첫 투자 유치          57화
 ├─ 11/17  박성진 배신          104화
```

Timeline Event를 클릭하면 해당 Chapter 또는 가능하다면 해당 Paragraph로 이동한다.

중요한 개념은

- Chapter/Narrative Order
- Story Chronological Time

을 구분하는 것이다.

300화가 10년 전 회상 장면일 수도 있기 때문이다.

이 차이를 향후 데이터 모델에서 고려한다.

---

# 10. Story Thread / Foreshadowing

장기적으로 복선과 진행 중인 Story Thread를 관리하고 싶다.

예:

```text
아버지가 남긴 USB
17화 → 83화 → ???

이지현의 출생 비밀
31화 → 72화 → 진행 중

박 회장의 비밀 계좌
52화 → 117화 → 회수 완료
```

오랫동안 언급되지 않은 중요한 설정이나 복선을 AI가 발견하여 사용자에게 알려주는 기능도 향후 고려한다.

---

# 11. AI Provider

특정 LLM Vendor에 종속되지 않는다.

사용자가 자신이 원하는 LLM을 선택하도록 한다.

장기적으로 다음 Provider를 고려한다.

- OpenAI
- Anthropic
- Google Gemini
- Ollama
- OpenAI-compatible API

Provider abstraction을 사용한다.

개념적으로 다음과 같은 구조를 생각할 수 있다.

```text
LlmProvider
 ├── OpenAI
 ├── Anthropic
 ├── Gemini
 ├── Ollama
 └── OpenAI Compatible
```

사용자가 자신의 API Key를 입력하는 BYOK(Bring Your Own Key) 방식을 기본으로 생각한다.

Local LLM 사용자는 Ollama 등의 Endpoint를 연결할 수 있도록 한다.

---

# 12. API Key 보안

API Key를 프로젝트 Markdown이나 일반 config 파일에 평문으로 저장하지 않는다.

특히 Git repository에 실수로 API Key가 포함되지 않도록 한다.

가능하면 OS Credential Store를 이용한다.

예:

- Windows Credential Manager
- macOS Keychain
- Linux Secret Service

프로젝트에는 credential reference 정도만 저장하는 방향을 고려한다.

---

# 13. AI는 필수 조건이 아니다

LoreWeave는 AI가 연결되어 있지 않아도 기본 Editor 기능을 사용할 수 있어야 한다.

AI는 보조 기능이다.

AI 연결이 없다고 프로젝트를 생성하거나 글을 작성할 수 없는 구조로 만들지 않는다.

---

# 14. AI 호출 방식

사용자가 글자를 입력할 때마다 LLM API를 호출하지 않는다.

API 비용과 UX를 고려해야 한다.

초기에는 사용자가 명시적으로

"AI Analyze"

같은 기능을 실행했을 때 분석하는 방식이 적절하다.

향후 필요하면

- Manual
- On Save
- After Idle
- Chapter Complete

등의 분석 정책을 제공할 수 있다.

---

# 15. 검색 / RAG

처음부터 Vector Database를 도입하지 않는다.

"AI 프로젝트니까 Vector DB가 필요하다"는 식으로 기술을 선택하지 않는다.

우선 SQLite와 필요하다면 SQLite FTS5를 이용한다.

실제 semantic search가 필요하다는 것이 확인된 이후에 embedding/vector search를 추가한다.

PostgreSQL, pgvector, Neo4j 등의 외부 DB는 초기에는 사용하지 않는다.

---

# 16. UI의 대략적인 방향

전체 UI는 VS Code와 Obsidian에서 일부 영감을 받을 수 있다.

대략 다음과 같은 구조를 생각한다.

```text
┌─────────────┬──────────────────────────────┬──────────────┐
│ Explorer    │ Editor                       │ Inspector    │
│             │                              │              │
│ Manuscript  │ Chapter 127                  │ Character    │
│ Characters  │                              │ Information  │
│ Relations   │                              │              │
│ Timeline    │                              │ Related      │
│ Threads     │                              │ Chapters     │
│ Search      │                              │              │
│ AI          │                              │ AI Issues    │
└─────────────┴──────────────────────────────┴──────────────┘
```

각 기능에 따라 중앙 Workspace가 변경될 수 있다.

예:

- Manuscript → Editor
- Characters → Character Management
- Relations → Graph View
- Timeline → Timeline View
- Threads → Story Thread View

---

# 17. 첫 번째 Target은 웹소설

장기적으로는 다음과 같은 글에도 적용할 가능성이 있다.

- 일반 소설
- 시나리오
- 게임 스토리
- 논문
- 연구 문서
- 장기 기획 문서

하지만 **초기 버전에서는 웹소설/장편소설만 생각한다.**

범용 Writing Platform을 처음부터 만들지 않는다.

다만 향후 확장을 막는 지나치게 강한 coupling은 피한다.

---

# 18. MVP의 핵심 가치

최종적으로 첫 번째 의미 있는 MVP가 증명해야 하는 것은 다음 질문이다.

> "새로운 회차에서 이전 회차의 설정과 충돌하는 내용을 찾아낼 수 있는가?"

예:

```text
302화

민수는 처음 보는 이지현에게 악수를 건넸다.
```

AI 분석 결과:

```text
Possible continuity error

김민수와 이지현은 이전에 만난 기록이 있습니다.

72화:
"민수는 회의실로 들어오는 이지현을 바라보았다."

[72화로 이동]

Confidence: 96%
```

이 기능이 제대로 작동한다면 LoreWeave의 핵심 가치를 증명한 것으로 본다.

---

# 19. Open Source Philosophy

이 프로젝트는 수익화를 우선하지 않는다.

개인 포트폴리오이면서 실제 글을 쓰는 사람에게 조금이라도 도움이 되는 것을 목표로 한다.

기본 철학:

> Your writing belongs to you.

가능하면 다음 원칙을 유지한다.

- No account
- No subscription
- No mandatory cloud
- Local-first
- Markdown-based
- Bring your own AI
- Local AI supported
- Open source
- Vendor neutral

---

# 20. 개발 원칙

이 프로젝트에서 특히 중요하다.

## YAGNI

현재 필요하지 않은 기능을 미래를 예상해서 구현하지 않는다.

## KISS

가능한 단순한 해결책을 우선한다.

## Incremental Development

한 번에 거대한 시스템을 만들지 않는다.

작은 기능 단위로 완성하고 테스트하면서 확장한다.

## Avoid Premature Abstraction

실제 두 개 이상의 구현에서 필요성이 확인되기 전까지 지나친 abstraction을 만들지 않는다.

## Avoid AI Overengineering

Agent, Multi-Agent, Vector DB, Graph DB 등이 멋있어 보인다는 이유만으로 도입하지 않는다.

문제를 해결하는 가장 단순한 기술을 선택한다.

## Human Controlled AI

AI의 판단을 무조건 사실로 취급하지 않는다.

AI 분석은 기본적으로 suggestion 또는 possible issue다.

사용자가 최종 판단한다.

---

# 21. 현재 상태

현재 repository는 비어 있다.

아직 기술 Stack과 상세 Architecture를 최종 확정하지 않았다.

따라서 바로 대량의 코드를 생성하지 마라.

우선 이 문서를 프로젝트의 장기 Context로 이해해라.

첫 단계에서는 나와 함께 다음을 결정해야 한다.

1. MVP 범위
2. 기술 Stack
3. Electron 프로젝트 구조
4. Editor 선택
5. SQLite 접근 방식
6. 기본 UI Architecture
7. 프로젝트 파일 구조

결정되지 않은 내용을 임의로 대규모 구현하지 마라.

내가 명시적으로 구현을 요청하기 전에는 먼저 분석하고 선택지를 제시해라.

---

# 22. Claude Code에게 기대하는 역할

너는 단순 Code Generator가 아니다.

이 프로젝트에서 다음 역할을 수행한다.

- Architecture 검토
- 구현 계획 작성
- 코드 구현
- Refactoring
- Test 작성
- Code Review
- 기술 부채 발견
- Security 검토
- Documentation 유지

특히 작업을 완료한 후에는 내가 코드를 이해할 수 있도록 중요한 변경 사항과 설계 이유를 설명한다.

새로운 Library나 Framework를 추가할 때는 단순히 편하다는 이유가 아니라 **왜 LoreWeave에 필요한지** 설명한다.

그리고 현재 요구사항보다 지나치게 큰 구현을 하려고 한다면 먼저 나에게 알려라.

---

# 23. 지금 해야 할 일

아직 코드를 작성하지 마라.

먼저 위 내용을 충분히 이해한 뒤 다음 항목만 분석해서 나에게 제안해라.

1. LoreWeave의 핵심 목표를 네가 이해한 방식으로 요약
2. 현실적인 첫 번째 MVP 범위
3. 추천 기술 Stack
4. 추천 프로젝트 구조
5. Rich Text Editor 후보 비교
6. SQLite Library/ORM 후보 비교
7. Graph/Timeline UI Library는 지금 선택해야 하는지 여부
8. 첫 번째 개발 Milestone 제안
9. 현재 단계에서 하지 말아야 할 것
10. 내가 결정해야 할 기술적 선택

가능하면 각각의 선택에는 이유와 trade-off를 설명해라.

**아직 scaffold를 생성하거나 package를 설치하거나 파일을 만들지 마라.**

먼저 계획을 합의한 후 개발을 시작한다.