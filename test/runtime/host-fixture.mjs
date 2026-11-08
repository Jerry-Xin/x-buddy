// SPDX-License-Identifier: Apache-2.0
// Guard only external services and instrument owned local resource boundaries.
// The actual host startBot, gateway, manager, SQLite and canonical lock run.
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const req = createRequire(import.meta.url);
const ts = req(process.env.HOST_TYPESCRIPT);
export const state = { events: [], dbs: new Set(), timers: new Set(), gateways: [], stores: [], groups: [], send: null, api: null, fail: '', hook: null };
globalThis.__hostBoundary = state;
state.event = (name, extra = {}) => {
  const e = { name, ...extra }; state.events.push(e);
  if (process.env.HOST_EVIDENCE) appendFileSync(process.env.HOST_EVIDENCE, JSON.stringify(e) + '\n');
  state.hook?.(name, extra);
  if (state.fail === name) throw new Error('owned fixture failure: ' + name);
};
const setIntervalReal = globalThis.setInterval, clearIntervalReal = globalThis.clearInterval;
globalThis.setInterval = (...args) => {
  state.event('timer'); const h = setIntervalReal(...args); state.timers.add(h); return h;
};
globalThis.clearInterval = h => { state.timers.delete(h); return clearIntervalReal(h); };
const url = n => pathToFileURL(join(root, n)).href;
const real = n => JSON.stringify(url('src/' + n) + '?host-real');
const stubs = new Map();
// Explicit existing native binding avoids ambient addon discovery. No binary or
// dependency bytes change; all SQL still runs in the pinned native package.
stubs.set('native-sqlite', `import {createRequire} from 'node:module';
 const Native=createRequire(${JSON.stringify(import.meta.url)})(${JSON.stringify(process.env.HOST_SQLITE)});
 export default class extends Native {constructor(path,options={}){super(path,{...options,nativeBinding:${JSON.stringify(join(process.env.HOST_SQLITE, 'build/Release/better_sqlite3.node'))}})}}`);
stubs.set('host/agent-bridge.ts', `export const queryAgent=()=>{throw Error('model boundary forbidden')}; export const createQueryAgent=()=>queryAgent; export const isStreamInterruptError=()=>false;`);
stubs.set('host/config.ts', `export const DEFAULT_CONFIG_PATH='forbidden'; export const loadConfig=()=>{throw Error('ambient config forbidden')}; export const resolveBotConfigs=()=>{throw Error('ambient config forbidden')};`);
stubs.set('host/cwd-resolver.ts', `export const cleanupExpiredCwds=()=>globalThis.__hostBoundary.event('home-use'); export const resolveSessionCwd=()=>{throw Error('message execution forbidden')};`);
stubs.set('host/session-router.ts', `export class SessionRouter { constructor(c,id){this.id=id;this.knownBots=new Set();globalThis.__hostBoundary.event('router')} registerKnownBot(id){this.knownBots.add(id);globalThis.__hostBoundary.event('sibling',{from:this.id,to:id})} unregisterKnownBot(id){this.knownBots.delete(id);globalThis.__hostBoundary.event('unregister',{from:this.id,to:id})} }`);
stubs.set('host/db-adapter.ts', `import {createAdapter as real} from ${real('host/db-adapter.ts')};
 export function createAdapter(p){const s=globalThis.__hostBoundary;s.event('db-open',{path:p}); const a=real(p);s.dbs.add(a);
 return new Proxy(a,{get(t,k){
 if(k==='close')return()=>{s.event('db-close',{path:p});t.close();s.dbs.delete(t)};
 if(k==='backup')return async dest=>{s.event('backup-start',{path:p,dest});await t.backup(dest);s.event('backup-collected',{dest})};
 if(k==='prepare')return sql=>{const stmt=t.prepare(sql);return {...stmt,run(...params){s.event('sql-attempt',{sql,params});const result=stmt.run(...params);s.event('sql-result',{sql,params,changes:result.changes});return result}}};
 if(k==='transaction')return fn=>{const tx=t.transaction(fn);return()=>{s.event('transaction-start');try{const v=tx();s.event('transaction-committed');return v}catch(error){s.event('transaction-rolled-back',{error:String(error)});throw error}}};
 const v=t[k];return typeof v==='function'?v.bind(t):v}});}`);
