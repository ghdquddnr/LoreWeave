# Round-trip 결과

- 코퍼스 50개 (문서화된 예외 1개는 비율에서 제외)
- byte 동일: `s(p(x)) == x`, 멱등: `s(p(s(p(x)))) == s(p(x))`, 국소성: 글자가 있는 문단 하나를 고쳤을 때 나머지가 `s(p(x))`와 같은 문단 비율
- 공백 문단: 에디터 안에서 공백·NBSP만 든 문단 수 (빈 줄이 보이지 않는 글자로 남는 경우. 코퍼스에 진짜 NBSP 줄이 1개 있다)
- 생성: `pnpm roundtrip` (자동 생성 파일, 직접 고치지 않는다)

| 조합 | byte 동일 | 멱등 | 국소성 | 공백 문단 | 변환 오류 | bom | eol | blank-lines | escape | whitespace | text-loss | other |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) 공식 · C1 | 49% | 94% | 100% | 1 | 0 | 0 | 0 | 7 | 13 | 0 | 10 | 2 |
| (a) 공식 · C2 | 45% | 94% | 100% | 1 | 0 | 0 | 0 | 4 | 18 | 0 | 10 | 2 |
| (a) 공식 · C3 | 57% | 96% | 100% | 1 | 0 | 0 | 0 | 3 | 13 | 0 | 9 | 1 |
| (b) 커뮤니티 · C1 | 41% | 100% | 100% | 3 | 0 | 0 | 0 | 5 | 11 | 6 | 10 | 4 |
| (b) 커뮤니티 · C2 | 39% | 100% | 100% | 3 | 0 | 0 | 0 | 4 | 14 | 6 | 10 | 4 |
| (b) 커뮤니티 · C3 | 59% | 98% | 100% | 541 | 0 | 0 | 0 | 1 | 14 | 3 | 7 | 2 |
| (c) 직접 작성 · C3 | 100% | 100% | 100% | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

유형 열은 그 유형의 차이가 하나라도 있는 사례 수다.

## 그룹별 byte 동일

| 그룹 | (a) 공식 · C1 | (a) 공식 · C2 | (a) 공식 · C3 | (b) 커뮤니티 · C1 | (b) 커뮤니티 · C2 | (b) 커뮤니티 · C3 | (c) 직접 작성 · C3 |
|---|---|---|---|---|---|---|---|
| blank | 2/6 | 2/6 | 5/6 | 1/6 | 1/6 | 5/6 | 6/6 |
| special | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | 0/4 | 4/4 |
| scene | 0/3 | 0/3 | 1/3 | 0/3 | 0/3 | 1/3 | 3/3 |
| emphasis | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 1/3 | 3/3 |
| chars | 2/5 | 2/5 | 2/5 | 2/5 | 2/5 | 2/5 | 5/5 |
| eol | 4/4 | 3/4 | 4/4 | 2/4 | 2/4 | 4/4 | 4/4 |
| frontmatter | 3/4 | 3/4 | 4/4 | 3/4 | 3/4 | 4/4 | 4/4 |
| structure | 2/3 | 2/3 | 1/3 | 1/3 | 1/3 | 1/3 | 3/3 |
| edge | 1/2 | 0/2 | 1/2 | 1/2 | 0/2 | 2/2 | 2/2 |
| m0a | 9/15 | 9/15 | 9/15 | 9/15 | 9/15 | 9/15 | 15/15 |

## 실패 사례 (첫 번째 차이)

### (a) 공식 · C1 — 25개

| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |
|---|---|---|---|---|---|
| blank-multi | blank-lines | ○ | 0/3 | "" | (없음) |
| blank-mixed | blank-lines | ○ | 0/3 | "" | (없음) |
| blank-tokens | text-loss, escape, blank-lines | × | 0/3 | "<br>" | "  " |
| blank-edges | blank-lines | ○ | 0/2 | "" | (없음) |
| special-inline | escape, text-loss | ○ | 0/4 | "변수 이름은 user_name_2였다." | "변수 이름은 user\\_name\\_2였다." |
| special-brackets | escape, text-loss | ○ | 0/5 | "[ ] 체크박스처럼 보이는 줄." | "\\[ \\] 체크박스처럼 보이는 줄." |
| special-line-start | text-loss | ○ | 0/1 | "1. 첫째, 절대 뒤돌아보지 말 것." ⏎ "" ⏎ "2007. 3. 2. 입학식 날이었다." | (없음) |
| special-code-pipe | text-loss | ○ | 0/2 | "그는 `sudo`라고 입력했다." ⏎ "" ⏎ "백틱 하나 ` 홀로." | "그는 라고 입력했다." |
| scene-breaks | other | ○ | 0/8 | "***" | "---" |
| scene-setext-trap | other, text-loss | × | 0/1 | "민수는 문을 닫았다." ⏎ "---" ⏎ "다음 날." | "## 민수는 문을 닫았다." ⏎ "" ⏎ "# 다음 날." |
| system-window | escape | ○ | 0/3 | "[시스템 메시지]" ⏎ "[퀘스트 '첫 만남'을 완료했습니다.]" ⏎ "[보상: 경험치 +100]" | "\\[시스템 메시지\\]" ⏎ "\\[퀘스트 '첫 만남'을 완료했습니다.\\]" ⏎ "\\[보상: 경험치 +100\\]" |
| emphasis-unclosed | escape | ○ | 0/3 | "**닫히지 않은 강조." | "\\*\\*닫히지 않은 강조." |
| emphasis-cjk | escape | ○ | 0/3 | "**\"대사\"**를 굵게 쓰면 깨진다." | "\\*\\*\"대사\"\\*\\*를 굵게 쓰면 깨진다." |
| chars-urls | escape, text-loss | × | 0/3 | "주소는 https://example.com/path?q=1&b=2_3 이다." | "주소는 https://example.com/path?q=1&amp;b=2\\_3 이다." |
| chars-indent-trailing | text-loss | ○ | 0/3 | "\t탭으로 들여쓴 문단." ⏎ "" ⏎ "    공백 네 칸 들여쓰기." | (없음) |
| chars-html | text-loss, blank-lines | ○ | 0/3 | "<b>굵게</b> 태그." | "**굵게** 태그." |
| fm-basic | blank-lines | ○ | 0/1 | "" | (없음) |
| structure-hard-breaks | text-loss | ○ | 0/2 | "백슬래시 줄바꿈\\" | "백슬래시 줄바꿈  " |
| edge-newlines-only | blank-lines | ○ | 0/0 | "" | (없음) |
| m0a-ch02 | escape | ○ | 0/32 | "[어제 설명회 어땠노? 괜찮은 사람 있더나?]" | "\\[어제 설명회 어땠노? 괜찮은 사람 있더나?\\]" |
| m0a-ch04 | escape | ○ | 0/27 | "[교수님, 오늘 회사를 세웠습니다.]" | "\\[교수님, 오늘 회사를 세웠습니다.\\]" |
| m0a-ch09 | escape | ○ | 0/30 | "[민수 군." | "\\[민수 군." |
| m0a-ch11 | escape | ○ | 0/37 | "[나 다음 주 월요일에 반차 쓴다. 개인적인 일.]" | "\\[나 다음 주 월요일에 반차 쓴다. 개인적인 일.\\]" |
| m0a-ch13 | escape | ○ | 0/29 | "[미안하다. 더 큰 데서 해 보고 싶었다.]" | "\\[미안하다. 더 큰 데서 해 보고 싶었다.\\]" |
| m0a-ch14 | escape | ○ | 0/29 | "[K테크, 신임 CTO에 박성진 씨 선임]" | "\\[K테크, 신임 CTO에 박성진 씨 선임\\]" |

### (a) 공식 · C2 — 27개

| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |
|---|---|---|---|---|---|
| blank-multi | escape, blank-lines | ○ | 0/3 | "" | "&nbsp;" |
| blank-mixed | blank-lines | ○ | 0/3 | "" | (없음) |
| blank-tokens | text-loss, blank-lines, escape | × | 0/3 | "<br>" | "&nbsp;" |
| blank-edges | escape | ○ | 0/2 | "" | "&nbsp;" |
| special-inline | escape, text-loss | ○ | 0/4 | "변수 이름은 user_name_2였다." | "변수 이름은 user\\_name\\_2였다." |
| special-brackets | escape, text-loss | ○ | 0/5 | "[ ] 체크박스처럼 보이는 줄." | "\\[ \\] 체크박스처럼 보이는 줄." |
| special-line-start | text-loss | ○ | 0/1 | "1. 첫째, 절대 뒤돌아보지 말 것." ⏎ "" ⏎ "2007. 3. 2. 입학식 날이었다." | (없음) |
| special-code-pipe | text-loss | ○ | 0/2 | "그는 `sudo`라고 입력했다." ⏎ "" ⏎ "백틱 하나 ` 홀로." | "그는 라고 입력했다." |
| scene-breaks | other | ○ | 0/8 | "***" | "---" |
| scene-setext-trap | other, text-loss | × | 0/1 | "민수는 문을 닫았다." ⏎ "---" ⏎ "다음 날." | "## 민수는 문을 닫았다." ⏎ "" ⏎ "# 다음 날." |
| system-window | escape | ○ | 0/3 | "[시스템 메시지]" ⏎ "[퀘스트 '첫 만남'을 완료했습니다.]" ⏎ "[보상: 경험치 +100]" | "\\[시스템 메시지\\]" ⏎ "\\[퀘스트 '첫 만남'을 완료했습니다.\\]" ⏎ "\\[보상: 경험치 +100\\]" |
| emphasis-unclosed | escape | ○ | 0/3 | "**닫히지 않은 강조." | "\\*\\*닫히지 않은 강조." |
| emphasis-cjk | escape | ○ | 0/3 | "**\"대사\"**를 굵게 쓰면 깨진다." | "\\*\\*\"대사\"\\*\\*를 굵게 쓰면 깨진다." |
| chars-urls | escape, text-loss | × | 0/3 | "주소는 https://example.com/path?q=1&b=2_3 이다." | "주소는 https://example.com/path?q=1&amp;b=2\\_3 이다." |
| chars-indent-trailing | text-loss | ○ | 0/3 | "\t탭으로 들여쓴 문단." ⏎ "" ⏎ "    공백 네 칸 들여쓰기." | (없음) |
| chars-html | text-loss | ○ | 0/3 | "<b>굵게</b> 태그." | "**굵게** 태그." |
| eol-multi-final-newline | escape | ○ | 0/1 | "" | "&nbsp;" |
| fm-basic | blank-lines | ○ | 0/1 | "" | (없음) |
| structure-hard-breaks | text-loss | ○ | 0/2 | "백슬래시 줄바꿈\\" | "백슬래시 줄바꿈  " |
| edge-empty | escape | ○ | 0/0 | "" | "&nbsp;" |
| edge-newlines-only | escape | ○ | 0/0 | "" ⏎ "" | "&nbsp;" |
| m0a-ch02 | escape | ○ | 0/32 | "[어제 설명회 어땠노? 괜찮은 사람 있더나?]" | "\\[어제 설명회 어땠노? 괜찮은 사람 있더나?\\]" |
| m0a-ch04 | escape | ○ | 0/27 | "[교수님, 오늘 회사를 세웠습니다.]" | "\\[교수님, 오늘 회사를 세웠습니다.\\]" |
| m0a-ch09 | escape | ○ | 0/30 | "[민수 군." | "\\[민수 군." |
| m0a-ch11 | escape | ○ | 0/37 | "[나 다음 주 월요일에 반차 쓴다. 개인적인 일.]" | "\\[나 다음 주 월요일에 반차 쓴다. 개인적인 일.\\]" |
| m0a-ch13 | escape | ○ | 0/29 | "[미안하다. 더 큰 데서 해 보고 싶었다.]" | "\\[미안하다. 더 큰 데서 해 보고 싶었다.\\]" |
| m0a-ch14 | escape | ○ | 0/29 | "[K테크, 신임 CTO에 박성진 씨 선임]" | "\\[K테크, 신임 CTO에 박성진 씨 선임\\]" |

### (a) 공식 · C3 — 21개

| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |
|---|---|---|---|---|---|
| blank-tokens | text-loss, blank-lines | × | 0/3 | "<br>" | (없음) |
| special-inline | escape, text-loss | ○ | 0/4 | "변수 이름은 user_name_2였다." | "변수 이름은 user\\_name\\_2였다." |
| special-brackets | escape, text-loss | ○ | 0/5 | "[ ] 체크박스처럼 보이는 줄." | "\\[ \\] 체크박스처럼 보이는 줄." |
| special-line-start | text-loss | ○ | 0/1 | "1. 첫째, 절대 뒤돌아보지 말 것." | (없음) |
| special-code-pipe | text-loss | ○ | 0/2 | "그는 `sudo`라고 입력했다." ⏎ "" ⏎ "백틱 하나 ` 홀로." | "그는 라고 입력했다." |
| scene-breaks | other | ○ | 0/8 | "***" | "---" |
| system-window | escape | ○ | 0/7 | "[시스템 메시지]" ⏎ "[퀘스트 '첫 만남'을 완료했습니다.]" ⏎ "[보상: 경험치 +100]" | "\\[시스템 메시지\\]" ⏎ "\\[퀘스트 '첫 만남'을 완료했습니다.\\]" ⏎ "\\[보상: 경험치 +100\\]" |
| emphasis-unclosed | escape | ○ | 0/4 | "**닫히지 않은 강조." | "\\*\\*닫히지 않은 강조." |
| emphasis-cjk | escape | ○ | 0/3 | "**\"대사\"**를 굵게 쓰면 깨진다." | "\\*\\*\"대사\"\\*\\*를 굵게 쓰면 깨진다." |
| chars-urls | escape, text-loss | × | 0/3 | "주소는 https://example.com/path?q=1&b=2_3 이다." | "주소는 https://example.com/path?q=1&amp;b=2\\_3 이다." |
| chars-indent-trailing | text-loss | ○ | 0/4 | "\t탭으로 들여쓴 문단." | (없음) |
| chars-html | text-loss, blank-lines | ○ | 0/3 | "<b>굵게</b> 태그." | "**굵게** 태그." |
| structure-blockquote | text-loss | ○ | 0/2 | ">" | "" |
| structure-hard-breaks | escape | ○ | 0/4 | "백슬래시 줄바꿈\\" | "백슬래시 줄바꿈\\\\" |
| edge-newlines-only | blank-lines | ○ | 0/0 | "" | (없음) |
| m0a-ch02 | escape | ○ | 0/32 | "[어제 설명회 어땠노? 괜찮은 사람 있더나?]" | "\\[어제 설명회 어땠노? 괜찮은 사람 있더나?\\]" |
| m0a-ch04 | escape | ○ | 0/27 | "[교수님, 오늘 회사를 세웠습니다.]" | "\\[교수님, 오늘 회사를 세웠습니다.\\]" |
| m0a-ch09 | escape | ○ | 0/30 | "[민수 군." | "\\[민수 군." |
| m0a-ch11 | escape | ○ | 0/37 | "[나 다음 주 월요일에 반차 쓴다. 개인적인 일.]" | "\\[나 다음 주 월요일에 반차 쓴다. 개인적인 일.\\]" |
| m0a-ch13 | escape | ○ | 0/29 | "[미안하다. 더 큰 데서 해 보고 싶었다.]" | "\\[미안하다. 더 큰 데서 해 보고 싶었다.\\]" |
| m0a-ch14 | escape | ○ | 0/29 | "[K테크, 신임 CTO에 박성진 씨 선임]" | "\\[K테크, 신임 CTO에 박성진 씨 선임\\]" |

### (b) 커뮤니티 · C1 — 29개

| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |
|---|---|---|---|---|---|
| blank-multi | blank-lines | ○ | 0/3 | "" ⏎ "" | (없음) |
| line-per-paragraph | whitespace | ○ | 0/1 | "\"야, 김민수!\"" ⏎ "익숙한 목소리였다." ⏎ "민수는 고개를 들었다." | "\"야, 김민수!\" 익숙한 목소리였다. 민수는 고개를 들었다. \"왜 이제 와.\" 성진이 숨을 몰아쉬며 웃었다." |
| blank-mixed | whitespace | ○ | 0/3 | "첫 번째 줄." ⏎ "바로 다음 줄." | "첫 번째 줄. 바로 다음 줄." |
| blank-tokens | text-loss | ○ | 0/3 | "<br>" ⏎ "" ⏎ "&nbsp;" | " " |
| blank-edges | blank-lines | ○ | 0/2 | "" ⏎ "" | (없음) |
| special-inline | text-loss, escape | ○ | 0/4 | "그는 ~진짜~ 몰랐다. ~~취소선~~ 같은 건 쓰지 않는다." | "그는 \\~진짜\\~ 몰랐다. 취소선 같은 건 쓰지 않는다." |
| special-brackets | escape, text-loss | ○ | 0/5 | "[ ] 체크박스처럼 보이는 줄." | "\\[ \\] 체크박스처럼 보이는 줄." |
| special-line-start | text-loss | ○ | 0/6 | "1. 첫째, 절대 뒤돌아보지 말 것." | "첫째, 절대 뒤돌아보지 말 것." |
| special-code-pipe | text-loss, other | ○ | 0/3 | "그는 `sudo`라고 입력했다." ⏎ "" ⏎ "백틱 하나 ` 홀로." | "그는 sudo라고 입력했다." |
| scene-breaks | other | ○ | 0/8 | "***" | "---" |
| scene-setext-trap | text-loss | ○ | 0/1 | "민수는 문을 닫았다." ⏎ "---" ⏎ "다음 날." | "## 민수는 문을 닫았다." ⏎ "" ⏎ "# 다음 날. 그리고 사흘 뒤." |
| system-window | escape, whitespace | ○ | 0/3 | "[시스템 메시지]" ⏎ "[퀘스트 '첫 만남'을 완료했습니다.]" ⏎ "[보상: 경험치 +100]" | "\\[시스템 메시지\\] \\[퀘스트 '첫 만남'을 완료했습니다.\\] \\[보상: 경험치 +100\\]" |
| emphasis-unclosed | escape, whitespace | ○ | 0/3 | "**닫히지 않은 강조." | "\\*\\*닫히지 않은 강조." |
| emphasis-cjk | escape | ○ | 0/3 | "**\"대사\"**를 굵게 쓰면 깨진다." | "\\*\\*\"대사\"\\*\\*를 굵게 쓰면 깨진다." |
| chars-urls | text-loss | ○ | 0/3 | "<https://example.com>" | "https://example.com" |
| chars-indent-trailing | other, text-loss, whitespace | ○ | 1/4 | "줄 끝에 공백 두 개  " | "줄 끝에 공백 두 개\\" |
| chars-html | text-loss | ○ | 0/3 | "<b>굵게</b> 태그." ⏎ "" ⏎ "&amp; 문자 그대로." | "**굵게** 태그." |
| eol-crlf | whitespace | ○ | 0/2 | "두 번째 문단." ⏎ "세 번째 줄." | "두 번째 문단. 세 번째 줄." |
| eol-multi-final-newline | blank-lines | ○ | 0/1 | "" ⏎ "" | (없음) |
| fm-basic | blank-lines | ○ | 0/1 | "" | (없음) |
| structure-blockquote | text-loss | ○ | 0/2 | "> 민수에게." ⏎ "> 잘 지내니?" | "> 민수에게. 잘 지내니?" |
| structure-hard-breaks | other | ○ | 0/2 | "공백 줄바꿈  " | "공백 줄바꿈\\" |
| edge-newlines-only | blank-lines | ○ | 0/0 | "" | (없음) |
| m0a-ch02 | escape | ○ | 0/32 | "[어제 설명회 어땠노? 괜찮은 사람 있더나?]" | "\\[어제 설명회 어땠노? 괜찮은 사람 있더나?\\]" |
| m0a-ch04 | escape | ○ | 0/27 | "[교수님, 오늘 회사를 세웠습니다.]" | "\\[교수님, 오늘 회사를 세웠습니다.\\]" |
| m0a-ch09 | escape | ○ | 0/30 | "[민수 군." | "\\[민수 군." |
| m0a-ch11 | escape | ○ | 0/37 | "[나 다음 주 월요일에 반차 쓴다. 개인적인 일.]" | "\\[나 다음 주 월요일에 반차 쓴다. 개인적인 일.\\]" |
| m0a-ch13 | escape | ○ | 0/29 | "[미안하다. 더 큰 데서 해 보고 싶었다.]" | "\\[미안하다. 더 큰 데서 해 보고 싶었다.\\]" |
| m0a-ch14 | escape | ○ | 0/29 | "[K테크, 신임 CTO에 박성진 씨 선임]" | "\\[K테크, 신임 CTO에 박성진 씨 선임\\]" |

### (b) 커뮤니티 · C2 — 30개

| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |
|---|---|---|---|---|---|
| blank-multi | blank-lines | ○ | 0/3 | "" ⏎ "" | (없음) |
| line-per-paragraph | whitespace | ○ | 0/1 | "\"야, 김민수!\"" ⏎ "익숙한 목소리였다." ⏎ "민수는 고개를 들었다." | "\"야, 김민수!\" 익숙한 목소리였다. 민수는 고개를 들었다. \"왜 이제 와.\" 성진이 숨을 몰아쉬며 웃었다." |
| blank-mixed | whitespace | ○ | 0/3 | "첫 번째 줄." ⏎ "바로 다음 줄." | "첫 번째 줄. 바로 다음 줄." |
| blank-tokens | text-loss, escape | ○ | 0/3 | "<br>" ⏎ "" | (없음) |
| blank-edges | blank-lines | ○ | 0/2 | "" ⏎ "" | (없음) |
| special-inline | text-loss, escape | ○ | 0/4 | "그는 ~진짜~ 몰랐다. ~~취소선~~ 같은 건 쓰지 않는다." | "그는 \\~진짜\\~ 몰랐다. 취소선 같은 건 쓰지 않는다." |
| special-brackets | escape, text-loss | ○ | 0/5 | "[ ] 체크박스처럼 보이는 줄." | "\\[ \\] 체크박스처럼 보이는 줄." |
| special-line-start | text-loss | ○ | 0/6 | "1. 첫째, 절대 뒤돌아보지 말 것." | "첫째, 절대 뒤돌아보지 말 것." |
| special-code-pipe | text-loss, other | ○ | 0/3 | "그는 `sudo`라고 입력했다." ⏎ "" ⏎ "백틱 하나 ` 홀로." | "그는 sudo라고 입력했다." |
| scene-breaks | other | ○ | 0/8 | "***" | "---" |
| scene-setext-trap | text-loss | ○ | 0/1 | "민수는 문을 닫았다." ⏎ "---" ⏎ "다음 날." | "## 민수는 문을 닫았다." ⏎ "" ⏎ "# 다음 날. 그리고 사흘 뒤." |
| system-window | escape, whitespace | ○ | 0/3 | "[시스템 메시지]" ⏎ "[퀘스트 '첫 만남'을 완료했습니다.]" ⏎ "[보상: 경험치 +100]" | "\\[시스템 메시지\\] \\[퀘스트 '첫 만남'을 완료했습니다.\\] \\[보상: 경험치 +100\\]" |
| emphasis-unclosed | escape, whitespace | ○ | 0/3 | "**닫히지 않은 강조." | "\\*\\*닫히지 않은 강조." |
| emphasis-cjk | escape | ○ | 0/3 | "**\"대사\"**를 굵게 쓰면 깨진다." | "\\*\\*\"대사\"\\*\\*를 굵게 쓰면 깨진다." |
| chars-urls | text-loss | ○ | 0/3 | "<https://example.com>" | "https://example.com" |
| chars-indent-trailing | other, text-loss, whitespace | ○ | 1/4 | "줄 끝에 공백 두 개  " | "줄 끝에 공백 두 개\\" |
| chars-html | text-loss | ○ | 0/3 | "<b>굵게</b> 태그." ⏎ "" ⏎ "&amp; 문자 그대로." | "**굵게** 태그." |
| eol-crlf | whitespace | ○ | 0/2 | "두 번째 문단." ⏎ "세 번째 줄." | "두 번째 문단. 세 번째 줄." |
| eol-multi-final-newline | blank-lines | ○ | 0/1 | "" ⏎ "" | (없음) |
| fm-basic | blank-lines | ○ | 0/1 | "" | (없음) |
| structure-blockquote | text-loss | ○ | 0/2 | "> 민수에게." ⏎ "> 잘 지내니?" | "> 민수에게. 잘 지내니?" |
| structure-hard-breaks | other | ○ | 0/2 | "공백 줄바꿈  " | "공백 줄바꿈\\" |
| edge-empty | escape | ○ | 0/0 | "" | "&nbsp;" |
| edge-newlines-only | escape | ○ | 0/0 | "" ⏎ "" | "&nbsp;" |
| m0a-ch02 | escape | ○ | 0/32 | "[어제 설명회 어땠노? 괜찮은 사람 있더나?]" | "\\[어제 설명회 어땠노? 괜찮은 사람 있더나?\\]" |
| m0a-ch04 | escape | ○ | 0/27 | "[교수님, 오늘 회사를 세웠습니다.]" | "\\[교수님, 오늘 회사를 세웠습니다.\\]" |
| m0a-ch09 | escape | ○ | 0/30 | "[민수 군." | "\\[민수 군." |
| m0a-ch11 | escape | ○ | 0/37 | "[나 다음 주 월요일에 반차 쓴다. 개인적인 일.]" | "\\[나 다음 주 월요일에 반차 쓴다. 개인적인 일.\\]" |
| m0a-ch13 | escape | ○ | 0/29 | "[미안하다. 더 큰 데서 해 보고 싶었다.]" | "\\[미안하다. 더 큰 데서 해 보고 싶었다.\\]" |
| m0a-ch14 | escape | ○ | 0/29 | "[K테크, 신임 CTO에 박성진 씨 선임]" | "\\[K테크, 신임 CTO에 박성진 씨 선임\\]" |

