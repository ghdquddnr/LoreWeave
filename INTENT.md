# LoreWeave — Project Intent

> **Write freely. Keep the world consistent.**

LoreWeave는 글을 대신 써주는 AI가 아니다.

LoreWeave는 사용자가 오랫동안 글을 쓰면서 만들어 온 **인물, 관계, 사건, 시간, 설정과 맥락을 잊지 않도록 돕는 Local-first Writing IDE**다.

이 문서는 LoreWeave의 기능 명세서가 아니다.

이 프로젝트를 왜 만드는지, 어떤 문제를 해결하려는지, 그리고 개발 과정에서 어떤 원칙을 지켜야 하는지를 기록한다.

기능이나 기술은 바뀔 수 있다.

하지만 이 문서에 정의된 Intent는 중요한 제품 방향 변경이 없는 한 유지한다.

---

# 1. Why LoreWeave Exists

LoreWeave의 시작은 단순한 불편함이었다.

장기 연재되는 웹소설을 읽다 보면 다음과 같은 문제를 자주 발견할 수 있다.

- 이전에 등장했던 인물의 이름이 달라진다.
- 인물의 나이, 직업, 성격 등의 설정이 달라진다.
- 이미 만난 두 사람이 처음 만나는 것처럼 묘사된다.
- 과거 사건의 날짜와 현재 시간축이 맞지 않는다.
- 죽거나 퇴장한 인물이 잘못 등장한다.
- 인물 간의 관계가 설명 없이 바뀐다.
- 금액, 지분, 직책 등의 구체적인 정보가 달라진다.
- 오래전에 만들어 놓은 설정이나 복선이 잊힌다.
- 앞뒤 문맥이 맞지 않는 장면이 등장한다.

이것을 단순히 작가의 성의 부족이라고 생각하지 않는다.

장기 연재물은 수십만 자에서 수백만 자까지 성장할 수 있다.

등장인물이 수십 명을 넘어갈 수 있고, 사건과 관계가 계속 추가된다.

작가는 새로운 이야기를 쓰면서 동시에 몇 달 또는 몇 년 전에 작성했던 수많은 정보를 기억해야 한다.

사람의 기억에는 한계가 있다.

기존의 일반적인 Text Editor는 글을 저장할 수는 있지만 그 글이 의미하는 것을 이해하지 못한다.

LoreWeave는 바로 이 지점에서 시작한다.

---

# 2. The Core Idea

프로그래머에게 IDE가 있는 것처럼 글을 쓰는 사람에게도 자신의 글을 구조적으로 이해하는 도구가 있을 수 있다.

IDE는 소스코드를 단순한 문자열로 취급하지 않는다.

IDE는 코드 안에 존재하는

- Class
- Function
- Variable
- Reference
- Dependency

등을 이해하고 서로 연결한다.

그 덕분에 개발자는 수십만 줄의 코드를 모두 기억하지 않아도 된다.

LoreWeave는 비슷한 생각을 글쓰기에 적용한다.

장편 소설이라면 글 안에는 단순한 문장 이상의 구조가 존재한다.

- Character
- Relationship
- Event
- Timeline
- Location
- Organization
- Item
- Fact
- Story Thread
- Foreshadowing

LoreWeave는 이러한 구조를 사용자가 관리하고 탐색할 수 있도록 돕는다.

그리고 필요한 경우 AI가 그 작업을 보조한다.

---

# 3. AI Is an Assistant, Not the Author

LoreWeave의 가장 중요한 원칙 중 하나다.

> **AI는 작가를 대체하지 않는다.**

LoreWeave의 목적은 버튼 하나를 눌러 소설 한 편을 생성하는 것이 아니다.

AI가 다음 문장을 대신 결정하는 것도 핵심 목적이 아니다.

LoreWeave에서 AI가 해야 할 일은 주로 **기억하고, 찾고, 연결하고, 확인하는 것**이다.

