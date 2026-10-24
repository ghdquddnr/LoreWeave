// 원고 형식 회귀 테스트용 코퍼스. M0-B 코퍼스(spikes/m0b-editor-feasibility/corpus/cases.ts)를 옮겨 왔다.
// 줄바꿈·BOM·보이지 않는 문자를 이스케이프로 적어 git과 편집기가 바이트를 바꾸지 못하게 한다.
// 템플릿 리터럴은 CR을 LF로 바꾸므로 쓰지 않는다.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Group =
  | 'blank'
  | 'special'
  | 'scene'
  | 'emphasis'
  | 'chars'
  | 'eol'
  | 'frontmatter'
  | 'structure'
  | 'edge'
  | 'm0a';

export interface CorpusCase {
  id: string;
  group: Group;
  note: string;
  raw: string;
  /** byte 동일을 기대하지 않는 이유 (문서화된 예외) */
  exception?: string;
}

const lines = (...ls: string[]) => ls.join('\n');
const crlf = (s: string) => s.replace(/\n/g, '\r\n');
const BOM = '\uFEFF';
const NBSP = '\u00A0';
const ZWSP = '\u200B';
const IDEO_SPACE = '\u3000';
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
const FLAG_KR = '\u{1F1F0}\u{1F1F7}';

const HANDWRITTEN: CorpusCase[] = [
  // 빈 줄 규약 (C1 / C2 / C3)
  {
    id: 'blank-single',
    group: 'blank',
    note: 'C1: 빈 줄 하나로 문단 구분',
    raw: lines('민수는 창밖을 보았다. 비가 오고 있었다.', '', '"우산 있어?"', '', '지현이 고개를 저었다.', ''),
  },
  {
    id: 'blank-multi',
    group: 'blank',
    note: '의도적 여백: 연속 빈 줄 2개, 3개',
    raw: lines('그날 밤, 아무도 잠들지 못했다.', '', '', '', '다음 날 아침.', '', '', '민수는 혼자였다.', ''),
  },
  {
    id: 'line-per-paragraph',
    group: 'blank',
    note: 'C3: 한 줄 = 한 문단, 빈 줄 없음 (웹소설 원고 관행)',
    raw: lines('"야, 김민수!"', '익숙한 목소리였다.', '민수는 고개를 들었다.', '"왜 이제 와."', '성진이 숨을 몰아쉬며 웃었다.', ''),
  },
  {
    id: 'blank-mixed',
    group: 'blank',
    note: '줄바꿈 하나, 빈 줄 하나, 빈 줄 둘이 섞임',
    raw: lines('첫 번째 줄.', '바로 다음 줄.', '', '빈 줄 하나 뒤.', '', '', '빈 줄 둘 뒤.', '마지막 줄.', ''),
  },
  {
    id: 'blank-tokens',
    group: 'blank',
    note: 'C2: 빈 문단 토큰 (<br>, &nbsp;, NBSP만 있는 줄)',
    raw: lines('장면이 끝났다.', '', '<br>', '', '&nbsp;', '', '새로운 장면.', '', NBSP, '', '끝.', ''),
  },
  {
    id: 'blank-edges',
    group: 'blank',
    note: '본문 앞 빈 줄 2개, 끝 빈 줄 3개',
    raw: lines('', '', '앞에 빈 줄이 두 개 있다.', '', '뒤에 빈 줄이 세 개 있다.', '', '', '', ''),
  },

  // 특수문자
  {
    id: 'special-inline',
    group: 'special',
    note: '문장 중 * _ ~ ~~',
    raw: lines(
      '계산은 간단했다. 5*5=25, 그리고 2*3=6.',
      '',
      '변수 이름은 user_name_2였다.',
      '',
      '그는 ~진짜~ 몰랐다. ~~취소선~~ 같은 건 쓰지 않는다.',
      '',
      '별 하나 * 하나.',
      '',
    ),
  },
  {
    id: 'special-brackets',
    group: 'special',
    note: '[ ] < > & \\ 와 링크처럼 보이는 문장',
    raw: lines(
      '[ ] 체크박스처럼 보이는 줄.',
      '',
      '그녀는 <그 남자>라고만 불렀다.',
      '',
      'A & B 상사. R&D 팀.',
      '',
      '경로는 C:\\Users\\민수\\원고였다.',
      '',
      '링크처럼 보이는 [제목](없음)과 [각주].',
      '',
    ),
  },
  {
    id: 'special-line-start',
    group: 'special',
    note: '줄 시작 # 1. - + > 와 "2007. 3. 2." 날짜',
    raw: lines(
      '# 해시태그로 시작하는 문장',
      '',
      '#해시태그 붙여 쓰기',
      '',
      '1. 첫째, 절대 뒤돌아보지 말 것.',
      '',
      '2007. 3. 2. 입학식 날이었다.',
      '',
      '- 대시로 시작하는 대사였다.',
      '',
      '+ 플러스로 시작.',
      '',
      '> 인용처럼 보이는 문장.',
      '',
      '10) 괄호 번호.',
      '',
    ),
  },
  {
    id: 'special-code-pipe',
    group: 'special',
    note: '백틱, 혼자 있는 ``` 줄, 파이프',
    raw: lines(
      '그는 `sudo`라고 입력했다.',
      '',
      '백틱 하나 ` 홀로.',
      '',
      '```',
      '',
      '선택지는 A | B | C 셋이었다.',
      '',
      '|표처럼| 보이는 |줄|',
      '',
    ),
  },

  // 장면 전환
  {
    id: 'scene-breaks',
    group: 'scene',
    note: '--- *** * * * ◇◆◇ ○ ○ ○',
    raw: lines(
      '첫 장면.',
      '',
      '---',
      '',
      '두 번째 장면.',
      '',
      '***',
      '',
      '세 번째.',
      '',
      '* * *',
      '',
      '네 번째.',
      '',
      '◇◆◇',
      '',
      '다섯 번째.',
      '',
      '○ ○ ○',
      '',
      '끝.',
      '',
    ),
  },
  {
    id: 'scene-setext-trap',
    group: 'scene',
    note: 'C3에서 빈 줄 없이 --- / === 를 쓰면 CommonMark는 제목(setext)으로 읽는다',
    raw: lines('민수는 문을 닫았다.', '---', '다음 날.', '그리고 사흘 뒤.', '===', '결국 아무도 오지 않았다.', ''),
  },
  {
    id: 'system-window',
    group: 'scene',
    note: '시스템창 블록',
    raw: lines(
      '[시스템 메시지]',
      "[퀘스트 '첫 만남'을 완료했습니다.]",
      '[보상: 경험치 +100]',
      '',
      '【상태창】',
      '이름: 김민수',
      '레벨: 1',
      '',
      '『스킬 획득: 집중』',
      '',
    ),
  },

  // 강조
  {
    id: 'emphasis-normal',
    group: 'emphasis',
    note: '정상 **굵게** *기울임* ***둘 다***',
    raw: lines('그건 **절대** 안 된다.', '', '*아마도* 그럴 것이다.', '', '***정말로*** 끝이었다.', ''),
  },
  {
    id: 'emphasis-unclosed',
    group: 'emphasis',
    note: '닫히지 않은 **, 홀로 있는 * **, 줄을 넘는 강조',
    raw: lines('**닫히지 않은 강조.', '', '별표 * 하나와 ** 둘.', '', '**여러 줄에', '걸친 강조**.', ''),
  },
  {
    id: 'emphasis-cjk',
    group: 'emphasis',
    note: '한국어 조사·따옴표에 붙은 강조 (CommonMark flanking 규칙 문제)',
    raw: lines('**"대사"**를 굵게 쓰면 깨진다.', '', '정말**진짜**로 몰랐다.', '', '그는 *「비밀」*이라고 했다.', ''),
  },

  // 문자
  {
    id: 'chars-quotes',
    group: 'chars',
    note: '“ ” ‘ ’ 「 」 『 』 …… ...',
    raw: lines(
      '“그래서?” 그녀가 물었다.',
      '',
      '‘혼잣말’이었다.',
      '',
      '「알겠습니다.」',
      '',
      '『월간 소설』 3월호.',
      '',
      '그는…… 말이 없었다. 그리고... 떠났다.',
      '',
    ),
  },
  {
    id: 'chars-invisible',
    group: 'chars',
    note: '전각 공백 들여쓰기, NBSP, ZWSP, 이모지 (ZWJ, 국기)',
    raw: lines(
      `${IDEO_SPACE}전각 공백으로 들여쓴 문단.`,
      '',
      `줄${NBSP}바꿈${NBSP}없는${NBSP}공백.`,
      '',
      `폭${ZWSP}없는${ZWSP}공백.`,
      '',
      `이모지 😀 ${FAMILY} ${FLAG_KR} 도 있다.`,
      '',
    ),
  },
  {
    id: 'chars-urls',
    group: 'chars',
    note: 'URL, 자동 링크, 메일 주소',
    raw: lines(
      '주소는 https://example.com/path?q=1&b=2_3 이다.',
      '',
      '<https://example.com>',
      '',
      '메일은 minsu@example.com.',
      '',
    ),
  },
  {
    id: 'chars-indent-trailing',
    group: 'chars',
    note: '줄 끝 공백 1·2개, 탭·공백 4칸 들여쓰기 (코드 블록으로 읽힐 위험)',
    raw: lines(
      '줄 끝에 공백 두 개  ',
      '다음 줄.',
      '',
      '줄 끝 공백 하나 ',
      '',
      '\t탭으로 들여쓴 문단.',
      '',
      '    공백 네 칸 들여쓰기.',
      '',
      '  공백 두 칸 들여쓰기.',
      '',
    ),
  },
  {
    id: 'chars-html',
    group: 'chars',
    note: '&lt; 엔티티, HTML 태그, 작가 메모 주석',
    raw: lines(
      '&lt;태그&gt;처럼 쓴 글자.',
      '',
      '<b>굵게</b> 태그.',
      '',
      '&amp; 문자 그대로.',
      '',
      '<!-- 작가 메모: 나중에 고칠 것 -->',
      '',
    ),
  },

  // 줄바꿈과 BOM
  {
    id: 'eol-crlf',
    group: 'eol',
    note: '전체 CRLF',
    raw: crlf(lines('윈도우 메모장에서 쓴 원고.', '', '두 번째 문단.', '세 번째 줄.', '')),
  },
  {
    id: 'eol-no-final-newline',
    group: 'eol',
    note: '마지막 개행 없음',
    raw: lines('마지막 개행이 없다.', '', '정말 없다.'),
  },
  {
    id: 'eol-multi-final-newline',
    group: 'eol',
    note: '마지막 개행 여러 개',
    raw: lines('끝에 개행이 여러 개.', '', '', ''),
  },
  {
    id: 'eol-mixed',
    group: 'eol',
    note: 'CRLF와 LF 혼합',
    raw: '첫 줄.\r\n\r\n둘째 줄.\n\n셋째 줄.\r\n',
    exception: '혼합 줄바꿈은 LF로 정규화해 저장한다 (보존 정책은 REPORT에서 결정)',
  },
  {
    id: 'eol-bom-crlf',
    group: 'eol',
    note: 'BOM + CRLF (윈도우 편집기 저장 형식)',
    raw: BOM + crlf(lines('BOM이 붙은 원고.', '', '두 번째 문단.', '')),
  },

  // frontmatter
  {
    id: 'fm-basic',
    group: 'frontmatter',
    note: '알 수 없는 키, 키 순서, 주석, 목록',
    raw: lines(
      '---',
      'title: 1화. 입학',
      'pov: 민수',
      'custom_key: 알 수 없는 키',
      'order: 1',
      '# 작가 메모: 키 순서 유지',
      'tags:',
      '  - 학교',
      '  - 첫 만남',
      '---',
      '',
      '본문 첫 문단.',
      '',
    ),
  },
  {
    id: 'fm-korean-bom-crlf',
    group: 'frontmatter',
    note: '한국어 키 + BOM + CRLF',
    raw: BOM + crlf(lines('---', '제목: 2화', '작성일: 2026-10-24', '---', '본문.', '')),
  },
  {
    id: 'fm-scene-break-start',
    group: 'frontmatter',
    note: '--- 장면 전환으로 시작하는 화 (frontmatter가 아님)',
    raw: lines('---', '', '장면 전환으로 시작하는 화.', '', '---', '', '두 번째 장면.', ''),
  },
  {
    id: 'fm-ambiguous',
    group: 'frontmatter',
    note: '--- 사이에 "키: 값" 한 줄. frontmatter로 읽힌다 (작가 의도는 장면 전환일 수 있음)',
    raw: lines('---', '시간: 새벽 3시', '---', '민수는 깨어 있었다.', ''),
  },

  // 구조 (지원 서브셋: 문단, 강제 줄바꿈, 굵게/기울임, 구분선, 인용, 제목)
  {
    id: 'structure-blockquote',
    group: 'structure',
    note: '여러 줄 인용 (편지)',
    raw: lines('편지에는 이렇게 적혀 있었다.', '', '> 민수에게.', '> 잘 지내니?', '>', '> 지현이가.', '', '편지는 거기서 끝났다.', ''),
  },
  {
    id: 'structure-hard-breaks',
    group: 'structure',
    note: '백슬래시 줄바꿈, 공백 두 개 줄바꿈',
    raw: lines('백슬래시 줄바꿈\\', '다음 줄.', '', '공백 줄바꿈  ', '다음 줄.', ''),
  },
  {
    id: 'structure-headings',
    group: 'structure',
    note: '화 제목과 소제목 (M0-A 챕터가 # 제목으로 시작)',
    raw: lines('# 1화. 입학', '', '본문.', '', '## 소제목', '', '본문 둘.', ''),
  },

  // 경계
  { id: 'edge-empty', group: 'edge', note: '빈 파일', raw: '' },
  { id: 'edge-newlines-only', group: 'edge', note: '개행만 있는 파일', raw: lines('', '', '') },
];

// M0-A 벤치마크 챕터 (main에 유지된 데이터)
const M0A_CHAPTERS = join(__dirname, '../../../spikes/m0a-ai-feasibility/benchmark/chapters');

function m0aChapters(): CorpusCase[] {
  return readdirSync(M0A_CHAPTERS)
    .filter((f) => /^ch\d+\.md$/.test(f))
    .sort()
    .map((f) => ({
      id: `m0a-${f.replace(/\.md$/, '')}`,
      group: 'm0a' as const,
      note: 'M0-A 합성 챕터',
      raw: readFileSync(join(M0A_CHAPTERS, f), 'utf8'),
    }));
}

export function loadCorpus(): CorpusCase[] {
  return [...HANDWRITTEN, ...m0aChapters()];
}
