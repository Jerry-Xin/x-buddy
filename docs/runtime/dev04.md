# DEV04 staged local runtime

This increment is based on accepted commit `466ae5f15ab8f836895e02d0ea08688cb90f910c`
(tree `9fc2e1c2a7947646d9c3d32ee844a924ca6a539c`). It implements an explicitly
constructed, per-bot `BotCodexRuntime` using the existing `AppServerClient`.
There is no package-entry export or host activation. Only `src/runtime/**`,
`test/runtime/**` and this documentation are added.

## Implemented seam

- Lazy shared readiness within one runtime, one owned child at a time, process
  generation tagging, crash failure without replay, monotonic 1/2/4/8/16/30s
  recovery delay and a five-crash/5-minute circuit with a 60s open interval.
- One driver for `openTurn` and `runTurn`; `done` settles without consuming
  events. Outcomes distinguish failure/interruption from completed success.
  These events are **raw App Server notifications**, not SDK `ThreadEvent`
  parity. Completed agent-message snapshots supply text in first-seen item order.
- Subscribe/buffer before thread/turn control calls; immutable host authority
  is registered before turn-buffer replay. Process/thread/turn identifiers must
  all match. Contexts are removed on terminal, reset, ceiling, cancellation and exit.
- Same-session FIFO, first-thread aliasing, independent thread concurrency,
  configurable pending depth (default three), removable abort/deadline admission,
  and execution ceilings measured after accepted `turn/start`.
- Dispatch-time host mapping lookup and generation-fenced mapping callback.
  `cancelSession` fences locally without waiting behind normal admission.
  A persisted generation provider supplements that local fence. The host still
  owns the transaction and compare-and-set; no database writes are added here.
- Interrupt response is never termination proof. Matching terminal or process
  exit is required. Missing proof quarantines the lane and fails its waiters;
  recovery stops admission, drains siblings, interrupts, closes stdin and waits
  for confirmed exit. A child whose exit is unconfirmed remains owned and no
  replacement starts. Shutdown bypasses recovery drain and settles drivers.
- Unsubscribe in cleanup, retry once, then quarantine/recycle. Every ordinary
  resume sends `config:{}`/`excludeTurns:true`; all thread/turn calls force
  `approvalPolicy:never`. No start-turn replay is enabled. Buffers are bounded
  to 10,000 notifications and overflow interrupts without pausing stdout.
- Isolated cron lanes use the supplied run key and never call the session
  mapping hook; this is only the runtime hook, not a scheduler implementation.

`onThread` is a synchronous CAS hook. The host must implement its generation
check in the actual write. A throwing callback quarantines the ambiguous
subscription rather than starting a turn. No stale callback can run after a
cancelled control call settles. Idle process-local lane aliases are discarded
after exit; durable cross-process resume requires the host mapping resolver.
Lane alias conflicts after an accepted thread operation fail closed rather
than merging two potentially active thread owners.

## Local verification

After a fresh locked install with the desired Node executable on `PATH`:

```sh
npm run build
node --test --test-timeout=30000 'test/runtime/**/*.test.mjs'
```

The deterministic suite imports the existing `FakeAppServer`, `FakeClock` and
`FaultPlan`; it never edits or copies them. It explicitly checks its no-steering
oracle because the fake permits concurrent starts on a busy thread. Every armed
in-process fault is checked with `assertExhausted`. A narrow test adapter can hold
control responses or inject stale callbacks, without claiming those behaviors
are real-binary facts. Separate process tests use the actual `AppServerClient`
and the existing foundation subprocess entry; they check real PIDs, crash,
two-bot isolation, cancellation, shutdown and no leftover child.

The fake's placeholder wire shapes, missing cold-reload semantics and lack of
real provider/auth behavior are retained limitations. No pinned 0.142.3 binary,
live model, real Octo transport, Linux conformance or API-key login was exercised.

## Required sole-writer integration request

The existing shared files and all **20 existing omission pins** are unchanged.
The staged suites are intentionally outside the currently approved runner glob;
the current checker must reject them. A passing staged runtime test is not a
passing integrated `npm run check`. Before acceptance, Archer-mini2 must:

1. Append `"test/runtime/**/*.test.mjs"` to `package.json`'s `test` command.
2. Append that glob to `NODE_GLOBS` and update the exact `TEST_COMMAND` pin in
   `scripts/check-tests.mjs` to that same command.
3. Add `test/runtime/runtime.test.mjs` and `test/runtime/process.test.mjs` to
   `NODE_SUITES`, preserving every existing pin (22 reviewed suites afterward).
4. Update the reviewed-suite-count assertion in `test/integration-checks.test.mjs`
   from 20 to 22. Add deletion and rename negatives for **each** runtime suite,
   plus nested/extra runtime collection and runtime-glob narrowing controls.
   Retain all existing DEV02, older-suite, skip-all and SSRF controls.
5. Run fresh locked Node22/24 integrated checks and deletion negative controls
   on the combined exact head. Do not amend the lock, CI, manifest, security
   contracts or imported-byte exceptions merely to collect these suites.

Until that change lands, three existing integration-test positive collection
controls are expected to fail when they copy the complete staged tree: the
unchanged-tree, added nested suite and added multiple suites controls. Their
failure must stay visible; do not skip them or describe the full check as green.

## Deferred R8 work and unchanged boundaries

Full DEV04 is **not complete**. Host `BotStack`/executor selection and lifecycle
wiring, unchanged `queryAgent` dual-executor assertions, SDK `ThreadEvent`
projection/tool/usage/error parity, full config/binary/environment/auth/ephemeral
login mapping, config-reload respawn, persisted reset transaction/CAS,
delivery/history completion barriers, cron execution/finalization, durable
incarnation/session recovery, runtime status schema and audit/catalog integration
remain later increments. The runtime's `stats` is a staged diagnostic view,
not the frozen production status schema. Initialization is ready only for this
local protocol seam; it does not certify configured provider authentication.

No `src/host`, `src/octo`, `src/index.ts`, imported codec, database, package,
lock, CI, configuration, manifest, checker or existing integration test is edited.
The SDK rollback path, `sdk_sessions`, cron hooks and external `queryAgent`
contract remain as accepted. No new outbound primitive or scanner exception is
introduced. XIN2157 and inherited dependency, XB-H01, pack-smoke and future
takeover holds remain. Local delivery requires independent review/testing;
no push, PR, main merge, deployment, publication or live activation is authorized.
