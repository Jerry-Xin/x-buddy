# Manual receipt admission

`CronStore.admitManual(scope, jobId, request)` reserves an explicit local invocation.
`startManual` admits its retained receipt through the existing constructor-bound
execution verifier. `finalize` applies the common terminal projection. These APIs
perform no model calls or outbound delivery.

The caller supplies `trigger: 'manual'`, the current generation, a run ID, a fresh
`manual:<UUID>` invocation ID, an explicit normalized mode, the existing validated
creator/target/definition/policy authority, and held owner/reset fencing. Command
callers must normalize the omitted command mode to `if-enabled`. Selecting `force`
does not establish operator authority. This module supplies no production operator
authorization resolver, proof issuer, lock acquisition, host or command binding.

| Current definition | `due` | `if-enabled` | `force` |
| --- | --- | --- | --- |
| Enabled future at | not-due | borrow | borrow |
| Enabled eligible due/overdue at | consume | consume | consume |
| Enabled recurring, eligible due slot | consume | borrow | borrow |
| Enabled recurring, not due | not-due | borrow | borrow |
| Disabled | disabled | disabled | borrow, remain disabled |
| Active queued/running receipt, including pending retry | already-running | already-running | already-running |

Exact invocation replay returns the validated original receipt without DML. It is
data, never a second dispatch grant. New requests cannot supersede a pending retry.
Reusing an invocation identity in another generation fails. Invalid or conflicting
stored provenance is quarantined; unrelated constraints are not dedupe success.

Reservation runs in one synchronous owner-fenced `BEGIN IMMEDIATE`. It rereads
the current definition and effective schedule, activation, backoff and watermark
fences. It does not change job cadence or consume a watermark. Consume uses the
canonical `[jobId, generation, effectiveSlot]` occurrence and scheduled slot;
borrow uses the manual UUID with NULL scheduled_for. The at reference, or an
available natural recurring next slot, is retained for audit. A backoff timestamp
is not treated as an authored occurrence. The admitted snapshot records mode,
ownership, enablement, next_run_at and definition/policy/owner/reset provenance.

`startBase` still rejects manual receipts. `admitRetry` still accepts only retained
consume retries. `startManual` uses the same issuer-bound frozen envelope,
original permit/deadline, owner/reset/runtime/lane/abort fences at entry and
precommit. Missing or unbound proof returns the existing typed no-write deferral.
The disabled-force exception applies only to a manual borrow admitted disabled,
in the same generation while it remains disabled. It never enables a definition.

Consume finalization uses the existing NULL-safe max watermark, canonical retry
chain, cadence/counter rules and owner-fenced at retirement. A successful kept at
remains disabled. Required unsupported alert/disable-notice/publication effects
still defer before CAS. None/suppressed success remains distinct from unknown
delivery, which does not become success. A borrow changes only its own outcome
and strictly newer informational last_* fields; counters, watermark, cadence,
enablement, alert state, deletion, backoff and automatic retries stay unchanged.

Borrow ownership survives date crossing and SQLite close/reopen or process crash.
An at becoming due while its borrower is active retains the existing one-shot-busy
deferral, with no overlap receipt or authored consumption. It can be reserved once
the borrower clears. A new explicit repeat requires a fresh manual identity.

The tests use unseeded public receipt/start/finalize chains and explicitly labeled
aggregate/corruption fixtures with a modeled issuer. Actual exit/SIGKILL/WAL
receipts prove transaction durability only. Production operator authorization,
issuer freshness and child-termination/startup recovery, scheduler timers and
immediate wakes, pruning/retention, real delivery/history effects, host/CLI wiring
and complete MAN/REPLAY/DEV09–11 acceptance remain pending. No table, index,
schema, dependency or imported-host change is required by this increment.
