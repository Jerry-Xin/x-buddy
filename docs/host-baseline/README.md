# DEV-00 host baseline

This directory documents the port of the pinned codex-channel-octo host into x-buddy.

- **Source:** `Mininglamp-OSS/codex-channel-octo@dd1298083d014d8e82376c01edb38a2e6914366f` (Apache-2.0). Later upstream commits are not imported.
- **Target base:** x-buddy `main` at `c64337da2824f858f5b3e2fac6f2be7606b75918`.

The port changes **no behavior**. Every imported file is byte-identical to the pin once the recorded transforms are reversed. `verify-port.mjs` proves this.

## Ownership

| Path | Owner |
|---|---|
| `src/octo/**`, `src/host/**`, `test/host/**`, `docs/host-baseline/**` | DEV-00 (this port) |
| `src/index.ts` | unchanged bootstrap library entry |
| `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, the vitest config, CI, `scripts/check-*.mjs`, `docs/import-manifest.json` | foundation writer (see `foundation-requests.md`) |

## Entry points

- `src/host/index.ts` is the process entry (`startBot`). It is not exported from the package.
- `src/index.ts` stays the library entry and still exports only the bootstrap marker.
- `src/host/cli.ts` keeps `./index.js` as its gateway entry, so it resolves to `dist/host/index.js`.
- No `bin` is added.

## Transform classes

Each file's transforms are recorded in `import-entries.json`.

| Class | Applies to | What changes |
|---|---|---|
| `spdx-header` | all 84 imported files | `// SPDX-License-Identifier: Apache-2.0` is inserted as line 1. |
| `change-notice` | all 84 | Line 2 becomes `// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 <source path>; changes: <list>.`, which is the Apache-2.0 §4(b) notice. |
| `import-path` | 65 files, 244 specifiers | Relative `.js` specifiers that resolve to a pinned file are re-pointed to that file's new location. This covers static imports, `export … from`, dynamic `import()`, `typeof import()`, `vi.mock`, `vi.importActual` and `importOriginal` generics. Specifiers that do not resolve to a pinned file are untouched; for example, test data such as `'../etc'` and `cli.test.ts`'s `'../../package.json'`. |
| `path-literal` | `src/host/gateway.ts:20`, `src/host/cli.ts:92` | `'../package.json'` becomes `'../../package.json'`. These are the only two. `registerBot` and `--version` therefore report x-buddy's version. |
| `shebang` | `src/host/cli.ts`, `src/host/index.ts` | `#!/usr/bin/env node` is removed. `check-security.mjs` requires the SPDX header on line 1 and has no optional-shebang support. Nothing executes these files directly, because no `bin` is added. |

Line numbers in a destination file equal the pin's line numbers plus 2, or plus 1 in the two files that lost a shebang.

## File map

