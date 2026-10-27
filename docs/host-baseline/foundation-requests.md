# Requests to the foundation writer (single writer, XIN-2504)

DEV-00 does not edit shared files. Every item below was measured in a scratch overlay outside the repository. That overlay held a copy of this branch plus the dependency set listed here, and nothing from it was committed.

## 1. Dependencies (exact pins, regenerated lockfile, `save-exact`)

**Runtime:**
- `@openai/codex-sdk` 0.142.3
- `@openai/codex` 0.142.3
- `better-sqlite3` 12.11.1
- `ws` 8.21.0
- `zod` 4.4.3
- `crypto-js` 4.2.0
- `curve25519-js` 0.0.4
- `md5-typescript` 1.0.5

**Dev:**
- `vitest` 3.2.6
- `@types/better-sqlite3`, `@types/ws`, `@types/crypto-js`, `@types/node`. The overlay resolved 9.6.0, 8.18.2, 4.2.2 and 26.6.5; pin these as you see fit.
- **`@modelcontextprotocol/sdk`** (the overlay resolved 1.32.2). Under x-buddy's `skipLibCheck: false`, this is the **only** typecheck error: `@openai/codex-sdk/dist/index.d.ts(1,30)` imports `@modelcontextprotocol/sdk/types.js`. The SDK lists it only as its own devDependency. Adding the types package fixes it without `skipLibCheck`.

## 2. tsconfig

**No change is needed.** With the dependencies above, `tsc --noEmit` and `tsc` exit 0 on the unmodified `tsconfig.json`. That config has `skipLibCheck: false`, and has neither `esModuleInterop` nor `resolveJsonModule`.

`test/host/**` is outside `include`, as A's tests were. Vitest transpiles the tests without typechecking them. If test typechecking is wanted, it should be a separate path-scoped tsconfig.

## 3. Vitest config and script

The overlay used `test: { include: ['test/host/**/*.test.ts'] }` with no other options. It needs a `test:host` script, and `check` should run it on Node 22 and 24. `better-sqlite3` resolves a prebuilt binary on both versions (see `evidence.md`).

## 4. ESLint

The unmodified `eslint.config.mjs` reports **22 errors** in imported content. There are no `no-explicit-any` hits. The content must not be edited, so this needs a reviewed, path-scoped decision. Global loosening is not acceptable.

| Rule | Count | Sites (destination lines) |
|---|---|---|
| `require-yield` | 11 | `test/host/agent-bridge.test.ts:658, 669, 688, 700, 733, 736, 763, 780`; `test/host/e2e.test.ts:720, 737, 752` |
| `preserve-caught-error` | 5 | `src/host/config.ts:317`; `src/host/configure.ts:62, 108`; `src/host/gateway.ts:224`; `src/host/session-store.ts:144` |
| `no-useless-escape` | 3 | `src/host/mention-utils.ts:29, 37, 124` |
| `no-empty` | 2 | `src/octo/socket.ts:761, 863` |
| `no-useless-assignment` | 1 | `src/octo/socket.ts:627` |

## 5. check-security.mjs

**Headers.** All 85 DEV-00 files pass the SPDX line-1 check. The shebangs were removed under the listed `shebang` transform.

**Private-endpoint pattern.** This pattern (`localhost` / `127.0.0.1` / `10.x` / `192.168.x` URLs) hits 10 files. All the hits are SSRF-guard code or its fixtures:

| File | Lines |
|---|---|
| `src/host/config.ts` | 362, 399, 407 |
| `src/host/configure.ts` | 38, 44 |
| `src/host/url-policy.ts` | 190, 266 |
| `test/host/cli.test.ts` | 50 |
| `test/host/config.test.ts` | 289, 293, 295 |
| `test/host/configure.test.ts` | 81, 82 |
| `test/host/conversation-md-http.test.ts` | 30 |
| `test/host/inbound-ssrf.test.ts` | 45, 47, 48 |
| `test/host/q34-q37-q38.test.ts` | 46, 48, 50, 53, 55, 57 |
| `test/host/url-policy.test.ts` | 114, 115, 117, 147, 148, 154, 155, 192 |

Contract rev2 §C listed `config.ts` at 397/405 (pin numbering). `config.ts:362` (pin 360) is an additional hit in the same file.

The request is a per-file, per-pattern exception bound to `destinationSha256`, so that it fails when the file changes. It must not be a path glob.

## 6. check-imports.mjs / manifest v2

`import-entries.json` holds the entry data: 84 imported entries and 1 authored entry.

The validator should:
- recompute both hashes;
- enforce the transform enum;
- reject duplicate destinations;
- reject unlisted files under `src/octo/**`, `src/host/**` and `test/host/**`.

`verify-port.mjs` additionally inverts the transforms. The validator can reuse it or call it.

The `policy` sentence in `docs/import-manifest.json` needs the reviewed update for selective imports (Charter v8). The existing `LICENSE` entry keeps its current source.
