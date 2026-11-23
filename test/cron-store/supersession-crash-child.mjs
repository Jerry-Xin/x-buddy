// SPDX-License-Identifier: Apache-2.0
import { CronStore } from '../../src/cron/store/index.ts';
import { Database, scope } from './helpers.mjs';
const [path, currentTime, point, mode] = process.argv.slice(2);
const db = new Database(path, { timeout: 0 });
const die = () => { if (mode === 'kill') process.kill(process.pid, 'SIGKILL'); else process.exit(79); };
const clock = { now: () => Number(currentTime) };
const seam = { before: 'beforeSupersessionCas', 'after-cas': 'afterTerminalCas', 'after-insert': 'afterReceiptInsert', 'after-projection': 'afterJobProjection' }[point];
const store = new CronStore(db, clock, seam ? { [seam]: die } : {});
const job = store.list(scope)[0];
const row = db.prepare("SELECT * FROM cron_runs WHERE job_id=? AND status='queued'").get(job.id);
const ownership = { ownerIncarnation: row.owner_incarnation, resetGeneration: row.reset_generation, assertHeld() {} };
const r = store.admitBase(scope, job.id, { trigger: 'scheduled', generation: job.generation, slot: job.next_run_at,
  runId: 'next-base', ownership, authority: { jobId: job.id, definition: store.definition(scope, job.id),
    creatorAuthorized: true, targetAuthorized: true, ownerIncarnation: ownership.ownerIncarnation,
    resetGeneration: ownership.resetGeneration, policy: { tools: 'none' } } });
if (r.kind !== 'reserved') throw new Error('Expected new base reservation');
die();
