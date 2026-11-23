// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { CronStore } from '../../src/cron/store/index.ts';
const Database = createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE);
const [path, serialized, point, mode] = process.argv.slice(2);
const request = JSON.parse(serialized), db = new Database(path, { timeout: 0 });
request.ownership.assertHeld = () => { if (!db.inTransaction) throw new Error('missing transaction'); };
function crash() { if (mode === 'sigkill') process.kill(process.pid, 'SIGKILL'); else process.exit(83); }
const seams = point === 'afterCommit' ? {} : { [point]: crash };
const store = new CronStore(db, { now: () => request.slot }, seams);
const result = store.admitBase({ allConversations: true }, request.authority.jobId, request);
if (result.kind !== 'overlap' || db.inTransaction) throw new Error('missing committed overlap');
crash();
