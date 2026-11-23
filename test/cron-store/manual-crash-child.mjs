// SPDX-License-Identifier: Apache-2.0
// Process durability probe only. No production startup repair, takeover or executor.
import { Database, scope } from './helpers.mjs';
import { ModeledIssuer } from './execution-fixture.mjs';
import { CronStore, terminalExpectation } from '../../src/cron/store/index.ts';
import { invocation } from './manual-fixture.mjs';
const [path, time, phase, point, mode, ownership] = process.argv.slice(2);
const db = new Database(path, { timeout: 0 });
const clock = { value: Number(time), now() { return this.value; } };
const stop = () => mode === 'kill' ? process.kill(process.pid, 'SIGKILL') : process.exit(79);
const owner = { ownerIncarnation: 'modeled-owner', resetGeneration: 2, assertHeld() {} };
const issuer = new ModeledIssuer();
const seams = {
  afterReceiptInsert() { if (phase === 'reservation' && point === 'mutated') stop(); },
  beforeManualCommit() { if (phase === 'reservation' && point === 'precommit') stop(); },
  afterExecutionCas() { if (phase === 'start' && point === 'mutated') stop(); },
  afterTerminalCas() { if (phase === 'terminal' && point === 'mutated') stop(); },
  afterJobProjection() { if (phase === 'terminal' && point === 'projection') stop(); },
};
const store = new CronStore(db, clock, seams, issuer.port(db));
const job = db.prepare('SELECT * FROM cron_jobs').get();
const f = { db, clock, owner, store, row: () => db.prepare("SELECT * FROM cron_runs WHERE run_id='manual-run'").get() };
if (point === 'before') stop();
let result;
if (phase === 'reservation') result = store.admitManual(scope, job.id, { trigger: 'manual', manualMode: ownership === 'consume' ? 'due' : 'if-enabled',
  generation: job.generation, runId: 'manual-run', invocationId: invocation, ownership: owner,
  authority: { jobId: job.id, definition: store.definition(scope, job.id), creatorAuthorized: true, targetAuthorized: true,
    ownerIncarnation: owner.ownerIncarnation, resetGeneration: 2, policy: { tools: 'none' } } });
else if (phase === 'start') result = store.startManual(scope, job.id, issuer.issue(f));
else result = store.finalize(scope, job.id, { expected: terminalExpectation(f.row()), ownership: owner,
  outcome: { kind: 'success', deliveryState: 'not-requested' } });
if (!['reserved', 'admitted', 'finalized'].includes(result.kind)) throw new Error('Unexpected crash fixture outcome');
if (point === 'committed') stop();
throw new Error('Crash point not reached');
