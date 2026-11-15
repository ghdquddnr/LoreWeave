// 삭제 API 방어 (package:win:branded의 packager 자식 프로세스에서만 쓴다): 허용 하위트리 밖이거나 링크/별칭으로 밖으로 나가는 삭제 대상은 실행 전에 거절하고, 모든 호출을 기록한다.
// 범위: 이 프로세스 안의 fs.promises/fs의 rm·rmdir·unlink(Sync 포함)를 감싼 것이다. OS 샌드박스가 아니며, 다른 프로세스·네이티브 코드의 삭제와 모든 경합(TOCTOU)을 막는다고 주장하지 않는다.
// 일반 "재귀 삭제 0" 정책의 해제가 아니다: packager가 호출하는 삭제를 이번 빌드가 새로 만든 독점 루트 안으로 한정하기 위한 장치다.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { isInside, lexists, realResolve } from './package-win.ts';

export class RmGuardError extends Error {}

export interface RmCall {
  api: string;
  abs: string;
  real: string;
  opts: { recursive: boolean; force: boolean } | null;
  allowed: boolean;
  linkFinal: boolean;
}

/** 대상이 허용 하위트리(엄밀히 안쪽) 안에 있고 실제 경로도 그 안이며 마지막 항목이 링크가 아닐 때만 허용한다. 기록을 돌려준다 (허용이 아니어도 돌려주며, 호출자가 거절한다) */
export function evaluateRmTarget(api: string, target: unknown, opts: unknown, allowed: readonly string[]): RmCall {
  const abs = resolve(String(target instanceof URL ? target.pathname.replace(/^\//, '') : target));
  const real = resolve(realResolve(dirname(abs)), basename(abs));
  let linkFinal = false;
  if (lexists(abs)) linkFinal = fs.lstatSync(abs).isSymbolicLink();
  const o = typeof opts === 'object' && opts !== null ? (opts as { recursive?: boolean; force?: boolean }) : null;
  const ok = !linkFinal && allowed.some((a) => isInside(abs, a) && abs.toLowerCase() !== resolve(a).toLowerCase() && isInside(real, fs.realpathSync.native(a)));
  return { api, abs, real, opts: o ? { recursive: !!o.recursive, force: !!o.force } : null, allowed: ok, linkFinal };
}

/** fs의 삭제 API를 감싼다. 반드시 packager를 import하기 전에 호출한다 (graceful-fs가 import 시점의 함수를 복사한다) */
export function installRmGuard(allowed: readonly string[], onCall: (call: RmCall) => void): void {
  const check = (api: string, target: unknown, opts: unknown): void => {
    const call = evaluateRmTarget(api, target, opts, allowed);
    onCall(call);
    if (!call.allowed) throw new RmGuardError(`rm 방어: 허용 하위트리 밖/링크 대상 삭제를 거절한다 (${api}: ${call.abs} → ${call.real})`);
  };
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const name of ['rm', 'rmdir', 'unlink']) {
    const original = promises[name]!.bind(fs.promises);
    promises[name] = async (target: unknown, opts?: unknown) => {
      check(`promises.${name}`, target, opts);
      return original(target, opts);
    };
  }
  const f = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['rm', 'rmdir', 'unlink']) {
    const original = f[name]!.bind(fs);
    f[name] = (target: unknown, ...rest: unknown[]) => {
      check(name, target, typeof rest[0] === 'object' ? rest[0] : null);
      return original(target, ...rest);
    };
  }
  for (const name of ['rmSync', 'rmdirSync', 'unlinkSync']) {
    const original = f[name]!.bind(fs);
    f[name] = (target: unknown, opts?: unknown) => {
      check(name, target, opts);
      return original(target, opts);
    };
  }
  syncBuiltinESMExports();
}
