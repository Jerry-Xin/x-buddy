// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { BotOwnershipLock } from '../../dist/transport/ownership-lock.js';
import { DARWIN_CHILD_OBSERVER } from '../../dist/runtime/darwin-child.js';
import { owned, trace, gone } from './lifecycle-fixture.mjs';

test('corrupt persisted exit cannot override a positively identified live owned child', async t => {
  const o = await owned(t, 2400); await o.killParent();
  const forged = { ...o.record, state: 'exited', exit: { source: 'owned-child-exit', code: 7, signal: null } };
  const corruptionBytes = JSON.stringify(forged); writeFileSync(o.recordPath, corruptionBytes);
  const lock = new BotOwnershipLock(o.dir), beforeLock = readFileSync(lock.path, 'utf8');
  let error, receipt, hypotheticalDbGrant = 0, hypotheticalHomeGrant = 0;
  const start = performance.now();
  try {
    try { receipt = await lock.reconcilePreviousChild('owned-test-bot'); hypotheticalDbGrant++; hypotheticalHomeGrant++; }
    catch (e) { error = { reason: e.reason, message: e.message }; }
    const py = `import ctypes,json\nn={'__name__':'fixture'};exec(${JSON.stringify(DARWIN_CHILD_OBSERVER)},n)\nn['lib']=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)\nn['lib'].proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int];n['lib'].proc_pidinfo.restype=ctypes.c_int\nprint(json.dumps(n['identity'](${o.record.child.pid})))`;
    const native = spawnSync('/usr/bin/python3', ['-I', '-c', py], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr); const nativeIdentity = JSON.parse(native.stdout);
    const row = { phase: 'persisted-exit-contradiction', originalBytes: o.bytes, corruptionBytes, nativeIdentity,
      receipt, error, elapsed: performance.now() - start, childAlive: !gone(o.record.child.pid),
      hypotheticalDbGrant, hypotheticalHomeGrant, actualProtectedEffects: 0,
      lockBefore: beforeLock, lockAfter: readFileSync(lock.path, 'utf8') };
    trace(row); assert.deepEqual(nativeIdentity, o.record.child); assert.equal(row.childAlive, true);
    assert.equal(receipt, undefined); assert.equal(error?.reason, 'live-child-contradiction');
    assert.equal(hypotheticalDbGrant, 0); assert.equal(hypotheticalHomeGrant, 0);
    assert.equal(row.lockAfter, beforeLock); assert.equal(readFileSync(o.recordPath, 'utf8'), corruptionBytes);
  } finally { lock.release(); }
});

test('modeled persisted-exit native absence/mismatch/permission/unknown controls', () => {
  const fixture = `import json\nn={'__name__':'fixture'};exec(SOURCE,n)\nR=n['Refusal'];n['old_pid']=111\nchild={'pid':222,'start':[3,4]};record={'host':{'pid':111,'start':[1,2]},'child':child,'state':'exited','exit':{'source':'owned-child-exit','code':7,'signal':None}}\nresults=[]\nfor mode in ['absent','live','mismatch','permission','unknown']:\n def identify(pid,absent=False):\n  if pid==111:return None\n  if mode=='permission':raise R('identity-permission-denied')\n  if mode=='unknown':raise R('identity-unavailable')\n  return None if mode=='absent' else child if mode=='live' else {'pid':222,'start':[3,5]}\n n['identity']=identify\n try:value=n['observe'](record);result='accepted'\n except R as e:result=str(e)\n expected={'absent':'accepted','live':'live-child-contradiction','mismatch':'child-identity-mismatch','permission':'identity-permission-denied','unknown':'identity-unavailable'}[mode]\n assert result==expected,(mode,result,expected)\n results.append({'mode':mode,'result':result})\nprint(json.dumps(results))`;
  const r = spawnSync('/usr/bin/python3', ['-I', '-c', 'SOURCE=' + JSON.stringify(DARWIN_CHILD_OBSERVER) + '\n' + fixture], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  trace({ phase: 'modeled-persisted-exit', code: r.status, stdout: r.stdout, stderr: r.stderr });
  assert.equal(r.status, 0, r.stderr);
});
