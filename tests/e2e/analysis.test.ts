// 화별 사실 추출을 실제 앱에서 (M3-PLAN 5절). 가짜 OpenAI 서버를 써서 비용 없이 확인한다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { AnalyzeProgress } from '../../src/preload/api.ts';
import { diag } from './diag.ts';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
const KEY = 'sk-e2e-fake-key';
let fake: FakeOpenAi;
let project: string;

before(async () => {
  fake = await startFakeOpenAi((user) => ({
    summary: '가짜 요약',
    entities: [{ name: '김민수', aliases: ['민수'] }],
    facts: user.includes('스무 살')
      ? [
          { entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' },
          { entity: '김민수', predicate: '고향', value: '서울', quote: '민수는 서울에서 태어났다.' },
        ]
      : [],
  }));
  project = await tempDir('analysis');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
});

after(async () => {
  await fake.close();
});

// 분석·검사 IPC에는 요청한 화면의 프로젝트 token을 함께 보낸다. 새 사용자 데이터에서 처음 연 프로젝트는 token 1이다

test('키 없이, 동의 없이는 분석하지 않고, AI를 쓰기 전에는 ai.db를 만들지 않는다', async () => {
  const { app, page } = await launch(await tempDir('ud-none'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    const status = await page.evaluate(() => window.loreweave.ai.analysisStatus(1));
    const none = { '001.md': 'none', '002.md': 'none' };
    assert.deepEqual(status, { states: none, checkStates: none, issueCounts: {}, totalCostUsd: 0, recoveredFrom: null, consent: false });
    const noConsent = await page.evaluate(() => window.loreweave.ai.analyze(['001.md'], 1).then(() => '', (e: Error) => e.message));
    assert.match(noConsent, /원고 전송에 동의해야/);
    await page.evaluate(() => window.loreweave.ai.setConsent(true));
    const noKey = await page.evaluate(() => window.loreweave.ai.analyze(['001.md'], 1).then(() => '', (e: Error) => e.message));
    assert.match(noKey, /API 키가 없습니다/);
    assert.equal((await readdir(join(project, '.loreweave'))).includes('ai.db'), false);
    assert.equal(fake.requests.length, 0);
  } finally {
    await closeWindow(app);
  }
});

test('분석: 키를 붙여 요청하고, 인용이 있는 사실만 저장하고, 원고는 바꾸지 않는다', async () => {
  const before = await readFile(join(project, 'chapters', '001.md'));
  const { app, page } = await launch(await tempDir('ud-ai'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.evaluate((key) => window.loreweave.ai.setKey(key), KEY);
    await page.evaluate(() => window.loreweave.ai.setConsent(true));
    const checked = await page.evaluate(() => window.loreweave.ai.check());
    // 진단 기록(선택): 가짜 서버 연결 실패가 있었던 순간에 서버가 받은 요청 수를 남긴다 (fake-openai.log와 시각으로 맞춘다)
    if (!checked.ok) diag('fail.log', `analysis check=${JSON.stringify(checked)} fakePort=${new URL(fake.baseUrl).port} fakeRequests=${fake.requests.length}`);
    assert.deepEqual(checked, { ok: true });

    const estimate = await page.evaluate(() => window.loreweave.ai.estimate(['001.md', '002.md'], 1));
    assert.ok(estimate.costUsd > 0 && estimate.costUsd < 0.01);

    const result = (await page.evaluate(async () => {
      const seen: number[] = [];
      const off = window.loreweave.ai.onProgress((p) => seen.push(p.done));
      const final = await window.loreweave.ai.analyze(['001.md', '002.md'], 1);
      off();
      return { final, seen };
    })) as { final: AnalyzeProgress; seen: number[] };
    assert.deepEqual({ ...result.final, costUsd: result.final.costUsd.toFixed(4) }, {
      total: 2,
      done: 2,
      failed: [],
      costUsd: '0.0010',
      stopped: null,
    });
    assert.ok(result.seen.includes(2));

    const calls = fake.requests.filter((r) => r.path.endsWith('/responses'));
    assert.equal(calls.length, 2);
    for (const r of fake.requests) assert.equal(r.authorization, `Bearer ${KEY}`);

    const analysis = await page.evaluate(() => window.loreweave.ai.analysis('001.md', 1));
    assert.ok(analysis);
    assert.equal(analysis.droppedQuotes, 1);
    assert.deepEqual(analysis.facts.map((f) => f.quote), ['둘 다 스무 살이었다.']);
    const status = await page.evaluate(() => window.loreweave.ai.analysisStatus(1));
    assert.deepEqual(status.states, { '001.md': 'fresh', '002.md': 'fresh' });
    assert.equal(status.totalCostUsd.toFixed(4), '0.0010');
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(await readFile(join(project, 'chapters', '001.md')), before);
  assert.ok((await readdir(join(project, '.loreweave'))).includes('ai.db'));
});
