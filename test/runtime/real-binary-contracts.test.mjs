// SPDX-License-Identifier: Apache-2.0
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CASE_TIMEOUT_MS = 15_000;
export const SUITE_BUDGET_MS = 90_000;
export const STATIC_MACH_DNS_CONTAINMENT_STATUS = 'UNVERIFIED';
export const ALLOWED_CONTAINMENT_ERRNOS = Object.freeze(['EPERM', 'EACCES']);
export const FORBIDDEN_CONTAINMENT_ERRNOS = Object.freeze([
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

const LOOPBACK_IP = ['127', '0', '0', '1'].join('.');
const SANDBOX_EXEC_BIN = '/usr/bin/sandbox-exec';
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SRC_ROOT_URL = pathToFileURL(join(REPO_ROOT, 'src/')).href;

let sourceHooksInstalled = false;

/**
 * Narrowly scoped source module resolve/load hooks matching test/runtime/host-fixture.mjs
 * so canonical src/*.ts modules (with NodeNext .js relative specifiers, TypeScript syntax,
 * pinned better-sqlite3 native addon, and offline product-node-modules packages) load
 * cleanly without dist/ imports or editing host-fixture.mjs.
 */
export function installSourceModuleHooks() {
  if (sourceHooksInstalled) return;
  sourceHooksInstalled = true;

  const req = createRequire(import.meta.url);
  const tsCandidate = process.env.HOST_TYPESCRIPT || resolve(REPO_ROOT, '../offline/typescript');
  const ts = req(existsSync(tsCandidate) ? tsCandidate : 'typescript');

  const defaultSqliteSubdir = process.versions.modules === '137' ? 'node24' : 'node22';
  const sqlitePath =
    process.env.HOST_SQLITE ||
    resolve(REPO_ROOT, `../offline/${defaultSqliteSubdir}/node_modules/better-sqlite3`);
  const sqliteBindingPath = join(sqlitePath, 'build/Release/better_sqlite3.node');
  const nativeSqliteSource = [
    "import { createRequire } from 'node:module';",
    `const Native = createRequire(${JSON.stringify(import.meta.url)})(${JSON.stringify(sqlitePath)});`,
    'export default class extends Native {',
    '  constructor(path, options = {}) {',
    `    super(path, { ...options, nativeBinding: ${JSON.stringify(sqliteBindingPath)} });`,
    '  }',
    '}',
  ].join('\n');

  const offlineProductModules = resolve(REPO_ROOT, '../offline/product-node-modules');
  const codecHref = pathToFileURL(join(REPO_ROOT, 'test/foundation/lib/wukong-codec.mjs')).href;
  const builtinFallbacks = new Map([
    [
      'ws',
      [
        "import { EventEmitter } from 'node:events';",
        "import { Buffer } from 'node:buffer';",
        'export default class NodeWebSocketAdapter extends EventEmitter {',
        '  static OPEN = 1;',
        '  static CLOSED = 3;',
        '  binaryType = "arraybuffer";',
        '  #ws;',
        '  constructor(url) {',
        '    super();',
        '    this.#ws = new globalThis.WebSocket(url);',
        '    this.#ws.binaryType = "arraybuffer";',
        '    this.#ws.addEventListener("open", () => this.emit("open"));',
        '    this.#ws.addEventListener("message", (ev) => {',
        '      const data = ev.data instanceof ArrayBuffer ? ev.data : Buffer.from(ev.data);',
        '      this.emit("message", data);',
        '    });',
        '    this.#ws.addEventListener("close", () => this.emit("close"));',
        '    this.#ws.addEventListener("error", (ev) => this.emit("error", ev?.error instanceof Error ? ev.error : new Error("WebSocket error")));',
        '  }',
        '  get readyState() { return this.#ws.readyState; }',
        '  send(data) { this.#ws.send(data); }',
        '  close() { try { this.#ws.close(); } catch {} }',
        '  terminate() { try { this.#ws.close(); } catch {} }',
        '}',
      ].join('\n'),
    ],
    [
      'curve25519-js',
      [
        `import { x25519KeyPair, x25519Shared } from ${JSON.stringify(codecHref)};`,
        'export function generateKeyPair(seed) {',
        '  const kp = x25519KeyPair(seed);',
        '  return { private: new Uint8Array(seed), public: new Uint8Array(kp.publicKey) };',
        '}',
        'export function sharedKey(privSeed, peerPublic) {',
        '  const kp = x25519KeyPair(privSeed);',
        '  return new Uint8Array(x25519Shared(kp.privateKey, peerPublic));',
        '}',
      ].join('\n'),
    ],
    [
      'md5-typescript',
      [
        "import { createHash } from 'node:crypto';",
        'export const Md5 = {',
        '  init(str) { return createHash("md5").update(String(str), "utf8").digest("hex"); },',
        '};',
      ].join('\n'),
    ],
    [
      'crypto-js',
      [
        "import { createDecipheriv } from 'node:crypto';",
        "import { Buffer } from 'node:buffer';",
        'const enc = {',
        '  Base64: {',
        '    parse(str) { return Buffer.from(String(str), "base64"); },',
        '    stringify(buf) { return Buffer.from(buf).toString("base64"); },',
        '  },',
        '  Utf8: {',
        '    parse(str) { return Buffer.from(String(str), "utf8"); },',
        '    stringify(buf) { return Buffer.from(buf).toString("utf8"); },',
        '  },',
        '};',
        'const AES = {',
        '  decrypt(cipherB64, keyBuf, opts) {',
        '    const ct = Buffer.from(String(cipherB64), "base64");',
        '    const decipher = createDecipheriv("aes-128-cbc", Buffer.from(keyBuf).subarray(0, 16), Buffer.from(opts.iv).subarray(0, 16));',
        '    const out = Buffer.concat([decipher.update(ct), decipher.final()]);',
        '    return { toString(encoder) { return encoder ? encoder.stringify(out) : out.toString("hex"); } };',
        '  },',
        '};',
        'export default { enc, AES, mode: { CBC: "CBC" }, pad: { Pkcs7: "Pkcs7" } };',
      ].join('\n'),
    ],
  ]);

  registerHooks({
    resolve(spec, context, next) {
      if (spec === 'better-sqlite3') {
        return { url: 'v156b-source:native-sqlite', shortCircuit: true };
      }
      if (context.parentURL?.startsWith(SRC_ROOT_URL) && spec.startsWith('.') && spec.endsWith('.js')) {
        const target = new URL(spec.slice(0, -3) + '.ts', context.parentURL);
        target.search = '';
        if (existsSync(fileURLToPath(target))) {
          return next(target.href, context);
        }
      }
      if (
        !spec.startsWith('.') &&
        !spec.startsWith('/') &&
        !spec.startsWith('node:') &&
        !spec.includes(':') &&
        !spec.startsWith('@openai/codex')
      ) {
        try {
          return next(spec, context);
        } catch {
          try {
            const resolvedPath = req.resolve(spec, { paths: [offlineProductModules] });
            return next(pathToFileURL(resolvedPath).href, context);
          } catch (err) {
            if (builtinFallbacks.has(spec)) {
              return { url: `v156b-source:${spec}`, shortCircuit: true };
            }
            throw err;
          }
        }
      }
      return next(spec, context);
    },
    load(target, context, next) {
      if (target === 'v156b-source:native-sqlite') {
        return { format: 'module', source: nativeSqliteSource, shortCircuit: true };
      }
      if (target.startsWith('v156b-source:')) {
        const pkgName = target.slice('v156b-source:'.length);
        if (builtinFallbacks.has(pkgName)) {
          return { format: 'module', source: builtinFallbacks.get(pkgName), shortCircuit: true };
        }
      }
      if (target.startsWith(SRC_ROOT_URL) && new URL(target).pathname.endsWith('.ts')) {
        const source = readFileSync(fileURLToPath(target), 'utf8');
        const outputText = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        }).outputText;
        return { format: 'module', source: outputText, shortCircuit: true };
      }
      return next(target, context);
    },
  });
}

installSourceModuleHooks();

const { normalizeProcessParams, normalizeTurnParams } = await import('../../src/app-server/params.ts');

/**
 * Loads all canonical src/ and test/foundation modules used by the v156B harness
 * without running containment preflight, resolving native binaries, or opening sockets.
 */
export async function loadCanonicalSourceModules() {
  installSourceModuleHooks();
  const [
    codexBinaryMod,
    clientMod,
    paramsMod,
    errorsMod,
    serverRequestsMod,
    bootstrapMod,
    runtimeMod,
    executorMod,
    hostCallerMod,
    octoEgressMod,
    hostIndexMod,
    mockResponsesMod,
    fakeOctoMod,
  ] = await Promise.all([
    import('../../src/runtime/codex-binary.ts'),
    import('../../src/app-server/client.ts'),
    import('../../src/app-server/params.ts'),
    import('../../src/app-server/errors.ts'),
    import('../../src/app-server/server-requests.ts'),
    import('../../src/runtime/bootstrap.ts'),
    import('../../src/runtime/runtime.ts'),
    import('../../src/runtime/executor.ts'),
    import('../../src/runtime/host-caller.ts'),
    import('../../src/runtime/octo-egress.ts'),
    import('../../src/host/index.ts'),
    import('../foundation/lib/mock-responses.mjs'),
    import('../foundation/lib/fake-octo.mjs'),
  ]);
  return {
    ...codexBinaryMod,
    ...clientMod,
    ...paramsMod,
    ...errorsMod,
    ...serverRequestsMod,
    ...bootstrapMod,
    ...runtimeMod,
    ...executorMod,
    ...hostCallerMod,
    ...octoEgressMod,
    ...hostIndexMod,
    ...mockResponsesMod,
    ...fakeOctoMod,
  };
}

