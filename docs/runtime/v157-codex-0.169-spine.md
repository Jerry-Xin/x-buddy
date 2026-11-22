# v157 Real Codex `0.169.1` App Server & SDK Spine (`XIN-2560`)

## 1. Scope & Authority

Under Owner direction `2124440651163406336`, `2124442183632064512`, and `2124450308330262528` (Charter `XIN-2037` comments `17d4993a-1b43-4908-abbd-3a8584bf788e`, `d8c3b78a-7468-4f43-8a6d-12316b7e7cb1`, `d5e43370-406d-4b2e-8d57-048bd6f92f87` and `XIN-2560` task description `v38`), `v157` advances the real Codex App Server message path from baseline commit `4b53d3edb655db32b1e16964a89c072570ba1ab6`:

- **Superseded `v156` Gates**: Exact `0.142.3` version pinning and the macOS `/usr/bin/sandbox-exec` Seatbelt own-host non-loopback preflight are superseded as gates for this engineering increment.
- **Target CLI & SDK Version (`0.169.1`)**:
  - `@openai/codex-sdk@0.169.1` (`dependencies["@openai/codex"] = "0.169.1"`)
  - `@openai/codex@0.169.1` (`optionalDependencies["@openai/codex-darwin-arm64"] = "npm:@openai/codex@0.169.1-darwin-arm64"`)
  - `@openai/codex-darwin-arm64@0.169.1-darwin-arm64` (`vendor/aarch64-apple-darwin/codex-package.json`, `layoutVersion: 1`, `entrypoint: "bin/codex"`, `pathDir: "codex-path"`, `resourcesDir: "codex-resources"`)

---

## 2. Concrete Real-Binary & Real-Package Findings on Baseline `4b53d3edb655db32b1e16964a89c072570ba1ab6`

Executing baseline `4b53d3ed` against the actual `@openai/codex-sdk@0.169.1` and `@openai/codex@0.169.1` packages exposed five concrete defects that synthetic mocks had not caught:

1. **`ERR_PACKAGE_PATH_NOT_EXPORTED` on `@openai/codex-sdk/package.json` (`src/runtime/codex-binary.ts`)**:
   - Real `@openai/codex-sdk@0.169.1/package.json` defines `"exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } }` without exporting `"./package.json"`.
   - `rootRequire.resolve('@openai/codex-sdk/package.json')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED`.
   - **Fix**: Added `resolvePackageJson(req, pkgName, exists)` in `src/runtime/codex-binary.ts`, which falls back to `req.resolve.paths(pkgName)` on `ERR_PACKAGE_PATH_NOT_EXPORTED` without importing the SDK module.
2. **`ERR_PACKAGE_PATH_NOT_EXPORTED` on `rootRequire('@openai/codex-sdk')` in `createDefaultSdkFactory` (`src/runtime/codex-binary.ts`)**:
   - Because `@openai/codex-sdk@0.169.1/package.json` is `"type": "module"` and its `"exports['.']"` map defines only `"import"` (with no `"require"` or `"default"` condition), CJS `rootRequire('@openai/codex-sdk')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined` on both Node `22.23.2` and Node `24.22.0`.
   - **Fix**: `createDefaultSdkFactory` catches `ERR_PACKAGE_PATH_NOT_EXPORTED` and loads `rootRequire(join(dirname(sdkPkgJson), 'dist', 'index.js'))` via Node 22/24 `require(esm)`.
3. **Stale `0.142.3` Version Pin & `layoutVersion: 1` Vendor Directory Layout (`src/runtime/codex-binary.ts`, `src/runtime/host-caller.ts`)**:
   - Updated `PINNED_CODEX_VERSION = '0.169.1'` and default `clientInfo.version` in `createHostCaller` to `preResolvedBinary?.version ?? PINNED_CODEX_VERSION`.
   - Updated `resolveCodexBinary` to parse and validate `vendor/<triple>/codex-package.json` (`layoutVersion: 1`, `version: "0.169.1"`, `target: <triple>`, `entrypoint: "bin/codex"`, `pathDir: "codex-path"`), resolving `vendor/<triple>/bin/codex` and `vendor/<triple>/codex-path` (while retaining legacy `codex/codex` + `path` fallback only when `codex-package.json` and `bin/codex` are absent).
   - Updated `createDefaultSdkFactory` to prepend `resolved.vendorPathDirs` to `resolvedEnv.PATH` because `@openai/codex-sdk@0.169.1` clears `pathDirs` when `codexPathOverride` is supplied.
4. **Non-Terminal `error` Notification (`willRetry: true`) Cancelling Active Turns in `BotCodexRuntime` (`src/runtime/runtime.ts`)**:
   - When real Codex `0.169.1` connects to an HTTP Responses endpoint (`MockResponsesServer`), it first attempts WebSocket upgrade (`GET /v1/responses`) and emits four `error` notifications with `willRetry: true` (`Reconnecting... 2/5` through `5/5`) before falling back to HTTPS (`POST /v1/responses`).
   - `BotCodexRuntime.#deliver` (`src/runtime/runtime.ts:359-364`) previously treated every `error` notification as terminal and called `this.#cancel(e, runtimeError('TurnFailedError', ...))` even when `p.willRetry === true`.
   - **Fix**: When `notification.method === 'error'` has `p.willRetry === true`, `BotCodexRuntime.#deliver` forwards the notification to `e.events` without cancelling the active turn.
