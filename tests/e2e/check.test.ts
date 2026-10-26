// 연속성 검사를 실제 앱에서 (M4-PLAN 5절). 화면은 다음 단계이고, 여기서는 main 기능을 window.loreweave로 부른다.
// 가짜 OpenAI 서버를 써서 비용 없이 확인한다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
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
            claim: '1화에서 민수는 스무 살이다.',
            evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }],
            confidence: 0.9,
          },
        ],
      };
    }
    const first = user.includes('<chapter n="1">');
    return {
      summary: '요약',
      entities: [{ name: '김민수', aliases: ['민수'] }],
      facts: first ? [{ entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' }] : [],
    };
  });
  project = await tempDir('check');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
});

after(async () => {
  await fake.close();
});

// 분석·검사 IPC에는 요청한 화면의 프로젝트 token을 함께 보낸다. 새 사용자 데이터에서 처음 연 프로젝트는 token 1이다

test('검사: 앞 화를 먼저 분석하고, 결과·상태·무시를 main에서 처리하며, 원고는 바꾸지 않는다', async () => {
  const before = await readFile(join(project, 'chapters', '003.md'));
  const { app, page } = await launch(await tempDir('ud-check'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();

    const noConsent = await page.evaluate(() => window.loreweave.ai.runCheck('003.md', 1).then(() => '', (e: Error) => e.message));
    assert.match(noConsent, /원고 전송에 동의해야/);
    await page.evaluate(() => window.loreweave.ai.setKey('sk-check-test'));
    await page.evaluate(() => window.loreweave.ai.setConsent(true));

    const firstPlan = await page.evaluate(() => window.loreweave.ai.planCheck('001.md', 1).then(() => '', (e: Error) => e.message));
    assert.match(firstPlan, /앞 화가 없어/);
    const plan = await page.evaluate(() => window.loreweave.ai.planCheck('003.md', 1));
    assert.deepEqual(plan.analyze, ['001.md', '002.md', '003.md']);
    assert.equal(plan.priors, 2);
    assert.equal(fake.requests.length, 0);

    const outcome = await page.evaluate(() => window.loreweave.ai.runCheck('003.md', 1));
    assert.deepEqual({ checked: outcome.checked, findings: outcome.findings, stopped: outcome.stopped }, { checked: true, findings: 1, stopped: null });
    assert.equal(fake.requests.filter((r) => r.path.endsWith('/responses')).length, 4);

    const result = await page.evaluate(() => window.loreweave.ai.checkResult('003.md'));
    assert.ok(result);
    assert.deepEqual(
      result.findings.map((f) => [f.category, f.dismissed, f.evidence.map((e) => e.file)]),
      [['age', false, ['001.md']]],
    );
    const status = await page.evaluate(() => window.loreweave.ai.analysisStatus());
    assert.deepEqual(status.checkStates, { '001.md': 'none', '002.md': 'none', '003.md': 'fresh' });

    await page.evaluate(() => window.loreweave.ai.dismiss('003.md', 0));
    assert.equal((await page.evaluate(() => window.loreweave.ai.checkResult('003.md')))!.findings[0]!.dismissed, true);
    // 다시 검사해도 숨는다 (분석은 다시 하지 않는다)
    const again = await page.evaluate(() => window.loreweave.ai.runCheck('003.md', 1));
    assert.equal(again.analysis, null);
    assert.equal(fake.requests.filter((r) => r.path.endsWith('/responses')).length, 5);
    assert.equal((await page.evaluate(() => window.loreweave.ai.checkResult('003.md')))!.findings[0]!.dismissed, true);
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(await readFile(join(project, 'chapters', '003.md')), before);
});