stubs.set('host/session-store.ts', `import {SessionStore as Real} from ${real('host/session-store.ts')}; export class SessionStore extends Real { constructor(a){super(a);globalThis.__hostBoundary.stores.push(this);globalThis.__hostBoundary.event('store-constructor')} init(){globalThis.__hostBoundary.event('store-init');return super.init()} cleanExpired(){globalThis.__hostBoundary.event('store-clean');return super.cleanExpired()} }`);
stubs.set('host/group-context.ts', `import {GroupContext as Real} from ${real('host/group-context.ts')}; export class GroupContext extends Real { constructor(...args){super(...args);globalThis.__hostBoundary.groups.push(this)} loadAllFromDb(){globalThis.__hostBoundary.event('context-load');return super.loadAllFromDb()} }`);
stubs.set('host/gateway.ts', `import {OctoGateway as Real} from ${real('host/gateway.ts')}; export class OctoGateway extends Real { constructor(c,o){super(c,o);globalThis.__hostBoundary.gateways.push(this);this.testOwnership=o?.ownership;globalThis.__hostBoundary.event('gateway')} setMessageHandler(h){this.testHandler=h;globalThis.__hostBoundary.event('handler');super.setMessageHandler(h)} stop(h,t){const gate=globalThis.__hostBoundary.handlerGate;if(gate&&h&&!h.has(gate)){h.add(gate);gate.finally(()=>h.delete(gate))}return super.stop(h,gate?1:t)} }`);
stubs.set('octo/socket.ts', `export class WKSocket { connect(){globalThis.__hostBoundary.event('connect')} async disconnectAndWait(){globalThis.__hostBoundary.event('disconnect')} }`);
const apiSource = readFileSync(join(root, 'src/octo/api.ts'), 'utf8');
const names = [...apiSource.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]);
stubs.set('octo/api.ts', names.map(n => `export async function ${n}(opts){ const s=globalThis.__hostBoundary;
 if('${n}'==='registerBot'){s.event('register');await s.beforeRegister?.();return {robot_id:opts.botToken,owner_uid:'owned-owner',ws_url:'wss://owned.invalid',im_token:'inert'}}
 if('${n}'==='getUploadCredentials'){s.event('cdn');return {}}
 if(['sendMessage','sendTyping','sendReadReceipt'].includes('${n}')&&s.send)return s.send('${n}',opts);
 if(s.api)return s.api('${n}',opts);
 throw Error('external service forbidden: ${n}');}`).join('\n'));
if (process.env.HOST_REAL_BRIDGE === '1') {
  stubs.delete('host/agent-bridge.ts');
  stubs.set('host/cwd-resolver.ts', `import {resolveSessionCwd as real} from ${real('host/cwd-resolver.ts')}; export const cleanupExpiredCwds=()=>globalThis.__hostBoundary.event('home-use'); export const resolveSessionCwd=real;`);
}
registerHooks({
  resolve(spec, context, next) {
    if (spec === 'better-sqlite3') return { url: 'host-fixture:native-sqlite', shortCircuit: true };
    if (context.parentURL?.startsWith(url('src/')) && spec.startsWith('.') && spec.endsWith('.js')) {
      const target = new URL(spec.slice(0, -3) + '.ts', context.parentURL); target.search = '';
      const name = fileURLToPath(target).slice(join(root, 'src/').length);
      // The scripted/native clients use the compiled error constructors. Match
      // production's single module identity so instanceof RPC proof stays real.
      if (name === 'app-server/errors.ts') return next(url('dist/app-server/errors.js'), context);
      if (stubs.has(name)) return { url: 'host-fixture:' + name, shortCircuit: true };
      return next(target.href, context);
    }
    return next(spec, context);
  },
  load(target, context, next) {
    if (target.startsWith('host-fixture:')) return { format: 'module', source: stubs.get(target.slice(13)), shortCircuit: true };
    if (target.startsWith(url('src/')) && new URL(target).pathname.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(target), 'utf8');
      return { format: 'module', source: ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText, shortCircuit: true };
    }
    return next(target, context);
  },
});
export function config(dir, id = 'owned-test-bot') {
  return { botId: id, dataDir: dir, cwdBase: join(dir, 'workspace'), cwd: join(dir, 'workspace'),
    baseDir: dir, botToken: id, apiUrl: 'https://owned.invalid', sdk: {}, rateLimit: { maxPerMinute: 10 },
    context: { maxContextChars: 1000 }, session: { ttlDays: 7 } };
}
export function reset() { state.events.length = 0; state.gateways.length = 0; state.stores.length = 0; state.groups.length = 0; state.send = null; state.api = null; state.fail = ''; state.hook = null; state.beforeRegister = null; state.handlerGate = null; }
export function assertClean(assert) { assert.equal(state.dbs.size, 0); assert.equal(state.timers.size, 0); }