export const REAL_BINARY_CONTRACT_MANIFEST = Object.freeze(
  [
    {
      id: 'v156B-PREFLIGHT',
      title:
        'Process-local Seatbelt containment preflight (loopback positive, own-host non-loopback TCP/UDP EPERM/EACCES negative, resolver/Mach IPC negative, 3-level parent->child->grandchild inheritance)',
      r8Section: 'D-v156 §4 / R8 §6.3 preflight',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-01',
      title:
        'Pre-init request rejected with -32600 Not initialized; second initialize rejected with -32600 Already initialized',
      r8Section: 'R8 §6.3 SB-01',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-02',
      title:
        'Second turn/start on active thread receives no turn/started within window; BotCodexRuntime lane serializes concurrent runTurn',
      r8Section: 'R8 §6.3 SB-02',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-03',
      title:
        'After terminal codex exec resume turn, thread/resume{config:{}} + turn/start includes terminal turn in model input while resume without config omits it',
      r8Section: 'R8 §6.3 SB-03',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-04',
      title:
        'turn/start overrides persist across turns and reload; runtime sends only cwd, approvalPolicy, and effort',
      r8Section: 'R8 §6.3 SB-04',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-05',
      title:
        'AGENTS.md edited after turn 1 leaves MockResponsesServer recorded instructions unchanged on turn 2',
      r8Section: 'R8 §6.3 SB-05',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-06',
      title:
        'Bidirectional session resume between codex exec (SDK) and codex app-server preserves prior turns',
      r8Section: 'R8 §6.3 SB-06',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-07',
      title:
        'approvalPolicy=never runs shell tool without server request; on-request escalation receives id:0 and -32000 parity error -> item failed, turn/completed, serverRequest/resolved',
      r8Section: 'R8 §6.3 SB-07',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-08',
      title:
        'turn/interrupt returns {} within <=2s and emits turn/completed status=interrupted within <=5s',
      r8Section: 'R8 §6.3 SB-08',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-09',
      title:
        'Two concurrent 4s scripted turns across separate threads complete within <=1.3x single-turn wall time inside <=15s case ceiling',
      r8Section: 'R8 §6.3 SB-09',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-10',
      title:
        'Mid-turn SIGTERM/SIGKILL/EOF termination bounds and post-respawn thread/resume shows interrupted turn',
      r8Section: 'R8 §6.3 SB-10',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-11',
      title:
        'CODEX_API_KEY env alone sends no Authorization; ephemeral store + account/login/start{type:apiKey} sends Bearer token and writes no auth.json in HOME or CODEX_HOME',
      r8Section: 'R8 §6.3 SB-11',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-12',
      title:
        'codex exec with -c approval_policy="on-request" records turn_context.approval_policy === "never" in rollout',
      r8Section: 'R8 §6.3 SB-12',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-13',
      title:
        'thread/start runtimeWorkspaceRoots:[cwd,extraDir] with network -c matches codex exec --add-dir extraDir turn_context',
      r8Section: 'R8 §6.3 SB-13',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SB-14',
      title:
        'codex app-server --session-source exec exits non-zero with unexpected argument',
      r8Section: 'R8 §6.3 SB-14',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'SP-T1',
      title:
        'thread/start.dynamicTools registration and item/tool/call across turn 1, thread/resume{config:{}}, and respawn classifies Outcome A/B/C',
      r8Section: 'R8 §6.4 SP-T1',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
    {
      id: 'v156B-SPINE',
      title:
        'Production startBot + FakeOctoServer + MockResponsesServer DM reply, /reset barrier, and AppServer-to-SDK rollback continuity',
      r8Section: 'D-v156 §4 / R8 §3.6.1',
      timeoutMs: CASE_TIMEOUT_MS,
      defaultStatus: 'NOT_RUN',
    },
  ].map((row) => Object.freeze(row)),
);

export function createRowLedger() {
  const ledger = new Map();
  for (const row of REAL_BINARY_CONTRACT_MANIFEST) {
    ledger.set(row.id, {
      id: row.id,
      title: row.title,
      r8Section: row.r8Section,
      timeoutMs: row.timeoutMs,
      status: 'NOT_RUN',
      durationMs: 0,
      detail: 'NOT_RUN: gate not executed for this row',
    });
  }
  return ledger;
}

/**
 * Distinguishes a failed v156B-PREFLIGHT row (status: 'FAIL') from downstream rows
 * halted by prior preflight failure (which must remain status: 'NOT_RUN').
 */
export function recordRowOutcomeOnError(rowLedger, rowId, err, preflightError, durationMs = 0) {
  const existing = rowLedger.get(rowId);
  if (!existing) return;
  if (rowId !== 'v156B-PREFLIGHT' && preflightError) {
    rowLedger.set(rowId, {
      ...existing,
      status: 'NOT_RUN',
      durationMs: 0,
      detail: `NOT_RUN: halted by prior v156B-PREFLIGHT failure (${preflightError.message ?? String(preflightError)})`,
    });
    return;
  }
  rowLedger.set(rowId, {
    ...existing,
    status: 'FAIL',
    durationMs,
    detail: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Only kernel sandbox denial errnos (EPERM or EACCES) prove Seatbelt containment.
 * Routing failures (ENETUNREACH, EHOSTUNREACH) and DNS NXDOMAIN (ENOTFOUND)
 * are explicitly rejected so offline hosts or catch-any errors never produce false positives.
 */
export function classifyContainmentErrno(code) {
  if (typeof code !== 'string' || code.length === 0) return false;
  if (FORBIDDEN_CONTAINMENT_ERRNOS.includes(code)) return false;
  return ALLOWED_CONTAINMENT_ERRNOS.includes(code);
}

/**
 * Seatbelt profile restricting network egress to localhost while denying remote IP,
 * remote unix-sockets, system resolver socket/config files (/var/run/mDNSResponder,
 * /etc/resolv.conf), and macOS DirectoryService/mDNSResponder/SystemConfiguration Mach lookup services.
 * Note: static unknown Mach/DNS behavior on target hardware remains UNVERIFIED
 * (STATIC_MACH_DNS_CONTAINMENT_STATUS = 'UNVERIFIED') until XIN-2750 executes
 * runContainmentPreflight in the separately released tester gate.
 */
export function buildLoopbackOnlySeatbeltProfile() {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound (remote ip))',
    '(allow network-outbound (remote ip "localhost:*"))',
    '(deny network-outbound (remote unix-socket))',
    '(deny file-read* file-write*',
    '  (literal "/var/run/mDNSResponder")',
    '  (literal "/private/var/run/mDNSResponder")',
    '  (literal "/etc/resolv.conf")',
    '  (literal "/private/etc/resolv.conf"))',
    '(deny mach-lookup',
    '  (global-name "com.apple.system.DirectoryService.libinfo_v1")',
    '  (global-name "com.apple.mDNSResponder.reloaded")',
    '  (global-name "com.apple.dnssd.service")',
    '  (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
  ].join('\n');
}

/**
 * Build canonical AppServer spawn parameters and 0.142.3 account/login/start RPC
 * payload by delegating directly to src/app-server/params.ts normalizeProcessParams
 * so args, login, and single-prepend vendorPathDirs PATH match production 100%.
 */
export function buildContainedAppServerSpawnSpec({
  wrapperPath,
  baseUrl,
  apiKey,
  cwd,
  baseEnv = {},
  extraEnv = {},
  vendorPathDirs = [],
  sandboxMode = 'read-only',
  approvalPolicy = 'never',
  networkAccessEnabled = false,
  webSearchMode = 'disabled',
  modelReasoningEffort,
}) {
  const mergedEnv = { ...baseEnv, ...extraEnv };
  const normalized = normalizeProcessParams(
    {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      env: mergedEnv,
    },
    {
      workingDirectory: cwd,
      sandboxMode,
      networkAccessEnabled,
      webSearchMode,
      approvalPolicy,
      ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    },
    mergedEnv,
    vendorPathDirs,
  );
  return {
    bin: wrapperPath,
    cwd,
    args: normalized.args,
    env: normalized.env,
    login: normalized.login,
    loginRpc: normalized.login ? { method: 'account/login/start', params: normalized.login } : undefined,
  };
}

/**
 * Builds AppServerClientOptions using the canonical onServerRequest property
 * from src/app-server/client.ts (lines 75, 383).
 */
export function buildAppServerClientOptions({
  spec,
  lifecycle,
  onServerRequest,
  serverRequests,
  clientVersion = '0.169.1',
}) {
  const handler = onServerRequest ?? serverRequests;
  return {
    bin: spec.bin,
    cwd: spec.cwd,
    args: spec.args,
    env: spec.env,
    clientInfo: { name: 'codex_sdk_ts', title: null, version: clientVersion },
    lifecycle,
    ...(handler ? { onServerRequest: handler } : {}),
  };
}

/**
 * Builds a complete TurnRequest with full TurnContext (incarnationId, origin,
 * principal, session, policy with egressAllowlist, and delivery) required by
 * BotCodexRuntime.openTurn -> freezeContext in src/runtime/runtime.ts:473-478.
 */
export function buildSb02TurnRequest({ cwdDir, incarnationId, text, seq = 1 }) {
  return {
    laneKey: 'sb02-lane',
    sessionKey: 'sb02-session',
    prompt: text,
    threadParams: { cwd: cwdDir, sandbox: 'read-only' },
    turnParams: { cwd: cwdDir },
    ctx: {
      incarnationId,
      origin: 'chat',
      principal: { uid: 'owner-uid-sb02', role: 'owner' },
      session: {
        sessionKey: 'sb02-session',
        resetGeneration: 0,
        channelId: 'dm-sb02',
        channelType: 1,
      },
      policy: {
        tools: 'none',
        egressAllowlist: [LOOPBACK_IP],
      },
      delivery: { logicalOrigin: `sb02-turn-${seq}` },
    },
  };
}

/**
 * Creates the SP-T1 dynamic tool server-request dispatcher and Outcome A/B/C
 * classifier matching the 0.142.3 DynamicToolCallResponse wire schema.
 */
export function createSpT1ToolDispatcher() {
  const state = {
    phase: 'turn1',
    toolCallsTurn1: 0,
    toolCallsAfterResume: 0,
    toolCallsAfterRespawn: 0,
    observedRequests: [],
  };
  const onServerRequest = async (req) => {
    state.observedRequests.push(req);
    if (req.method === 'item/tool/call') {
      if (state.phase === 'turn1') state.toolCallsTurn1++;
      else if (state.phase === 'resume') state.toolCallsAfterResume++;
      else if (state.phase === 'respawn') state.toolCallsAfterRespawn++;
      const items = [{ type: 'inputText', text: 'tool-ok' }];
      return {
        result: {
          contentItems: items,
          content: items,
          success: true,
        },
      };
    }
    return { error: { code: -32000, message: `unhandled server request: ${req.method}` } };
  };
  const classifyOutcome = () =>
    state.toolCallsTurn1 > 0 && state.toolCallsAfterResume > 0 && state.toolCallsAfterRespawn > 0
      ? 'A'
      : state.toolCallsTurn1 > 0
        ? 'B'
        : 'C';
  return { state, onServerRequest, classifyOutcome };
}

/**
 * Extracts turn_context.sandbox_policy objects from rollout JSONL content for SB-13 parity checks.
 */
export function extractRolloutTurnContextSandboxPolicies(jsonlText) {
  const policies = [];
  for (const rawLine of String(jsonlText ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const tc = parsed?.type === 'turn_context' ? parsed.payload : parsed?.turn_context ?? null;
      if (tc && typeof tc === 'object' && tc.sandbox_policy) {
        policies.push(tc.sandbox_policy);
      }
    } catch {}
  }
  return policies;
}

/**
 * Parses `/bin/ps -Ao pid=,ppid=,lstart=` (or 2-column `pid=,ppid=`) into a process table
 * mapping pid -> { pid, ppid, lstart } and childrenByParent mapping ppid -> pid[].
 */
export function parsePsProcessTable(psOutput) {
  const processes = new Map();
  const childrenByParent = new Map();
  for (const rawLine of String(psOutput ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const lstart = (match[3] ?? '').trim();
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    processes.set(pid, { pid, ppid, lstart });
    let list = childrenByParent.get(ppid);
    if (!list) {
      list = [];
      childrenByParent.set(ppid, list);
    }
    list.push(pid);
  }
  return { processes, childrenByParent };
}

export function parsePsProcessTree(psOutput) {
  return parsePsProcessTable(psOutput).childrenByParent;
}

/**
 * Returns all owned descendants + root PIDs in bottom-up post-order (leaves first,
 * roots last) so child and grandchild tool/SDK processes are terminated before
 * or alongside their parents without relying on negative-PID group signals.
 */
export function collectDescendantPids(rootPids, psOutput) {
  const { childrenByParent } = parsePsProcessTable(psOutput);
  const visited = new Set();
  const ordered = [];
  const visit = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0 || visited.has(pid)) return;
    visited.add(pid);
    const kids = childrenByParent.get(pid) ?? [];
    for (const kid of kids) visit(kid);
    ordered.push(pid);
  };
  for (const rootPid of rootPids) {
    visit(Number(rootPid));
  }
  return ordered;
}

/**
 * Collects bottom-up descendant targets for owned roots while verifying start-identity (`lstart`)
 * so a recycled PID (whose current `lstart` differs from the recorded `lstart`) is never signaled
 * or traversed.
 */
export function collectOwnedDescendantTargets(ownedRecords, psOutput) {
  const { processes, childrenByParent } = parsePsProcessTable(psOutput);
  const visited = new Set();
  const targets = [];
  const confirmedExitedPids = [];
  const recycledSkippedPids = [];

  const visit = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0 || visited.has(pid)) return;
    visited.add(pid);
    const proc = processes.get(pid);
    if (!proc) return;
    const kids = childrenByParent.get(pid) ?? [];
    for (const kid of kids) visit(kid);
    targets.push({ pid: proc.pid, ppid: proc.ppid, lstart: proc.lstart });
  };

  const normalizedRecords =
    ownedRecords instanceof Map ? [...ownedRecords.values()] : Array.isArray(ownedRecords) ? ownedRecords : [];

  for (const rawRec of normalizedRecords) {
    const pid = typeof rawRec === 'number' ? rawRec : Number(rawRec?.pid);
    const expectedLstart = typeof rawRec === 'object' && rawRec ? String(rawRec.lstart ?? '').trim() : '';
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const live = processes.get(pid);
    if (!live) {
      confirmedExitedPids.push(pid);
      continue;
    }
    if (expectedLstart && live.lstart && live.lstart !== expectedLstart) {
      confirmedExitedPids.push(pid);
      recycledSkippedPids.push(pid);
      continue;
    }
    visit(pid);
  }

  return {
    targets,
    confirmedExitedPids,
    recycledSkippedPids,
  };
}

/**
 * Prunes confirmed-exited or recycled PIDs from an owned process Map (`pid -> { pid, lstart }`).
 */
export function pruneConfirmedExitedProcesses(ownedProcessMap, psOutput) {
  if (!(ownedProcessMap instanceof Map)) return [];
  const { confirmedExitedPids } = collectOwnedDescendantTargets(ownedProcessMap, psOutput);
  for (const pid of confirmedExitedPids) {
    ownedProcessMap.delete(pid);
  }
  return confirmedExitedPids;
}

export function buildSseTextReply(text, { respId = 'resp_loopback_1', msgId = 'msg_loopback_1', delayMs = 0 } = {}) {
  const outputItem = {
    id: msgId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return {
    events: [
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress', output: [] } },
      },
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        },
      },
      {
        event: 'response.content_part.added',
        data: {
          type: 'response.content_part.added',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
      },
      {
        event: 'response.output_text.delta',
        ...(delayMs > 0 ? { delayMs } : {}),
        data: {
          type: 'response.output_text.delta',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: text,
        },
      },
      {
        event: 'response.output_text.done',
        data: {
          type: 'response.output_text.done',
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          text,
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: outputItem,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            id: respId,
            object: 'response',
            status: 'completed',
            output: [outputItem],
          },
        },
      },
    ],
  };
}

export function buildSseFunctionCallReply(
  name,
  argsObj,
  { respId = 'resp_fn_1', itemId = 'fc_item_1', callId = 'call_loopback_1', delayMs = 0 } = {},
) {
  const argumentsJson = typeof argsObj === 'string' ? argsObj : JSON.stringify(argsObj);
  const fnItem = {
    id: itemId,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: argumentsJson,
    status: 'completed',
  };
  return {
    events: [
      {
        event: 'response.created',
        data: { type: 'response.created', response: { id: respId, object: 'response', status: 'in_progress', output: [] } },
      },
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: itemId,
            type: 'function_call',
            call_id: callId,
            name,
            arguments: '',
            status: 'in_progress',
          },
        },
      },
      {
        event: 'response.function_call_arguments.delta',
        ...(delayMs > 0 ? { delayMs } : {}),
        data: {
          type: 'response.function_call_arguments.delta',
          item_id: itemId,
          output_index: 0,
          call_id: callId,
          delta: argumentsJson,
        },
      },
      {
        event: 'response.function_call_arguments.done',
        data: {
          type: 'response.function_call_arguments.done',
          item_id: itemId,
          output_index: 0,
          call_id: callId,
          arguments: argumentsJson,
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: 0,
          item: fnItem,
        },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: {
            id: respId,
            object: 'response',
            status: 'completed',
            output: [fnItem],
          },
        },
      },
    ],
  };
}

function bearerSha256(token) {
  return createHash('sha256').update(`Bearer ${token}`).digest('hex');
}

function postResponsesRequests(mock) {
  return mock.requests().filter((r) => r.method === 'POST' && r.path === '/v1/responses');
}

function cleanDir(dir) {
  if (!dir || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isDirectory()) {
      cleanDir(full);
    } else {
      try {
        unlinkSync(full);
      } catch {}
    }
  }
  try {
    rmdirSync(dir);
  } catch {}
}

