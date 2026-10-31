// E2E 정리의 무기한 대기 방지: 창이 닫히지 않는 상태(저장 충돌)에서도 closeWindow는 한도 안에 끝나고,
// 이 테스트가 띄운 앱 프로세스만 강제로 끝내며, 그 사실을 기록한다 (파일 끝에서 별도 실패로 보고되는 기록은 여기서 가져가 확인한다).
// 정상 닫기(저장 뒤 닫힘)와 이미 닫힌 앱의 중복 정리는 기록 없이 끝난다. 합성 원고·격리 userData, 외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeWindow, killApp, launch, stubFolderDialog, takeCleanupFailures, tempDir } from './launch.ts';

const alive = (pid: number | undefined) => {
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
};

async function open(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), '# A\n\noriginal\n');
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.locator('.ProseMirror').waitFor();
  return { dir, app, page };
}

test('충돌로 창이 닫히지 않으면 한도 안에 이 앱만 끝내고 기록하며, 외부 원고 바이트는 그대로이고, 중복 정리는 안전하다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await open('cleanup-conflict');
  const pid = app.process().pid;
  takeCleanupFailures();
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('LOCAL_EDIT');
  const external = '# A\n\nEXTERNAL must survive\n';
  await writeFile(join(dir, 'chapters', '001.md'), external);
  await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
  const start = Date.now();
  await closeWindow(app, 3_000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10_000, `한도(3초) 안에 끝난다: ${elapsed}ms`);
  assert.equal(alive(pid), false, '이 테스트의 앱 프로세스가 끝났다');
  const failures = takeCleanupFailures();
  assert.equal(failures.length, 1, '정리 한도 초과가 기록된다 (삼키지 않는다)');
  assert.match(failures[0]!, new RegExp(`pid=${pid}`));
  assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), external, '충돌을 남긴 채 닫아도 바깥 변경은 그대로');
  // 이미 닫힌 앱: 아무 일도 하지 않고 기록도 없다
  await closeWindow(app, 3_000);
  await killApp(app);
  assert.deepEqual(takeCleanupFailures(), []);
});

test('정상 닫기는 저장한 뒤 닫히고 정리 실패로 기록되지 않는다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await open('cleanup-normal');
  takeCleanupFailures();
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('SAVED_ON_CLOSE');
  await closeWindow(app);
  assert.deepEqual(takeCleanupFailures(), []);
  assert.match(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), /SAVED_ON_CLOSE/, '정상 닫기는 저장을 마친 뒤 닫힌다');
  await closeWindow(app); // 중복 정리
  assert.deepEqual(takeCleanupFailures(), []);
});
