// SPDX-License-Identifier: Apache-2.0
// Owned WAL fixture only; this is not an App Server child termination proof.
import { createRequire } from 'node:module';
import { readFileSync, writeSync } from 'node:fs';
import { CronStore } from '../../src/cron/store/index.ts';
const [path, file, point, signal] = process.argv.slice(2);
const Database = createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE);
const db = new Database(path, { timeout: 0 });
const { expected, clock } = JSON.parse(readFileSync(file, 'utf8'));
const store = new CronStore(db, { now: () => clock });
const stop = () => signal === 'SIGKILL' ? process.kill(process.pid, 'SIGKILL') : process.exit(73);
if (point === 'before') stop();
const result = store.reconcileRestart({ targetSession: 'group:fixture' }, expected.job_id,
  { expected, ownership: { ownerIncarnation: 'modeled-replacement-owner', resetGeneration: 2, assertHeld() {} } });
writeSync(1, JSON.stringify(result));
stop();
