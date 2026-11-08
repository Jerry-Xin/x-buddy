# Durable host session generations

This local increment continues `6e8f7903a3787fe32f0718916d3b7e9fee198af2`.
Production execution still has no issuer, authorization/creator-target producer
or mandatory-effect implementation. Main supplies no execution setup. Missing
prerequisites retain typed `NO-WRITES`; raw and cleaned reset/new commands remain
refused before the legacy command handler. No production operation is activated.

The canonical ownership lease precedes DB open. Startup collects a SQLite online
backup before any initialization DDL, including the unchanged GroupContext
constructor and legacy message-column adoption. Idempotent constructor DDL is
covered on reopen too. Only completed consistent backups count toward retention;
the current backup and two recent predecessors are kept. Failed partial backups
remain separate. Each initialization transaction and migration record commits
together, then a separate incarnation transaction records lifecycle bookkeeping
before cleanup/intake. Failure stops startup and reports the actual recorded
schema/incarnation phase and backup location. Incarnation rows never prove a
native process has exited.

Only `schema_migrations`, `bot_incarnations`, and R8's verbatim
`session_generations` are added. The eight existing tables remain;
`sdk_sessions` is the only session/thread mapping. Generation rows have no FK to
transient sessions and survive reset, session deletion and TTL cleanup.

The constructor-bound SessionState captures canonical store methods and checks
the real ownership lease. HostCaller uses its durable readers rather than setup
maps. A captured turn rechecks authority, lease and generation before and after
synchronous compound writes. Mapping/signature errors latch the turn's refusal,
so the bridge's existing callback exception handling cannot permit later
publication or accepted-work replay. The executor composes the canonical mapping
hook before projecting `thread.started`; AppServer persistence refusal prevents
`turn/start`. The SDK cannot retract accepted work, but later effects are refused.

The host fences creation/touch, ordinary and backfilled history, mapping/clear,
signature and cursor publication. Backfill bookkeeping belongs to the store
instance and generation. Group publication uses the unchanged imported methods;
its index-owned adapter surfaces swallowed SQL failures and restores the existing
Map preimages on rollback. The consumption cursor is pending until the compound
mapping/signature transaction succeeds. Existing group retention/roster policy
is retained. Host/store/router/group identities must match before processing.

`HostCaller.resetSession` is a trusted local boundary, independent of ordinary
completion/router queues. The existing constructor issuer must authenticate all
eight prerequisites before CAS; persistence creates none of those prerequisites.
Reset uses the immutable admitted envelope. One short transaction deletes the
session/history, advances the monotonic barrier, clears mapping/dependent
signature state and increments the generation. Only after commit does the caller
cancel old work. It returns the committed generation even when cancellation
reports an error; no automatic second reset or rollback occurs. Duplicate and
overlapping observations are coalesced so the inherited runtime cannot invent a
fence beyond SQLite. New host work waits for cancellation collection, its own
admission deadline, confirmed termination/quarantine rules and the retained F2
last-effect completion barrier. Shutdown collects handlers, effects, reset
notifications and native ownership before incarnation end, DB close and lease-last
release. Unknown/interrupted delivery creates no successful assistant history.

The only newly changed imported files are `session-store.ts` and `db-adapter.ts`,
alongside the existing index overlay. Five exact overlays become seven. Their
original/preimage/forward/inverse/postimage proofs, both manifests and both exact
validators are updated. The other four overlays and 81 imported destinations stay
unchanged; all 84 original source identities/licenses and six transforms remain.

Bounded verification uses the existing guarded Node test lane and the original
Node22.23.2/ABI127 and Node24.22.0/ABI137 pins. The restored 100 SQLite package
files and unchanged 205 compiler/type files are verified in a new private tool
directory. No dependency, binary, package, lockfile or runner pin changes. The
owned host fixture selects the exact native binding explicitly, avoiding ambient
addon discovery. A narrow compile-only declaration describes that existing
offline native API; runtime cases execute the actual binary. Scoped compilation
is not a full-host build or resolution of historical compiler failures.

Final results per runtime: 36 persistence cases and 18 affected error/projection
regressions pass. The 19 provenance cases comprise one healthy and 18 negative
cases, producing 38 validator receipts (two healthy and 36 intended refusals). The same actual-startBot parent case fails the
intended missing-generation-table assertion. Missing-guard commands refuse before
target execution. Compilation and validator receipts are reported separately
from feature cases. Earlier failed/setup attempts remain in the evidence ledger.
No full suite or closed F2/immutable bridge replay is claimed.

Private SQLite cases include WAL-consistent populated backup, reopen/TTL,
first/delayed mapping, all history/signature/cursor paths, binding/ownership and
reentrancy refusal, commit/cancellation and duplicate-control races, held delivery,
actual owned-process cleanup, native crashes before/inside/after commit, rollback,
actual-schema legacy downgrade-open and DB/WAL/SHM-isolated restore. Additive
tables remain through rollback. Deployed package/rollout acceptance, old-package
reset reconciliation, full history/egress/scheduler integration and production
authorization remain separate R8 obligations. Accepted LOCAL/integration
baselines, six C1 exceptions per runtime, immutable 128 assertions/52 declarations,
helper exit1, historical CR/RED/FAIL/96 FAIL/TS2345 and all inherited holds remain.
This is author evidence for separately released formal review and local testing.
