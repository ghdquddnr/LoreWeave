// 문제 가능성 패널의 [무시 취소]: 무시한 결과를 보기로 연 뒤 명시 클릭(키보드 Enter 포함)으로 되돌린다.
// 합성 원고(M0A 복사본)·격리 userData·가짜 OpenAI 서버(무료; 결과는 높은 확신 1개 + 낮은 확신 1개). ai:undismiss는 호출 수를 세는 무료 대역으로 감싼다:
// 첫 호출은 장벽(hold)에 붙잡았다가 release하면 거절하고, 그 뒤는 실제 처리기로 넘긴다.
// 관측 범위: 버튼 조작 뒤 가짜 서버의 요청 수가 그대로이고 원고 Buffer가 그대로인 것까지. 합성 Electron 검사이며 수동 GUI·실제 IME·실모델·탐지율 검증이 아니다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication } from 'playwright';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
const files = ['001.md', '002.md', '003.md'];
const FAIL = '합성 무시 취소 실패';
let fake: FakeOpenAi;
let project: string;

const high = { category: 'age', target_quote: '"스물두 살입니다."', claim: '1화에서 민수는 스무 살이다. 두 달 뒤 스물두 살일 수 없다.', evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }], confidence: 0.9 };
const low = { category: 'number', target_quote: '"스물두 살입니다."', claim: '모순으로 볼 근거가 없다.', evidence: [{ chapter: 1, quote: '둘 다 스무 살이었다.' }], confidence: 0.1 };

before(async () => {
  fake = await startFakeOpenAi((user) => {
    if (user.startsWith('# 참고 자료')) return { findings: [high, low] };
    return {
      summary: '요약',
      entities: [{ name: '김민수', aliases: ['민수'] }],
      facts: user.includes('<chapter n="1">') ? [{ entity: '김민수', predicate: '나이', value: '스무 살', quote: '둘 다 스무 살이었다.' }] : [],
    };
  });
  project = await tempDir('issues-undismiss');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
});

after(async () => {
  await fake.close();
});

type G = { calls: number; held: boolean; release?: () => void };
const undismissCalls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).calls);
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());

