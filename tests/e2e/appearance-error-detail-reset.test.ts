// 외관 설정 저장이 거듭 실패할 때, 새 실패의 기술 상세는 접힌 채 시작한다 (같은 원문 오류가 연속으로 나와도 별개의 실패). 펼친 상세가 다음 실패로 이어지지 않는다.
// 복구(성공)하면 오류·상세가 사라지고, 실패한 변경들의 최신 값이 실제로 저장된다. 원고 바이트는 그대로다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 설정 UI. 실패는 main의 appearance:update 핸들러를 감싼 합성 오류(IPC 실패 대역)이며 성공은 원래 핸들러다. 실제 키·외부 전송 0.
// 합성 Electron이며 수동 GUI·실제 OS 입력 확인이 아니다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

interface Plan {
  calls: number;
  /** 다음 appearance:update 호출들의 결과: 오류 메시지, null(원래 핸들러로 성공), 'HOLD'(풀릴 때까지 붙잡은 뒤 성공) */
  outcomes: (string | null)[];
  release: (() => void) | null;
}
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { plan: Plan }).plan.calls);
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

test('외관 저장 재실패: 새 실패의 상세는 접힌 채 시작하고(동일 원문 포함), 복구하면 오류가 사라지고 최신 값이 저장된다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('appearance-error-detail');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const userData = await tempDir('appearance-error-detail-ud');
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'daylight', followSystem: false } }));
  const { app, page } = await launch(userData);
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { plan: Plan };
      g.plan = { calls: 0, outcomes: ['EISDIR: synthetic first failure', 'EISDIR: synthetic first failure', 'ENOSPC: synthetic second failure', null], release: null };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('appearance:update')!;
      handlers.set('appearance:update', async (...args: unknown[]) => {
        g.plan.calls++;
        const outcome = g.plan.outcomes.shift();
        if (outcome) throw new Error(outcome);
        return original(...args);
      });
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '환경설정' });
    const alert = dialog.getByRole('alert');
    const size = dialog.getByRole('slider', { name: '원고 글자 크기' });
    const line = dialog.getByRole('slider', { name: '줄 간격' });

    // 실패 1: 안내가 뜨고 상세는 접힌 채 시작, 펼치면 첫 오류 원문
    await size.focus();
    await page.keyboard.press('ArrowRight'); // 글자 크기 +1
    await alert.getByText('외관 설정을 저장하지 못했습니다').waitFor();
    assert.equal(await alert.locator('.tech-detail').count(), 0, '첫 실패의 상세는 접힌 채 시작한다');
    await alert.getByRole('button', { name: '기술 상세' }).click();
    assert.ok(((await alert.locator('.tech-detail').textContent()) ?? '').includes('first failure'), '첫 실패 원문');

    // 같은 원문의 연속 실패(다시 저장): 별개의 실패라 상세가 다시 접힌 채 시작한다
    await alert.getByRole('button', { name: '다시 저장', exact: true }).click();
    await until('두 번째 저장 시도', async () => (await calls(app)) === 2);
    await until('접힘 초기화', async () => (await alert.locator('.tech-detail').count()) === 0);
    // 다시 저장 실패 뒤에도 포커스가 모달 안의 다시 저장 버튼에 남아 있다 (ErrorNote를 다시 만들지 않는다)
    const afterRetry = await page.evaluate(() => ({ inDialog: !!document.activeElement?.closest('[role="dialog"]'), label: document.activeElement?.textContent ?? '' }));
    assert.equal(afterRetry.inDialog, true, `재실패 뒤 포커스가 모달 안에 있다: ${JSON.stringify(afterRetry)}`);
    assert.equal(afterRetry.label, '다시 저장', '포커스는 누른 다시 저장 버튼에 그대로다');
    assert.equal(await alert.getByRole('button', { name: '기술 상세' }).count(), 1, '기술 상세 버튼이 다시 접힌 상태로 있다');
    assert.match(await alert.innerText(), /아직 저장되지 않았습니다/, '미저장 안내는 그대로다');
    await alert.getByRole('button', { name: '기술 상세' }).click();
    assert.ok(((await alert.locator('.tech-detail').textContent()) ?? '').includes('first failure'), '동일 원문이 다시 정확히 나타난다');

    // 새 외관 변경으로 다른 오류: 다시 접힌 채 시작하고 이전 원문이 남지 않는다
    await line.focus();
    await page.keyboard.press('ArrowRight');
    await until('세 번째 저장 시도', async () => (await calls(app)) === 3);
    await until('다른 오류 안내', async () => (await alert.getByRole('button', { name: '기술 상세' }).count()) === 1 && (await alert.locator('.tech-detail').count()) === 0);
    await alert.getByRole('button', { name: '기술 상세' }).click();
    const third = (await alert.locator('.tech-detail').textContent()) ?? '';
    assert.ok(third.includes('ENOSPC') && !third.includes('first failure'), `새 오류의 상세만 보인다: ${third}`);

    // 복구: 다시 저장 → 성공, 오류와 상세가 사라지고 실패했던 변경들의 최신 값이 저장된다
    await alert.getByRole('button', { name: '다시 저장', exact: true }).click();
    await alert.waitFor({ state: 'detached' });
    assert.equal(await calls(app), 4, '저장 호출은 시도마다 한 번씩 총 4회 (자동 재시도 없음)');
    const saved = JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).appearance;
    assert.equal(saved.manuscriptSize, 18, '복구 뒤 글자 크기 최신 값이 저장됐다');
    assert.equal(saved.lineHeight, 2, '복구 뒤 줄 간격 최신 값이 저장됐다');
    assert.equal(saved.theme, 'daylight');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 그대로다');
  } finally {
    await closeWindow(app);
  }
});