### (b) 커뮤니티 · C3 — 20개

| 사례 | 유형 | 멱등 | 비국소 문단 | 원본 | 저장 결과 |
|---|---|---|---|---|---|
| blank-tokens | text-loss, escape, blank-lines | ○ | 0/3 | "<br>" | (없음) |
| special-inline | text-loss, escape | ○ | 0/4 | "그는 ~진짜~ 몰랐다. ~~취소선~~ 같은 건 쓰지 않는다." | "그는 \\~진짜\\~ 몰랐다. 취소선 같은 건 쓰지 않는다." |
| special-brackets | escape, text-loss | ○ | 0/5 | "[ ] 체크박스처럼 보이는 줄." | "\\[ \\] 체크박스처럼 보이는 줄." |
| special-line-start | text-loss | ○ | 0/6 | "1. 첫째, 절대 뒤돌아보지 말 것." | "첫째, 절대 뒤돌아보지 말 것." |
| special-code-pipe | text-loss, other | × | 0/3 | "그는 `sudo`라고 입력했다." ⏎ "" ⏎ "백틱 하나 ` 홀로." | "그는 sudo라고 입력했다." |
| scene-breaks | other | ○ | 0/8 | "***" | "---" |
| system-window | escape | ○ | 0/7 | "[시스템 메시지]" ⏎ "[퀘스트 '첫 만남'을 완료했습니다.]" ⏎ "[보상: 경험치 +100]" | "\\[시스템 메시지\\]" ⏎ "\\[퀘스트 '첫 만남'을 완료했습니다.\\]" ⏎ "\\[보상: 경험치 +100\\]" |
| emphasis-unclosed | escape | ○ | 0/4 | "**닫히지 않은 강조." | "\\*\\*닫히지 않은 강조." |
| emphasis-cjk | escape | ○ | 0/3 | "**\"대사\"**를 굵게 쓰면 깨진다." | "\\*\\*\"대사\"\\*\\*를 굵게 쓰면 깨진다." |
| chars-urls | text-loss | ○ | 0/3 | "<https://example.com>" | "https://example.com" |
| chars-indent-trailing | whitespace | ○ | 2/6 | "줄 끝에 공백 두 개  " | "줄 끝에 공백 두 개" |
| chars-html | text-loss, escape | ○ | 0/3 | "<b>굵게</b> 태그." | "**굵게** 태그." |
| structure-blockquote | whitespace | ○ | 0/2 | ">" | "> " |
| structure-hard-breaks | escape, whitespace | ○ | 0/4 | "백슬래시 줄바꿈\\" | "백슬래시 줄바꿈\\\\" |
| m0a-ch02 | escape | ○ | 0/32 | "[어제 설명회 어땠노? 괜찮은 사람 있더나?]" | "\\[어제 설명회 어땠노? 괜찮은 사람 있더나?\\]" |
| m0a-ch04 | escape | ○ | 0/27 | "[교수님, 오늘 회사를 세웠습니다.]" | "\\[교수님, 오늘 회사를 세웠습니다.\\]" |
| m0a-ch09 | escape | ○ | 0/30 | "[민수 군." | "\\[민수 군." |
| m0a-ch11 | escape | ○ | 0/37 | "[나 다음 주 월요일에 반차 쓴다. 개인적인 일.]" | "\\[나 다음 주 월요일에 반차 쓴다. 개인적인 일.\\]" |
| m0a-ch13 | escape | ○ | 0/29 | "[미안하다. 더 큰 데서 해 보고 싶었다.]" | "\\[미안하다. 더 큰 데서 해 보고 싶었다.\\]" |
| m0a-ch14 | escape | ○ | 0/29 | "[K테크, 신임 CTO에 박성진 씨 선임]" | "\\[K테크, 신임 CTO에 박성진 씨 선임\\]" |

### (c) 직접 작성 · C3 — 0개

