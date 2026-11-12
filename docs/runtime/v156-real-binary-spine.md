# v156 Real-Binary Loopback Spine & Process-Local OS Containment (`D-v156 A+B`, `B1`–`B3` Second Bounded Remediation)

## 1. Scope & Phase Boundary

Under Owner approval `D-v156 A+B` (Charter `XIN-2037` comment `6dd1d1b3-21b3-4cce-8039-cc065528da69`) and the `v156 B1–B3` remediation contract on `XIN-2560` (Charter comment `06a71818-bf16-43ce-a99c-01efff4557cb` and `XIN-2746` review `289ab33b-b66a-4493-ad90-87a505cd1437`):

1. **Slice `v156A` (Production Startup / Executor / Config / Env Seam + Exact `@openai/codex@0.142.3` Pin)**:
   - Implemented in `src/runtime/host-caller.ts`, `src/runtime/codex-binary.ts`, `src/host/index.ts` (overlay #1/10), and `src/host/agent-bridge.ts` (overlay #4/10), with synthetic-peer regressions in `test/runtime/chat-spine.test.mjs`.
   - Reviewed in `XIN-2746` (`9ff191f6-e5d4-4dc3-87f9-672159615f64` and `289ab33b-b66a-4493-ad90-87a505cd1437`) as `PASS / READY` (`0` blocking findings) and retained byte-for-byte unchanged during `B1`–`B3` harness/doc remediation.
2. **Slice `v156B` (Prepared Gated Real-Binary & OS Containment Harness)**:
   - Authored in `test/runtime/real-binary-contracts.test.mjs` and documented in this file.
   - **Default Gate (`CODEX_OCTO_REAL_BINARY_GATE` unset)**: Every contract row (`17/17`: `v156B-PREFLIGHT`, `SB-01`..`SB-14`, `SP-T1`, and `v156B-SPINE`) is registered as an individual `node:test` case with `{ timeout: 15_000, skip: 'NOT_RUN: ...' }` and recorded as `NOT_RUN` in `createRowLedger()` without importing `@openai/codex-sdk` or spawning any native binary.
   - **Loader-Only Mode (`globalThis.__v156B_LOADER_ONLY = true` with Gate OFF)**: Allows guarded synthetic author verification of `installSourceModuleHooks`, `loadCanonicalSourceModules`, `buildContainedAppServerSpawnSpec`, `buildAppServerClientOptions`, `buildSb02TurnRequest`, `createSpT1ToolDispatcher`, `extractRolloutTurnContextSandboxPolicies`, `collectOwnedDescendantTargets`, `pruneConfirmedExitedProcesses`, and `recordRowOutcomeOnError` without entering any gated test body.
   - **Require-Gate Mode (`CODEX_OCTO_REAL_BINARY_REQUIRE=1` without `CODEX_OCTO_REAL_BINARY_GATE=1`)**: Fails closed immediately per row with `NOT_RUN`.
   - **Released Gate (`CODEX_OCTO_REAL_BINARY_GATE=1`)**: Authorized **only** in the separately PjM-released `XIN-2750` tester gate after independent `XIN-2746` exact-head `APPROVED`.

---

## 2. `B1` Remediation: Own-Host Non-Loopback Containment Controls, Resolver/Mach IPC & Start-Identity Descendant Reaper

### 2.1 Seatbelt Profile (`buildLoopbackOnlySeatbeltProfile`)
Every native `codex app-server` and `@openai/codex-sdk` (`codex exec`) invocation in `v156B` is wrapped in `/usr/bin/sandbox-exec -f <profilePath>` via `createSandboxedCodexWrapper`:

```scheme
(version 1)
(allow default)
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:*"))
(deny network-outbound (remote unix-socket))
(deny file-read* file-write*
  (literal "/var/run/mDNSResponder")
  (literal "/private/var/run/mDNSResponder")
  (literal "/etc/resolv.conf")
  (literal "/private/etc/resolv.conf"))
(deny mach-lookup
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.mDNSResponder.reloaded")
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
```

- **Static Unknown Mach/DNS Qualification**: Prior to `XIN-2750` executing `runContainmentPreflight` on the target host, macOS Seatbelt Mach/DNS behavior under `(allow default)` with explicit `mach-lookup` and `/var/run/mDNSResponder` denials remains **`UNVERIFIED`** (`STATIC_MACH_DNS_CONTAINMENT_STATUS = 'UNVERIFIED'`), not claimed as a measured host leak or an already-demonstrated runtime pass.

### 2.2 Own-Host Non-Loopback & Resolver/Mach Negative Controls (`runContainmentPreflight`)
- **Required Own-Host Non-Loopback Interface (Zero External Fallbacks)**:
  - `runContainmentPreflight` discovers the host's own active non-loopback `IPv4` interface via `findLocalNonLoopbackIpv4()` and binds ephemeral local TCP (`startEphemeralListener`) and UDP (`startEphemeralUdpListener`) listeners on that address.
  - If no active non-loopback `IPv4` interface exists or local binding fails, `runContainmentPreflight` fails closed immediately with `STOP_B_PREFLIGHT_FAILED`. External fallback addresses and external domain targets are completely removed.
- **Strict Kernel Errno Classification (`classifyContainmentErrno`)**:
  - **Accepted (`ALLOWED_CONTAINMENT_ERRNOS`)**: `EPERM`, `EACCES` only.
  - **Forbidden (`FORBIDDEN_CONTAINMENT_ERRNOS`)**: `ENETUNREACH`, `EHOSTUNREACH`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ETIMEDOUT`.
  - Routing errors (`ENETUNREACH`/`EHOSTUNREACH`), connection refusals (`ECONNREFUSED`), timeouts (`ETIMEDOUT`), and `.invalid` / `ENOTFOUND` catch-any checks are strictly rejected.
- **Preflight Probes (Executed in Direct Parent and 3-Level Sandboxed Parent -> Sandboxed Child -> Sandboxed Grandchild)**:
  1. **Loopback positive controls**: Loopback HTTP `fetch` to `<loopback-ip>:<ephemeral-port>/healthz` (`200 OK`) and `dns.lookup('localhost', { all: true })` (recorded as a positive loopback control only, not proof of external DNS isolation).
  2. **Own-host non-loopback TCP negative control**: `net.connect` to `<own-non-loopback-ip>:<ephemeral-tcp-port>` -> must fail strictly with `EPERM` or `EACCES`, and `localNonLoopbackTcpSrv.connections` must equal `0`.
  3. **Own-host non-loopback UDP negative control**: `dgram.send` to `<own-non-loopback-ip>:<ephemeral-udp-port>` -> must fail strictly with `EPERM` or `EACCES`, and `localNonLoopbackUdpSrv.packets` must equal `0`.
  4. **System resolver unix-socket & `/etc/resolv.conf` negative controls**: `net.connect({ path: '/var/run/mDNSResponder' })` and `fs.readFileSync('/etc/resolv.conf')` -> must fail strictly with `EPERM` or `EACCES`.
  5. **Direct c-ares `dns.Resolver` & Mach `mDNSResponder` daemon IPC negative controls**: `dns.Resolver` configured with `<own-non-loopback-ip>:<ephemeral-udp-port>` must reject without `ENOTFOUND`/`ENETUNREACH`/`EHOSTUNREACH` while delivering `0` packets to `localNonLoopbackUdpSrv`; `/usr/bin/dns-sd -G v4 localhost` must not receive a `127.0.0.1` answer from the `mDNSResponder` Mach service inside the sandbox.
  6. **3-Level Seatbelt inheritance verification**: `wrapperPath` spawns sandboxed parent (`depth 1`), which spawns sandboxed child (`depth 2`, `ppid === parentPid`), which spawns sandboxed grandchild (`depth 3`, `ppid === childPid`), verifying all controls at `depth 3`.

### 2.3 Per-Case Start-Identity Process Ledger & Confirmed-Exit Pruning (`parsePsProcessTable`, `collectOwnedDescendantTargets`, `pruneConfirmedExitedProcesses`, `reapOwnedProcesses`)
- Each test case in `withIsolatedCaseEnv` creates its own per-case `casePidLedgerPath` (`case-pids.jsonl`) and `caseOwnedProcesses` Map (`pid -> { pid, lstart }`).
- `createSandboxedCodexWrapper` captures `/bin/ps -p "$$" -o lstart=` and writes `{"pid":$$,"lstart":"..."}` to `casePidLedgerPath` before `exec "/usr/bin/sandbox-exec" -f "${profilePath}" "${realCodexBin}" "$@"`.
- `collectOwnedDescendantTargets(ownedRecords, psOutput)` parses `/bin/ps -Ao pid=,ppid=,lstart=` via `parsePsProcessTable`. If a recorded root PID is no longer in `ps` or its live `lstart` differs from the recorded `lstart` (indicating OS PID reuse/recycling), the PID is classified in `confirmedExitedPids` / `recycledSkippedPids` and is **never** traversed or signaled.
- `reapOwnedProcesses` (aliased as `reapProcessTreeFromLedger`) verifies `isTargetStillSameProcess` (`pid` and `lstart` match) before sending `SIGTERM` and again before escalating to `SIGKILL` in bottom-up post-order (grandchildren -> children -> roots), then calls `pruneConfirmedExitedProcesses` to remove all exited PIDs from `caseOwnedProcesses` and `suiteActiveProcesses`.

---

## 3. `B2` Remediation: Source Module Loader Hooks, `onServerRequest`, Canonical `normalizeProcessParams` & `CODEX_HOME` Cleanup

1. **Source Module Loader Hooks (`installSourceModuleHooks`, `loadCanonicalSourceModules`)**:
   - `installSourceModuleHooks()` registers a `node:module` `registerHooks({ resolve, load })` loader (following the pattern in `test/runtime/host-fixture.mjs` without modifying `host-fixture.mjs` or the runner) that:
     - Rewrites relative `.js` specifiers inside `src/**` to `.ts`;
     - Transpiles `src/**/*.ts` on load via the pinned offline `typescript` compiler (`HOST_TYPESCRIPT`);
     - Binds `better-sqlite3` to the pinned runtime-specific native addon (`HOST_SQLITE`); and
     - Resolves bare packages (`ws`, `curve25519-js`, `crypto-js`, `md5-typescript`) from the offline `product-node-modules` store.
   - `loadCanonicalSourceModules()` dynamically imports all required `src/**/*.ts` and `test/foundation/lib/*.mjs` modules and is verified in guarded author self-checks with `CODEX_OCTO_REAL_BINARY_GATE` OFF.
2. **Canonical `normalizeProcessParams` Delegation (`buildContainedAppServerSpawnSpec`)**:
   - `buildContainedAppServerSpawnSpec` delegates directly to `normalizeProcessParams` from `src/app-server/params.ts` **once**:
     - `spec.args` and `spec.login` (`{ type: 'apiKey', apiKey }` when `apiKey` is defined, `undefined` when omitted) are preserved verbatim from `normalizeProcessParams`;
     - `vendorPathDirs` is prepended to `spec.env.PATH` **exactly once**;
     - `spawnContainedClient` calls `buildContainedAppServerSpawnSpec` directly without calling `normalizeProcessParams` a second time.
3. **Canonical `AppServerClientOptions.onServerRequest` Wiring (`buildAppServerClientOptions`)**:
   - `buildAppServerClientOptions` wires `onServerRequest` on `AppServerClientOptions` (matching `src/app-server/client.ts:75, 383`), ensuring `SB-07` and `SP-T1` server-request callbacks are invoked by `AppServerClient`.
4. **Private Directories, `assertNoAuthFiles` & Evidence Preservation**:
   - Each case in `withIsolatedCaseEnv` creates private `homeDir`, `tmpDir`, `codexHomeDir`, `cwdDir`, and `dataDir`.
   - `assertNoAuthFiles(homeDir, codexHomeDir, rowId)` verifies zero `auth.json` or credential files in both `HOME` and `CODEX_HOME`.
   - Case and suite ledgers are preserved to `CODEX_OCTO_REAL_BINARY_EVIDENCE_PATH` and `CODEX_OCTO_REAL_BINARY_EVIDENCE_DIR` **before** temp directory cleanup.

---

## 4. `B3` Remediation: Per-Row `SB-01..14`, `SP-T1` & Production Spine Matrix (`<=15s/case`, `<=90s/suite`)

Every row in `REAL_BINARY_CONTRACT_MANIFEST` is an independent `node:test` case with `{ timeout: 15_000 }` (`CASE_TIMEOUT_MS = 15_000`) and guarded by `SUITE_BUDGET_MS = 90_000` inclusive of `after()` cleanup:

| Row ID | R8 Authority | Per-Case Budget | Contract Assertion Implemented in `test/runtime/real-binary-contracts.test.mjs` | Author-Turn Status |
|---|---|---:|---|---|
| `v156B-PREFLIGHT` | `D-v156 §4` / `R8 §6.3` | `<= 15s` | Seatbelt loopback positive (`fetch` + `dns.lookup('localhost')`), own-host non-loopback TCP & UDP `EPERM`/`EACCES` negative (`0` listener hits), `/var/run/mDNSResponder` & `/etc/resolv.conf` `EPERM`/`EACCES` negative, `dns.Resolver` + `/usr/bin/dns-sd` Mach IPC negative, and 3-level parent->child->grandchild inheritance | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-01` | `R8 §6.3 SB-01` | `<= 15s` | Pre-init `thread/start` returns `-32600 Not initialized`; second `initialize` after `AppServerClient.start()` rejects with `-32600 Already initialized` | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-02` | `R8 §6.3 SB-02` | `<= 15s` | Part A (isolated `mockPartA`): second `turn/start` on active thread receives no `turn/started` while turn 1 is active; Part B (isolated `mockPartB` + `buildSb02TurnRequest` with full `TurnContext`): `BotCodexRuntime` lane serializes concurrent `openTurn` calls so second `turn/start` follows first `turn/completed` | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-03` | `R8 §6.3 SB-03` | `<= 15s` | After terminal `codex exec resume` turn via `@openai/codex-sdk`, `thread/resume` without `config` omits the external turn from model input, while `thread/resume{config:{}}` includes it | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-04` | `R8 §6.3 SB-04` | `<= 15s` | `normalizeTurnParams` sends only `cwd` and `effort` (plus `approvalPolicy` on `turn/start`); reasoning effort override persists across turns and `thread/resume{config:{}}` reload | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-05` | `R8 §6.3 SB-05` | `<= 15s` | Editing `AGENTS.md` after turn 1 leaves `MockResponsesServer` recorded instructions unchanged on turn 2 | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-06` | `R8 §6.3 SB-06` | `<= 15s` | Thread started via `codex exec` (`createDefaultSdkFactory`) resumes in `AppServerClient`, and subsequent `AppServerClient` turn resumes in `codex exec resume` with prior turn history preserved | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-07` | `R8 §6.3 SB-07` | `<= 15s` | Wired via `onServerRequest`: under `approvalPolicy: 'never'`, shell function call emits `commandExecution` `item/completed` with `0` server requests; under `'on-request'` with escalation, request has `id: 0` and `execParityServerRequestHandler` `-32000` reply yields failed item, `turn/completed`, and `serverRequest/resolved` | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-08` | `R8 §6.3 SB-08` | `<= 15s` | `turn/interrupt` on in-flight turn returns `{}` within `<= 2,000` ms and emits `turn/completed` (`status: 'interrupted'`) within `<= 5,000` ms | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-09` | `R8 §6.3 SB-09` | `<= 15s` | Single 4s scripted turn vs two concurrent 4s scripted turns across separate threads completes in `<= 1.3x` single-turn wall time inside the `<= 15s` case ceiling (5-run median soak `5 x 8s = 40s` is explicitly marked `NOT_RUN` because it exceeds the `D-v156` `<= 15s/case` ceiling) | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-10` | `R8 §6.3 SB-10` | `<= 15s` | Mid-turn `SIGTERM` (`<= 2s` exit), mid-turn `SIGKILL` (`<= 2s` exit), and mid-turn stdin `EOF` (`client.close` drain), followed by respawn + `thread/resume{config:{}}` verifying interrupted turn state | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-11` | `R8 §6.3 SB-11` | `<= 15s` | `CODEX_API_KEY` env alone (`apiKey: undefined`) sends `authorization: null` to `MockResponsesServer`; ephemeral store + `account/login/start { type: 'apiKey', apiKey }` sends `Bearer <key>` (verified via SHA256 digest) and writes no `auth.json` in `HOME` or `CODEX_HOME` (`assertNoAuthFiles`) | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-12` | `R8 §6.3 SB-12` | `<= 15s` | `codex exec` with `approvalPolicy: 'on-request'` writes rollout JSONL under `CODEX_HOME` with `"approval_policy": "never"` | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-13` | `R8 §6.3 SB-13` | `<= 15s` | `extractRolloutTurnContextSandboxPolicies` verifies both `app-server` (`runtimeWorkspaceRoots: [cwd, extraDir]`) and `codex exec --add-dir extraDir` rollout `turn_context.sandbox_policy` record `network_access === false` and include both `cwd` and `extraDir` in `writable_roots` | `NOT_RUN` (gated for `XIN-2750`) |
| `SB-14` | `R8 §6.3 SB-14` | `<= 15s` | `codex app-server --session-source exec` exits non-zero with `"unexpected argument"` | `NOT_RUN` (gated for `XIN-2750`) |
| `SP-T1` | `R8 §6.4 SP-T1` | `<= 15s` | Wired via `createSpT1ToolDispatcher` (`onServerRequest` returning `{ contentItems, content, success: true }`): registers `dynamicTools` on `thread/start`, drives scripted tool calls on turn 1, after `thread/resume{config:{}}`, and after respawn + `thread/resume{config:{}}`, and classifies Outcome `A`, `B`, or `C` | `NOT_RUN` (gated for `XIN-2750`) |
| `v156B-SPINE` | `D-v156 §4` / `R8 §3.6.1` | `<= 15s` | Exercises production `startBot` + `FakeOctoServer` + `MockResponsesServer`: (1) `/config` in `app-server` mode reports `Executor: app-server` and `Cron: enabled`; (2) DM turn 1 delivers reply; (3) `/reset` delivers reset confirmation and fences prior history; (4) post-reset DM turn 2 creates fresh thread; (5) restart in `CODEX_OCTO_EXECUTOR=sdk` mode verifies `/config` reports `Executor: sdk` and `Cron: disabled (sdk rollback mode)`, and resumes post-reset thread via `codex exec resume` with prior turn history | `NOT_RUN` (gated for `XIN-2750`) |

---

## 5. Contractual `STOP B` Fail-Closed & Downstream `NOT_RUN` Ledger Semantics (`recordRowOutcomeOnError`)

If during the separately released `XIN-2750` gate (`CODEX_OCTO_REAL_BINARY_GATE=1`):
1. `/usr/bin/sandbox-exec` is absent, the host has no bindable non-loopback `IPv4` interface, or any `runContainmentPreflight` positive/negative/inheritance control fails (`STOP_B_PREFLIGHT_FAILED`),
2. `@openai/codex-sdk@0.142.3`, `@openai/codex@0.142.3`, or `@openai/codex-darwin-arm64@0.142.3` (`vendor/aarch64-apple-darwin/codex/codex`) is not installed in the offline runtime environment (since package/binary installation and network downloads are prohibited), or
3. Any contract case exceeds `15,000` ms or the suite exceeds `90,000` ms inclusive of cleanup (`STOP_B_BUDGET_EXCEEDED`),

`withIsolatedCaseEnv` and `recordRowOutcomeOnError` immediately halt execution (`STOP B`), recording `v156B-PREFLIGHT` as `FAIL` while preserving `status: 'NOT_RUN'` (and skipping directory/process creation) for all 16 unexecuted downstream rows (`SB-01`..`SB-14`, `SP-T1`, and `v156B-SPINE`), and retaining Slice `v156A` as a separately reviewed artifact.
