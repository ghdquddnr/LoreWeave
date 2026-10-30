// AI 분석 화면 (M3-PLAN 1·5절): 설정 → 동의 → 분석 → 사실 패널 → 인용으로 이동. 가짜 OpenAI 서버를 쓴다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
let fake: FakeOpenAi;
let project: string;

before(async () => {
  fake = await startFakeOpenAi((user) =>
    user.includes('n="1"')
      ? {
          summary: '민수와 성진이 대학에 입학한다.',
          entities: [{ name: '김민수', aliases: ['민수'] }],
          facts: [
            { entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' },
            { entity: '김정호', predicate: '직업', value: '공장 운영', quote: "김정호는 수원에서 '대성정밀'이라는 자동차 부품 공장을 25년째 운영하고 있었다." },
          ],
        }
      : { summary: '요약', entities: [], facts: [] },
  );
  project = await tempDir('analysis-ui');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
});

after(async () => {
  await fake.close();
});

test('설정에서 키 저장 → 동의 → 이 화 분석 → 사실 패널 → 인용을 누르면 그 문장이 선택된다', async () => {
  const { app, page } = await launch(await tempDir('ud-ui'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    const facts = page.getByRole('complementary', { name: 'AI가 찾은 사실' });
    await facts.getByText('아직 분석하지 않은 화입니다').waitFor();

    // 키 없이 분석하면 설정이 열린다
    await page.getByRole('button', { name: '이 화 분석' }).click();
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.getByRole('textbox', { name: 'API 키' }).fill('sk-ui-test');
    await settings.getByRole('button', { name: '저장' }).click();
    await settings.getByText('저장됨 (암호화해 이 컴퓨터에만 보관)').waitFor();
    assert.equal(await settings.getByRole('textbox', { name: 'API 키' }).inputValue(), '');
    await settings.getByRole('button', { name: '연결 확인' }).click();
    await settings.getByText(/연결됨/).waitFor();
    await settings.getByRole('button', { name: '닫기' }).click();

    await page.getByRole('button', { name: '이 화 분석' }).click();
    const consent = page.getByRole('dialog', { name: '원고 전송 안내' });
    await consent.getByRole('button', { name: '동의하고 계속' }).click();
    await facts.getByRole('heading', { name: '김민수' }).waitFor();
    await facts.getByText('나이: 스무 살').waitFor();
    await page.getByRole('navigation', { name: '화 목록' }).getByLabel('AI 분석됨').waitFor();

    await facts.getByRole('button', { name: '“둘 다 스무 살이었다.”' }).click();
    await page.waitForFunction(() => window.getSelection()?.toString() === '둘 다 스무 살이었다.', null, { timeout: 3000 });
    await facts.getByRole('button', { name: /대성정밀/ }).click();
    await page.waitForFunction(() => window.getSelection()?.toString().includes('대성정밀'), null, { timeout: 3000 });
  } finally {
    await closeWindow(app);
  }
});

test('분석 뒤 고친 화는 "바뀜"으로 표시되고, 남은 화 분석은 예상 비용을 먼저 보여 준다', async () => {
  const { app, page } = await launch(await tempDir('ud-ui2'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.evaluate(() => window.loreweave.ai.setKey('sk-ui-test'));
    // 1화는 앞 테스트에서 분석됐다 (같은 프로젝트). 바깥에서 고친다
    await writeFile(join(project, 'chapters', '001.md'), '# 1화. 입학\n\n바뀐 본문\n');
    await page.getByRole('navigation', { name: '화 목록' }).getByLabel('AI 분석 뒤 바뀜').waitFor();

    await page.getByRole('button', { name: '남은 화 분석 (3)' }).click();
    // 이 사용자 데이터에서는 처음이라 전송 동의를 먼저 받는다
    await page.getByRole('dialog', { name: '원고 전송 안내' }).getByRole('button', { name: '동의하고 계속' }).click();
    const confirm = page.getByRole('dialog', { name: '분석 확인' });
    await confirm.getByText(/예상 비용 최대 \$0\.0\d+/).waitFor();
    const before = fake.requests.length;
    await confirm.getByRole('button', { name: '취소' }).click();
    assert.equal(fake.requests.length, before);

    await page.getByRole('button', { name: '남은 화 분석 (3)' }).click();
    await page.getByRole('dialog', { name: '분석 확인' }).getByRole('button', { name: '분석' }).click();
    await page.getByText(/화 3개 분석 · \$/).waitFor();
    await page.getByRole('button', { name: '남은 화 분석 (0)' }).waitFor();
  } finally {
    await closeWindow(app);
  }
});
