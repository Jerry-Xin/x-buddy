// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { CronStore } from '../../src/cron/store/index.ts';
const Database=createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE);
const [path,serialized,now,point,mode]=process.argv.slice(2),request=JSON.parse(serialized),db=new Database(path,{timeout:0});
request.ownership.assertHeld=()=>{if(!db.inTransaction) throw Error('missing ownership transaction');};
function crash(){if(mode==='sigkill') process.kill(process.pid,'SIGKILL');else process.exit(83);}
const store=new CronStore(db,{now:()=>Number(now)},point==='afterCommit'?{}:{[point]:crash});
if(store.finalize({allConversations:true},request.expected.job_id,request).kind!=='finalized'||db.inTransaction) throw Error('missing terminal commit');
crash();