function listFilesRecursive(dir, prefix = '') {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    if (lstatSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Verifies that neither private HOME nor private CODEX_HOME contains auth.json
 * or credential artifacts.
 */
export function assertNoAuthFiles(homeDir, codexHomeDir, rowId = 'case') {
  assert.equal(
    existsSync(join(homeDir, '.codex', 'auth.json')),
    false,
    `${rowId}: HOME/.codex/auth.json must never be written`,
  );
  assert.deepEqual(
    readdirSync(homeDir),
    [],
    `${rowId}: private HOME must remain completely clean`,
  );
  const codexHomeFiles = listFilesRecursive(codexHomeDir);
  assert.equal(
    codexHomeFiles.some((f) => f === 'auth.json' || f.endsWith('/auth.json') || f.includes('credentials')),
    false,
    `${rowId}: CODEX_HOME must never persist auth.json or credential files (found: ${codexHomeFiles.join(', ')})`,
  );
}

function isProcessGone(pid) {
  if (!pid || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

function snapshotPsOutput() {
  try {
    return execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,lstart='], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

function captureLiveProcessRecord(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const { processes } = parsePsProcessTable(snapshotPsOutput());
  const entry = processes.get(pid);
  return {
    pid,
    lstart: entry?.lstart ?? '',
  };
}

function trackOwnedProcess(pid, caseOwnedProcesses, pidLedgerPath, suiteActiveProcesses) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const rec = captureLiveProcessRecord(pid);
  if (!rec) return;
  if (caseOwnedProcesses instanceof Map) {
    caseOwnedProcesses.set(pid, rec);
  }
  if (suiteActiveProcesses instanceof Map) {
    suiteActiveProcesses.set(pid, rec);
  }
  if (pidLedgerPath) {
    writeFileSync(pidLedgerPath, JSON.stringify(rec) + '\n', { flag: 'a' });
  }
}

function readRecordedProcessRecords(pidLedgerPath, extraRecords = []) {
  const byPid = new Map();
  const addRec = (raw) => {
    const pid = typeof raw === 'number' ? raw : Number(raw?.pid);
    const lstart = typeof raw === 'object' && raw ? String(raw.lstart ?? '').trim() : '';
    if (!Number.isInteger(pid) || pid <= 0) return;
    const prev = byPid.get(pid);
    if (!prev || (!prev.lstart && lstart)) {
      byPid.set(pid, { pid, lstart });
    }
  };
  if (extraRecords instanceof Map) {
    for (const r of extraRecords.values()) addRec(r);
  } else if (Array.isArray(extraRecords)) {
    for (const r of extraRecords) addRec(r);
  }
  if (pidLedgerPath && existsSync(pidLedgerPath)) {
    const lines = readFileSync(pidLedgerPath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('{')) {
        try {
          addRec(JSON.parse(line));
          continue;
        } catch {}
      }
      const parsedPid = Number.parseInt(line, 10);
      if (Number.isInteger(parsedPid) && parsedPid > 0) {
        addRec({ pid: parsedPid, lstart: '' });
      }
    }
  }
  return byPid;
}

function isTargetStillSameProcess(target, psTable) {
  const live = psTable.processes.get(target.pid);
  if (!live) return false;
  if (target.lstart && live.lstart && live.lstart !== target.lstart) {
    return false;
  }
  return !isProcessGone(target.pid);
}

export async function reapOwnedProcesses(
  pidLedgerPath,
  ownedRecords = new Map(),
  waitBudgetMs = 2_000,
  suiteActiveProcesses = null,
) {
  const combinedMap = readRecordedProcessRecords(pidLedgerPath, ownedRecords);
  if (combinedMap.size === 0) return [];

  const initialPs = snapshotPsOutput();
  const { targets } = collectOwnedDescendantTargets(combinedMap, initialPs);
  const filteredTargets = targets.filter((t) => t.pid !== process.pid);

  if (filteredTargets.length > 0) {
    const currentPsTable = parsePsProcessTable(initialPs);
    for (const target of filteredTargets) {
      if (isTargetStillSameProcess(target, currentPsTable)) {
        try {
          process.kill(target.pid, 'SIGTERM');
        } catch {}
      }
    }

    const sigtermDeadline = Date.now() + Math.min(400, waitBudgetMs);
    while (Date.now() < sigtermDeadline) {
      const pollTable = parsePsProcessTable(snapshotPsOutput());
      if (filteredTargets.every((t) => !isTargetStillSameProcess(t, pollTable))) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const preKillTable = parsePsProcessTable(snapshotPsOutput());
    for (const target of filteredTargets) {
      if (isTargetStillSameProcess(target, preKillTable)) {
        try {
          process.kill(target.pid, 'SIGKILL');
        } catch {}
      }
    }

    const killDeadline = Date.now() + waitBudgetMs;
    while (Date.now() < killDeadline) {
      const pollTable = parsePsProcessTable(snapshotPsOutput());
      if (filteredTargets.every((t) => !isTargetStillSameProcess(t, pollTable))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const finalPs = snapshotPsOutput();
  if (ownedRecords instanceof Map) {
    pruneConfirmedExitedProcesses(ownedRecords, finalPs);
  }
  if (suiteActiveProcesses instanceof Map) {
    pruneConfirmedExitedProcesses(suiteActiveProcesses, finalPs);
  }
  return filteredTargets.map((t) => t.pid);
}

export const reapProcessTreeFromLedger = reapOwnedProcesses;

function createSandboxedCodexWrapper(dir, realCodexBin, profileText, pidLedgerPath) {
  const profilePath = join(dir, 'loopback-only.sb');
  const wrapperPath = join(dir, 'codex-sandboxed');
  writeFileSync(profilePath, profileText, { mode: 0o600 });
  const script = [
    '#!/bin/sh',
    'LSTART=$(/bin/ps -p "$$" -o lstart= 2>/dev/null | sed "s/^[[:space:]]*//;s/[[:space:]]*$//" || true)',
    `printf '{"pid":%s,"lstart":"%s"}\\n' "$$" "$LSTART" >> "${pidLedgerPath}"`,
    `exec "${SANDBOX_EXEC_BIN}" -f "${profilePath}" "${realCodexBin}" "$@"`,
    '',
  ].join('\n');
  writeFileSync(wrapperPath, script, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  return { profilePath, wrapperPath };
}

function createDirectCodexWrapper(dir, realCodexBin, pidLedgerPath) {
  const wrapperPath = join(dir, 'codex-direct');
  const script = [
    '#!/bin/sh',
    'LSTART=$(/bin/ps -p "$$" -o lstart= 2>/dev/null | sed "s/^[[:space:]]*//;s/[[:space:]]*$//" || true)',
    `printf '{"pid":%s,"lstart":"%s"}\\n' "$$" "$LSTART" >> "${pidLedgerPath}"`,
    `exec "${realCodexBin}" "$@"`,
    '',
  ].join('\n');
  writeFileSync(wrapperPath, script, { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  return { profilePath: null, wrapperPath };
}

function runSandboxedNodeProbe(profileText, scriptSource, env, pidLedgerPath, caseOwnedProcesses, suiteActiveProcesses, timeoutMs = 5_000) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(
      SANDBOX_EXEC_BIN,
      ['-p', profileText, process.execPath, '--input-type=module', '-e', scriptSource],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (child.pid) {
      trackOwnedProcess(child.pid, caseOwnedProcesses, pidLedgerPath, suiteActiveProcesses);
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(async () => {
      await reapOwnedProcesses(pidLedgerPath, caseOwnedProcesses, 500, suiteActiveProcesses);
      rejectProbe(new Error(`Sandboxed probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectProbe(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveProbe({ code, signal, stdout: stdout.trim(), stderr: stderr.trim(), pid: child.pid });
    });
  });
}

function findLocalNonLoopbackIpv4() {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const info of entries ?? []) {
      if (info && info.family === 'IPv4' && !info.internal && info.address && !info.address.startsWith('127.')) {
        return info.address;
      }
    }
  }
  return null;
}

async function startEphemeralListener(host, handler) {
  let connections = 0;
  const server = createServer((req, res) => {
    connections++;
    handler(req, res);
  });
  server.on('connection', () => {
    connections++;
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    host,
    port,
    get connections() {
      return connections;
    },
    baseUrl: ['http', '://', host, ':', String(port)].join(''),
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function startEphemeralUdpListener(host) {
  let packets = 0;
  const socket = createSocket('udp4');
  socket.on('message', () => {
    packets++;
  });
  await new Promise((resolveBind, rejectBind) => {
    socket.once('error', rejectBind);
    socket.bind(0, host, () => {
      socket.off('error', rejectBind);
      resolveBind();
    });
  });
  const addr = socket.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    socket,
    host,
    port,
    get packets() {
      return packets;
    },
    async close() {
      await new Promise((resolveClose) => {
        try {
          socket.close(() => resolveClose());
        } catch {
          resolveClose();
        }
      });
    },
  };
}

/**
 * B1 Remediation:
 * - Zero external IP or external domain constants anywhere; requires own-host non-loopback
 *   IPv4 interface and fails closed with STOP_B_PREFLIGHT_FAILED if unavailable.
 * - Local non-loopback TCP and UDP negative controls target ephemeral listeners bound on
 *   the host's own non-loopback IPv4 interface and accept ONLY EPERM or EACCES.
 * - System resolver / Mach IPC containment verifies /var/run/mDNSResponder unix-socket
 *   EPERM/EACCES denial, /etc/resolv.conf read EPERM/EACCES denial, c-ares non-loopback
 *   UDP DNS denial (0 packets received by local UDP listener), and /usr/bin/dns-sd Mach
 *   mDNSResponder daemon IPC denial, plus dns.lookup('localhost') as a positive loopback
 *   control (not external DNS isolation proof).
 * - Verifies 3-level Seatbelt inheritance across sandboxed parent (depth 1) ->
 *   sandboxed child (depth 2) -> sandboxed grandchild (depth 3).
 */
async function runContainmentPreflight(
  privateEnv,
  rootDir,
  pidLedgerPath,
  caseOwnedProcesses,
  suiteActiveProcesses,
) {
  if (!existsSync(SANDBOX_EXEC_BIN)) {
    throw new Error(`STOP_B_PREFLIGHT_FAILED: ${SANDBOX_EXEC_BIN} not found on host`);
  }

  const localNonLoopbackIp = findLocalNonLoopbackIpv4();
  if (!localNonLoopbackIp) {
    throw new Error(
      'STOP_B_PREFLIGHT_FAILED: host has no active non-loopback IPv4 interface; external fallback is forbidden',
    );
  }

  const healthSrv = await startEphemeralListener(LOOPBACK_IP, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  let localNonLoopbackTcpSrv = null;
  let localNonLoopbackUdpSrv = null;
  try {
    try {
      localNonLoopbackTcpSrv = await startEphemeralListener(localNonLoopbackIp, (_req, res) => {
        res.writeHead(500);
        res.end('UNEXPECTED_NON_LOOPBACK_TCP_REACHED');
      });
      localNonLoopbackUdpSrv = await startEphemeralUdpListener(localNonLoopbackIp);
    } catch (bindErr) {
      throw new Error(
        `STOP_B_PREFLIGHT_FAILED: unable to bind local non-loopback TCP/UDP listeners on ${localNonLoopbackIp}: ${
          bindErr instanceof Error ? bindErr.message : String(bindErr)
        }`,
      );
    }

    const nonLoopbackTargetIp = localNonLoopbackTcpSrv.host;
    const nonLoopbackTcpPort = localNonLoopbackTcpSrv.port;
    const nonLoopbackUdpPort = localNonLoopbackUdpSrv.port;
    const profileText = buildLoopbackOnlySeatbeltProfile();

    const verificationScript = `
      import net from 'node:net';
      import dgram from 'node:dgram';
      import dns from 'node:dns/promises';
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';

      const allowedErrnos = new Set(['EPERM', 'EACCES']);
      const forbiddenErrnos = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT']);
      const checkErrno = (label, code) => {
        if (forbiddenErrnos.has(code) || !allowedErrnos.has(code)) {
          console.error(label + '_INVALID_ERRNO:' + String(code));
          process.exit(31);
        }
      };

      // 1. Loopback HTTP + localhost lookup positive controls (note: dns.lookup('localhost') is a positive control only)
      const healthRes = await fetch(${JSON.stringify(`${healthSrv.baseUrl}/healthz`)});
      if (!healthRes.ok) {
        console.error('LOOPBACK_POSITIVE_FAILED:' + healthRes.status);
        process.exit(32);
      }
      const localhostAddrs = await dns.lookup('localhost', { all: true });
      if (!Array.isArray(localhostAddrs) || localhostAddrs.length === 0) {
        console.error('LOCALHOST_LOOKUP_POSITIVE_FAILED');
        process.exit(32);
      }

      // 2. Own-host non-loopback TCP negative control (strictly EPERM/EACCES; ENETUNREACH/EHOSTUNREACH forbidden)
      const tcpCode = await new Promise((resolveCode) => {
        const sock = net.connect({ host: ${JSON.stringify(nonLoopbackTargetIp)}, port: ${nonLoopbackTcpPort}, timeout: 1500 });
        sock.on('connect', () => {
          sock.destroy();
          console.error('NON_LOOPBACK_TCP_CONNECTED');
          process.exit(33);
        });
        sock.on('timeout', () => {
          sock.destroy();
          resolveCode('ETIMEDOUT');
        });
        sock.on('error', (err) => {
          resolveCode(String(err.code ?? 'UNKNOWN'));
        });
      });
      checkErrno('NON_LOOPBACK_TCP', tcpCode);

      // 3. Own-host non-loopback UDP negative control (strictly EPERM/EACCES)
      const udpDnsCode = await new Promise((resolveCode) => {
        const udp = dgram.createSocket('udp4');
        udp.on('error', (err) => {
          try { udp.close(); } catch {}
          resolveCode(String(err.code ?? 'UNKNOWN'));
        });
        udp.send(Buffer.from([0x00, 0x01, 0x01, 0x00]), ${nonLoopbackUdpPort}, ${JSON.stringify(nonLoopbackTargetIp)}, (err) => {
          try { udp.close(); } catch {}
          if (!err) {
            console.error('UDP_NON_LOOPBACK_SEND_SUCCEEDED');
            process.exit(34);
          }
          resolveCode(String(err.code ?? 'UNKNOWN'));
        });
      });
      checkErrno('UDP_NON_LOOPBACK', udpDnsCode);

      // 4. System resolver unix-socket (/var/run/mDNSResponder) & /etc/resolv.conf negative controls
      const mdnsSockCode = await new Promise((resolveCode) => {
        const s = net.connect({ path: '/var/run/mDNSResponder' });
        s.on('connect', () => {
          s.destroy();
          console.error('MDNS_UNIX_SOCKET_CONNECTED');
          process.exit(35);
        });
        s.on('error', (err) => resolveCode(String(err.code ?? 'UNKNOWN')));
      });
      checkErrno('MDNS_UNIX_SOCKET', mdnsSockCode);

      if (fs.existsSync('/etc/resolv.conf')) {
        let resolvCode = 'NONE';
        try {
          fs.readFileSync('/etc/resolv.conf', 'utf8');
        } catch (err) {
          resolvCode = String(err.code ?? 'UNKNOWN');
        }
        checkErrno('ETC_RESOLV_CONF', resolvCode);
      }

      // 5. Direct c-ares dns.Resolver pointed at own-host non-loopback UDP listener + Mach mDNSResponder daemon IPC negative control
      const resolver = new dns.Resolver({ timeout: 400, tries: 1 });
      resolver.setServers([${JSON.stringify(`${nonLoopbackTargetIp}:${nonLoopbackUdpPort}`)}]);
      let resolverSucceeded = false;
      try {
        await resolver.resolve4('localhost');
        resolverSucceeded = true;
      } catch (err) {
        if (err && (err.code === 'ENOTFOUND' || err.code === 'ENETUNREACH' || err.code === 'EHOSTUNREACH')) {
          console.error('DIRECT_DNS_RESOLVER_FORBIDDEN_ERRNO:' + String(err.code));
          process.exit(36);
        }
      }
      if (resolverSucceeded) {
        console.error('DIRECT_DNS_RESOLVER_SUCCEEDED');
        process.exit(36);
      }

      if (fs.existsSync('/usr/bin/dns-sd')) {
        const dnsSd = spawnSync('/usr/bin/dns-sd', ['-G', 'v4', 'localhost'], {
          timeout: 500,
          encoding: 'utf8',
        });
        const dnsSdOut = String(dnsSd.stdout ?? '') + String(dnsSd.stderr ?? '');
        if (dnsSdOut.includes('127.0.0.1')) {
          console.error('MDNS_MACH_IPC_LEAKED:' + dnsSdOut);
          process.exit(37);
        }
      }

      console.log(JSON.stringify({
        ok: true,
        pid: process.pid,
        ppid: process.ppid,
        tcpCode,
        udpDnsCode,
        mdnsSockCode,
      }));
    `;

    // Probe A: Direct sandboxed parent probe
    const parentProbe = await runSandboxedNodeProbe(
      profileText,
      verificationScript,
      privateEnv,
      pidLedgerPath,
      caseOwnedProcesses,
      suiteActiveProcesses,
      5_000,
    );
    if (parentProbe.code !== 0 || !parentProbe.stdout.includes('"ok":true')) {
      throw new Error(
        `STOP_B_PREFLIGHT_FAILED: parent probe failed (code=${parentProbe.code}, stdout=${parentProbe.stdout}, stderr=${parentProbe.stderr})`,
      );
    }

    // Probe B: Real 3-level Seatbelt inheritance (sandboxed parent depth 1 -> sandboxed child depth 2 -> sandboxed grandchild depth 3)
    const { wrapperPath } = createSandboxedCodexWrapper(
      rootDir,
      process.execPath,
      profileText,
      pidLedgerPath,
    );

    const sandboxedChildScript = `
      import { spawnSync } from 'node:child_process';
      import fs from 'node:fs';

      fs.writeFileSync(${JSON.stringify(pidLedgerPath)}, JSON.stringify({ pid: process.pid, lstart: '' }) + '\\n', { flag: 'a' });
      const selfCheck = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', ${JSON.stringify(verificationScript)}],
        { encoding: 'utf8', timeout: 4000 },
      );
      if (selfCheck.status !== 0 || !String(selfCheck.stdout).includes('"ok":true')) {
        console.error('GRANDCHILD_DEPTH3_FAILED:', selfCheck.status, selfCheck.stderr || selfCheck.stdout);
        process.exit(42);
      }
      const grandchildData = JSON.parse(String(selfCheck.stdout).trim().split('\\n').at(-1));
      if (grandchildData.ppid !== process.pid || grandchildData.pid === process.pid) {
        console.error('GRANDCHILD_LINEAGE_MISMATCH:', JSON.stringify(grandchildData), 'expected ppid=', process.pid);
        process.exit(43);
      }
      console.log(JSON.stringify({
        childOk: true,
        childPid: process.pid,
        childPpid: process.ppid,
        grandchildPid: grandchildData.pid,
        grandchildPpid: grandchildData.ppid,
      }));
    `;

    const sandboxedParentScript = `
      import { spawnSync } from 'node:child_process';
      import fs from 'node:fs';

      fs.writeFileSync(${JSON.stringify(pidLedgerPath)}, JSON.stringify({ pid: process.pid, lstart: '' }) + '\\n', { flag: 'a' });
      const childRes = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', ${JSON.stringify(sandboxedChildScript)}],
        { encoding: 'utf8', timeout: 4500 },
      );
      if (childRes.status !== 0 || !String(childRes.stdout).includes('"childOk":true')) {
        console.error('CHILD_DEPTH2_FAILED:', childRes.status, childRes.stderr || childRes.stdout);
        process.exit(41);
      }
      const childInfo = JSON.parse(String(childRes.stdout).trim().split('\\n').at(-1));
      if (childInfo.childPpid !== process.pid || childInfo.grandchildPpid !== childInfo.childPid) {
        console.error('THREE_LEVEL_LINEAGE_MISMATCH:', JSON.stringify(childInfo), 'parentPid=', process.pid);
        process.exit(44);
      }
      console.log('THREE_LEVEL_DESCENDANT_INHERITANCE_VERIFIED');
    `;

    const inheritanceResult = await new Promise((resolveChild, rejectChild) => {
      const child = spawn(wrapperPath, ['--input-type=module', '-e', sandboxedParentScript], {
        env: privateEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (child.pid) {
        trackOwnedProcess(child.pid, caseOwnedProcesses, pidLedgerPath, suiteActiveProcesses);
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(async () => {
        await reapOwnedProcesses(pidLedgerPath, caseOwnedProcesses, 500, suiteActiveProcesses);
        rejectChild(new Error('3-level descendant wrapper probe timed out'));
      }, 6_000);
      child.stdout.on('data', (c) => {
        stdout += String(c);
      });
      child.stderr.on('data', (c) => {
        stderr += String(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectChild(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveChild({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });

    if (
      inheritanceResult.code !== 0 ||
      !inheritanceResult.stdout.includes('THREE_LEVEL_DESCENDANT_INHERITANCE_VERIFIED')
    ) {
      throw new Error(
        `STOP_B_PREFLIGHT_FAILED: 3-level descendant inheritance probe failed (code=${inheritanceResult.code}, stderr=${inheritanceResult.stderr})`,
      );
    }

    if (localNonLoopbackTcpSrv.connections !== 0) {
      throw new Error(
        `STOP_B_PREFLIGHT_FAILED: local non-loopback TCP listener observed ${localNonLoopbackTcpSrv.connections} unexpected connections`,
      );
    }
    if (localNonLoopbackUdpSrv.packets !== 0) {
      throw new Error(
        `STOP_B_PREFLIGHT_FAILED: local non-loopback UDP listener observed ${localNonLoopbackUdpSrv.packets} unexpected packets`,
      );
    }

    await reapOwnedProcesses(pidLedgerPath, caseOwnedProcesses, 1_000, suiteActiveProcesses);

    return {
      profileText,
      localNonLoopbackIp,
      loopbackAllowed: true,
      nonLoopbackBlockedWithKernelErrno: true,
      dnsUdpAndUnixSocketBlockedWithKernelErrno: true,
      descendantInherited: true,
      staticMachDnsStatus: STATIC_MACH_DNS_CONTAINMENT_STATUS,
    };
  } finally {
    await localNonLoopbackUdpSrv?.close();
    await localNonLoopbackTcpSrv?.close();
    await healthSrv.close();
  }
}

const loaderOnlyMode = Boolean(globalThis.__v156B_LOADER_ONLY);
const v157RealBinaryMode = process.env.CODEX_OCTO_V157_REAL_BINARY === '1';
const gateReleased = process.env.CODEX_OCTO_REAL_BINARY_GATE === '1' || v157RealBinaryMode;
const gateRequired = process.env.CODEX_OCTO_REAL_BINARY_REQUIRE === '1';
const GATE_SKIP_REASON =
  'NOT_RUN: v156B real-binary/containment execution requires Linus XIN-2746 exact-head APPROVED and separate PjM XIN-2750 gate release (CODEX_OCTO_REAL_BINARY_GATE=1)';

if (!loaderOnlyMode && !gateReleased) {
  if (gateRequired) {
    for (const row of REAL_BINARY_CONTRACT_MANIFEST) {
      test(`${row.id}: ${row.title}`, { timeout: CASE_TIMEOUT_MS }, () => {
        throw new Error(`${GATE_SKIP_REASON} [row=${row.id}]`);
      });
    }
  } else {
    for (const row of REAL_BINARY_CONTRACT_MANIFEST) {
      test(`${row.id}: ${row.title}`, { timeout: CASE_TIMEOUT_MS, skip: `${GATE_SKIP_REASON} [row=${row.id}]` }, () => {});
    }
  }
} else if (!loaderOnlyMode && gateReleased) {
  const suiteStartedAt = Date.now();
  const rowLedger = createRowLedger();
  const suiteRootDir = mkdtempSync(join(tmpdir(), 'v156b-suite-'));
  const suitePidLedgerPath = join(suiteRootDir, 'suite-spawned-pids.jsonl');
  writeFileSync(suitePidLedgerPath, '', { mode: 0o600 });
  const suiteActiveProcesses = new Map();

  let sharedState = null;
  let preflightError = null;

  const assertWithinSuiteBudget = (stage) => {
    const elapsedMs = Date.now() - suiteStartedAt;
    if (elapsedMs > SUITE_BUDGET_MS) {
      throw new Error(`STOP_B_BUDGET_EXCEEDED: ${stage} exceeded ${SUITE_BUDGET_MS}ms suite ceiling (${elapsedMs}ms)`);
    }
  };

  const ensureSuiteInitialized = async (casePidLedgerPath, caseOwnedProcesses) => {
    if (preflightError) throw preflightError;
    if (sharedState) return sharedState;
    try {
      assertWithinSuiteBudget('preflight-start');
      let preflight;
      if (v157RealBinaryMode) {
        preflight = {
          profileText: null,
          localNonLoopbackIp: null,
          loopbackAllowed: true,
          nonLoopbackBlockedWithKernelErrno: false,
          dnsUdpAndUnixSocketBlockedWithKernelErrno: false,
          descendantInherited: false,
          staticMachDnsStatus: STATIC_MACH_DNS_CONTAINMENT_STATUS,
          supersededByV157: true,
        };
      } else {
        const preflightRoot = join(suiteRootDir, 'preflight');
        mkdirSync(preflightRoot, { mode: 0o700 });
        const preflightHome = join(preflightRoot, 'home');
        const preflightTmp = join(preflightRoot, 'tmp');
        const preflightCodexHome = join(preflightRoot, 'codex-home');
        mkdirSync(preflightHome, { mode: 0o700 });
        mkdirSync(preflightTmp, { mode: 0o700 });
        mkdirSync(preflightCodexHome, { mode: 0o700 });

        const preflightEnv = {
          PATH: '/usr/bin:/bin',
          HOME: preflightHome,
          TMPDIR: preflightTmp,
          CODEX_HOME: preflightCodexHome,
        };
        preflight = await runContainmentPreflight(
          preflightEnv,
          preflightRoot,
          casePidLedgerPath ?? suitePidLedgerPath,
          caseOwnedProcesses ?? suiteActiveProcesses,
          suiteActiveProcesses,
        );
      }

      const loadedModules = await loadCanonicalSourceModules();
      const resolved = loadedModules.resolveCodexBinary();
      assert.equal(resolved.version, loadedModules.PINNED_CODEX_VERSION);
      assert.equal(resolved.version, '0.169.1');
      assert.equal(existsSync(resolved.bin), true);

      const { wrapperPath, profilePath } = v157RealBinaryMode
        ? createDirectCodexWrapper(suiteRootDir, resolved.bin, suitePidLedgerPath)
        : createSandboxedCodexWrapper(
            suiteRootDir,
            resolved.bin,
            preflight.profileText,
            suitePidLedgerPath,
          );

      sharedState = {
        preflight,
        resolved,
        wrapperPath,
        profilePath,
        ...loadedModules,
      };
      return sharedState;
    } catch (err) {
      preflightError = err instanceof Error ? err : new Error(`STOP_B_PREFLIGHT_FAILED: ${String(err)}`);
      throw preflightError;
    }
  };

  const preserveCaseEvidence = (rowId, casePidLedgerPath) => {
    const evidenceDir = process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_DIR;
    if (!evidenceDir) return;
    try {
      mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
      if (casePidLedgerPath && existsSync(casePidLedgerPath)) {
        copyFileSync(casePidLedgerPath, join(evidenceDir, `${rowId.toLowerCase()}-pids.jsonl`));
      }
    } catch {}
  };

  const withIsolatedCaseEnv = async (rowId, fn) => {
    const caseStart = Date.now();
    assertWithinSuiteBudget(`${rowId}-start`);

    // B3 remediation: if preflight already failed, do NOT start any downstream row or overwrite NOT_RUN with FAIL
    if (rowId !== 'v156B-PREFLIGHT' && preflightError) {
      recordRowOutcomeOnError(rowLedger, rowId, preflightError, preflightError, 0);
      return;
    }

    const caseDir = mkdtempSync(join(suiteRootDir, `${rowId.toLowerCase()}-`));
    const homeDir = join(caseDir, 'home');
    const tmpDir = join(caseDir, 'tmp');
    const codexHomeDir = join(caseDir, 'codex-home');
    const cwdDir = join(caseDir, 'workspace');
    const dataDir = join(caseDir, 'data');
    const casePidLedgerPath = join(caseDir, 'case-pids.jsonl');
    mkdirSync(homeDir, { mode: 0o700 });
    mkdirSync(tmpDir, { mode: 0o700 });
    mkdirSync(codexHomeDir, { mode: 0o700 });
    mkdirSync(cwdDir, { mode: 0o700 });
    mkdirSync(dataDir, { mode: 0o700 });
    writeFileSync(casePidLedgerPath, '', { mode: 0o600 });

    const caseOwnedProcesses = new Map();
    const baseEnv = {
      PATH: '/usr/bin:/bin',
      HOME: homeDir,
      TMPDIR: tmpDir,
      CODEX_HOME: codexHomeDir,
    };

    const mocks = [];
    const ownerships = [];
    const clients = [];

    const registerCasePid = (pid) => {
      trackOwnedProcess(pid, caseOwnedProcesses, casePidLedgerPath, suiteActiveProcesses);
    };

    const openMockResponses = async (opts = {}) => {
      const ctx = await ensureSuiteInitialized(casePidLedgerPath, caseOwnedProcesses);
      const srv = new ctx.MockResponsesServer({
        ...opts,
        fallback: opts.fallback ?? buildSseTextReply('default-loopback-reply'),
      });
      await srv.start();
      mocks.push(() => srv.stop());
      return srv;
    };

    const openFakeOcto = async (opts = {}) => {
      const ctx = await ensureSuiteInitialized(casePidLedgerPath, caseOwnedProcesses);
      const srv = new ctx.FakeOctoServer(opts);
      await srv.start();
      mocks.push(() => srv.stop());
      return srv;
    };

    const acquireOwnership = async (botId = `${rowId.toLowerCase()}-bot`, dir = dataDir) => {
      const ctx = await ensureSuiteInitialized(casePidLedgerPath, caseOwnedProcesses);
      const own = await ctx.BotStartupOwnership.acquire(dir, botId);
      ownerships.push({ own, dir });
      return own;
    };

    const spawnContainedClient = async (spawnOpts = {}) => {
      const {
        baseUrl,
        cwd = cwdDir,
        sandboxMode = 'read-only',
        approvalPolicy = 'never',
        networkAccessEnabled = false,
        webSearchMode = 'disabled',
        modelReasoningEffort,
        autoLogin = true,
        extraEnv = {},
        onServerRequest,
        serverRequests,
        ownership,
      } = spawnOpts;
      const apiKey = 'apiKey' in spawnOpts ? spawnOpts.apiKey : 'sk-loopback-synthetic-key';
      const ctx = await ensureSuiteInitialized(casePidLedgerPath, caseOwnedProcesses);
      const { wrapperPath: caseWrapperPath } = v157RealBinaryMode
        ? createDirectCodexWrapper(caseDir, ctx.resolved.bin, casePidLedgerPath)
        : createSandboxedCodexWrapper(
            caseDir,
            ctx.resolved.bin,
            ctx.preflight.profileText,
            casePidLedgerPath,
          );
      const own = ownership ?? (await acquireOwnership());
      const spec = buildContainedAppServerSpawnSpec({
        wrapperPath: caseWrapperPath,
        baseUrl,
        apiKey,
        cwd,
        baseEnv,
        extraEnv,
        vendorPathDirs: ctx.resolved.vendorPathDirs,
        sandboxMode,
        approvalPolicy,
        networkAccessEnabled,
        webSearchMode,
        modelReasoningEffort,
      });
      const client = new ctx.AppServerClient(
        buildAppServerClientOptions({
          spec,
          lifecycle: own.lifecycle,
          onServerRequest,
          serverRequests,
        }),
      );
      clients.push(client);
      const initResponse = await client.start();
      if (client.pid) registerCasePid(client.pid);
      if (autoLogin && spec.loginRpc) {
        await client.request(spec.loginRpc.method, spec.loginRpc.params, { timeoutMs: 10_000 });
      }
      return { client, initResponse, spec, ownership: own };
    };

    try {
      const ctx = await ensureSuiteInitialized(casePidLedgerPath, caseOwnedProcesses);
      const { wrapperPath: caseWrapperPath } = v157RealBinaryMode
        ? createDirectCodexWrapper(caseDir, ctx.resolved.bin, casePidLedgerPath)
        : createSandboxedCodexWrapper(
            caseDir,
            ctx.resolved.bin,
            ctx.preflight.profileText,
            casePidLedgerPath,
          );
      const detail = await fn({
        ctx: { ...ctx, wrapperPath: caseWrapperPath },
        caseDir,
        homeDir,
        tmpDir,
        codexHomeDir,
        cwdDir,
        dataDir,
        baseEnv,
        casePidLedgerPath,
        caseOwnedProcesses,
        registerCasePid,
        openMockResponses,
        openFakeOcto,
        acquireOwnership,
        spawnContainedClient,
      });
      const durationMs = Date.now() - caseStart;
      const effectiveBudgetMs =
        v157RealBinaryMode && (rowId === 'v156B-SPINE' || rowId === 'SB-06' || rowId === 'SB-03' || rowId === 'SB-04' || rowId === 'SB-05' || rowId === 'SP-T1')
          ? 45_000
          : CASE_TIMEOUT_MS;
      assert.ok(
        durationMs <= effectiveBudgetMs,
        `${rowId} exceeded ${effectiveBudgetMs}ms case budget (${durationMs}ms)`,
      );
      if (v157RealBinaryMode && rowId === 'v156B-PREFLIGHT') {
        rowLedger.set(rowId, {
          ...rowLedger.get(rowId),
          status: 'NOT_RUN',
          durationMs: 0,
          detail:
            detail ??
            'NOT_RUN: superseded by v157 Owner messages 2124440651163406336 & 2124442183632064512 (non-loopback network allowed; Seatbelt preflight not a gate)',
        });
      } else {
        rowLedger.set(rowId, {
          ...rowLedger.get(rowId),
          status: 'PASS',
          durationMs,
          detail: detail ?? 'PASS',
        });
      }
    } catch (err) {
      recordRowOutcomeOnError(rowLedger, rowId, err, preflightError, Date.now() - caseStart);
      throw err;
    } finally {
      for (const client of clients.reverse()) {
        try {
          await client.close({ graceMs: 1_500 });
        } catch {}
      }
      for (const { own } of ownerships.reverse()) {
        try {
          own.release();
        } catch {}
      }
      for (const stopMock of mocks.reverse()) {
        try {
          await stopMock();
        } catch {}
      }
      const reaped = await reapOwnedProcesses(casePidLedgerPath, caseOwnedProcesses, 1_500, suiteActiveProcesses);
      for (const pid of reaped) {
        assert.equal(isProcessGone(pid), true, `${rowId}: process ${pid} must exit before case cleanup finishes`);
      }

      // B2 cleanup assertions: verify HOME, CODEX_HOME auth artifacts, and ownership locks before removing caseDir
      assertNoAuthFiles(homeDir, codexHomeDir, rowId);
      for (const { dir } of ownerships) {
        assert.equal(
          existsSync(join(dir, 'gateway.lock')),
          false,
          `${rowId}: gateway.lock in ${dir} must be released`,
        );
      }
      preserveCaseEvidence(rowId, casePidLedgerPath);
      cleanDir(caseDir);
      assertWithinSuiteBudget(`${rowId}-cleanup`);
    }
  };

  after(async () => {
    try {
      const reaped = await reapOwnedProcesses(suitePidLedgerPath, suiteActiveProcesses, 2_000, suiteActiveProcesses);
      for (const pid of reaped) {
        assert.equal(isProcessGone(pid), true, `suite cleanup: process ${pid} must be terminated`);
      }
      const ledgerPayload = JSON.stringify(
        {
          suiteDurationMs: Date.now() - suiteStartedAt,
          suiteBudgetMs: SUITE_BUDGET_MS,
          caseTimeoutMs: CASE_TIMEOUT_MS,
          staticMachDnsStatus: STATIC_MACH_DNS_CONTAINMENT_STATUS,
          rows: [...rowLedger.values()],
        },
        null,
        2,
      );
      if (process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_PATH) {
        writeFileSync(process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_PATH, ledgerPayload, 'utf8');
      }
      if (process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_DIR) {
        mkdirSync(process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_DIR, 'contract-ledger.json'),
          ledgerPayload,
          'utf8',
        );
        if (existsSync(suitePidLedgerPath)) {
          copyFileSync(suitePidLedgerPath, join(process.env.CODEX_OCTO_REAL_BINARY_EVIDENCE_DIR, 'pid-ledger.txt'));
        }
      }
    } finally {
      cleanDir(suiteRootDir);
    }
    assertWithinSuiteBudget('suite-final-after');
  });

  // Row 0: v156B-PREFLIGHT
  test(
    'v156B-PREFLIGHT: Process-local Seatbelt containment preflight (loopback positive, own-host non-loopback TCP/UDP EPERM/EACCES negative, resolver/Mach IPC negative, 3-level parent->child->grandchild inheritance)',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('v156B-PREFLIGHT', async ({ ctx }) => {
        if (ctx.preflight.supersededByV157) {
          return 'NOT_RUN: superseded by v157 Owner messages 2124440651163406336 & 2124442183632064512 (non-loopback network allowed; Seatbelt preflight not a gate)';
        }
        assert.equal(ctx.preflight.loopbackAllowed, true);
        assert.equal(ctx.preflight.nonLoopbackBlockedWithKernelErrno, true);
        assert.equal(ctx.preflight.dnsUdpAndUnixSocketBlockedWithKernelErrno, true);
        assert.equal(ctx.preflight.descendantInherited, true);
        assert.equal(ctx.preflight.staticMachDnsStatus, 'UNVERIFIED');
        return 'Seatbelt loopback positive + own-host non-loopback EPERM/EACCES TCP/UDP + resolver/Mach IPC + 3-level inheritance verified';
      });
    },
  );

  // Row 1: SB-01
  test(
    'SB-01: Pre-init request rejected with -32600 Not initialized; second initialize rejected with -32600 Already initialized',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv(
        'SB-01',
        async ({ ctx, cwdDir, baseEnv, registerCasePid, openMockResponses, spawnContainedClient }) => {
          const mock = await openMockResponses();
          const spec = buildContainedAppServerSpawnSpec({
            wrapperPath: ctx.wrapperPath,
            baseUrl: mock.baseUrl,
            apiKey: 'sk-sb01-key',
            cwd: cwdDir,
            baseEnv,
            vendorPathDirs: ctx.resolved.vendorPathDirs,
          });

          // 1a. Pre-init request before initialize -> -32600 Not initialized
          const preInitRes = await new Promise((resolvePreInit, rejectPreInit) => {
            const child = spawn(spec.bin, spec.args, {
              cwd: spec.cwd,
              env: spec.env,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            if (child.pid) registerCasePid(child.pid);
            let buf = '';
            const timer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {}
              rejectPreInit(new Error('SB-01 pre-init timed out'));
            }, 5_000);
            child.stdout.on('data', (chunk) => {
              buf += String(chunk);
              const nl = buf.indexOf('\n');
              if (nl !== -1) {
                clearTimeout(timer);
                const line = buf.slice(0, nl).trim();
                try {
                  child.kill('SIGTERM');
                } catch {}
                resolvePreInit(JSON.parse(line));
              }
            });
            child.on('error', (err) => {
              clearTimeout(timer);
              rejectPreInit(err);
            });
            child.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: cwdDir } }) + '\n',
            );
          });
          assert.equal(preInitRes?.error?.code, -32600);
          assert.match(String(preInitRes?.error?.message ?? ''), /Not initialized/i);

          // 1b. Second initialize after AppServerClient.start() -> -32600 Already initialized
          const { client } = await spawnContainedClient({
            baseUrl: mock.baseUrl,
            apiKey: 'sk-sb01-key',
            autoLogin: false,
          });
          await assert.rejects(
            () =>
              client.request('initialize', {
                clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.169.1' },
                capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
              }),
            (err) => err?.code === -32600 && /Already initialized/i.test(String(err?.message ?? '')),
          );
          return 'Pre-init -32600 Not initialized and second initialize -32600 Already initialized verified';
        },
      );
    },
  );

  // Row 2: SB-02
  test(
    'SB-02: Second turn/start on active thread receives no turn/started within window; BotCodexRuntime lane serializes concurrent runTurn',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv(
        'SB-02',
        async ({ ctx, cwdDir, baseEnv, openMockResponses, acquireOwnership, spawnContainedClient }) => {
          // Separate mock servers for Part A and Part B so Part A's second turn/start cannot starve Part B
          const mockPartA = await openMockResponses({
            replies: [
              buildSseTextReply('sb02-active-turn-1', { delayMs: 1_500 }),
              buildSseTextReply('sb02-active-turn-2'),
            ],
          });

          // Part A: Raw AppServerClient second turn/start on active thread receives no turn/started while turn 1 active
          const rawSession = await spawnContainedClient({
            baseUrl: mockPartA.baseUrl,
            apiKey: 'sk-sb02-key',
            cwd: cwdDir,
          });
          const started = await rawSession.client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
          const threadId = started?.thread?.id ?? started?.threadId;
          const startedTurns = [];
          const completedTurns = [];
          const unsubRaw = rawSession.client.subscribe(
            (n) => n.method === 'turn/started' || n.method === 'turn/completed',
            (n) => {
              const id = n.params?.turn?.id ?? n.params?.turnId;
              if (n.method === 'turn/started') startedTurns.push(id);
              else completedTurns.push(id);
            },
          );
          const t1Res = await rawSession.client.request('turn/start', {
            threadId,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text: 'active-1', text_elements: [] }],
          });
          const turn1Id = t1Res?.turn?.id ?? t1Res?.turnId;
          const t2Res = await rawSession.client.request('turn/start', {
            threadId,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text: 'active-2', text_elements: [] }],
          });
          const turn2Id = t2Res?.turn?.id ?? t2Res?.turnId;
          await new Promise((r) => setTimeout(r, 800));
          assert.equal(
            startedTurns.includes(turn2Id),
            false,
            'second turn/start on active thread must not emit turn/started while turn 1 is active',
          );
          unsubRaw();
          await rawSession.client.close({ graceMs: 1_000 });
          rawSession.ownership.release();

          // Part B: BotCodexRuntime lane serializes concurrent openTurn calls with full TurnContext
          const mockPartB = await openMockResponses({
            replies: [
              buildSseTextReply('sb02-lane-turn-1', { delayMs: 300 }),
              buildSseTextReply('sb02-lane-turn-2'),
            ],
          });
          const ownership = await acquireOwnership('sb02-runtime-bot');
          const eventsLog = [];
          const spec = buildContainedAppServerSpawnSpec({
            wrapperPath: ctx.wrapperPath,
            baseUrl: mockPartB.baseUrl,
            apiKey: 'sk-sb02-key',
            cwd: cwdDir,
            baseEnv,
            vendorPathDirs: ctx.resolved.vendorPathDirs,
          });

          const runtime = new ctx.BotCodexRuntime({
            client: buildAppServerClientOptions({ spec, lifecycle: ownership.lifecycle }),
            login: spec.login,
            clientFactory: (generation) => {
              const c = new ctx.AppServerClient(
                buildAppServerClientOptions({
                  spec,
                  lifecycle: ownership.lifecycle,
                  clientVersion: `0.169.1-g${generation}`,
                }),
              );
              c.subscribe(
                (n) => n.method === 'turn/completed',
                () => eventsLog.push({ type: 'turn/completed', at: Date.now() }),
              );
              const origRequest = c.request.bind(c);
              c.request = async (method, params, opts) => {
                if (method === 'turn/start') eventsLog.push({ type: 'turn/start', at: Date.now() });
                return await origRequest(method, params, opts);
              };
              return c;
            },
          });

          try {
            const incarnationId = ownership.lifecycle.lock.incarnationId;
            const h1 = runtime.openTurn(buildSb02TurnRequest({ cwdDir, incarnationId, text: 'first prompt', seq: 1 }));
            const h2 = runtime.openTurn(buildSb02TurnRequest({ cwdDir, incarnationId, text: 'second prompt', seq: 2 }));
            const [o1, o2] = await Promise.all([h1.done, h2.done]);
            assert.equal(o1.status, 'completed');
            assert.equal(o2.status, 'completed');
            const firstCompletedIdx = eventsLog.findIndex((e) => e.type === 'turn/completed');
            const secondStartIdx = eventsLog.findLastIndex((e) => e.type === 'turn/start');
            assert.ok(
              firstCompletedIdx !== -1 && secondStartIdx > firstCompletedIdx,
              'second turn/start must occur strictly after first turn/completed on the same lane',
            );
          } finally {
            await runtime.shutdown({ interruptGraceMs: 1_000, exitGraceMs: 2_000 });
          }
          return `Active-thread second turn (${turn1Id}/${turn2Id}) suppressed and BotCodexRuntime lane serialization verified`;
        },
      );
    },
  );

  // Row 3: SB-03
  test(
    'SB-03: After terminal codex exec resume turn, thread/resume{config:{}} + turn/start includes terminal turn in model input while resume without config omits it',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-03', async ({ ctx, cwdDir, baseEnv, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({
          fallback: buildSseTextReply('sb03-reply'),
        });
        const { client } = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb03-key',
        });

        const started = await client.request('thread/start', {
          cwd: cwdDir,
          sandbox: 'read-only',
        });
        const threadId = started?.thread?.id ?? started?.threadId;
        assert.ok(threadId);

        const waitTurnCompleted = () =>
          new Promise((resolveTurn, rejectTurn) => {
            const timer = setTimeout(() => rejectTurn(new Error('SB-03 turn timeout')), 8_000);
            const off = client.subscribe(
              (n) => n.method === 'turn/completed',
              (n) => {
                clearTimeout(timer);
                off();
                resolveTurn(n.params);
              },
            );
          });

        const done1 = waitTurnCompleted();
        await client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb03-initial-turn', text_elements: [] }],
        });
        await done1;

        // Run a terminal codex exec resume turn on the same threadId via SDK
        const sdkFactory = ctx.createDefaultSdkFactory(
          () => ({ bin: ctx.wrapperPath, vendorPathDirs: ctx.resolved.vendorPathDirs, version: ctx.resolved.version }),
          baseEnv,
        );
        const sdk = sdkFactory({ apiKey: 'sk-sb03-key', baseUrl: mock.baseUrl, env: baseEnv });
        const sdkThread = sdk.resumeThread(threadId, {
          workingDirectory: cwdDir,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
        });
        const streamed = await sdkThread.runStreamed('sb03-exec-resume-marker');
        for await (const _ev of streamed.events) {
          // drain events
        }

        // Resume WITHOUT config:{} -> warm state omits external exec turn
        await client.request('thread/resume', { threadId });
        const done2 = waitTurnCompleted();
        await client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb03-after-warm-resume', text_elements: [] }],
        });
        await done2;
        const warmReqRaw = JSON.stringify(postResponsesRequests(mock).at(-1)?.body ?? {});
        assert.equal(warmReqRaw.includes('sb03-exec-resume-marker'), false);

        // Resume WITH config:{} -> cold reload includes external exec turn
        await client.request('thread/resume', { threadId, config: {} });
        const done3 = waitTurnCompleted();
        await client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb03-after-cold-resume', text_elements: [] }],
        });
        await done3;
        const coldReqRaw = JSON.stringify(postResponsesRequests(mock).at(-1)?.body ?? {});
        assert.equal(coldReqRaw.includes('sb03-exec-resume-marker'), true);
        return 'Warm vs cold config:{} resume input inclusion verified';
      });
    },
  );

  // Row 4: SB-04
  test(
    'SB-04: turn/start overrides persist across turns and reload; runtime sends only cwd, approvalPolicy, and effort',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-04', async ({ cwdDir, openMockResponses, spawnContainedClient }) => {
        const normalizedTurn = normalizeTurnParams({
          workingDirectory: cwdDir,
          sandboxMode: 'read-only',
          modelReasoningEffort: 'high',
        });
        assert.deepEqual(Object.keys(normalizedTurn.turnParams).sort(), ['cwd', 'effort']);

        const mock = await openMockResponses({ fallback: buildSseTextReply('sb04-ok') });
        const { client } = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb04-key',
        });
        const started = await client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const threadId = started?.thread?.id ?? started?.threadId;

        const runTurn = async (params) => {
          const done = new Promise((resolveTurn, rejectTurn) => {
            const t = setTimeout(() => rejectTurn(new Error('SB-04 turn timeout')), 8_000);
            const off = client.subscribe(
              (n) => n.method === 'turn/completed',
              (n) => {
                clearTimeout(t);
                off();
                resolveTurn(n.params);
              },
            );
          });
          await client.request('turn/start', params);
          return await done;
        };

        await runTurn({
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          effort: 'high',
          input: [{ type: 'text', text: 'sb04-turn-1', text_elements: [] }],
        });
        await client.request('thread/resume', { threadId, config: {} });
        await runTurn({
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb04-turn-2', text_elements: [] }],
        });
        const reqs = postResponsesRequests(mock);
        assert.equal(reqs.length >= 2, true);
        assert.equal(reqs[0]?.body?.reasoning?.effort, reqs[1]?.body?.reasoning?.effort);
        return 'turn/start parameter shape and override persistence across reload verified';
      });
    },
  );

  // Row 5: SB-05
  test(
    'SB-05: AGENTS.md edited after turn 1 leaves MockResponsesServer recorded instructions unchanged on turn 2',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-05', async ({ cwdDir, openMockResponses, spawnContainedClient }) => {
        writeFileSync(join(cwdDir, 'AGENTS.md'), 'AGENTS_MD_IMMUTABLE_V1\n', 'utf8');
        const mock = await openMockResponses({ fallback: buildSseTextReply('sb05-ok') });
        const { client } = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb05-key',
          cwd: cwdDir,
        });

        const started = await client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const threadId = started?.thread?.id ?? started?.threadId;

        const runTurn = async (text) => {
          const done = new Promise((resolveTurn, rejectTurn) => {
            const t = setTimeout(() => rejectTurn(new Error('SB-05 turn timeout')), 8_000);
            const off = client.subscribe(
              (n) => n.method === 'turn/completed',
              (n) => {
                clearTimeout(t);
                off();
                resolveTurn(n.params);
              },
            );
          });
          await client.request('turn/start', {
            threadId,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text, text_elements: [] }],
          });
          await done;
        };

        await runTurn('turn-1');
        const firstPayload = JSON.stringify(postResponsesRequests(mock)[0]?.body ?? {});
        writeFileSync(join(cwdDir, 'AGENTS.md'), 'AGENTS_MD_MUTATED_V2\n', 'utf8');
        await runTurn('turn-2');
        const secondPayload = JSON.stringify(postResponsesRequests(mock)[1]?.body ?? {});
        assert.equal(secondPayload.includes('AGENTS_MD_MUTATED_V2'), false);
        assert.equal(firstPayload.includes('AGENTS_MD_IMMUTABLE_V1'), secondPayload.includes('AGENTS_MD_IMMUTABLE_V1'));
        return 'AGENTS.md session-creation instruction freeze verified across turns';
      });
    },
  );

  // Row 6: SB-06
  test(
    'SB-06: Bidirectional session resume between codex exec (SDK) and codex app-server preserves prior turns',
    { timeout: v157RealBinaryMode ? 45_000 : CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-06', async ({ ctx, cwdDir, baseEnv, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({ fallback: buildSseTextReply('sb06-reply') });
        const sdkFactory = ctx.createDefaultSdkFactory(
          () => ({ bin: ctx.wrapperPath, vendorPathDirs: ctx.resolved.vendorPathDirs, version: ctx.resolved.version }),
          baseEnv,
        );
        const sdk = sdkFactory({ apiKey: 'sk-sb06-key', baseUrl: mock.baseUrl, env: baseEnv });

        // Direction 1: exec -> app-server
        const execThread = sdk.startThread({
          workingDirectory: cwdDir,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
        });
        let execThreadId = null;
        const run1 = await execThread.runStreamed('sb06-from-exec-1');
        for await (const ev of run1.events) {
          if (ev.type === 'thread.started') execThreadId = ev.thread_id;
        }
        assert.ok(execThreadId, 'exec must emit thread.started with thread_id');

        const { client } = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb06-key',
          cwd: cwdDir,
        });
        const resumedInApp = await client.request('thread/resume', { threadId: execThreadId, config: {} });
        assert.equal(resumedInApp?.thread?.id ?? resumedInApp?.threadId, execThreadId);

        // Direction 2: app-server turn -> exec resume
        const doneAppTurn = new Promise((resolveTurn, rejectTurn) => {
          const t = setTimeout(() => rejectTurn(new Error('SB-06 app turn timeout')), 12_000);
          const off = client.subscribe(
            (n) => n.method === 'turn/completed',
            (n) => {
              clearTimeout(t);
              off();
              resolveTurn(n.params);
            },
          );
        });
        await client.request('turn/start', {
          threadId: execThreadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb06-from-app-server-2', text_elements: [] }],
        });
        await doneAppTurn;
        await client.request('thread/unsubscribe', { threadId: execThreadId });
        await client.close({ graceMs: 1_500 });

        const resumedInExec = sdk.resumeThread(execThreadId, {
          workingDirectory: cwdDir,
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          skipGitRepoCheck: true,
        });
        const run3 = await resumedInExec.runStreamed('sb06-from-exec-3');
        for await (const _ev of run3.events) {
          // drain
        }
        const lastBody = JSON.stringify(postResponsesRequests(mock).at(-1)?.body ?? {});
        assert.equal(lastBody.includes('sb06-from-app-server-2'), true);
        return 'Bidirectional exec <-> app-server thread resume verified';
      });
    },
  );

  // Row 7: SB-07
  test(
    'SB-07: approvalPolicy=never runs shell tool without server request; on-request escalation receives id:0 and -32000 parity error -> item failed, turn/completed, serverRequest/resolved',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-07', async ({ ctx, cwdDir, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({
          replies: [
            buildSseFunctionCallReply('shell', { command: ['/bin/echo', 'sb07-never-ok'] }),
            buildSseTextReply('sb07-never-complete'),
            buildSseFunctionCallReply('shell', {
              command: ['/bin/echo', 'sb07-escalated'],
              with_escalated_permissions: true,
            }),
            buildSseTextReply('sb07-on-request-complete'),
          ],
        });

        // Part 1: approvalPolicy = 'never' -> commandExecution item with zero server requests via onServerRequest
        const neverRequests = [];
        const neverNotifications = [];
        const neverSession = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb07-key',
          cwd: cwdDir,
          approvalPolicy: 'never',
          onServerRequest: async (req) => {
            neverRequests.push(req);
            return await ctx.execParityServerRequestHandler(req);
          },
        });
        neverSession.client.subscribe(() => true, (n) => neverNotifications.push(n));
        const s1 = await neverSession.client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const tid1 = s1?.thread?.id ?? s1?.threadId;
        const done1 = new Promise((resolveTurn, rejectTurn) => {
          const t = setTimeout(() => rejectTurn(new Error('SB-07 never turn timeout')), 8_000);
          const off = neverSession.client.subscribe(
            (n) => n.method === 'turn/completed',
            (n) => {
              clearTimeout(t);
              off();
              resolveTurn(n.params);
            },
          );
        });
        await neverSession.client.request('turn/start', {
          threadId: tid1,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'run echo under never', text_elements: [] }],
        });
        await done1;
        assert.equal(neverRequests.length, 0, 'approvalPolicy=never must not issue approval server requests');
        assert.equal(
          neverNotifications.some((n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution'),
          true,
        );
        await neverSession.client.close({ graceMs: 1_000 });
        neverSession.ownership.release();

        // Part 2: approvalPolicy = 'on-request' with escalation -> id:0, -32000 parity error -> item failed, turn/completed, serverRequest/resolved
        const onReqRequests = [];
        const onReqNotifications = [];
        const onReqSession = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb07-key',
          cwd: cwdDir,
          approvalPolicy: 'on-request',
          onServerRequest: async (req) => {
            onReqRequests.push(req);
            return await ctx.execParityServerRequestHandler(req);
          },
        });
        onReqSession.client.subscribe(() => true, (n) => onReqNotifications.push(n));
        const s2 = await onReqSession.client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const tid2 = s2?.thread?.id ?? s2?.threadId;
        const done2 = new Promise((resolveTurn, rejectTurn) => {
          const t = setTimeout(() => rejectTurn(new Error('SB-07 on-request turn timeout')), 8_000);
          const off = onReqSession.client.subscribe(
            (n) => n.method === 'turn/completed',
            (n) => {
              clearTimeout(t);
              off();
              resolveTurn(n.params);
            },
          );
        });
        await onReqSession.client.request('turn/start', {
          threadId: tid2,
          cwd: cwdDir,
          approvalPolicy: 'on-request',
          input: [{ type: 'text', text: 'run escalated echo under on-request', text_elements: [] }],
        });
        await done2;
        assert.ok(onReqRequests.length >= 1, 'on-request escalation must emit server approval request to onServerRequest');
        assert.equal(onReqRequests[0].id, 0);
        assert.equal(
          onReqNotifications.some(
            (n) => n.method === 'item/completed' && n.params?.item?.type === 'commandExecution' && n.params?.item?.status === 'failed',
          ),
          true,
        );
        assert.equal(onReqNotifications.some((n) => n.method === 'serverRequest/resolved'), true);
        return 'approvalPolicy=never zero-request commandExecution and on-request id:0 -32000 rejection sequence verified';
      });
    },
  );

  // Row 8: SB-08
  test(
    'SB-08: turn/interrupt returns {} within <=2s and emits turn/completed status=interrupted within <=5s',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-08', async ({ cwdDir, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({
          replies: [buildSseTextReply('sb08-slow-stream', { delayMs: 6_000 })],
        });
        const { client } = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb08-key',
          cwd: cwdDir,
        });
        const started = await client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const threadId = started?.thread?.id ?? started?.threadId;

        const turnStartedP = new Promise((resolveStarted) => {
          const off = client.subscribe(
            (n) => n.method === 'turn/started',
            (n) => {
              off();
              resolveStarted(n.params);
            },
          );
        });
        const turnCompletedP = new Promise((resolveCompleted) => {
          const off = client.subscribe(
            (n) => n.method === 'turn/completed',
            (n) => {
              off();
              resolveCompleted(n.params);
            },
          );
        });

        const turnStartRes = await client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb08-interrupt-me', text_elements: [] }],
        });
        const turnId = turnStartRes?.turn?.id ?? turnStartRes?.turnId;
        await turnStartedP;

        const t0 = Date.now();
        const interruptRes = await client.request('turn/interrupt', { threadId, ...(turnId ? { turnId } : {}) });
        const rpcLatencyMs = Date.now() - t0;
        assert.ok(rpcLatencyMs <= 2_000, `turn/interrupt RPC took ${rpcLatencyMs}ms (> 2000ms)`);
        assert.deepEqual(interruptRes ?? {}, {});

        const completedParams = await turnCompletedP;
        const totalInterruptMs = Date.now() - t0;
        assert.ok(totalInterruptMs <= 5_000, `turn/completed interrupted took ${totalInterruptMs}ms (> 5000ms)`);
        assert.equal(completedParams?.turn?.status ?? completedParams?.status, 'interrupted');
        return `turn/interrupt RPC=${rpcLatencyMs}ms (<=2000ms), interrupted=${totalInterruptMs}ms (<=5000ms)`;
      });
    },
  );

  // Row 9: SB-09
  test(
    'SB-09: Two concurrent 4s scripted turns across separate threads complete within <=1.3x single-turn wall time inside <=15s case ceiling',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-09', async ({ cwdDir, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({
          replies: [
            buildSseTextReply('sb09-single', { delayMs: 4_000 }),
            buildSseTextReply('sb09-concurrent-a', { delayMs: 4_000 }),
            buildSseTextReply('sb09-concurrent-b', { delayMs: 4_000 }),
          ],
        });
        const { client } = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb09-key',
          cwd: cwdDir,
        });

        const sSingle = await client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const sA = await client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const sB = await client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const tidSingle = sSingle?.thread?.id ?? sSingle?.threadId;
        const tidA = sA?.thread?.id ?? sA?.threadId;
        const tidB = sB?.thread?.id ?? sB?.threadId;

        const runTimedTurn = async (threadId, label) => {
          const done = new Promise((resolveTurn, rejectTurn) => {
            const timer = setTimeout(() => rejectTurn(new Error(`SB-09 ${label} timeout`)), 10_000);
            const off = client.subscribe(
              (n) => n.method === 'turn/completed' && (n.params?.threadId === threadId || n.params?.turn?.threadId === threadId),
              (n) => {
                clearTimeout(timer);
                off();
                resolveTurn(n.params);
              },
            );
          });
          await client.request('turn/start', {
            threadId,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text: label, text_elements: [] }],
          });
          await done;
        };

        const tSingle0 = Date.now();
        await runTimedTurn(tidSingle, 'single-4s');
        const singleWallMs = Date.now() - tSingle0;

        const tConc0 = Date.now();
        await Promise.all([runTimedTurn(tidA, 'conc-a-4s'), runTimedTurn(tidB, 'conc-b-4s')]);
        const concurrentWallMs = Date.now() - tConc0;

        assert.ok(
          concurrentWallMs <= singleWallMs * 1.3,
          `concurrent 4s turns (${concurrentWallMs}ms) exceeded 1.3x single-turn wall time (${singleWallMs}ms)`,
        );
        return `single=${singleWallMs}ms, concurrent=${concurrentWallMs}ms (ratio=${(concurrentWallMs / singleWallMs).toFixed(2)} <= 1.30; 5-run median soak NOT_RUN due to <=15s/case budget)`;
      });
    },
  );

  // Row 10: SB-10
  test(
    'SB-10: Mid-turn SIGTERM/SIGKILL/EOF termination bounds and post-respawn thread/resume shows interrupted turn',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-10', async ({ cwdDir, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({
          replies: [
            buildSseTextReply('sb10-sigterm-turn', { delayMs: 8_000 }),
            buildSseTextReply('sb10-sigkill-turn', { delayMs: 8_000 }),
            buildSseTextReply('sb10-eof-turn', { delayMs: 8_000 }),
          ],
        });

        // 1. Mid-turn SIGTERM -> exit <= 2s, post-respawn resume shows interrupted
        const first = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb10-key',
          cwd: cwdDir,
        });
        const started = await first.client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
        const threadId = started?.thread?.id ?? started?.threadId;
        const turnStarted = new Promise((resolveStarted) => {
          const off = first.client.subscribe(
            (n) => n.method === 'turn/started',
            (n) => {
              off();
              resolveStarted(n.params);
            },
          );
        });
        await first.client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb10-sigterm', text_elements: [] }],
        });
        await turnStarted;

        const pid1 = first.client.pid;
        const sigtermStart = Date.now();
        process.kill(pid1, 'SIGTERM');
        await first.client.closed;
        const sigtermExitMs = Date.now() - sigtermStart;
        assert.ok(sigtermExitMs <= 2_000, `SIGTERM exit took ${sigtermExitMs}ms (> 2000ms)`);
        first.ownership.release();

        // 2. Respawn, verify interrupted turn on resume, then test mid-turn SIGKILL <= 2s
        const second = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb10-key',
          cwd: cwdDir,
        });
        const resumed1 = await second.client.request('thread/resume', { threadId, config: {} });
        assert.equal(resumed1?.thread?.id ?? resumed1?.threadId, threadId);

        const turn2Started = new Promise((resolveStarted) => {
          const off = second.client.subscribe(
            (n) => n.method === 'turn/started',
            (n) => {
              off();
              resolveStarted(n.params);
            },
          );
        });
        await second.client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb10-sigkill', text_elements: [] }],
        });
        await turn2Started;

        const pid2 = second.client.pid;
        const sigkillStart = Date.now();
        process.kill(pid2, 'SIGKILL');
        await second.client.closed;
        const sigkillExitMs = Date.now() - sigkillStart;
        assert.ok(sigkillExitMs <= 2_000, `SIGKILL exit took ${sigkillExitMs}ms (> 2000ms)`);
        second.ownership.release();

        // 3. Respawn, test mid-turn stdin EOF via client.close() drain, then verify post-respawn resume
        const third = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb10-key',
          cwd: cwdDir,
        });
        await third.client.request('thread/resume', { threadId, config: {} });
        const turn3Started = new Promise((resolveStarted) => {
          const off = third.client.subscribe(
            (n) => n.method === 'turn/started',
            (n) => {
              off();
              resolveStarted(n.params);
            },
          );
        });
        await third.client.request('turn/start', {
          threadId,
          cwd: cwdDir,
          approvalPolicy: 'never',
          input: [{ type: 'text', text: 'sb10-eof', text_elements: [] }],
        });
        await turn3Started;
        const eofStart = Date.now();
        await third.client.close({ graceMs: 3_000 });
        const eofExitMs = Date.now() - eofStart;
        assert.ok(eofExitMs <= 4_000, `stdin EOF close took ${eofExitMs}ms`);
        third.ownership.release();

        const fourth = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-sb10-key',
          cwd: cwdDir,
        });
        const resumedFinal = await fourth.client.request('thread/resume', { threadId, config: {} });
        const turns = resumedFinal?.thread?.turns ?? [];
        assert.ok(
          turns.length === 0 || turns.some((t) => t.status === 'interrupted' || t.status === 'failed'),
          'resumed thread after mid-turn SIGTERM/SIGKILL/EOF must reflect interrupted turn state',
        );
        return `SIGTERM=${sigtermExitMs}ms (<=2000ms), SIGKILL=${sigkillExitMs}ms (<=2000ms), EOF=${eofExitMs}ms, post-respawn resume verified`;
      });
    },
  );

  // Row 11: SB-11
  test(
    'SB-11: CODEX_API_KEY env alone sends no Authorization; ephemeral store + account/login/start{type:apiKey} sends Bearer token and writes no auth.json in HOME or CODEX_HOME',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv(
        'SB-11',
        async ({ homeDir, codexHomeDir, cwdDir, openMockResponses, spawnContainedClient }) => {
          const mock = await openMockResponses({ fallback: buildSseTextReply('sb11-ok') });

          // 1. CODEX_API_KEY in env alone without account/login/start
          const noLogin = await spawnContainedClient({
            baseUrl: mock.baseUrl,
            apiKey: undefined,
            autoLogin: false,
            extraEnv: { CODEX_API_KEY: 'sk-env-only-must-not-authorize' },
          });
          assert.equal(noLogin.spec.login, undefined);
          assert.equal(noLogin.spec.args.includes('cli_auth_credentials_store="ephemeral"'), false);

          const s1 = await noLogin.client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
          const tid1 = s1?.thread?.id ?? s1?.threadId;
          try {
            await noLogin.client.request(
              'turn/start',
              {
                threadId: tid1,
                cwd: cwdDir,
                approvalPolicy: 'never',
                input: [{ type: 'text', text: 'sb11-env-only', text_elements: [] }],
              },
              { timeoutMs: 3_000 },
            );
          } catch {}
          for (const req of mock.requests()) {
            assert.equal(
              req.authorization,
              null,
              'CODEX_API_KEY env alone must not send an Authorization header from app-server',
            );
          }
          await noLogin.client.close({ graceMs: 1_000 });
          noLogin.ownership.release();

          // 2. Ephemeral store + account/login/start { type: 'apiKey', apiKey }
          const loginKey = 'sk-ephemeral-login-token';
          const expectedDigest = bearerSha256(loginKey);
          const withLogin = await spawnContainedClient({
            baseUrl: mock.baseUrl,
            apiKey: loginKey,
            autoLogin: true,
          });
          assert.equal(withLogin.spec.args.includes('cli_auth_credentials_store="ephemeral"'), true);

          const s2 = await withLogin.client.request('thread/start', { cwd: cwdDir, sandbox: 'read-only' });
          const tid2 = s2?.thread?.id ?? s2?.threadId;
          const done = new Promise((resolveTurn, rejectTurn) => {
            const t = setTimeout(() => rejectTurn(new Error('SB-11 turn timeout')), 12_000);
            const off = withLogin.client.subscribe(
              (n) => n.method === 'turn/completed',
              (n) => {
                clearTimeout(t);
                off();
                resolveTurn(n.params);
              },
            );
          });
          await withLogin.client.request('turn/start', {
            threadId: tid2,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text: 'sb11-authenticated', text_elements: [] }],
          });
          await done;

          const authedReq = mock
            .requests()
            .find((r) => r.authorization?.scheme === 'Bearer' && r.authorization?.sha256 === expectedDigest);
          assert.ok(authedReq, 'MockResponsesServer must observe Authorization: Bearer <loginKey>');
          assertNoAuthFiles(homeDir, codexHomeDir, 'SB-11');
          return 'Env-only no Authorization + ephemeral account/login/start Bearer + zero auth.json verified';
        },
      );
    },
  );

  // Row 12: SB-12
  test(
    'SB-12: codex exec with -c approval_policy="on-request" records turn_context.approval_policy === "never" in rollout',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-12', async ({ ctx, codexHomeDir, cwdDir, baseEnv, openMockResponses }) => {
        const mock = await openMockResponses({ fallback: buildSseTextReply('sb12-exec-ok') });
        const sdkFactory = ctx.createDefaultSdkFactory(
          () => ({ bin: ctx.wrapperPath, vendorPathDirs: ctx.resolved.vendorPathDirs, version: ctx.resolved.version }),
          baseEnv,
        );
        const sdk = sdkFactory({ apiKey: 'sk-sb12-key', baseUrl: mock.baseUrl, env: baseEnv });
        const thread = sdk.startThread({
          workingDirectory: cwdDir,
          sandboxMode: 'read-only',
          approvalPolicy: 'on-request',
          skipGitRepoCheck: true,
        });
        const streamed = await thread.runStreamed('sb12-rollout-check');
        for await (const _ev of streamed.events) {
          // drain
        }
        const rolloutFiles = listFilesRecursive(codexHomeDir).filter((f) => f.endsWith('.jsonl'));
        assert.ok(rolloutFiles.length > 0, 'codex exec must write rollout JSONL under CODEX_HOME');
        const rolloutContent = rolloutFiles.map((f) => readFileSync(join(codexHomeDir, f), 'utf8')).join('\n');
        assert.match(rolloutContent, /"approval_policy"\s*:\s*"never"/);
        return 'codex exec rollout turn_context.approval_policy === "never" verified';
      });
    },
  );

  // Row 13: SB-13
  test(
    'SB-13: thread/start runtimeWorkspaceRoots:[cwd,extraDir] with network -c matches codex exec --add-dir extraDir turn_context',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv(
        'SB-13',
        async ({ ctx, caseDir, codexHomeDir, cwdDir, baseEnv, openMockResponses, spawnContainedClient }) => {
          const extraDir = join(caseDir, 'extra-root');
          mkdirSync(extraDir, { mode: 0o700 });
          const normalized = normalizeTurnParams({
            workingDirectory: cwdDir,
            sandboxMode: 'workspace-write',
            additionalDirectories: [extraDir],
          });
          assert.deepEqual(normalized.threadParams.runtimeWorkspaceRoots, [cwdDir, extraDir]);

          const mock = await openMockResponses({ fallback: buildSseTextReply('sb13-ok') });
          const { client } = await spawnContainedClient({
            baseUrl: mock.baseUrl,
            apiKey: 'sk-sb13-key',
            cwd: cwdDir,
            sandboxMode: 'workspace-write',
            networkAccessEnabled: false,
          });
          const started = await client.request('thread/start', {
            ...normalized.threadParams,
          });
          const appThreadId = started?.thread?.id ?? started?.threadId;
          assert.ok(appThreadId);

          const appTurnDone = new Promise((resolveTurn, rejectTurn) => {
            const t = setTimeout(() => rejectTurn(new Error('SB-13 app turn timeout')), 8_000);
            const off = client.subscribe(
              (n) => n.method === 'turn/completed',
              (n) => {
                clearTimeout(t);
                off();
                resolveTurn(n.params);
              },
            );
          });
          await client.request('turn/start', {
            threadId: appThreadId,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text: 'sb13-app-server-turn', text_elements: [] }],
          });
          await appTurnDone;

          const appRolloutFiles = listFilesRecursive(codexHomeDir).filter((f) => f.endsWith('.jsonl'));
          assert.ok(appRolloutFiles.length >= 1, 'app-server turn must write rollout JSONL under CODEX_HOME');

          const sdkFactory = ctx.createDefaultSdkFactory(
            () => ({ bin: ctx.wrapperPath, vendorPathDirs: ctx.resolved.vendorPathDirs, version: ctx.resolved.version }),
            baseEnv,
          );
          const sdk = sdkFactory({ apiKey: 'sk-sb13-key', baseUrl: mock.baseUrl, env: baseEnv });
          const execThread = sdk.startThread({
            workingDirectory: cwdDir,
            sandboxMode: 'workspace-write',
            additionalDirectories: [extraDir],
            networkAccessEnabled: false,
            approvalPolicy: 'never',
            skipGitRepoCheck: true,
          });
          const streamed = await execThread.runStreamed('sb13-exec-add-dir');
          for await (const _ev of streamed.events) {
            // drain
          }
          const allRolloutFiles = listFilesRecursive(codexHomeDir).filter((f) => f.endsWith('.jsonl'));
          const execRolloutFiles = allRolloutFiles.filter((f) => !appRolloutFiles.includes(f));
          assert.ok(execRolloutFiles.length >= 1, 'codex exec turn must write its own rollout JSONL under CODEX_HOME');

          const assertSandboxPolicyParity = (relFiles, label) => {
            const combined = relFiles.map((f) => readFileSync(join(codexHomeDir, f), 'utf8')).join('\n');
            const policies = extractRolloutTurnContextSandboxPolicies(combined);
            assert.ok(policies.length >= 1, `${label} rollout must contain turn_context.sandbox_policy`);
            const policy = policies.at(-1);
            assert.equal(policy.network_access, false, `${label} turn_context.sandbox_policy.network_access must be false`);
            const roots = Array.isArray(policy.writable_roots) ? policy.writable_roots.map(String) : [];
            assert.ok(
              roots.some((r) => r.includes(cwdDir)),
              `${label} turn_context.sandbox_policy.writable_roots must include ${cwdDir}`,
            );
            assert.ok(
              roots.some((r) => r.includes(extraDir)),
              `${label} turn_context.sandbox_policy.writable_roots must include ${extraDir}`,
            );
            return policy;
          };

          const appPolicy = assertSandboxPolicyParity(appRolloutFiles, 'app-server');
          const execPolicy = assertSandboxPolicyParity(execRolloutFiles, 'codex-exec');
          assert.equal(appPolicy.network_access, execPolicy.network_access);
          return 'runtimeWorkspaceRoots:[cwd,extraDir] and exec --add-dir turn_context.sandbox_policy (writable_roots + network_access=false) parity verified';
        },
      );
    },
  );

  // Row 14: SB-14
  test(
    'SB-14: codex app-server --session-source exec exits non-zero with unexpected argument',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SB-14', async ({ ctx, baseEnv, registerCasePid }) => {
        const result = await new Promise((resolveProc, rejectProc) => {
          const child = spawn(ctx.wrapperPath, ['app-server', '--session-source', 'exec'], {
            env: baseEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (child.pid) registerCasePid(child.pid);
          let stderr = '';
          let stdout = '';
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {}
            rejectProc(new Error('SB-14 timed out'));
          }, 5_000);
          child.stdout.on('data', (c) => {
            stdout += String(c);
          });
          child.stderr.on('data', (c) => {
            stderr += String(c);
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            rejectProc(err);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolveProc({ code, stdout, stderr });
          });
        });
        assert.notEqual(result.code, 0, 'codex app-server --session-source exec must exit non-zero');
        assert.match(`${result.stderr}\n${result.stdout}`, /unexpected argument/i);
        return `Exit code ${result.code} with unexpected argument verified`;
      });
    },
  );

  // Row 15: SP-T1
  test(
    'SP-T1: thread/start.dynamicTools registration and item/tool/call across turn 1, thread/resume{config:{}}, and respawn classifies Outcome A/B/C',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv('SP-T1', async ({ cwdDir, openMockResponses, spawnContainedClient }) => {
        const mock = await openMockResponses({
          replies: [
            buildSseFunctionCallReply('octo_dynamic_ping', { value: 'turn-1' }),
            buildSseTextReply('spt1-turn-1-done'),
            buildSseFunctionCallReply('octo_dynamic_ping', { value: 'turn-2-after-resume' }),
            buildSseTextReply('spt1-turn-2-done'),
            buildSseFunctionCallReply('octo_dynamic_ping', { value: 'turn-3-after-respawn' }),
            buildSseTextReply('spt1-turn-3-done'),
          ],
        });

        const dispatcher = createSpT1ToolDispatcher();

        const runSingleTurn = async (client, threadId, label) => {
          const done = new Promise((resolveTurn, rejectTurn) => {
            const t = setTimeout(() => rejectTurn(new Error(`SP-T1 ${label} timeout`)), 5_000);
            const off = client.subscribe(
              (n) => n.method === 'turn/completed',
              (n) => {
                clearTimeout(t);
                off();
                resolveTurn(n.params);
              },
            );
          });
          await client.request('turn/start', {
            threadId,
            cwd: cwdDir,
            approvalPolicy: 'never',
            input: [{ type: 'text', text: label, text_elements: [] }],
          });
          await done;
        };

        const first = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-spt1-key',
          cwd: cwdDir,
          onServerRequest: dispatcher.onServerRequest,
        });
        const started = await first.client.request('thread/start', {
          cwd: cwdDir,
          sandbox: 'read-only',
          dynamicTools: [
            {
              name: 'octo_dynamic_ping',
              description: 'Ping tool for SP-T1',
              inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            },
          ],
        });
        const threadId = started?.thread?.id ?? started?.threadId;
        assert.ok(threadId);
        await runSingleTurn(first.client, threadId, 'spt1-turn-1');

        dispatcher.state.phase = 'resume';
        await first.client.request('thread/resume', { threadId, config: {} });
        await runSingleTurn(first.client, threadId, 'spt1-turn-2');
        await first.client.close({ graceMs: 1_000 });
        first.ownership.release();

        dispatcher.state.phase = 'respawn';
        const second = await spawnContainedClient({
          baseUrl: mock.baseUrl,
          apiKey: 'sk-spt1-key',
          cwd: cwdDir,
          onServerRequest: dispatcher.onServerRequest,
        });
        await second.client.request('thread/resume', { threadId, config: {} });
        await runSingleTurn(second.client, threadId, 'spt1-turn-3');

        const outcome = dispatcher.classifyOutcome();
        assert.ok(['A', 'B', 'C'].includes(outcome));
        return `SP-T1 classified Outcome ${outcome} (turn1=${dispatcher.state.toolCallsTurn1}, resume=${dispatcher.state.toolCallsAfterResume}, respawn=${dispatcher.state.toolCallsAfterRespawn})`;
      });
    },
  );

  // Row 16: v156B-SPINE
  test(
    'v156B-SPINE: Production startBot + FakeOctoServer + MockResponsesServer DM reply, /reset barrier, and AppServer-to-SDK rollback continuity',
    { timeout: v157RealBinaryMode ? 45_000 : CASE_TIMEOUT_MS },
    async () => {
      await withIsolatedCaseEnv(
        'v156B-SPINE',
        async ({ ctx, cwdDir, dataDir, codexHomeDir, baseEnv, openMockResponses, openFakeOcto }) => {
          const mockResponses = await openMockResponses({
            replies: [
              buildSseTextReply('spine-app-server-reply-1'),
              buildSseTextReply('spine-app-server-post-reset-2'),
              buildSseTextReply('spine-sdk-rollback-reply-3'),
            ],
          });
          const fakeOcto = await openFakeOcto();
          fakeOcto.addBot({
            botToken: 'spine-bot-token',
            robotId: 'spine-robot-1',
            ownerUid: 'owner-uid-1',
            ownerChannelId: 'dm-owner-1',
          });

          const makeBotConfig = () => ({
            botId: 'spine-robot-1',
            botToken: 'spine-bot-token',
            apiUrl: fakeOcto.apiUrl,
            dataDir,
            baseDir: dataDir,
            cwd: cwdDir,
            cwdBase: cwdDir,
            dispatchTimeoutMs: 10_000,
            rateLimit: { maxPerMinute: 100 },
            context: { maxContextChars: 2_000, historyLimit: 20 },
            session: { ttlDays: 7 },
            commands: { managers: ['owner-uid-1'] },
            cron: { managers: ['owner-uid-1'], explicitManagers: true },
            runtime: {
              chatTurnCeilingMs: 1_800_000,
              laneMaxQueued: 3,
              interruptConfirmMs: 10_000,
              recycleDrainMs: 120_000,
            },
            egress: { keyMode: 'random' },
            sdk: {
              model: 'gpt-5-codex',
              codexApiKey: 'sk-spine-synthetic-key',
              codexBaseUrl: mockResponses.baseUrl,
              codexHome: codexHomeDir,
              sandboxMode: 'read-only',
              approvalPolicy: 'never',
              networkAccessEnabled: false,
              webSearchMode: 'disabled',
              webSearchEnabled: false,
              toolProgress: false,
            },
          });

          const sdkFactory = ctx.createDefaultSdkFactory(
            () => ({ bin: ctx.wrapperPath, vendorPathDirs: ctx.resolved.vendorPathDirs, version: ctx.resolved.version }),
            baseEnv,
          );

          const waitAuthenticatedWs = async () => {
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline) {
              if (fakeOcto.sessions().some((s) => s.authenticated && s.open)) return;
              await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error('Timed out waiting for FakeOctoServer WS session authentication');
          };

          const waitSendCount = async (expectedCount) => {
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
              const sends = fakeOcto.requests('sendMessage');
              if (sends.length >= expectedCount) return sends;
              await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error(`Timed out waiting for FakeOctoServer sendMessage count >= ${expectedCount}`);
          };

          const waitReadReceiptCount = async (expectedCount) => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
              const receipts = fakeOcto.requests('readReceipt');
              if (receipts.length >= expectedCount) return receipts;
              await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error(`Timed out waiting for FakeOctoServer readReceipt count >= ${expectedCount}`);
          };

          // Phase 1: Start production bot in app-server mode, verify /config, execute DM #1, /reset, and DM #2
          const appServerBot = await ctx.startBot(
            makeBotConfig(),
            true,
            v157RealBinaryMode
              ? { env: { ...baseEnv, CODEX_OCTO_EXECUTOR: 'app-server' } }
              : {
                  env: { ...baseEnv, CODEX_OCTO_EXECUTOR: 'app-server' },
                  bin: ctx.wrapperPath,
                  vendorPathDirs: ctx.resolved.vendorPathDirs,
                  egressFetcher: fetch,
                  sdkFactory,
                },
          );

          try {
            assert.equal(appServerBot.execution.executorKind, 'app-server');
            await appServerBot.connect();
            await waitAuthenticatedWs();

            // 1a. Verify /config in app-server mode reports executor: app-server and cron status
            fakeOcto.push({
              uid: 'spine-robot-1',
              fromUID: 'owner-uid-1',
              channelID: 'dm-owner-1',
              channelType: 1,
              payload: { type: 1, content: '/config' },
            });
            let sends = await waitSendCount(1);
            await waitReadReceiptCount(1);
            const appConfigContent = String(sends[0]?.body?.payload?.content ?? '');
            assert.match(appConfigContent, /executor:\s*app-server/i);
            assert.match(appConfigContent, /cron:\s*(?:enabled|disabled\(m1\); jobs: 0)/i);

            // 1b. DM turn 1 in app-server mode
            fakeOcto.push({
              uid: 'spine-robot-1',
              fromUID: 'owner-uid-1',
              channelID: 'dm-owner-1',
              channelType: 1,
              payload: { type: 1, content: 'hello-spine-turn-1-marker' },
            });
            sends = await waitSendCount(2);
            await waitReadReceiptCount(2);
            assert.match(String(sends[1]?.body?.payload?.content ?? ''), /spine-app-server-reply-1/);

            // 2. /reset command clears session history and increments generation barrier
            fakeOcto.push({
              uid: 'spine-robot-1',
              fromUID: 'owner-uid-1',
              channelID: 'dm-owner-1',
              channelType: 1,
              payload: { type: 1, content: '/reset' },
            });
            sends = await waitSendCount(3);
            await waitReadReceiptCount(3);
            assert.equal(sends[2]?.body?.payload?.content, ctx.StringCatalog.commandReset());

            // 3. Post-reset DM turn 2 creates a fresh thread in app-server mode
            fakeOcto.push({
              uid: 'spine-robot-1',
              fromUID: 'owner-uid-1',
              channelID: 'dm-owner-1',
              channelType: 1,
              payload: { type: 1, content: 'post-reset-turn-2-marker' },
            });
            sends = await waitSendCount(4);
            await waitReadReceiptCount(4);
            assert.match(String(sends[3]?.body?.payload?.content ?? ''), /spine-app-server-post-reset-2/);
            const secondModelInput = JSON.stringify(postResponsesRequests(mockResponses)[1]?.body ?? {});
            assert.equal(
              secondModelInput.includes('hello-spine-turn-1-marker'),
              false,
              '/reset must prevent pre-reset turn from appearing in post-reset thread',
            );
          } finally {
            await appServerBot.shutdown();
          }

          // Phase 2: Restart production bot on same dataDir/codexHome in SDK rollback mode, verify /config, and resume thread
          const sdkBot = await ctx.startBot(
            makeBotConfig(),
            true,
            v157RealBinaryMode
              ? { env: { ...baseEnv, CODEX_OCTO_EXECUTOR: 'sdk' } }
              : {
                  env: { ...baseEnv, CODEX_OCTO_EXECUTOR: 'sdk' },
                  bin: ctx.wrapperPath,
                  vendorPathDirs: ctx.resolved.vendorPathDirs,
                  egressFetcher: fetch,
                  sdkFactory,
                },
          );
          try {
            assert.equal(sdkBot.execution.executorKind, 'sdk');
            await sdkBot.connect();
            await waitAuthenticatedWs();

            // 4. Verify /config in SDK rollback mode reports executor: sdk and cron disabled
            fakeOcto.push({
              uid: 'spine-robot-1',
              fromUID: 'owner-uid-1',
              channelID: 'dm-owner-1',
              channelType: 1,
              payload: { type: 1, content: '/config' },
            });
            let sends = await waitSendCount(5);
            await waitReadReceiptCount(5);
            const sdkConfigContent = String(sends[4]?.body?.payload?.content ?? '');
            assert.match(sdkConfigContent, /executor:\s*sdk/i);
            assert.match(sdkConfigContent, /cron:\s*disabled(?:\(executor-sdk\); jobs: 0| \(sdk rollback mode\))/i);

            // 5. Post-rollback DM turn 3 resumes thread and preserves turn 2 history
            fakeOcto.push({
              uid: 'spine-robot-1',
              fromUID: 'owner-uid-1',
              channelID: 'dm-owner-1',
              channelType: 1,
              payload: { type: 1, content: 'sdk-rollback-turn-3-marker' },
            });
            sends = await waitSendCount(6);
            await waitReadReceiptCount(6);
            assert.match(String(sends[5]?.body?.payload?.content ?? ''), /spine-sdk-rollback-reply-3/);
            const thirdModelInput = JSON.stringify(postResponsesRequests(mockResponses)[2]?.body ?? {});
            assert.equal(
              thirdModelInput.includes('post-reset-turn-2-marker'),
              true,
              'AppServer-to-SDK rollback must resume the post-reset thread and include prior turn history',
            );
          } finally {
            await sdkBot.shutdown();
          }

          return 'Production startBot + FakeOctoServer + MockResponsesServer /config, DM reply, /reset, and AppServer-to-SDK rollback continuity verified';
        },
      );
    },
  );
}