예를 들어 사용자가 다음과 같이 작성했다고 하자.

> 민수는 처음 보는 이지현에게 악수를 건넸다.

하지만 두 사람이 72화에서 이미 만났다면 LoreWeave는 다음과 같이 알려줄 수 있다.

> **Possible continuity issue**
>
> 김민수와 이지현은 이전에 만난 기록이 있습니다.
>
> 72화에서 두 사람이 처음 만나는 장면이 발견되었습니다.
>
> [72화로 이동]

LoreWeave는 문장을 자동으로 수정하지 않는다.

작가가 의도적으로 그렇게 작성했을 수도 있기 때문이다.

최종 판단은 항상 사람에게 있다.

---

# 4. AI Can Be Wrong

LLM의 판단은 사실이 아니다.

AI는 다음과 같은 실수를 할 수 있다.

- 문맥을 잘못 이해할 수 있다.
- 회상 장면을 현재 사건으로 오해할 수 있다.
- 동명이인을 같은 사람으로 판단할 수 있다.
- 비유적인 표현을 실제 설정으로 판단할 수 있다.
- 의도적인 설정 변경을 오류라고 판단할 수 있다.

따라서 LoreWeave에서 AI 분석 결과는 기본적으로 다음과 같은 의미를 가진다.

> **Possible Issue**

AI의 판단을 자동으로 Canonical Fact로 확정하지 않는다.

사용자가 검토할 수 있도록 가능한 한 다음 정보를 함께 제공한다.

- 판단 이유
- 관련 인물 또는 사건
- 근거가 된 원문
- 근거 Chapter
- Confidence
- 원문으로 이동할 수 있는 Navigation

AI의 역할은 판결하는 것이 아니라 **사용자가 판단할 수 있는 정보를 제공하는 것**이다.

---

# 5. Evidence Before Confidence

LoreWeave에서 중요한 것은 AI가 얼마나 자신 있게 말하는지가 아니다.

**왜 그렇게 판단했는지를 사용자가 확인할 수 있는가**가 더 중요하다.

따라서 다음과 같은 결과보다

> 설정 오류일 가능성이 97%입니다.

다음과 같은 결과를 더 가치 있게 본다.

> 12화에서 김민수는 술을 마시지 못한다고 말했습니다.
>
> 138화에서는 김민수가 매일 술을 즐겨 마시는 사람으로 묘사됩니다.
>
> 두 설정 사이에 변화가 설명된 장면을 찾지 못했습니다.
>
> [12화 보기] [138화 보기]

Confidence Score는 보조 정보일 뿐이다.

**Evidence가 Confidence보다 중요하다.**

---

# 6. The Manuscript Belongs to the User

사용자가 작성한 글은 LoreWeave의 것이 아니다.

> **Your writing belongs to you.**

LoreWeave가 없어져도 사용자의 글은 남아 있어야 한다.

프로젝트 개발이 중단되더라도 사용자의 원고를 읽을 수 있어야 한다.

사용자가 다른 프로그램으로 이동하고 싶다면 자유롭게 이동할 수 있어야 한다.

이 때문에 LoreWeave는 원고의 Source of Truth를 가능한 한 개방된 형식으로 유지한다.

기본 원고 형식은 Markdown이다.

사용자는 LoreWeave 없이도 자신의 글을 열 수 있어야 한다.

예를 들어 다음과 같은 프로그램에서도 읽을 수 있어야 한다.

- VS Code
- Obsidian
- Markdown Editor
- 일반 Text Editor
- 미래의 다른 Writing Tool

LoreWeave만 이해할 수 있는 proprietary binary format에 사용자의 원고를 가두지 않는다.

---

# 7. Markdown Is Storage, Not UX

Markdown은 저장 형식이다.

사용자가 Markdown 문법을 알아야 한다는 의미가 아니다.

작가는 글을 쓰기 위해

```
**bold**
# heading
> quote
```

같은 문법을 배울 필요가 없다.

