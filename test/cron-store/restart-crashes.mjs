// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, readFileSync, existsSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Database, state } from './helpers.mjs';
import { clean, gone } from '../runtime/lifecycle-fixture.mjs';
import { record } from './restart-fixture.mjs';

for (const kind of ['consume', 'borrow', 'queued']) for (const point of ['beforeRestartCas', 'afterRestartCas', 'afterJobProjection', 'beforeRestartCommit', 'afterCommit'])
for (const mode of ['exit', 'SIGKILL']) test(`actual restart crash: ${kind}/${point}/${mode}, WAL all-or-none`, async () => {
  const root = mkdtempSync(join(process.env.CRON_STORE_SCRATCH, 'repair-crash-')), checkpoint = join(root, 'checkpoint.json');
  const env = Object.fromEntries(['PATH', 'HOME', 'TZ', 'CRON_STORE_SCRATCH', 'CRON_STORE_SQLITE_PACKAGE', 'LIFECYCLE_EVIDENCE', 'REPAIR_TRACE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const args = [checkpoint, point, mode, kind];
  const child = fork(new URL('./restart-crash-child.mjs', import.meta.url), args, { env,
    execArgv: ['--import', new URL('./register.mjs', import.meta.url).pathname], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '', signaled = false;
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  child.on('message', message => {
    if (message.crash) { assert.equal(mode, 'SIGKILL'); assert.equal(signaled, false); signaled = true; child.kill('SIGKILL'); }
  });
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
  const exited = once(child, 'exit'), closed = once(child, 'close');
  let evidence;
  try {
    const exit = await exited; clearTimeout(timeout); await closed;
    assert.equal(existsSync(checkpoint), true, stderr);
    evidence = JSON.parse(readFileSync(checkpoint, 'utf8'));
    assert.deepEqual(exit, mode === 'exit' ? [73, null] : [null, 'SIGKILL'], stderr);
    assert.equal(signaled, mode === 'SIGKILL');
    for (let i = 0; i < 40 && !gone(evidence.nativeScope.previousChild.pid); i++) await delay(50);
    assert.equal(gone(evidence.nativeScope.previousHost.pid), true);
    assert.equal(gone(evidence.nativeScope.previousChild.pid), true);
    const db = new Database(evidence.db, { timeout: 0 });
    let after;
    try {
      after = state(db); assert.equal(db.inTransaction, false);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      if (point !== 'afterCommit') assert.deepEqual(after, evidence.before);
      else if (kind === 'queued') {
        assert.deepEqual(after.jobs, evidence.before.jobs);
        assert.equal(after.runs[0].status, 'queued'); assert.equal(after.runs[0].owner_incarnation, evidence.nativeScope.currentIncarnationId);
        assert.deepEqual(after.runs[0], { ...evidence.before.runs[0], owner_incarnation: evidence.nativeScope.currentIncarnationId });
      } else {
        assert.equal(after.runs[0].status, 'interrupted'); assert.equal(after.runs[0].reason, 'restart');
        if (kind === 'consume') { assert.equal(after.jobs[0].last_slot_watermark, after.runs[0].authored_slot); assert.equal(after.jobs[0].consecutive_errors, 1); }
        else { assert.equal(after.jobs[0].last_slot_watermark, null); assert.equal(after.jobs[0].consecutive_errors, 0); assert.equal(after.jobs[0].next_run_at, evidence.before.jobs[0].next_run_at); }
      }
    } finally { db.close(); }
    record({ phase: 'actual-repair-crash', kind, point, mode, child: child.pid, args, env, exit, signaled,
      stdout, stderr, before: evidence.before, after, scope: evidence.nativeScope, childAbsent: gone(child.pid) });
  } finally {
    clearTimeout(timeout);
    if (evidence) { clean(evidence.dbDir); clean(evidence.lifecycleDir); }
    if (existsSync(checkpoint)) unlinkSync(checkpoint); rmdirSync(root);
  }
  assert.equal(gone(child.pid), true); assert.equal(existsSync(evidence.dbDir), false); assert.equal(existsSync(evidence.lifecycleDir), false);
  record({ phase: 'repair-crash-cleanup', pid: child.pid, collected: true, dbAbsent: true, lifecyclePathAbsent: true });
});