/** 합성 원고·격리 userData로 설정 대화상자를 열고, appearance:update의 결과 순서를 정한다 */
async function setup(outcomes: (string | null)[]) {
  const dir = await tempDir('appearance-error-focus');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const userData = await tempDir('appearance-error-focus-ud');
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'daylight', followSystem: false } }));
  const { app, page } = await launch(userData);
  await app.evaluate(({ ipcMain }, list) => {
    const g = globalThis as unknown as { plan: Plan };
    g.plan = { calls: 0, outcomes: list, release: null };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('appearance:update')!;
    handlers.set('appearance:update', async (...args: unknown[]) => {
      g.plan.calls++;
      const outcome = g.plan.outcomes.shift();
      if (outcome === 'HOLD') await new Promise<void>((resolve) => (g.plan.release = resolve));
      else if (outcome) throw new Error(outcome);
      return original(...args);
    });
  }, outcomes);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
  await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
  const opener = page.getByRole('button', { name: '설정', exact: true });
  await opener.focus();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '환경설정' });
  await dialog.waitFor();
  return { app, page, dialog, alert: dialog.getByRole('alert'), path };
}
const activeInfo = (page: import('playwright').Page) =>
  page.evaluate(() => ({ body: document.activeElement === document.body, inDialog: !!document.activeElement?.closest('[role="dialog"]'), label: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '' }));

test('재실패·재시도 성공 뒤에도 포커스가 모달 안에 남고, Escape가 닫고 연 버튼으로 돌아온다', { timeout: 120_000 }, async () => {
  const { app, page, dialog, alert, path } = await setup(['EISDIR: synthetic failure', 'EISDIR: synthetic failure', null]);
  try {
    await dialog.getByRole('slider', { name: '원고 글자 크기' }).focus();
    await page.keyboard.press('ArrowRight');
    await alert.getByText('외관 설정을 저장하지 못했습니다').waitFor();
    await alert.getByRole('button', { name: '기술 상세' }).click();
    // 재실패: 실제 Escape가 정상으로 닫힌다 (포커스가 BODY로 사라지지 않았다면 backdrop 핸들러가 받는다)
    await alert.getByRole('button', { name: '다시 저장', exact: true }).click();
    await until('재실패', async () => (await calls(app)) === 2);
    await until('접힘 초기화', async () => (await alert.locator('.tech-detail').count()) === 0);
    const failed = await activeInfo(page);
    assert.equal(failed.inDialog, true, `재실패 뒤 포커스가 모달 안에 있다: ${JSON.stringify(failed)}`);
    // 재시도 성공: 안내가 사라져도 포커스는 모달 안의 컨트롤에 남는다
    await alert.getByRole('button', { name: '다시 저장', exact: true }).click();
    await alert.waitFor({ state: 'detached' });
    const ok = await activeInfo(page);
    assert.equal(ok.body, false, `재시도 성공 뒤 포커스가 BODY로 사라지지 않았다: ${JSON.stringify(ok)}`);
    assert.equal(ok.inDialog, true, '포커스가 모달 안에 있다');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent), '설정', '닫으면 연 버튼으로 돌아온다');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 그대로다');
  } finally {
    await closeWindow(app);
  }
});

test('재시도 응답을 기다리는 사이 사용자가 옮긴 포커스는 성공 응답이 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, dialog, alert } = await setup(['EISDIR: synthetic failure', 'HOLD']);
  try {
    const size = dialog.getByRole('slider', { name: '원고 글자 크기' });
    await size.focus();
    await page.keyboard.press('ArrowRight');
    await alert.getByText('외관 설정을 저장하지 못했습니다').waitFor();
    await alert.getByRole('button', { name: '다시 저장', exact: true }).click();
    await until('붙잡은 재시도 진입', async () => (await calls(app)) === 2);
    await dialog.getByRole('slider', { name: '줄 간격' }).focus(); // 사용자가 다른 컨트롤로 옮긴다
    await app.evaluate(() => (globalThis as unknown as { plan: Plan }).plan.release!());
    await alert.waitFor({ state: 'detached' });
    assert.equal((await activeInfo(page)).label, '줄 간격', '성공 응답이 사용자가 옮긴 포커스를 빼앗지 않았다');
  } finally {
    await closeWindow(app);
  }
});
