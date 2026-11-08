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
    // 검사 요청(검사 프롬프트 '# 참고 자료')의 수가 하나 늘고, 실행이 끝나 [이 화 검사]가 다시 눌릴 때까지 기다린다 (이전 검사의 '검사 완료' 문구가 남아 있어 문구만으로는 끝을 알 수 없다)
    const checkRequests = () => fake.requests.filter((r) => JSON.stringify(r.body).includes('# 참고 자료')).length;
    const runCheck = async () => {
      const before = checkRequests();
      await page.getByRole('button', { name: '이 화 검사' }).click();
      await page.getByRole('dialog', { name: 'AI 실행 확인' }).getByRole('button', { name: /^(동의하고 실행|실행)$/ }).click(); // 동의는 처음 한 번만 묻는다
      for (let n = 0; n < 600 && checkRequests() === before; n++) await page.waitForTimeout(25);
      assert.equal(checkRequests(), before + 1, '검사 요청이 한 번 갔다');
      await page.getByRole('button', { name: '이 화 검사' }).and(page.locator(':enabled')).waitFor({ timeout: 60_000 });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
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

    // 3) 높은 확신 결과를 무시 (같은 검사에 낮은 확신 결과가 따로 하나 더 있는 다른 두 카드 조합) → 필터 안내 → 무시한 결과 보기
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

    // 4) 같은 결과가 낮은 확신이면서 무시된 경우 (한 finding에 두 필터가 겹침): 낮은 확신 카드를 보이게 한 뒤 무시하고, 화를 오가며 필터를 초기화해도 버튼으로 다시 닿는다
    const backToThree = async () => {
      await chapter(2).click();
      await issues.getByText('이번 검사에서 찾은 문제 가능성이 없습니다.').waitFor();
      await chapter(3).click();
      await issues.getByRole('heading', { name: /^문제 가능성/ }).waitFor();
    };
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click();
    await issues.locator('.issue-card.low').getByRole('button', { name: '무시' }).click();
    await emptyFiltered.waitFor(); // 무시한 낮은 확신 카드는 보이지 않는다
    assert.equal(await cards.count(), 0);
    await backToThree(); // 두 토글이 초기화된다
    await emptyFiltered.waitFor();
    assert.equal(await cards.count(), 0);
    assert.equal(await issues.getByRole('button', { name: /^확신이 낮아 숨긴 결과/ }).count(), 0, '무시를 숨긴 동안 낮은 확신 버튼은 같은 결과를 세지 않는다');
    await issues.getByRole('button', { name: '무시한 결과 2개 보기' }).click();
    assert.equal(await cards.count(), 1, '무시한 높은 확신 카드만 보이고, 낮은 확신 카드는 아직 숨겨져 있다');
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click(); // 이제 낮은 확신 토글이 나타난다
    await issues.locator('.issue-card.low').waitFor();
    assert.equal(await cards.count(), 2, '무시한 낮은 확신 카드에도 두 토글로 닿는다');
    assert.equal(await emptyFiltered.count(), 0, '카드가 보이면 빈 상태 문구가 사라진다');
    await issues.getByRole('button', { name: '확신이 낮은 결과 숨기기' }).click();
    await issues.getByRole('button', { name: '무시한 결과 숨기기' }).click();
    await emptyFiltered.waitFor();

    // 5) 낮은 확신 결과 하나뿐이고 그것이 무시된 경우 (4)에서 무시한 같은 결과가 새 검사에도 무시로 이어진다): 버튼 없는 막다른 길이 되지 않는다
    assert.equal(fake.requests.length, requestsBefore, '3)~4)의 무시와 토글은 새 요청을 만들지 않았다 (관측 범위 안)');
    mode = 'low';
    await runCheck();
    const requestsAfterCheck = fake.requests.length; // 새 검사 자체의 요청은 여기까지
    await emptyFiltered.waitFor();
    // 같은 낮은 확신 결과는 앞에서 이미 무시했고 그 무시는 새 검사에도 이어진다: 이 화의 유일한 결과가 무시된 낮은 확신 결과다
    assert.equal(await issues.getByRole('button', { name: /^확신이 낮아 숨긴 결과/ }).count(), 0);
    assert.equal(await cards.count(), 0);
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).click(); // 유일한 길: 무시 토글
    assert.equal(await cards.count(), 0, '낮은 확신 필터가 아직 가리고 있다');
    await emptyFiltered.waitFor();
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click(); // 그 뒤 낮은 확신 토글이 나타난다
    await issues.getByText('무시함').waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal(await emptyFiltered.count() + (await emptyNone.count()), 0);

    // 표시·토글·무시만으로는 새 분석·검사 요청이 없고, 원고는 그대로다
    assert.equal(fake.requests.length, requestsAfterCheck, '5)의 토글도 새 요청을 만들지 않았다 (관측 범위 안)');
    const after = await Promise.all(files.map((f) => readFile(join(project, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});