5. **WebSocket-to-HTTPS Transport Fallback Notices in `agent-bridge.ts` (`src/host/agent-bridge.ts`, overlay `#4/10`)**:
   - Both `ExecEventProjector` (`app-server`) and `codex exec --experimental-json` (`sdk`) project `Reconnecting... k/5` as `{ type: 'error', message: 'Reconnecting... k/5 (...)' }` and project the subsequent `warning` notification as `{ type: 'item.completed', item: { type: 'error', message: 'Falling back from WebSockets to HTTPS transport. ...' } }`.
   - **Fix**: `runOnce` in `src/host/agent-bridge.ts` drains `^Falling back from WebSockets to HTTPS transport\.` as a non-fatal codex notice and holds `^Reconnecting\.\.\.\s+\d+\/\d+\b` as a pending transient reconnect error that is cleared upon `turn.completed` (or re-thrown if the stream terminates without `turn.completed`, preserving `isStreamInterruptError` recovery).
6. **Codex `0.169.1` Per-Thread Persistence Writer Lease Across `app-server` and `codex exec resume` (`SB-06`, `v156B-SPINE`)**:
   - Under Codex `0.169.1`, `codex app-server` retains an active persistence writer lease in `CODEX_HOME` for any thread it has opened until the `codex app-server` process exits (`client.close()` / `appServerBot.shutdown()`); spawning a concurrent `codex exec resume <threadId>` process against the same `CODEX_HOME` while `codex app-server` is still running fails with `thread-store conflict: thread <id> already has an active writer (code -32600)`.
   - Closing the `app-server` client (`await client.close({ graceMs: 1_500 })` in `SB-06` and `await appServerBot.shutdown()` before starting `sdkBot` in `v156B-SPINE`, matching the production executor rollback boundary) releases the writer lease cleanly.

---

## 3. Mocked Boundaries vs Real Executed Components

In the `v157` end-to-end verification:

- **Real (Unmocked) Components**:
  - Production entry point `startBot(config, true, { env })` -> `BotStartupOwnership` (`gateway.lock`) -> `SessionStore` / SQLite (`better-sqlite3` native addon) -> `OctoGateway` -> `OctoEgress` (`OctoApiClient` over real `fetch`) -> `ChatTurnIssuer` -> `createHostCaller` -> `resolveCodexBinary()` -> `createQueryAgent` (`src/host/agent-bridge.ts`).
  - Real `AppServerClient` (`src/app-server/client.ts`) spawning the real `@openai/codex-darwin-arm64@0.169.1-darwin-arm64` native binary (`vendor/aarch64-apple-darwin/bin/codex app-server --listen stdio://`), executing JSON-RPC `initialize`, `account/login/start` (`{ type: 'apiKey' }` with `cli_auth_credentials_store="ephemeral"`), `thread/start`, `turn/start`, `thread/unsubscribe`, and graceful shutdown.
  - Real `@openai/codex-sdk@0.169.1` (`createDefaultSdkFactory` -> `new Codex({ codexPathOverride })`) spawning real `codex exec --experimental-json` and `codex exec --experimental-json ... resume <threadId>`.
- **Local Test Endpoints / Fixtures (Named Mocked Boundaries)**:
  - `FakeOctoServer` (`test/foundation/lib/fake-octo.mjs`): local HTTP + WebSocket WuKongIM server mocking Octo REST (`/v1/bot/register`, `/v1/bot/sendMsg`, `/v1/bot/sendStatus`, `/v1/bot/readReceipt`) and inbound encrypted WebSocket frames.
  - `MockResponsesServer` (`test/foundation/lib/mock-responses.mjs`): local HTTP server mocking OpenAI Responses API `POST /v1/responses` SSE streams.

---

## 4. Residual Gaps & Explicit `NOT_RUN` Items

- **`SB-09` Five-Run Median Concurrency Soak**: Single-run `SB-09` 2-thread concurrency passes against real `0.169.1`; the five-run median latency soak remains `NOT_RUN`.
- **Legacy `v156B-PREFLIGHT` Seatbelt Own-Host Non-Loopback Isolation Probe**: Superseded as a gate for `v157` by Owner messages `2124440651163406336` and `2124442183632064512` and recorded as `NOT_RUN`.
- **Downstream / Out-of-Scope Capabilities**: Scheduled `/cron` execution (`M3` `XIN-2562`/`XIN-2749`), `/fork` execution, per-bot hot-reload diffing (`DEV-08`), and live external Octo IM / live external OpenAI provider traffic remain `NOT_RUN`.
