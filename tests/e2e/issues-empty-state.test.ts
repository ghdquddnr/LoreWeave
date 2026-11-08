// 문제 가능성 패널의 빈 상태 의미: 저장된 결과가 실제로 0건인 경우와, 결과는 있지만 지금 필터로 표시할 카드가 없는 경우를 구분한다.
// 합성 원고(M0A 복사본)·격리 userData·가짜 OpenAI 서버(무료). 검사 응답은 mode로 바꾼다: zero(0건) / low(낮은 확신 1개) / mixed(높은 확신 1개 + 낮은 확신 1개).
// 판정은 관측 가능한 문구·카드·버튼으로 한다. 합성 Electron 검사이며 수동 GUI·실제 IME·실모델·탐지율 검증이 아니다. 유료·외부 호출 없음.
// 관측 범위: 토글·무시 뒤 fake 서버의 요청 수가 그대로인 것까지만 본다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
const files = ['001.md', '002.md', '003.md'];
let fake: FakeOpenAi;
let project: string;
let mode: 'zero' | 'low' | 'mixed' = 'zero';

const high = { category: 'age', target_quote: '"스물두 살입니다."', claim: '1화에서 민수는 스무 살이다. 두 달 뒤 스물두 살일 수 없다.', evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }], confidence: 0.9 };
const low = { category: 'number', target_quote: '"스물두 살입니다."', claim: '모순으로 볼 근거가 없다.', evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }], confidence: 0.1 };

before(async () => {
  fake = await startFakeOpenAi((user) => {
    if (user.startsWith('# 참고 자료')) return { findings: mode === 'zero' ? [] : mode === 'low' ? [low] : [high, low] };
    return {
      summary: '요약',
      entities: [{ name: '김민수', aliases: ['민수'] }],
      facts: user.includes('<chapter n="1">') ? [{ entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' }] : [],
    };
  });
  project = await tempDir('issues-empty');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
});

after(async () => {
  await fake.close();
});

test('빈 상태: 실제 0건과 숨긴 결과만 있는 경우를 구분하고, 보기·무시한 결과 보기로 카드가 보이면 빈 상태 문구가 사라진다', { timeout: 180_000 }, async () => {
  const originals = await Promise.all(files.map((f) => readFile(join(project, 'chapters', f))));
  const { app, page } = await launch(await tempDir('ud-issues-empty'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.evaluate(() => window.loreweave.ai.setKey('sk-issues-empty'));
    const issues = page.getByRole('region', { name: '문제 가능성' });
    const chapter = (n: number) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: new RegExp(`^${n}화`) });
    const runCheck = async () => {
      await page.getByRole('button', { name: '이 화 검사' }).click();
      await page.getByRole('dialog', { name: 'AI 실행 확인' }).getByRole('button', { name: /^(동의하고 실행|실행)$/ }).click(); // 동의는 처음 한 번만 묻는다
      await page.getByText(/검사 완료/).waitFor({ timeout: 60_000 });
    };
    const emptyNone = issues.getByText('이번 검사에서 찾은 문제 가능성이 없습니다.');
    const emptyFiltered = issues.getByText('현재 표시할 결과가 없습니다.');
    const cards = issues.locator('.issue-card');

    // 1) 아직 검사하지 않음 → 검사했고 저장된 결과가 실제로 0건
    await chapter(2).click();
    await issues.getByText('아직 검사하지 않은 화입니다').waitFor();
    assert.equal(await emptyNone.count() + (await emptyFiltered.count()), 0, '검사 전에는 빈 결과 문구가 없다');
    mode = 'zero';
    await runCheck();
    await emptyNone.waitFor();
    await issues.getByText('문제가 없다는 뜻은 아닙니다', { exact: false }).waitFor();
    assert.equal(await emptyFiltered.count(), 0, '실제 0건에는 필터 안내가 아니다');
    assert.equal(await cards.count(), 0);
    assert.equal(await issues.getByRole('button', { name: /보기$/ }).count(), 0, '숨긴 결과가 없으니 보기 버튼도 없다');

    // 2) 낮은 확신만 있어 숨김 → 필터 안내 → 보기로 카드, 문구 제거 → 다시 숨기기
    await chapter(3).click();
    await issues.getByText('아직 검사하지 않은 화입니다').waitFor();
    mode = 'low';
    await runCheck();
    await emptyFiltered.waitFor();
    assert.equal(await emptyNone.count(), 0, '숨긴 결과만 있는데 "찾은 문제가 없다"고 하지 않는다');
    assert.equal(await cards.count(), 0);
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click();
    await issues.getByText('숫자·금액', { exact: true }).waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal(await emptyFiltered.count() + (await emptyNone.count()), 0, '카드가 보이면 빈 상태 문구가 사라진다');
    await issues.getByRole('button', { name: '확신이 낮은 결과 숨기기' }).click();
    await emptyFiltered.waitFor();
    assert.equal(await cards.count(), 0);

    // 3) 높은 확신 결과를 무시 (+ 낮은 확신 결과가 겹침) → 필터 안내 → 무시한 결과 보기
    mode = 'mixed';
    await runCheck();
    await issues.getByRole('heading', { name: '문제 가능성 (1)' }).waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal(await emptyFiltered.count() + (await emptyNone.count()), 0, '보이는 카드가 있으면 빈 상태 문구가 없다');
    const requestsBefore = fake.requests.length;
    await issues.getByRole('button', { name: '무시' }).first().click();
    await emptyFiltered.waitFor();
    assert.equal(await emptyNone.count(), 0);
    assert.equal(await cards.count(), 0);
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).waitFor();
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).waitFor();
    // 무시한 결과만 보기: 낮은 확신 결과는 아직 숨겨져 있고 카드는 하나다
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).click();
    await issues.getByText('무시함').waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal(await emptyFiltered.count(), 0, '무시한 결과 카드가 보이면 빈 상태 문구가 사라진다');
    await issues.getByRole('button', { name: '무시한 결과 숨기기' }).click();
    await emptyFiltered.waitFor();
    // 낮은 확신 결과만 보기: 무시한 결과는 숨겨져 있고 카드는 하나다
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click();
    await issues.getByText('숫자·금액', { exact: true }).waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal(await emptyFiltered.count(), 0);
    await issues.getByRole('button', { name: '확신이 낮은 결과 숨기기' }).click();
    await emptyFiltered.waitFor();

    // 표시·토글·무시만으로는 새 분석·검사 요청이 없고, 원고는 그대로다
    assert.equal(fake.requests.length, requestsBefore, '무시와 토글은 새 요청을 만들지 않았다 (관측 범위 안)');
    const after = await Promise.all(files.map((f) => readFile(join(project, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});