test('무시 취소: 무시함 표시와 함께 취소 버튼이 있고, 실패하면 무시 상태를 유지한 채 재시도되며, 성공하면 일반 카드·배지로 돌아와 화 왕복에도 유지되고, 낮은 확신 필터는 그대로다', { timeout: 180_000 }, async () => {
  const originals = await Promise.all(files.map((f) => readFile(join(project, 'chapters', f))));
  const { app, page } = await launch(await tempDir('ud-issues-undismiss'), { OPENAI_BASE_URL: fake.baseUrl });
  try {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    await page.evaluate(() => window.loreweave.ai.setKey('sk-issues-undismiss'));
    const issues = page.getByRole('region', { name: '문제 가능성' });
    const chapter = (n: number) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: new RegExp(`^${n}화`) });
    const cards = issues.locator('.issue-card');
    const failNote = issues.getByText(new RegExp(FAIL));
    const undoButton = issues.getByRole('button', { name: '무시 취소', exact: true });
    const badge = (label: string) => chapter(3).locator(`[aria-label="${label}"]`);
    const roundTrip = async () => {
      await chapter(2).click();
      await issues.getByRole('heading', { name: /^문제 가능성/ }).waitFor();
      await chapter(3).click();
      await issues.getByRole('heading', { name: /^문제 가능성/ }).waitFor();
    };

    // 3화를 검사한다 (가짜 서버): 높은 확신 1개 + 낮은 확신 1개
    await chapter(3).click();
    await issues.getByText('아직 검사하지 않은 화입니다').waitFor();
    await page.getByRole('button', { name: '이 화 검사' }).click();
    await page.getByRole('dialog', { name: 'AI 실행 확인' }).getByRole('button', { name: /^(동의하고 실행|실행)$/ }).click();
    await issues.getByRole('heading', { name: '문제 가능성 (1)' }).waitFor({ timeout: 60_000 });
    await badge('문제 가능성 1개').waitFor();
    const requestsAfterCheck = fake.requests.length;

    await app.evaluate(({ ipcMain }, message) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { calls: 0, held: false });
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('ai:undismiss')!;
      handlers.set('ai:undismiss', async (...args: unknown[]) => {
        if (g.calls++ === 0) {
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
          throw new Error(message);
        }
        return original(...args);
      });
    }, FAIL);

    // 1) 높은 확신 결과를 무시 → 보기: '무시함' 표시와 [무시 취소]
    await issues.getByRole('button', { name: '무시', exact: true }).click();
    await issues.getByText('현재 표시할 결과가 없습니다.').waitFor();
    await badge('검사함: 문제 가능성 없음').waitFor();
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).click();
    await issues.getByText('무시함', { exact: true }).waitFor();
    await undoButton.waitFor();
    assert.equal(await cards.count(), 1);

    // 2) 취소 요청을 장벽에 붙잡는다: 대기 중에는 중복 조작이 막히고 무시 상태가 그대로다
    await undoButton.click();
    for (let n = 0; n < 600 && !(await held(app)); n++) await page.waitForTimeout(25);
    assert.equal(await held(app), true, '취소 요청이 장벽에 붙잡히지 않았다');
    assert.equal(await undismissCalls(app), 1);
    assert.equal(await undoButton.isDisabled(), true, '대기 중에는 버튼이 눌리지 않는다');
    await undoButton.click({ force: true }).catch(() => undefined);
    await page.keyboard.press('Enter');
    assert.equal(await undismissCalls(app), 1, '대기 중 중복 클릭·Enter가 새 요청을 만들지 않았다 (관측 범위 안)');
    await release(app); // 실패
    await failNote.waitFor();
    await issues.getByText('무시를 취소하지 못했습니다', { exact: false }).waitFor();
    assert.equal(await issues.getByText('무시함', { exact: true }).count(), 1, '실패하면 무시 상태 그대로');
    assert.equal(await undoButton.isEnabled(), true, '다시 시도할 수 있다');
    await badge('검사함: 문제 가능성 없음').waitFor();

    // 3) 키보드(포커스 + Enter)로 재시도: 성공하면 일반 카드·배지·heading 수로 돌아오고 실패 안내가 사라진다
    await undoButton.focus();
    await page.keyboard.press('Enter');
    await issues.getByRole('heading', { name: '문제 가능성 (1)' }).waitFor();
    await badge('문제 가능성 1개').waitFor();
    assert.equal(await undismissCalls(app), 2);
    assert.equal(await issues.getByText('무시함', { exact: true }).count(), 0);
    assert.equal(await undoButton.count(), 0);
    assert.equal(await failNote.count(), 0, '성공하면 이전 실패 안내가 남지 않는다');
    assert.equal(await issues.getByRole('button', { name: /^무시한 결과/ }).count(), 0, '무시한 결과가 없다');
    assert.equal(await issues.getByRole('button', { name: '무시', exact: true }).count(), 1, '일반 카드로 돌아왔다');

    // 4) 화 왕복 뒤에도 유지된다
    await roundTrip();
    await issues.getByRole('heading', { name: '문제 가능성 (1)' }).waitFor();
    assert.equal(await issues.getByText('무시함', { exact: true }).count(), 0);
    await badge('문제 가능성 1개').waitFor();

    // 5) 낮은 확신 결과: 보이게 해 무시 → 화 왕복(필터 초기화) → 무시 보기 → 낮은 확신 보기로 카드 → 취소해도 낮은 확신 필터는 그대로
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click();
    await issues.locator('.issue-card.low').getByRole('button', { name: '무시', exact: true }).click();
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).waitFor();
    await roundTrip();
    await issues.getByRole('button', { name: '무시한 결과 1개 보기' }).click();
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click(); // 무시 토글을 켜야 나타난다
    const lowCard = issues.locator('.issue-card.low');
    await lowCard.getByText('무시함', { exact: true }).waitFor();
    await lowCard.getByRole('button', { name: '무시 취소', exact: true }).click();
    await lowCard.getByRole('button', { name: '무시', exact: true }).waitFor();
    assert.equal(await lowCard.getByText('무시함', { exact: true }).count(), 0, '낮은 확신 카드의 무시가 취소됐다');
    assert.equal(await issues.getByRole('heading', { name: '문제 가능성 (1)' }).count(), 1, 'heading 수는 낮은 확신 결과를 세지 않는다');
    // 낮은 확신 필터는 그대로: 숨기면 카드가 사라진다 (취소가 필터를 우회하지 않는다)
    await issues.getByRole('button', { name: '확신이 낮은 결과 숨기기' }).click();
    assert.equal(await issues.locator('.issue-card.low').count(), 0);
    assert.equal(await cards.count(), 1);
    await roundTrip();
    assert.equal(await issues.locator('.issue-card.low').count(), 0, '화 왕복 뒤에도 낮은 확신 결과는 숨겨져 있다');
    await issues.getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).waitFor();

    // 버튼 조작만으로는 새 AI 요청이 없고 원고는 그대로다
    assert.equal(fake.requests.length, requestsAfterCheck, '무시·취소·토글은 새 AI 요청을 만들지 않았다 (관측 범위 안)');
    const after = await Promise.all(files.map((f) => readFile(join(project, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await release(app).catch(() => undefined);
    await closeWindow(app);
  }
});
