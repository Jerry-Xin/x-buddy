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

## Collection integration and bounded lifecycle repairs

Collection integration was delivered separately at
`60a37a6fbbf73bcc91a2d7be2adeee6d74495e48` (tree
`d03be703d98646f9f165bd909efd59c6515d2618`). It collects both runtime suites,
retains all 20 predecessor omission pins and adds two runtime pins. Its 44
collection controls cover removal, renaming, nested/additional suites and glob
narrowing. This repair preserves those three shared files byte for byte.
The integration receipt reports a final Node 22 host debounce failure (XB-H01);
its earlier green revision does not replace that failure or establish acceptance.

The lifecycle repair starts from that integrated head, whose runtime/client
blobs equal the reviewed `da598582382bf21d71c99c254012603a196e1645` source:

- Repeated client close requests keep the earliest monotonic kill deadline.
  A shorter shutdown grace escalates an existing recycle close; a longer request
  cannot extend it. Each caller still waits for confirmed child exit and pending
  request settlement. Runtime ownership is retained until that proof arrives.
- Recovery captures its process owner and checks owner, exit and recycling state
  after each asynchronous boundary. Retired recovery cannot close a replacement,
  clear its lanes or overwrite `starting`/`ready`/crash backoff. Recovery bookkeeping
  is owner-specific so a replacement can independently quarantine and recycle.

Regressions exercise zero/shorter/longer close requests against actual children
requiring SIGKILL, including shutdown during an existing 15-second recycle close.
Every process is collected even if an assertion fails. Deterministic injected-client
tests cover a crash during drain, ready and held-start replacements, preserved
backoff, new-lane admission, stale notifications and a subsequent normal recycle.
These are local seam/fault-adapter claims, not real-binary timing guarantees.

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
