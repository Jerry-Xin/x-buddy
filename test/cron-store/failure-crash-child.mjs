// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { CronStore, terminalExpectation } from '../../src/cron/store/index.ts';
const [path,boundary,method,time]=process.argv.slice(2);
const Database=createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE),db=new Database(path);
const terminate=()=>{if(method==='kill')process.kill(process.pid,'SIGKILL');else process.exit(0);};
const seams=boundary==='committed'?{}:{[boundary]:terminate};
const store=new CronStore(db,{now:()=>Number(time)},seams),run=db.prepare("SELECT * FROM cron_runs WHERE run_id='base'").get();
store.finalize({targetSession:'group:fixture'},run.job_id,{expected:terminalExpectation(run),ownership:{ownerIncarnation:'owner',resetGeneration:2,assertHeld(){}},outcome:{kind:'failure',reason:'network'},retryRunId:'retry1'});
if(boundary!=='committed')throw new Error('fault boundary was not reached');terminate();
