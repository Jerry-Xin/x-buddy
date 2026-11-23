# DEV-00 verification evidence

- **Tested head:** `d13c0702aa9bdfcf4ed8d767545841f671f43d72`. This commit adds only this file, so it changes nothing that the tests or `verify-port.mjs` read.
- **Machine:** darwin arm64.
- **Execution:** no server startup, model calls or network listeners other than the loopback unit fixtures that the pinned tests already use, and no live profile or secret reads.

## Port fidelity

`node docs/host-baseline/verify-port.mjs <codex-channel-octo checkout>` printed:

> Port fidelity verified: 84 imported files byte-identical to the pin after inverting the listed transforms (244 specifier rewrites); 1 authored file(s); no unlisted files.

**Negative check.** In a throwaway copy, `isAuthenticCronFire` was edited and its `destinationSha256` was recomputed. The verifier still failed: `inverse transform is not byte-identical to the pin: src/host/cron-fire-marker.ts`.

## Host suite (vitest 3.2.6)

Each run used a scratch overlay: `git archive HEAD` plus the exact pins in `foundation-requests.md` §1. Nothing from the overlay is committed.

| Node | ABI | better-sqlite3 / SQLite | Files | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|---|---|
| 22.23.2 | 127 | 12.11.1 / 3.53.2 | 56 | 1186 | 1186 | 0 | 0 |
| 24.22.1 | 137 | 12.11.1 / 3.53.2 | 56 | 1186 | 1186 | 0 | 0 |
| 26.5.0 (extra) | 147 | 12.11.1 / 3.53.2 | 56 | 1186 | 1186 | 0 | 0 |

The 1186 tests break down as:
- 1178 tests in the 55 imported files. This number was measured, not inherited; it happens to equal XIN-2053's reference.
- 8 tests in the authored `cron-fire-marker.test.ts`.

**Native ABI gap.** The prebuilt binary was verified only on darwin arm64. Linux x64 for Node 22 and 24 (the CI matrix) is unverified until the foundation writer's CI runs.

## Static checks

**Overlay** (HEAD, pinned deps and `@modelcontextprotocol/sdk` types, with the unmodified `tsconfig.json` and `eslint.config.mjs`):
- `tsc --noEmit` exits 0.
- `tsc` (build) exits 0.
- `eslint . --max-warnings 0` reports 22 errors, all in imported content. They are listed in `foundation-requests.md` §4.

**In-repo `npm run check` at HEAD** (repo devDependencies only): **red**, as expected until the foundation writer lands the shared changes. It is not claimed to pass.

| Script | Exit | Cause |
|---|---|---|
| `typecheck`, `test`, `build` | non-zero | Runtime dependencies are not yet in `package.json` (`@openai/codex-sdk` etc.). |
| `pack-smoke` | non-zero | Nothing is built. |
| `lint` | 1 | The 22 errors above. |
| `check:imports` | 0 | — |
| `check:security` | 1 | The private-endpoint pattern hits in 10 SSRF files (`foundation-requests.md` §5). The secret patterns have no hits, and all SPDX headers pass. |

**Shared files** are unchanged versus `c64337da`: `src/index.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `scripts/**`, `.github/**` and `docs/import-manifest.json`.

## Hardening tests (by name, all passing on Node 22, 24 and 26)

### SSRF and per-hop Authorization

`test/host/inbound-ssrf.test.ts`:
- `tryResolveFile S1 follow-up: per-hop credential scoping`:
  - `DROPS Authorization header on cross-host redirect (the re-review bug)`;
  - `keeps Authorization across same-host redirects`;
  - `cross-host → same-host redirect ADDS Authorization on hop 2 (per-hop logic)`;
- `does NOT send Authorization header for cross-host URL (CDN, etc.)`.

`test/host/url-policy-redirect.test.ts`:
- `callback receives currentUrl + previousUrl on each hop`;
- `callback can return different headers per hop`.

`test/host/media-inbound.test.ts`:
- `sends the bot token only to the same host (Authorization scoping)`.

### wss://

`test/host/url-policy.test.ts`, `isAllowedWsUrl (unauthenticated-payload transport guard)`.

**Gap at the pin:** no test drives `gateway.ts`'s `wss://` rejection (`src/host/gateway.ts:129`), and no test asserts that the client key seed comes from the CSPRNG (`src/octo/socket.ts:400` uses `randomBytes(32)`). Both are carried unchanged, and the gaps go to XIN-2505. No test was invented for them inside DEV-00.

### CONNACK, RECVACK, poison messages and caps

`test/host/octo/wksocket-packet.test.ts`:
- `CONNACK with salt shorter than 16 bytes FAILS the connection (not silent-drop)`;
- `CONNACK with salt >= 16 bytes connects normally (negative case)`;
- `sends RECVACK after a successful decrypt`;
- `does NOT send RECVACK when decrypt fails (lets the server redeliver)`;
- `ack-and-drops a poison message after repeated decrypt failures (issue #82)`.

`test/host/octo/d1-socket-dos.test.ts`:
- `closes connection when tempBuffer exceeds 1 MiB cap (P0-1)`;
- `rejects malformed variable-length > 4 bytes (P0-1 varlen cap)`.

`test/host/d1-protocol-dos.test.ts`:
- `drops oversized base64 payload instead of decoding to a 75 MB Buffer`.

### Prompt safety and the inline wrapper

`test/host/prompt-safety.test.ts`, `test/host/file-inline-wrap.test.ts`, `test/host/s3-quote-context-sanitize.test.ts`, `test/host/document-framing.test.ts` and `test/host/truncation-seam.test.ts`.

### Channel allowlist, bot filter and rate limiting

`test/host/session-router.test.ts`:
- `unsupported channel types (system messages)`:
  - `drops a system channel_type (8 "systemcmdonline") with no reply`;
  - `drops an unknown channel_type (e.g. 99)`;
- `rejects requests exceeding rate limit`;
- `group rate limit is per-member, not one shared bucket for the whole channel`;
- `G20: per-user cross-channel rate limit`.

`test/host/q13-q14-q17.test.ts`:
- `global rate limit blocks after burst from many sessions`.

### Fail-closed mention-free gating

`test/host/server-mention-prefs.test.ts`:
- `fails closed on timeout and retries after the negative-cache TTL`;
- `propagates invalid JSON to the gate, which fails closed`.

`test/host/g3-g8-g12-g13.test.ts`:
- `still requires @mention in non-mention-free groups`.

### Cron fire (authored)

`test/host/cron-fire-marker.test.ts`:
- `rejects a forged marker without a nonce`;
- `rejects a forged marker with a wrong nonce`;
- `rejects a nonce without a strict boolean marker`;
- `drops a forged unmentioned group cron fire at the mention gate`;
- `lets an authentic unmentioned group cron fire through the mention gate`;
- `applies the rate limit to forged fires but not authentic ones`.

**Disclosure:** the pin has no producer, so this test covers the consumer only. The producer is DEV-09/10.

### SDK executor and sessions

`test/host/agent-bridge.test.ts`:
- `queryAgent event mapping`;
- `retries fresh (with fallback prompt) when resume fails before any side effect`.

`test/host/session-store.test.ts` and `test/host/document-persistence.test.ts` cover `sdk_sessions` through `setSdkSessionId` and `getSdkSessionId`.
