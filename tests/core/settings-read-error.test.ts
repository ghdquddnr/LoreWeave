// settings.json의 일시적인 읽기 I/O 실패를 기본값으로 오인해 부분 설정 저장이 기존 설정을 덮어쓰지 않는지 본다.
// 환경 기법(합성): 독점 새 임시 폴더의 settings.json 하나에 대해서만 fs/promises.readFile을 감싸 EACCES/EPERM/EIO를 던지게 한다 (실제 ACL·권한·기본 프로필은 건드리지 않는다).
// updateSettings·readSettings는 실제 제품 함수이고 실제 합성 파일에 쓴다. 이 파일은 node:test가 파일마다 별도 프로세스로 실행하므로 patch가 다른 검사로 새지 않고, 매 테스트가 finally로 복구한다.
// 한계: 합성 오류이며 실제 디스크·백신·ACL 동작이 아니다. readFile 한 지점만 주입한다.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODEL } from '../../src/core/ai/models.ts';
import { DEFAULT_APPEARANCE } from '../../src/core/appearance.ts';
import { readSettings, settingsPath, updateSettings } from '../../src/main/settings.ts';

const fsp = process.getBuiltinModule('fs/promises');
const dir = () => mkdtemp(join(tmpdir(), 'loreweave-settings-read-'));

/** 이 settings.json의 readFile만 code로 실패시킨다. 호출 수를 센다. 돌려주는 함수가 패치를 푼다 */
function failRead(path: string, code: string) {
  const original = fsp.readFile;
  const state = { calls: 0 };
  (fsp as { readFile: unknown }).readFile = async (p: unknown, ...args: unknown[]) => {
    if (String(p) === path) {
      state.calls++;
      throw Object.assign(new Error(`합성 ${code}`), { code });
    }
    return (original as (...a: unknown[]) => unknown)(p, ...args);
  };
  return { state, restore: () => void ((fsp as { readFile: unknown }).readFile = original) };
}

async function seed(d: string) {
  await updateSettings(d, { lastProject: '합성/프로젝트', aiModel: 'gpt-6.1-sol', aiSendConsent: true });
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'lamplight', followSystem: false, manuscriptSize: 20 } }));
}

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`읽기 I/O 오류(${code}): updateSettings는 기본값으로 덮어쓰지 않고 오류를 돌려주며, settings.json Buffer·쓰기·rename이 없고, 오류가 풀린 뒤의 새 부분 변경은 바꾼 항목만 바꾼다`, async () => {
    const d = await dir();
    await seed(d);
    const before = await readFile(settingsPath(d));
    const beforeFiles = (await readdir(d)).sort();
    const { state, restore } = failRead(settingsPath(d), code);
    try {
      await assert.rejects(updateSettings(d, { lastProject: '합성/다른' }), (e: NodeJS.ErrnoException) => e.code === code);
      assert.equal(state.calls, 1, '읽기가 시도됐다');
      restore();
      assert.deepEqual(await readFile(settingsPath(d)), before, 'settings.json Buffer가 그대로다');
      assert.deepEqual((await readdir(d)).sort(), beforeFiles, '임시 파일 등 쓰기 흔적이 없다');
      const s = await readSettings(d);
      assert.equal(s.aiModel, 'gpt-6.1-sol');
      assert.equal(s.aiSendConsent, true);
      assert.equal(s.lastProject, '합성/프로젝트');
      assert.equal(s.appearance.theme, 'lamplight');
      // 오류가 풀린 뒤의 새 명시 부분 변경: 바꾼 항목만 바뀐다
      await updateSettings(d, { lastProject: '합성/다른' });
      const after = await readSettings(d);
      assert.equal(after.lastProject, '합성/다른');
      assert.equal(after.aiModel, 'gpt-6.1-sol');
      assert.equal(after.aiSendConsent, true);
      assert.deepEqual(after.appearance, { ...DEFAULT_APPEARANCE, theme: 'lamplight', followSystem: false, manuscriptSize: 20 });
    } finally {
      restore();
    }
  });
}

test('대기열: 읽기 오류로 실패한 변경 뒤에도 같은 폴더의 다음 변경이 막히지 않고, 실패한 변경이 동의를 false로 되돌리지 않는다', async () => {
  const d = await dir();
  await seed(d);
  const { restore } = failRead(settingsPath(d), 'EIO');
  try {
    const failing = updateSettings(d, { aiSendConsent: false, aiModel: 'gpt-6-luna' });
    await assert.rejects(failing);
    restore();
    await updateSettings(d, { lastProject: '합성/복구 뒤' });
    const s = await readSettings(d);
    assert.equal(s.aiSendConsent, true, '실패한 변경이 동의를 되돌리지 않았다');
    assert.equal(s.aiModel, 'gpt-6.1-sol', '실패한 변경이 모델을 되돌리지 않았다');
    assert.equal(s.lastProject, '합성/복구 뒤');
  } finally {
    restore();
  }
});

test('계약 유지: 파일 없음(ENOENT)은 초기 설정을 만들고, 깨진 JSON·배열은 기본값에서 다시 저장한다', async () => {
  const d = await dir();
  await updateSettings(d, { lastProject: '합성/처음' }); // ENOENT → 기본값에 합쳐 생성
  assert.equal((await readSettings(d)).lastProject, '합성/처음');
  const { writeFile } = fsp;
  await writeFile(settingsPath(d), '{ 깨진');
  await updateSettings(d, { aiSendConsent: true }); // 깨진 JSON → 기본값에서 시작해 올바른 파일로 되돌린다
  const s = await readSettings(d);
  assert.equal(s.aiSendConsent, true);
  assert.equal(s.lastProject, null);
  await writeFile(settingsPath(d), '[1,2]');
  await updateSettings(d, { lastProject: '합성/배열 뒤' });
  assert.equal((await readSettings(d)).lastProject, '합성/배열 뒤');
});

test('읽기용 readSettings는 읽기 오류에도 앱이 뜨도록 기본값을 돌려준다 (UI 복구 정책 유지)', async () => {
  const d = await dir();
  await seed(d);
  const { restore } = failRead(settingsPath(d), 'EACCES');
  try {
    const s = await readSettings(d);
    assert.equal(s.aiModel, DEFAULT_MODEL);
    assert.equal(s.aiSendConsent, false);
  } finally {
    restore();
  }
});