| Source at `dd12980` | Destination | Transforms beyond `spdx-header, change-notice` |
|---|---|---|
| `src/__tests__/agent-bridge.test.ts` | `test/host/agent-bridge.test.ts` | import-path |
| `src/__tests__/api-timeout.test.ts` | `test/host/api-timeout.test.ts` | import-path |
| `src/__tests__/api.test.ts` | `test/host/api.test.ts` | import-path |
| `src/__tests__/background-readonly-anchor.test.ts` | `test/host/background-readonly-anchor.test.ts` | import-path |
| `src/__tests__/bot-manager.test.ts` | `test/host/bot-manager.test.ts` | import-path |
| `src/__tests__/c1-followup-cleanup.test.ts` | `test/host/c1-followup-cleanup.test.ts` | import-path |
| `src/__tests__/c1-rejection-userguard.test.ts` | `test/host/c1-rejection-userguard.test.ts` | import-path |
| `src/__tests__/c1-richtext-budgets.test.ts` | `test/host/c1-richtext-budgets.test.ts` | import-path |
| `src/__tests__/cli-upgrade.test.ts` | `test/host/cli-upgrade.test.ts` | import-path |
| `src/__tests__/cli.test.ts` | `test/host/cli.test.ts` | import-path |
| `src/__tests__/commands.test.ts` | `test/host/commands.test.ts` | import-path |
| `src/__tests__/config-watcher.test.ts` | `test/host/config-watcher.test.ts` | import-path |
| `src/__tests__/config.test.ts` | `test/host/config.test.ts` | import-path |
| `src/__tests__/configure.test.ts` | `test/host/configure.test.ts` | import-path |
| `src/__tests__/conversation-md-api.test.ts` | `test/host/conversation-md-api.test.ts` | import-path |
| `src/__tests__/conversation-md-http.test.ts` | `test/host/conversation-md-http.test.ts` | import-path |
| `src/__tests__/conversation-md.test.ts` | `test/host/conversation-md.test.ts` | import-path |
| `src/__tests__/cwd-resolver.test.ts` | `test/host/cwd-resolver.test.ts` | import-path |
| `src/__tests__/d1-protocol-dos.test.ts` | `test/host/d1-protocol-dos.test.ts` | import-path |
| `src/__tests__/db-adapter.test.ts` | `test/host/db-adapter.test.ts` | import-path |
| `src/__tests__/document-framing.test.ts` | `test/host/document-framing.test.ts` | import-path |
| `src/__tests__/document-persistence.test.ts` | `test/host/document-persistence.test.ts` | import-path |
| `src/__tests__/e2e.test.ts` | `test/host/e2e.test.ts` | import-path |
| `src/__tests__/file-inline-wrap.test.ts` | `test/host/file-inline-wrap.test.ts` | import-path |
| `src/__tests__/format-tool-params.test.ts` | `test/host/format-tool-params.test.ts` | import-path |
| `src/__tests__/g2-file-inline.test.ts` | `test/host/g2-file-inline.test.ts` | import-path |
| `src/__tests__/g3-g8-g12-g13.test.ts` | `test/host/g3-g8-g12-g13.test.ts` | import-path |
| `src/__tests__/g4-history-api.test.ts` | `test/host/g4-history-api.test.ts` | import-path |
| `src/__tests__/g9-g10-g21.test.ts` | `test/host/g9-g10-g21.test.ts` | import-path |
| `src/__tests__/gateway.test.ts` | `test/host/gateway.test.ts` | import-path |
| `src/__tests__/group-config.test.ts` | `test/host/group-config.test.ts` | import-path |
| `src/__tests__/group-context-http.test.ts` | `test/host/group-context-http.test.ts` | import-path |
| `src/__tests__/group-context.test.ts` | `test/host/group-context.test.ts` | import-path |
| `src/__tests__/inbound-ssrf.test.ts` | `test/host/inbound-ssrf.test.ts` | import-path |
| `src/__tests__/inbound-wiring.test.ts` | `test/host/inbound-wiring.test.ts` | import-path |
| `src/__tests__/inbound.test.ts` | `test/host/inbound.test.ts` | import-path |
| `src/__tests__/media-inbound.test.ts` | `test/host/media-inbound.test.ts` | import-path |
| `src/__tests__/mention-utils.test.ts` | `test/host/mention-utils.test.ts` | import-path |
| `src/__tests__/octo/d1-socket-dos.test.ts` | `test/host/octo/d1-socket-dos.test.ts` | import-path |
| `src/__tests__/octo/protocol.test.ts` | `test/host/octo/protocol.test.ts` | import-path |
| `src/__tests__/octo/wksocket-packet.test.ts` | `test/host/octo/wksocket-packet.test.ts` | import-path |
| `src/__tests__/p2-polish.test.ts` | `test/host/p2-polish.test.ts` | import-path |
| `src/__tests__/pr33-followup.test.ts` | `test/host/pr33-followup.test.ts` | import-path |
| `src/__tests__/prompt-safety.test.ts` | `test/host/prompt-safety.test.ts` | import-path |
| `src/__tests__/q13-q14-q17.test.ts` | `test/host/q13-q14-q17.test.ts` | import-path |
| `src/__tests__/q34-q37-q38.test.ts` | `test/host/q34-q37-q38.test.ts` | import-path |
| `src/__tests__/s3-quote-context-sanitize.test.ts` | `test/host/s3-quote-context-sanitize.test.ts` | import-path |
| `src/__tests__/server-mention-prefs.test.ts` | `test/host/server-mention-prefs.test.ts` | import-path |
| `src/__tests__/session-router.test.ts` | `test/host/session-router.test.ts` | import-path |
| `src/__tests__/session-store.test.ts` | `test/host/session-store.test.ts` | import-path |
| `src/__tests__/shutdown.test.ts` | `test/host/shutdown.test.ts` | import-path |
| `src/__tests__/stream-relay.test.ts` | `test/host/stream-relay.test.ts` | import-path |
| `src/__tests__/truncation-seam.test.ts` | `test/host/truncation-seam.test.ts` | import-path |
| `src/__tests__/url-policy-redirect.test.ts` | `test/host/url-policy-redirect.test.ts` | import-path |
| `src/__tests__/url-policy.test.ts` | `test/host/url-policy.test.ts` | import-path |
| `src/agent-bridge.ts` | `src/host/agent-bridge.ts` | — |
| `src/bot-manager.ts` | `src/host/bot-manager.ts` | — |
| `src/channel-id.ts` | `src/host/channel-id.ts` | import-path |
| `src/cli.ts` | `src/host/cli.ts` | shebang, path-literal |
| `src/commands.ts` | `src/host/commands.ts` | — |
| `src/config-watcher.ts` | `src/host/config-watcher.ts` | — |
| `src/config.ts` | `src/host/config.ts` | — |
| `src/configure.ts` | `src/host/configure.ts` | — |
| `src/conversation-md.ts` | `src/host/conversation-md.ts` | import-path |
| `src/cron-fire-marker.ts` | `src/host/cron-fire-marker.ts` | — |
| `src/cwd-resolver.ts` | `src/host/cwd-resolver.ts` | — |
| `src/db-adapter.ts` | `src/host/db-adapter.ts` | — |
| `src/file-inline-wrap.ts` | `src/host/file-inline-wrap.ts` | — |
| `src/gateway.ts` | `src/host/gateway.ts` | path-literal, import-path |
| `src/group-config.ts` | `src/host/group-config.ts` | — |
| `src/group-context.ts` | `src/host/group-context.ts` | import-path |
| `src/inbound.ts` | `src/host/inbound.ts` | import-path |
| `src/index.ts` | `src/host/index.ts` | shebang, import-path |
| `src/media-inbound.ts` | `src/host/media-inbound.ts` | — |
| `src/mention-prefs.ts` | `src/host/mention-prefs.ts` | import-path |
| `src/mention-utils.ts` | `src/host/mention-utils.ts` | import-path |
| `src/octo/api.ts` | `src/octo/api.ts` | — |
| `src/octo/socket.ts` | `src/octo/socket.ts` | — |
| `src/octo/types.ts` | `src/octo/types.ts` | — |
| `src/prompt-safety.ts` | `src/host/prompt-safety.ts` | — |
| `src/session-router.ts` | `src/host/session-router.ts` | import-path |
| `src/session-store.ts` | `src/host/session-store.ts` | — |
| `src/stream-relay.ts` | `src/host/stream-relay.ts` | import-path |
| `src/url-policy.ts` | `src/host/url-policy.ts` | — |
| _(none, authored)_ | `test/host/cron-fire-marker.test.ts` | authored |

