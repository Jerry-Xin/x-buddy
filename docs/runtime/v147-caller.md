# v147 guarded caller integration

This is a candidate continuation of `0dfe5522626748eb800aa494d020e38a5730f0fc`
(tree `677fd6ca66234e6f63c2c7f5e3c0f3fd2399011d`). It does not promote that
candidate or change accepted LOCAL `ae9f4b64` or integration `1811e091`.

The selected adapter delta comes from `2fd983350a45c94ad99bc9a38ec166aa00eb8f02`,
not its entire older tree. Projection/parameter logic and its fixture are reused;
the runtime delta is applied only after verifying the current runtime preimage
equals its `1811e091` preimage. Newer client, native observation, canonical
ownership, gateway, manager, store and lifecycle fixes remain intact. Tests and
the old harness are reconciled into the guarded real-caller selection, rather
than replaying its prior runner or unguarded selector attempt.

## Caller and lifetime

`createQueryAgent` binds the executor constructor and a synchronous current-turn
guard. The external five-argument query signature, text result, prompt safeguards,
tool redaction, notice/error classification and bounded recovery remain. The
default query refuses missing issuer before AGENTS refresh. Neither executor has
an implicit installed SDK constructor; both constructors require injection.

`startBot` constructs one `HostCaller` under its existing canonical ownership.
The guarded bootstrap injection is optional; main provides no production issuer.
`handleMessage` checks caller availability before routing, then captures its
independent prepared turn before session/history/mapping effects. The issuer is
constructor-bound, not selected from message data or a mutable last-caller slot.
Input and context data are copied/frozen; principal, channel, session, origin,
incarnation, logical message identity and admission deadline must match.

Missing authority, creator/target, reset, permit, runtime, lane, deadline or
mandatory effects return typed NO-WRITES. Native exit supplies none of those
capabilities. The fixed admission deadline stays with the runtime; expiration
does not turn dispatch timeout into cancellation of an accepted turn. Reset
guards fence callbacks and output. Failure/interruption yields no partial bridge
text. Persistent reset/CAS and mandatory history/delivery effects are still
unimplemented production prerequisites, not supplied by fixture readiness flags.

The per-bot factory supplies the SAME `ownership.lifecycle` through
`AppServerClientOptions.lifecycle`; it creates no second lock or child owner.
It retains all generation clients and collects runtime/client shutdown before
the existing lifecycle reader drain, DB close and final lease release. A rejected
runtime shutdown remains retryable on its original owner. Existing host cleanup
closures and manager pending-owner retry behavior are retained.

SDK rollback uses the injected SDK control and exposes cron state disabled with
reason executor-sdk. No scheduler or cron activation is added. A failed or
ambiguously accepted App Server turn never selects SDK or automatically replays.
Existing StreamRelay/direct sends remain the existing outbound boundary; this
increment does not implement or claim unified OctoEgress.

## Reversible provenance

The bridge is the fourth explicit overlay, alongside the three existing host
overlays. Only the index overlay is refreshed; gateway and manager bytes/patches
remain intact. The bridge preimage SHA256 is
`6edc2cacf9564d9215c0e9d542bb3a2295d50012a1a9e1c6b29b373c55ea9fb8`.
Its immutable mechanical preimage and exact forward patch are in the existing
semantic provenance directory. Both validators pin forward and inverse bytes;
inversion recovers original blob `ce0870775897f1189cedbcfe4d32430b79dde16c`
and raw SHA256
`3c9f492d87d08fe530bfbc85133d85a1707ea0352d1cf4aa3117fab6ffa40dc2`.
Original 84-source digest, licences, mechanical transforms and source metadata
remain fixed. Other 80 imports are unchanged. No relabel, blanket exception or
hash refresh without inverse proof is admitted. Bridge negatives cover wrong
preimage/path, extra hunk, deletion, postimage repin, unlisted import/overlay and
stale exceptions. Existing 22 suite pins and original collection controls remain.

## Finite verification and retained limits

Use the packet-pinned macOS arm64 Node 22.23.2/ABI127 and 24.22.0/ABI137,
compiler and ABI-specific native SQLite module. The affected selection runs
through the existing Node test runner with `test/runtime/query-agent-harness.mjs`
preloaded. That guard requires private HOME/TMPDIR and an explicit environment
allowlist, denies installed SDK imports, credential reads and network/API calls,
and admits only owned inert children, the fixed native observer, exact validator
bytes and the byte-pinned inert descendant. It is not an execution issuer or a
replacement test framework. No installation, native rebuild or new runner occurs.

The exact original two-generation fixture SHA256 is
`02eef28c0b72a8c524f6fb74e321844fe55e08c787201c3ccec97d15723749dc`;
delivery includes its unchanged bytes and native/SQL receipts. Affected tests
exercise actual bootstrap and bridge, both injected executors, per-turn/reset
fences, malformed/missing prerequisites, ambiguous acceptance, same-owner retry,
generation collection and SQL reopen/integrity. Finite source mutations target
the event fence, mandatory-effects gate, lifecycle attachment and shutdown call.

The original bridge suite has 48 declarations and 66 historical assertion
executions: 65 semantic cases and one final-snapshot-only item.updated limitation.
Vitest is absent from the supplied offline packet and retained checkouts. Those
66 executions are not claimed as new runs here, nor as protocol parity. Replaying
the original suite needs the existing pinned dependency made available by its
owner; installing or replacing it is outside this release.

Collection-control positives retain inherited failures because existing cron
test paths are outside the unchanged package globs. No package, shared-suite,
dependency, lock, native pin, CI, CLI, configuration, DDL or store repair is made.
All failed/setup/mutation attempts remain in evidence. Scoped compilation and
bounded passing rows do not establish a green full build, suite or product.
Prior 2739 review904/test904+10, original96FAIL, TS2345/exit2 and diagnostic hash
`ac952c2f2df29ca7dab8175fd7786fcba3a1ef5113d0a6b133bf25735499a3fa`
remain inherited/unwaived; the closed11576 corpus is not replayed.

The historical selector incident included account-aware 400/model_not_found,
not only ENOENT. Credential source/access and network origin remain UNVERIFIED;
historical argv, environment-key and process-tree observations remain UNAVAILABLE.
The docs-only correction did not establish no exposure or a successful response.
No recreation of that incident is authorized or performed by this selection.

Production issuer/authority/effects, full reset/history/egress integration,
real-binary/model/provider/network/Linux/UI/device/live and broader DEV04 gates
remain open. Existing security, provenance, takeover, scanner, runner and daemon
holds remain. Next owner is PjM for blocked prerequisites and independent gates;
no review/test dispatch, baseline promotion, push, PR, merge, deployment or
publication is performed here.
