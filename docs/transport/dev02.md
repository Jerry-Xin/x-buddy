# DEV02 transport prerequisite increment

This is a local, staged increment on accepted integration
`7c2139d0a3849a0ec754dd0a02fcfe39cd405ec8` (tree
`cb1c182255ce962fecc59c9e83c31500b6ddf6af`), under XIN-2546. XIN-2481 has
no other registered DEV02 task; execution history contained only this run.
The accepted bundle SHA256 is
`8449e7cca3008c25c5762ef9f63a17ea7d7eb3f5e43c3eff8edbdd1ea13dc732`.

## Implemented boundaries

| File | Responsibility | Contract evidence |
| --- | --- | --- |
| `src/transport/clock.ts` | Injected wall/monotonic clock and cancellable waits | R8 10.4, existing foundation FakeClock |
| `src/transport/api-client.ts` | Request-wide 30s default/60s ceiling, four methods, int64 parsing, structured scrubbed errors, bounded 429 retries and response bytes, same-origin paths, redirect refusal | R8 3.1, R1–R3 |
| `src/transport/ownership-lock.ts` | Exclusive private lock, exact inode/nonce ownership, callback admission before DB open, release after callback cleanup | R8 2.6, 8.1 subset |
| `src/transport/transport.ts` | Register/identity, socket lifecycle, 15s CONNACK deadline, deferred refresh/cooldown, backoff, watchdog, independent heartbeat and immediate stopIntake | R8 T8, T13–T21, EP-01/02, C15 subset |
| `test/dev02-*.test.mjs` | Fault-clock, API, independent-process contention, and real WKSocket/local fake Octo tests | Existing test globs, no runner edits |
| `test/integration-checks.test.mjs` | Allow the positive controls to report multiple newly collected suites, with an added regression | Gate implementation and negative controls unchanged |

The wire codec, crypto, framing limits, poison cap, ping detection and ACK
implementation are reused by importing `WKSocket`; none of its bytes changed.
The wrapper disables the old socket's automatic reconnect synchronously when
retiring it. Socket epoch guards and lifetime cancellation reject stale results.
REST registration never changes the client's configured endpoint from `api_url`.
Initial registration, refresh, and any supplied WebSocket override all use the
existing URL policy. Ordinary self echoes are filtered; preference/document
events remain admitted. Consumer exceptions are contained.

## Consumption contract for DEV04

1. Acquire `BotOwnershipLock` before creating/opening the bot's DB or runtime.
2. Create `OctoApiClient` from the validated configuration and create transport
   with that held lock. Install the inbound handler before `start()`.
3. `start()` resolves on the first CONNACK. A first-attempt failure rejects that
   promise but retains a bounded reconnect timer; observe `state` and the
   connection predicates for later automatic recovery. Call `stop()` if aborting
   startup. A stopped object is terminal: create a new transport to start again.
4. On shutdown call `stopIntake()` before draining host handlers. It stops the
   wire receiver immediately. The host owns bounded handler drain; transport
   `stop()` collects its own socket/API work. Close DB resources, then release the
   external lock **last**, including on failed startup. Transport never releases
   that lock itself. `withBotOwnership` provides the outer callback/finally seam.

Heartbeats never rebuild a socket. HTTP 429 only increments its dedicated count;
other errors increment failures/streak, and success resets the streak. Watchdog
intervention requires no connecting/connected socket, rebuild or pending retry.
Refresh attempts use monotonic time, at most once per 60 seconds. A rejected
refresh registration retries ordinary registration within the deferred delay
instead of repeatedly forcing token refresh during cooldown.

The supervisor retains the rapid-disconnect streak across retired WKSocket
instances: three consecutive post-CONNACK closes lasting less than five
monotonic seconds request a refresh through that same cooldown. A connection
lasting at least five seconds breaks the streak; thirty stable seconds reset
the streak and reconnect backoff. Pre-CONNACK failures do not increment it.
Retired callbacks and stopped transports cannot increment it or queue recovery.

## Explicit limits and holds

- This does not wire or activate the existing host, App Server, SDK executor,
  package root export, CLI or a live bot. All imported files, SDK rollback,
  `sdk_sessions`, cron markers and existing startup paths are unchanged.
- Existing stale, corrupt or inaccessible locks **refuse admission**. There is
  no automatic stale reclaim: a dead host does not establish that its child has
  exited. DEV04 must add child PID/start-identity reconciliation and its bounded
  restart tests before authorizing takeover. No process is killed by this code.
- Lock release rejects replacements visible during its inode/nonce check. This
  is conditional on actors following the exclusive-create/no-takeover protocol:
  an external actor renaming a live lock after the final check but before the
  pathname unlink can cause the replacement to be deleted. The conditional
  release race is tracked for XIN-2505 and must be addressed before introducing
  concurrent takeover; this repair does not implement takeover.
- Migration framework, online backup, `schema_migrations`, `bot_incarnations`,
  downgrade harness and the cron-running contention scenario are not implemented
  here. The contention test uses stable DB/WAL fixtures and proves that the
  contender cannot reach the DB-open callback; it is not a migration test.
- Existing WKSocket ping/stability internals use native timers; the wrapper's
  clock tests do not claim live 240-second black-hole acceptance. The unchanged
  host suite supplies its existing socket hardening regressions.
- The API client accepts the already trusted configured endpoint under existing
  policy. It refuses redirects entirely. No new DNS-pinning, egress exemption,
  scanner waiver, management authorization or message egress capability is claimed.
- This is not full DEV02 acceptance, full Octo parity, real-server conformance,
  a real Codex-binary check, or release/merge permission. Outbound integration
  remains held until DEV06 and the accepted security gates. Linux is unverified
  unless a separate Linux result is attached.

## Verification

```sh
npm ci
npm run build
node --test --test-timeout=30000 "test/dev02-*.test.mjs"
npm run check
```

Run host regressions sequentially across runtimes: the inherited host fixtures
use fixed lock directories, so concurrent host runs can collide (XB-H02).
Report actual runner counts and any skips/flakes, not sums of historical receipts.
Tests use only local fake peers and temporary directories with synthetic tokens.

## Shared writer handoff

No dependency, package, lockfile, CI, config, import-manifest, checker or parity
matrix change is required for this increment. Root test globs already collect
these suites. New modules are authored, not selective imports. Archer-mini2
remains sole writer of shared manifest/matrix/config data; a later integration
may record these authored paths and SHA256 values from the delivery identity
artifact. Do not mark R8 matrix rows fully passed from this bounded receipt.

The authored checker **tests** had two positive-control assertions that assumed
exactly 17 total suites and one added suite. They now allow a variable number of
new suites while retaining the 17 reviewed-suite assertion and checking the
specific added paths. A regression adds two suites together. No checker script,
runner configuration, collection rule, security negative control or exemption
was changed.
