// SPDX-License-Identifier: Apache-2.0
/** Fail-closed preload for the bounded offline caller selection, not an execution issuer. */
import * as childProcess from 'node:child_process';
import * as filesystem from 'node:fs';
import * as network from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { DARWIN_CHILD_OBSERVER } from '../../dist/runtime/darwin-child.js';

const require = createRequire(import.meta.url);
const fs = require('node:fs'), cp = require('node:child_process');
export const guardState = { sdkImports: 0, network: 0, credentials: 0, deniedSpawns: 0, allowedSpawns: [] };
const refuse = reason => { throw new Error('offline guard refused: ' + reason); };
const root = resolve(import.meta.dirname, '../..');
const privateRoot = process.env.CALLER_GUARD_ROOT;
if (!privateRoot || !process.env.HOME?.startsWith(privateRoot + '/') || !process.env.TMPDIR?.startsWith(privateRoot + '/')) refuse('private HOME/TMPDIR required');
const envKeys = new Set(['PATH','HOME','TMPDIR','TMP','TEMP','TZ','LANG','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM',
  'HOST_TYPESCRIPT','HOST_SQLITE','HOST_PIN_REPO','HOST_EVIDENCE','HOST_REAL_BRIDGE','PROVENANCE_EVIDENCE','LIFECYCLE_EVIDENCE',
  'CALLER_GUARD_ROOT','NODE_TEST_CONTEXT','NODE_TEST_WORKER_ID','NODE_TEST_REPORTER','NODE_TEST_REPORTER_DESTINATION',
  'REVIEW_SOURCE','REVIEW_RECEIPT','CODEX_HOME','CODEX_OCTO_EXECUTOR','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','PYTHONDONTWRITEBYTECODE','__CF_USER_TEXT_ENCODING']);
for (const key of Object.keys(process.env)) if (!envKeys.has(key)) refuse('non-allowlisted environment key: ' + key);

const credentialPath = value => {
  if (typeof value === 'number') return false;
  let name;
  try { name = value instanceof URL ? fileURLToPath(value) : String(value); } catch { return false; }
  return /(?:^|\/)(?:\.codex|\.aws|\.ssh|\.azure|\.config|Keychains)(?:\/|$)|(?:^|\/)(?:auth\.json|credentials|config\.toml|\.env(?:\..*)?)$/.test(name);
};
const checkRead = value => { if (credentialPath(value)) { guardState.credentials++; refuse('credential read'); } };
for (const name of ['readFileSync','readFile','openSync','open','createReadStream']) {
  const original = fs[name]; fs[name] = function(path, ...args) { checkRead(path); return original.call(this, path, ...args); };
}
const fsp = require('node:fs/promises');
for (const name of ['readFile','open']) { const original = fsp[name]; fsp[name] = function(path, ...args) { checkRead(path); return original.call(this, path, ...args); }; }
const denyNetwork = () => { guardState.network++; refuse('network/API'); };
require('node:net').Socket.prototype.connect = denyNetwork;
for (const mod of [require('node:http'), require('node:https')]) for (const key of ['request','get']) mod[key] = denyNetwork;
for (const key of ['lookup','resolve','resolve4','resolve6']) require('node:dns')[key] = denyNetwork;
globalThis.fetch = denyNetwork;