LoreWeave의 Editor는 가능한 한 일반적인 Text Editor 또는 Writing Application처럼 자연스럽게 동작해야 한다.

사용자는 글쓰기에 집중한다.

LoreWeave가 내부적으로 Markdown을 관리한다.

따라서 다음 두 가지를 동시에 만족하는 것이 목표다.

> **Human-friendly editing**

그리고

> **Open and portable storage**

---

# 8. Local First

LoreWeave는 Local-first Application이다.

사용자의 프로젝트는 기본적으로 사용자의 컴퓨터에 존재한다.

LoreWeave를 사용하기 위해 중앙 서버가 반드시 필요해서는 안 된다.

기본적인 글쓰기 기능을 사용하기 위해 다음을 요구하지 않는다.

- 회원가입
- 로그인
- Subscription
- Cloud Account
- LoreWeave Server Connection
- AI Connection

인터넷이 연결되지 않아도 기본적인 프로젝트 관리와 글쓰기가 가능해야 한다.

---

# 9. AI Is Optional

LoreWeave에서 AI는 중요한 기능이지만 애플리케이션의 존재 조건은 아니다.

AI Provider를 설정하지 않아도 다음과 같은 기본 기능은 정상적으로 사용할 수 있어야 한다.

- 프로젝트 생성
- 프로젝트 열기
- Chapter 작성
- Chapter 편집
- 검색
- 수동 설정 관리

AI 기능을 사용하고 싶은 사용자는 자신이 원하는 Provider를 연결한다.

LoreWeave는 장기적으로 다음과 같은 방식을 지원할 수 있다.

- Commercial LLM API
- OpenAI-compatible API
- Local LLM
- Ollama

특정 AI Vendor에 사용자를 종속시키지 않는 것을 지향한다.

---

# 10. Bring Your Own AI

LoreWeave가 자체적으로 AI 사용량을 판매하는 것을 기본 모델로 생각하지 않는다.

사용자가 자신이 원하는 AI를 선택한다.

사용자가 API Provider를 사용한다면 자신의 API Key를 사용할 수 있다.

Local LLM을 선호한다면 자신의 컴퓨터에서 실행되는 모델을 사용할 수 있다.

AI 기술은 빠르게 변한다.

오늘 가장 좋은 모델이 몇 년 뒤에도 가장 좋은 모델이라는 보장은 없다.

따라서 LoreWeave의 핵심 가치가 특정 모델 이름에 의존해서는 안 된다.

LoreWeave가 해결해야 하는 문제는

> "어떤 모델을 사용하는가?"

보다

> "작품의 어떤 맥락을 찾아 어떤 근거와 함께 모델에게 제공할 것인가?"

에 더 가깝다.

---

# 11. Local-first Does Not Mean AI Requests Stay Local

Local-first라는 표현이 사용자를 오해하게 만들어서는 안 된다.

사용자가 Cloud AI Provider를 선택한다면 분석에 필요한 원고 일부가 해당 Provider의 API로 전송될 수 있다.

사용자가 Local LLM을 선택한다면 외부 AI Provider로 원고를 전송하지 않을 수 있다.

LoreWeave는 이 차이를 사용자에게 명확하게 알려야 한다.

LoreWeave 자체 서버에 원고를 저장하지 않는다는 것과 외부 AI API에 분석 요청을 보내는 것은 서로 다른 문제다.

보안과 개인정보에 관한 표현은 기술적으로 정확해야 한다.

---

# 12. Structured Knowledge Is Derived Data

LoreWeave는 SQLite 등을 이용해 다음과 같은 정보를 관리할 수 있다.

- Characters
- Relationships
- Events
- Facts
- Timeline
- Story Threads
- AI Analysis

하지만 이것들은 원고 그 자체가 아니다.

기본적으로 원고에서 만들어진 **Derived Data**다.

가능한 데이터는 원본 Markdown으로부터 다시 생성할 수 있어야 한다.

