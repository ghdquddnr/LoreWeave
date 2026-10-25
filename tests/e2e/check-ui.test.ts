// 연속성 검사 화면 (M4-PLAN 1·5절): [이 화 검사] → 확인 창 → 문제 가능성 → 이 화 문장·근거로 이동 → 무시.
// 가짜 OpenAI 서버를 쓴다.

import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
let fake: FakeOpenAi;
let project: string;

before(async () => {
  fake = await startFakeOpenAi((user) => {
    if (user.startsWith('# 참고 자료')) {
      return {
        findings: [
          {
            category: 'age',
            target_quote: '"스물두 살입니다."',
            claim: '1화에서 민수는 스무 살이다. 두 달 뒤 스물두 살일 수 없다.',
            evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }],
            confidence: 0.9,
          },
        ],
      };
    }
    return {
      summary: '요약',
      entities: [{ name: '김민수', aliases: ['민수'] }],
      facts: user.includes('<chapter n="1">') ? [{ entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' }] : [],
    };
  });
  project = await tempDir('check-ui');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
});

after(async () => {
  await fake.close();
});

test('이 화 검사: 먼저 분석할 화와 비용을 확인받고, 문제 가능성의 문장과 근거로 이동하고, 무시하면 숨는다', async () => {
  const { app, page } = await launch(await tempDir('ud-check-ui'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.evaluate(() => window.loreweave.ai.setKey('sk-check-ui'));
    const issues = page.getByRole('region', { name: '문제 가능성' });

    // 1화는 앞 화가 없다
    await page.getByRole('button', { name: '이 화 검사' }).click();
    await page.getByRole('dialog', { name: '원고 전송 안내' }).getByRole('button', { name: '동의하고 계속' }).click();
    await page.getByText('앞 화가 없어 검사할 수 없습니다').waitFor();

    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: /^3화/ }).click();
    await issues.getByText('아직 검사하지 않은 화입니다').waitFor();
    await page.getByRole('button', { name: '이 화 검사' }).click();
    const confirm = page.getByRole('dialog', { name: '검사 확인' });
    await confirm.getByText('이 화를 앞 화 2개와 비교할까요?').waitFor();
    await confirm.getByText(/먼저 화 3개를 분석합니다 \(001\.md, 002\.md, 003\.md\)/).waitFor();
    const before = fake.requests.length;
    await confirm.getByRole('button', { name: '취소' }).click();
    assert.equal(fake.requests.length, before);

    await page.getByRole('button', { name: '이 화 검사' }).click();
    await page.getByRole('dialog', { name: '검사 확인' }).getByRole('button', { name: '검사' }).click();
    await page.getByText(/검사 완료: 문제 가능성 1개 · \$[\d.]+ · 먼저 분석한 화 3개/).waitFor();
    await issues.getByRole('heading', { name: '문제 가능성 (1)' }).waitFor();
    await issues.getByText('앞 화 2개의 사실 1개와 비교', { exact: false }).waitFor();
    await issues.getByText('나이', { exact: true }).waitFor();

    // 이 화 문장으로
    await issues.getByRole('button', { name: /^이 화: / }).click();
    await page.waitForFunction(() => window.getSelection()?.toString() === '"스물두 살입니다."', null, { timeout: 3000 });
    // 근거(1화)로: 1화가 열리고 근거 문장이 선택된다
    await issues.getByRole('button', { name: '1화: “둘 다 스무 살이었다.”' }).click();
    await page.waitForFunction(() => window.getSelection()?.toString() === '둘 다 스무 살이었다.', null, { timeout: 5000 });
    assert.match((await page.locator('.ProseMirror').textContent()) ?? '', /^1화\. 입학/);

    // 3화로 돌아가 무시
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: /^3화/ }).click();
    await issues.getByRole('button', { name: '무시' }).click();
    await issues.getByText('찾은 문제 가능성이 없습니다.').waitFor();
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).click();
    await issues.getByText('무시함').waitFor();
  } finally {
    await closeWindow(app);
  }
});