const guardedChild = (bin, args, options) => {
  const env = options?.env ?? process.env;
  if (Object.keys(env).some(key => !envKeys.has(key))) { guardState.deniedSpawns++; refuse('child environment'); }
  for (const key of ['HOME','TMPDIR','CODEX_HOME']) if (env[key] && !env[key].startsWith(privateRoot + '/')) refuse('non-private child path');
  const path = value => value.startsWith('file:') ? fileURLToPath(value) : resolve(value);
  if (bin === process.execPath) for (let i = 0; i < (args ?? []).length; i++) {
    if (args[i] === '--import' && path(args[++i] ?? '') !== fileURLToPath(import.meta.url)) refuse('unlisted preload');
    if (args[i]?.startsWith('--import=')) refuse('unlisted preload');
  }
  const script = bin === process.execPath ? (args ?? []).find(value => typeof value === 'string' && /\.(?:mjs|test\.ts)$/.test(value) && path(value) !== fileURLToPath(import.meta.url)) : undefined;
  const sourceScript = script && path(script).startsWith(join(root, 'test') + '/');
  const digest = file => createHash('sha256').update(filesystem.readFileSync(file)).digest('hex');
  const validator = script && [join(root, 'scripts/check-imports.mjs'), join(root, 'scripts/check-tests.mjs'), join(root, 'scripts/check-security.mjs'), join(root, 'docs/host-baseline/verify-port.mjs')]
    .some(file => path(script) === file || (path(script).startsWith(privateRoot + '/') && digest(path(script)) === digest(file)));
  const generations = script?.endsWith('/original-native-generations.mjs') && digest(path(script)) === '02eef28c0b72a8c524f6fb74e321844fe55e08c787201c3ccec97d15723749dc';
  const lintProbe = (() => {
    const cwd = options?.cwd && resolve(options.cwd);
    if (bin !== process.execPath || args?.length !== 1 || !cwd?.startsWith(resolve(process.env.TMPDIR) + '/x-buddy-checks-') || args[0] !== join(cwd, 'lint-manifest-probe.mjs')) return false;
    try {
      if (fs.realpathSync(cwd) !== cwd) return false;
      const source = '// SPDX-License-Identifier: Apache-2.0\nconst a: any = 1;\n';
      const loopback = ['http', '://', 'localhost'].join('');
      const test = `// SPDX-License-Identifier: Apache-2.0\nconst u = '${loopback}/x';\n`;
      const hash = s => createHash('sha256').update(s).digest('hex');
      const expected = {schemaVersion:2,imports:[{kind:'imported',destination:'src/host/a.ts',destinationSha256:hash(source)},{kind:'imported',destination:'test/host/a.test.ts',destinationSha256:hash(test)}],exceptions:[{check:'eslint',destination:'src/host/a.ts',line:2,rule:'@typescript-eslint/no-explicit-any',lineSha256:hash('const a: any = 1;'),reason:'test'}]};
      const probe = `import { loadManifest, exceptionsFor } from ${JSON.stringify(join(root, 'scripts/lib/manifest.mjs'))}; exceptionsFor(loadManifest(), 'eslint');`;
      for (const file of [args[0], join(cwd, 'src/host/a.ts'), join(cwd, 'test/host/a.test.ts'), join(cwd, 'LICENSE'), join(cwd, 'docs/import-manifest.json')]) {
        if (fs.realpathSync(file) !== file) return false;
      }
      return fs.readFileSync(args[0], 'utf8') === probe && fs.readFileSync(join(cwd,'src/host/a.ts'),'utf8') === source && fs.readFileSync(join(cwd,'test/host/a.test.ts'),'utf8') === test && fs.readFileSync(join(cwd,'LICENSE'),'utf8') === 'Apache License\n' && fs.readFileSync(join(cwd,'docs/import-manifest.json'),'utf8') === JSON.stringify(expected);
    } catch { return false; }
  })();
  const observer = bin === '/usr/bin/python3' && args?.length === 3 && args[0] === '-I' && args[1] === '-c' && args[2] === DARWIN_CHILD_OBSERVER;
  const gitCommand = args?.[0] === '-C' ? args[2] : args?.[0];
  const localGit = ['git','/usr/bin/git'].includes(bin) && ['init','add','ls-files','cat-file','rev-parse','write-tree','status'].includes(gitCommand);
  const privateCopy = ['cp','/bin/cp'].includes(bin) && args?.[0] === '-R' && args.at(-1).startsWith(privateRoot + '/');
  const pidDiagnostic = bin === '/bin/ps' && args?.length === 4 && args[0] === '-p' && /^\d+$/.test(args[1]) && args[2] === '-o' && args[3] === 'pid=,lstart=,stat=';
  const inertDescendant = args?.length === 5 && args[0] === '-e' && createHash('sha256').update(args[1]).digest('hex') === '248a449d0b86efd241e8395e2963f424b4f336a539350fe3111270cfa0cb4d47'
    && ['finite','persistent'].includes(args[2]) && args.slice(3).every(p => p.startsWith(privateRoot + '/'));
  if (!(lintProbe || observer || localGit || privateCopy || pidDiagnostic || (bin === process.execPath && (sourceScript || validator || generations || inertDescendant) && (inertDescendant || !(args ?? []).some(arg => /^(?:-e|-p|-r|--eval|--print|--require|--inspect|--loader|--experimental-loader)(?:=|$)/.test(arg)))))) {
    guardState.deniedSpawns++; refuse('constructor/spawn');
  }
  guardState.allowedSpawns.push({ bin, script: observer ? 'fixed native observer' : script ?? args[0], envKeys: Object.keys(env).sort() });
};
for (const name of ['spawn','spawnSync','execFile','execFileSync']) {
  const original = cp[name]; cp[name] = function(bin, args, options, ...rest) {
    guardedChild(bin, args, options);
    if (bin === process.execPath) {
      if (!args.includes(import.meta.url) && !args.includes(fileURLToPath(import.meta.url))) args = ['--import', import.meta.url, ...args];
      options = { ...options, env: { ...(options?.env ?? process.env), CALLER_GUARD_ROOT: privateRoot, TMPDIR: process.env.TMPDIR, HOME: options?.env?.HOME ?? process.env.HOME } };
    }
    return original.call(this, bin, args, options, ...rest);
  };
}
const originalFork = cp.fork;
cp.fork = function(module, args = [], options = {}) {
  const script = module instanceof URL ? fileURLToPath(module) : module;
  guardedChild(options.execPath ?? process.execPath, [script, ...args], options);
  return originalFork.call(this, module, args, { ...options,
    execArgv: ['--import', import.meta.url],
    env: { ...(options.env ?? process.env), CALLER_GUARD_ROOT: privateRoot, TMPDIR: process.env.TMPDIR, HOME: options.env?.HOME ?? process.env.HOME } });
};
for (const name of ['exec','execSync']) cp[name] = () => { guardState.deniedSpawns++; refuse('unlisted process API'); };
registerHooks({ resolve(spec, context, next) {
  const codexPkgJson = /^@openai\/codex(?:-sdk|-[a-z0-9-]+)?\/package\.json$/.test(spec)
    && /(?:\/codex-binary\.(?:js|ts)|\/node_modules\/@openai\/codex(?:-sdk)?\/package\.json)$/.test(context?.parentURL ?? '');
  if (!codexPkgJson && (/^@openai\/codex|(?:^|\/)node_modules\/@openai\/codex/.test(spec))) { guardState.sdkImports++; refuse('installed SDK import'); }
  return next(spec, context);
} });
syncBuiltinESMExports();
void childProcess; void filesystem; void network; void http; void https; void dns;
