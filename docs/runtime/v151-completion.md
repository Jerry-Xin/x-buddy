# Host session completion: bounded local increment

This continuation starts at `7284a71596587531d1dea4340926af4d44a3dbe3`.
It implements a per-bot, per-session host completion owner around the actual
`startBot -> handleMessage -> immutable HostCaller -> queryAgent` path. Runtime
terminal settlement stays separate. The next same-session caller cannot route,
read history or assemble its prompt until the preceding host callback settles.
The existing router dispatch timeout releases its lock without canceling the
accepted turn; the host still owns that callback.

Final reply segments use the existing `sendMessage` interface and original
relay mention/split wire format. They share one absolute 60-second budget.
Each segment and subsequent history/mapping write checks the captured trusted
generation. Unknown/failed delivery stops further segments and assistant history
without a resend. Read receipts and progress/typing notices are owned and bounded;
these direct sends do not constitute unified OctoEgress.

Shutdown stops admission and cancels queued/active completion work before the
gateway drain. Completion gets the original absolute 10-second shutdown drain
window, followed by the unchanged runtime/native cleanup. An uncollected effect
retains the DB and canonical lease; ordinary same-owner retry can finish after
the effect settles. Other sessions and bots have independent completion lanes.
The queue cap and original admission deadline are retained.

The existing constructor-bound generation reader can observe a reset that a
trusted producer has already committed. `observeReset` cancels older work and
the existing runtime session. It does not produce a persistent reset or CAS.
This host has no persistent reset-generation/CAS producer. `/reset` and `/new`
therefore return typed `NO-WRITES: reset-cas-unavailable` before legacy command
mutation, including while ordinary work is queued. The injected generation map
used in tests is inert evidence of fencing, not production CAS authority.

## Blocking path outside this increment

`SessionRouter.runHandlerWithTimeout` calls its private `replySafe`, which calls
`sendMessage` without the completion signal. There is no constructor or
per-invocation callback for that reply. The actual guarded caller reproducer
holds the router timeout apology, observes a trusted generation change, then
releases the capture: the old apology still publishes. Its security assertion
remains RED for both executors. The router's rate-limit and oversized-message
replies use the same private path and are also outside the completion guard.

The minimum additional source path is `src/host/session-router.ts`: add an
optional per-invocation reply callback to `routeAndHandle` and carry it through
its routing/timeout replies, so the already allowed index caller can bind that
effect to the captured completion scope. Existing callers retain their default
reply behavior. This also requires an exact fifth reversible import overlay,
the two validator/manifests pins and corresponding negative proof; v151 permits
only the existing four overlays and explicitly excludes this host file. No
private-method replacement, alternate router, mutable last-caller binding or
validator exception is applied. PjM/Owner must authorize that exact path and
provenance delta before this blocked scope can continue.

Production authority/issuer/creator-target/reset/permit/runtime/lane/deadline and
mandatory effects remain required before writes. Cron producer/finalization and
real SDK cancellation/native authority are not supplied here. The prior F1
classification and no-ambiguous-replay behavior remain intact. The six Owner
accepted AppServer C1 nonparity failures and historical assertion counts are
inherited, not new executions or notification parity. No product or full-suite
acceptance is claimed for this partial increment.