따라서 내부 데이터베이스가 손상되거나 삭제되더라도 원고 자체가 사라져서는 안 된다.

가능한 경우 LoreWeave는 프로젝트의 내부 데이터를 다시 구축할 수 있어야 한다.

---

# 13. Navigate, Don't Just Report

LoreWeave는 문제를 알려주는 것에서 끝나지 않는다.

사용자가 그 문제를 직접 확인할 수 있어야 한다.

예를 들어

> 72화의 내용과 충돌할 가능성이 있습니다.

라고 알려준다면 사용자가 72화를 직접 찾아가도록 만들지 않는다.

가능하면

> **[72화 해당 위치로 이동]**

을 제공한다.

같은 원칙을 다음 기능에도 적용한다.

- Character
- Relationship
- Timeline Event
- Search Result
- Story Thread
- AI Issue
- Reference

LoreWeave는 단순한 Dashboard가 아니라 **탐색 가능한 Writing Environment**를 지향한다.

---

# 14. Visualize Complexity

장기 연재 작품은 시간이 지날수록 복잡해진다.

LoreWeave는 이 복잡성을 단순히 목록으로만 보여주는 것이 아니라 필요할 경우 시각적으로 이해할 수 있도록 돕는다.

장기적으로 다음과 같은 시각화를 고려한다.

### Character Relationship Graph

인물과 인물의 관계를 Graph 형태로 탐색한다.

### Timeline

작품 속 주요 사건을 시간 순서로 확인한다.

### Story Threads

복선이나 진행 중인 사건이 언제 시작되고 어디에서 다시 등장했는지 확인한다.

그러나 시각화 자체가 목적은 아니다.

**사용자가 작품을 더 쉽게 이해하고 탐색할 수 있을 때만 시각화를 추가한다.**

예쁜 Graph를 만들기 위해 데이터 모델을 왜곡하지 않는다.

---

# 15. Story Time and Written Order Are Different

소설에서는 작성된 순서와 작품 세계의 시간 순서가 다를 수 있다.

예를 들어 300화가 10년 전 사건을 다루는 회상 장면일 수 있다.

따라서 LoreWeave는 장기적으로 다음 개념을 구분해야 한다.

- Chapter Order
- Narrative Order
- Story Chronological Time

이는 단순한 Timeline UI 문제가 아니다.

인물이 특정 시점에 무엇을 알고 있었는지 판단하기 위해서도 중요하다.

LoreWeave의 데이터 모델은 이러한 차이를 표현할 수 있는 방향으로 발전해야 한다.

---

# 16. Start With Novels

LoreWeave의 기본 아이디어는 다른 장문 문서에도 적용할 수 있다.

예를 들어:

- Screenplay
- Game Scenario
- Research Paper
- Technical Document
- Long-term Planning Document

논문이라면 Character 대신 다음 개념이 중요할 수 있다.

- Claim
- Evidence
- Citation
- Hypothesis
- Experiment

하지만 이것은 미래의 가능성이다.

현재 LoreWeave는 **웹소설과 장편소설**에 집중한다.

처음부터 모든 종류의 문서를 지원하는 범용 플랫폼을 만들지 않는다.

먼 미래의 가능성을 위해 현재의 제품을 복잡하게 만들지 않는다.

---

# 17. Quality Over Feature Count

LoreWeave는 기능의 개수로 성공을 판단하지 않는다.

Graph, Timeline, AI Chat, Vector Search, Multi-Agent 등의 기능이 많다고 좋은 제품이 되는 것은 아니다.

작은 기능이라도 실제로 사용자의 문제를 해결해야 한다.

특히 LoreWeave의 첫 번째 중요한 성공 기준은 다음과 같다.

> **새로운 Chapter에서 이전 Chapter와 충돌하는 설정을 실제로 찾아낼 수 있는가?**

이 기능이 신뢰할 수 없다면 다른 AI 기능을 많이 추가해도 LoreWeave의 핵심 문제를 해결하지 못한 것이다.

