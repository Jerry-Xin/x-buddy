// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, rmdirSync, unlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const trace = value => { if (process.env.LIFECYCLE_EVIDENCE) appendFileSync(process.env.LIFECYCLE_EVIDENCE, JSON.stringify(value) + '\n'); };
export const gone = pid => {
  // Cleanup diagnostic only. Never used to admit startup or infer termination.
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};
export function clean(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) clean(path); else unlinkSync(path);
  }
  rmdirSync(dir);
}
export async function owned(t, drain = 700) {
  const dir = mkdtempSync(join(tmpdir(), 'xin2739-'));
  const home = join(dir, 'home'); mkdirSync(home, { mode: 0o700 });
  const parent = fork(new URL('./inert-lifecycle-parent.mjs', import.meta.url), [dir, String(drain)], {
    env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = ''; parent.stderr.on('data', b => { stderr += b; }); parent.stdout.resume();
  const exited = once(parent, 'exit');
  const ready = await Promise.race([once(parent, 'message').then(([m]) => m), exited.then(() => { throw new Error(stderr); })]);
  assert.equal(ready.ready, true);
  const recordPath = join(dir, 'app-server-child.json');
  const bytes = readFileSync(recordPath, 'utf8'); const record = JSON.parse(bytes);
  assert.equal(record.child.pid, ready.child); assert.equal(record.host.pid, parent.pid);
  assert.equal(record.state, 'running'); assert.equal(record.child.start.length, 2);
  trace({ phase: 'spawn', dir, home, parent: parent.pid, child: ready.child, recordBytes: bytes });
  let killed = false;
  const killParent = async () => {
    assert.equal(killed, false); killed = true;
    parent.kill('SIGKILL'); // Only this test's directly owned parent handle.
    const status = await exited; assert.deepEqual(status, [null, 'SIGKILL']);
    trace({ phase: 'parent-exit', pid: parent.pid, status });
  };
  t.after(async () => {
    if (!killed && parent.exitCode === null && parent.signalCode === null) await killParent();
    for (let i = 0; i < 900 && !gone(ready.child); i++) await delay(50);
    await delay(40);
    assert.equal(gone(parent.pid), true); assert.equal(gone(ready.child), true);
    assert.deepEqual(readdirSync(home), []);
    clean(dir);
    trace({ phase: 'cleanup', parent: parent.pid, child: ready.child, parentAbsent: gone(parent.pid),
      childAbsent: gone(ready.child), ownedHomeAbsent: !existsSync(home), dirAbsent: !existsSync(dir) });
  });
  return { dir, home, parent, record, recordPath, bytes, killParent };
}
