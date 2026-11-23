// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { CronStore } from '../../src/cron/store/index.ts';
import { ModeledIssuer, scope } from './execution-fixture.mjs';
const [path,runId,time,point,mode]=process.argv.slice(2);
const Database=createRequire(import.meta.url)(process.env.CRON_STORE_SQLITE_PACKAGE),db=new Database(path);
const stop=()=>{if(mode==='kill')process.kill(process.pid,'SIGKILL');else process.exit(79);};
const proxy={get inTransaction(){return db.inTransaction;},prepare:sql=>db.prepare(sql),exec(sql){db.exec(sql);if(sql==='COMMIT'&&point==='committed')stop();}};
const issuer=new ModeledIssuer(), clock={value:Number(time),now(){return this.value;}},
  owner={ownerIncarnation:'modeled-owner',resetGeneration:2,assertHeld(){}},
  seams={beforeExecutionCas(){if(point==='before')stop();},afterExecutionCas(){if(point==='after-cas')stop();}};
const store=new CronStore(proxy,clock,seams,issuer.port(db)),row=db.prepare('SELECT * FROM cron_runs WHERE run_id=?').get(runId);
const f={store,clock,owner,row:()=>row};const request=issuer.issue(f,row);
if(runId==='base')store.startBase(scope,row.job_id,request);else store.admitRetry(scope,row.job_id,request);
throw new Error('Expected crash boundary was not reached');