---

# 18. Measure AI Quality

LLM 기능은 "그럴듯하게 동작한다"는 느낌만으로 평가하지 않는다.

가능하면 정답을 알고 있는 테스트 데이터를 만든다.

예를 들어 의도적으로 다음과 같은 오류가 포함된 Synthetic Novel을 만들 수 있다.

- 인물 이름 불일치
- 나이 불일치
- 직업 불일치
- 첫 만남 충돌
- 생사 상태 충돌
- 날짜 충돌
- 관계 충돌
- 금액 또는 숫자 충돌

그리고 AI가 이를 얼마나 탐지하는지 측정한다.

중요한 지표는 상황에 따라 다음을 포함할 수 있다.

- True Positive
- False Positive
- False Negative
- Precision
- Recall

특히 False Positive를 중요하게 본다.

작가가 정상적인 문장을 쓸 때마다 LoreWeave가 오류라고 경고한다면 사용자는 결국 경고를 무시하게 된다.

AI 기능은 **측정하고 개선한다.**

---

# 19. Prefer Simple Architecture

LoreWeave는 AI 프로젝트라는 이유로 복잡한 AI Architecture를 사용하지 않는다.

다음 기술은 실제 필요성이 확인되기 전까지 도입하지 않는다.

- Vector Database
- Graph Database
- Multi-Agent
- Agent Framework
- Separate AI Backend
- Distributed Architecture

SQLite와 일반적인 검색으로 충분하다면 그것을 사용한다.

하나의 LLM 요청으로 해결할 수 있다면 Agent를 만들지 않는다.

단순한 데이터 구조로 표현할 수 있다면 Graph Database를 사용하지 않는다.

기술은 문제를 해결하기 위해 존재한다.

---

# 20. Avoid Premature Abstraction

미래에 필요할 것 같다는 이유만으로 추상화를 만들지 않는다.

Provider가 하나뿐이라면 거대한 Provider Framework를 만들 필요가 없다.

Entity가 아직 Character밖에 없다면 모든 미래 Entity를 예상한 Generic Entity System을 만들 필요가 없다.

실제 두 번째 요구사항이 나타났을 때 공통점을 보고 추상화한다.

LoreWeave는 미래의 모든 가능성을 미리 구현하지 않는다.

---

# 21. Build Incrementally

LoreWeave는 개인 프로젝트이며 정해진 출시 일정이 없다.

빠르게 많은 기능을 만드는 것이 목적이 아니다.

작은 기능을 하나씩 완성한다.

각 단계는 가능하면 독립적으로 의미가 있어야 한다.

예를 들어:

1. 글을 작성하고 저장할 수 있다.
2. 프로젝트를 탐색할 수 있다.
3. 원고를 검색할 수 있다.
4. 인물을 관리할 수 있다.
5. AI가 정보를 추출할 수 있다.
6. 과거 설정과 비교할 수 있다.
7. 충돌 가능성을 알려줄 수 있다.
8. 근거 원문으로 이동할 수 있다.

각 단계를 이해하고 검증한 뒤 다음 단계로 이동한다.

---

# 22. Finish What We Start

LoreWeave는 기능을 끝없이 추가하는 실험장이 되는 것을 목표로 하지 않는다.

새로운 기술이 흥미롭다는 이유로 기존 작업을 중단하고 계속 갈아엎지 않는다.

필요한 기술 변화는 받아들이되, **완성 가능한 범위를 유지하는 것**을 중요하게 본다.

새로운 기능을 추가하기 전에 다음 질문을 한다.

1. 이것이 LoreWeave의 핵심 문제 해결에 필요한가?
2. 지금 필요한가?
3. 기존 기능을 먼저 완성해야 하지 않는가?
4. 더 단순한 방법은 없는가?
5. 이 기능 때문에 프로젝트 완성 가능성이 낮아지지 않는가?

답이 명확하지 않다면 구현을 미룬다.

