// SPDX-License-Identifier: Apache-2.0
// Synchronously collected fault process; it opens only the parent's owned test database.
import { createRequire } from 'node:module';
import { CronStore } from '../../src/cron/store/index.ts';
const Database = createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE);
const [path, serialized, point] = process.argv.slice(2);
const request = JSON.parse(serialized);
const db = new Database(path, {timeout:0});
request.ownership.assertHeld = () => {if (!db.inTransaction) throw new Error('missing transaction');};
const store = new CronStore(db,{now:() => request.slot},{[point]() {process.exit(83);}});
try {
  console.log(JSON.stringify(store.admitBase({allConversations:true},request.authority.jobId,request)));
} finally {db.close();}