## Invariants carried unchanged (proved by `verify-port.mjs`)

- **SDK executor.** `src/host/agent-bridge.ts` is the `@openai/codex-sdk` executor, and `queryAgent` is unchanged. This is the SDK fallback and rollback base.
- **`sdk_sessions`.**
  - The DDL is at `src/host/session-store.ts:73`.
  - `setSdkSessionId` is at `src/host/session-store.ts:304` and is called from `src/host/index.ts:727`.
  - There is no migration.
- **Cron-fire hooks.**
  - `src/host/cron-fire-marker.ts`;
  - `src/host/session-router.ts:350` (`isCronFire`);
  - `:410` (mention-gate bypass);
  - `:437` (rate-limit bypass).
  - The pin's `index.ts:791–795` is now `src/host/index.ts:792–797` (no cursor advance for `message_seq=0`).
  - **The pin has no cron-fire producer.** The new `test/host/cron-fire-marker.test.ts` covers only the consumer. The producer is DEV-09/10 follow-up work, and none was invented here.

## How to verify

```sh
node docs/host-baseline/verify-port.mjs <path to a codex-channel-octo checkout containing dd12980>
```

Results are recorded in `evidence.md`. Outbound and process sites are listed in `outbound-map.md`.

## Still held

These remain held and are not activated:

- live host activation;
- the state directory: `~/.codex-channel-octo` collides with an installed A and must move before any activation (XIN-2505);
- the `buildUpgradeArgs` upgrade target (XIN-2505);
- outbound integration (DEV-06);
- push, PR and merge.