---

# 23. Open Source

LoreWeave는 오픈소스 프로젝트를 지향한다.

목표는 수익화가 아니다.

개인적인 포트폴리오이기도 하지만 단순히 기술을 전시하기 위한 프로젝트만은 아니다.

실제로 글을 쓰는 누군가에게 도움이 되는 프로그램을 만들고 싶다.

많은 사용자가 필요하지 않다.

단 한 명이라도 LoreWeave 덕분에

> "예전에 써놓고 잊었던 설정을 찾았다."

또는

> "연재 중 설정 실수를 발견했다."

라고 느낀다면 이 프로젝트는 충분한 의미가 있다.

---

# 24. Portfolio Is a Result, Not the Product

LoreWeave는 개발자의 포트폴리오이기도 하다.

하지만 포트폴리오를 보여주기 위해 불필요한 기술을 넣지 않는다.

예를 들어 다음과 같은 이유로 기술을 선택하지 않는다.

- 이력서에 적기 좋아 보인다.
- AI 프로젝트처럼 보인다.
- Architecture Diagram이 화려해진다.
- 최신 기술이라서 사용해 보고 싶다.

좋은 포트폴리오는 많은 기술을 사용한 프로젝트가 아니라

**실제 문제를 발견하고 적절한 기술을 선택해 끝까지 해결한 프로젝트**

라고 생각한다.

---

# 25. Decision Priority

기술적 또는 제품적 선택이 충돌할 경우 다음 우선순위를 기준으로 판단한다.

1. **사용자의 원고와 데이터 안전**
2. **글쓰기 경험**
3. **정확성과 신뢰성**
4. **사용자가 결과를 검증할 수 있는가**
5. **단순성**
6. **유지보수성**
7. **확장성**
8. **기술적 새로움**

확장성과 최신 기술을 위해 기본적인 글쓰기 경험을 희생하지 않는다.

---

# 26. What LoreWeave Should Never Become

LoreWeave는 다음과 같은 제품이 되는 것을 목표로 하지 않는다.

### AI Novel Generator

버튼 하나로 소설을 대량 생성하는 서비스가 아니다.

### Mandatory Cloud Platform

사용자의 원고를 사용하기 위해 반드시 서버에 업로드해야 하는 서비스가 아니다.

### Subscription-first Product

사용자를 서비스에 묶어 두는 것이 목적이 아니다.

### LLM Vendor Frontend

특정 AI API에 UI만 씌운 프로그램이 아니다.

### Technology Showcase

Vector DB, Agent, Graph DB 등의 기술을 보여주기 위해 존재하는 프로젝트가 아니다.

### Proprietary Writing Format

LoreWeave를 떠나면 자신의 글을 사용할 수 없는 구조를 만들지 않는다.

---

# 27. The Long-Term Vision

LoreWeave가 충분히 발전한다면 사용자는 수백 개의 Chapter를 가진 작품에서도 자신의 세계를 탐색할 수 있을 것이다.

인물을 클릭하면 그 인물이 언제 등장했고 누구와 어떤 관계를 가지고 있는지 확인한다.

Timeline에서 사건을 클릭하면 해당 장면으로 이동한다.

오래전에 작성했던 복선을 확인한다.

새로운 Chapter를 작성하면 LoreWeave가 과거의 관련 내용을 찾아준다.

그리고 필요하다면 조용히 말해준다.

> "이 부분은 183화의 설정과 조금 다른 것 같습니다."

하지만 무엇을 쓸지는 끝까지 사람이 결정한다.

---

# 28. One Sentence

LoreWeave가 무엇인지 다시 판단해야 할 때는 이 문장으로 돌아온다.

> **LoreWeave is a local-first writing IDE that helps writers remember, navigate, and maintain the worlds they create.**

그리고 LoreWeave가 무엇을 위해 존재하는지는 더 간단하게 표현할 수 있다.

> **AI should help writers remember their story, not write it for them.**