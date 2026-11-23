# Local restart receipt repair

The store now consumes the approved optional macOS canonical lifecycle boundary
at parent `b3356bc0b6ec1c58914428f320b24f65be4a11f4`. Earlier missing-interface
reports describe their exact older inputs; they do not describe this continuation.
The original source and reports remain in the evidence packet. Baseline v145,
accepted LOCAL ae9f4b64 and distinct integration 1811e091 remain unchanged.

Construct `CronStore(db, clock, testSeams, executionVerifier, { lock, expected })`
with the SAME `BotOwnershipLock` that completed `reconcilePreviousChild()`.
`expected` is the immutable expected bot/current incarnation/previous incarnation,
parent and child PID/microsecond starts and retained device/inode scope. It is
copied at construction and carries no native authority. The store calls the
canonical prototype implementation on that exact object, so JSON, booleans,
instance method replacements and structural/prototype copies cannot mint a fact.
No registry, producer, acquisition factory or request-selected verifier is added.

Both canonical implementations are captured once when the store module loads,
before individual stores are constructed. Temporarily replacing a prototype
property during construction cannot become the store's pinned implementation,
even when the original property is restored before repair or resumed admission.
Authentic construction and later prototype mutation retain the same checks.

The previous-child implementation internally calls the instance's `assertHeld`.
The store therefore calls the pinned canonical lease check both before and after
the pinned previous-child check. Synchronous instance re-entry cannot leave a
changed lock content or invalid directory undetected at the final sample. A
detected loss revokes the private native fact even after filesystem restoration.
This correction closes the nested dispatch finding at reviewed `59d00db`; the
earlier no-op instance substitution regression remains a separate control.

`reconcileRestart(scope, jobId, { expected: oldReceiptExpectation, ownership })`
is synchronous. Missing construction binding retains the original typed
`previous-child-termination-unavailable` deferral before DB access. An invalid
canonical fact refuses before DB access. A healthy binding checks entry, the
immediate pre-CAS boundary and the final precommit boundary. The same lease must
remain held through DB/resource close. These are non-atomic call-site samples;
no continuous monitoring or elimination of external check-to-effect races is
claimed. Observed directory/lease loss permanently revokes the fact even after
restoration. Wrong scope expectations do not revoke healthy native evidence.

Within one short `BEGIN IMMEDIATE`, complete immutable provenance, manual/R1
rules, retained base/retry chains, expected old owner/status, reset, generation,
current definition, single flight and timing are re-read and checked. The CAS
compares every receipt column. Entry and pre-CAS refusals perform zero DML;
post-CAS failure rolls back the complete jobs/runs snapshot. SQLite
`total_changes()` counts rolled-back attempted writes, so those rollbacks are
explicitly distinguished from zero attempted DML. Duplicate repair validates
stored outcomes/chains and performs zero DML with unchanged `total_changes()`.

| Old receipt | Supported store result |
| --- | --- |
| Running executing/admission | Interrupted with reason `restart` |
| Running delivering | Interrupted, completion/delivery unknown, no resend or fabricated history |
| Queued manual request lost | Terminal skipped with reason `restart`, common terminal projection |
| Queued timed base/retry, current enabled generation | Same receipt/attempt/ready time/chain transferred to current owner; no job effects or new attempt zero |
| Current incarnation work | Never stolen or repaired |
| Stale running generation | Own receipt and strictly newer informational projection only; replacement authored state protected |
| Stale queued timed generation | No-write deferral |

The existing common terminal projection remains the sole authored consumption
writer. Consume attempt zero uses NULL-safe max watermark; retry repair never
consumes again. Restart is non-transient: eligible recurring interruption uses
the existing error-counter/backoff calculation with no quick retry. Lost queued
manual work uses the existing neutral projection. Borrowed future, disabled or
recurring work stays borrowed across downtime/date crossing, updating only its
own receipt and newer information. It cannot alter W, cadence, counters,
retry/alert state, enablement or deletion. An original one-shot due slot remains
eligible after its borrower clears. Replacement generations retain their domain.

Mandatory unsupported alert/disable notice/publication effects defer BEFORE CAS.
In particular, running consume one-shot repair currently defers when its required
disable notice has no accepted transactional representation. No partial repair,
dummy notice, deletion-on-unknown or fabricated production effect is substituted.
Queued consuming manual one-shots use the established neutral retirement path;
unknown/interrupted outcomes never invoke successful one-shot deletion.

Resumption reserves data only. `startBase`/`admitRetry` still require the existing
constructor-bound execution issuer, independent current authority/reset/permit/
runtime/lane/abort checks and the unchanged fixed admission deadline. A mixed-owner
retained retry chain is accepted only under this same canonical binding, with
exact previous/current incarnations. The original provenance/readiness/natural-slot
priority rules remain; there is no blanket watermark bypass or new attempt zero.
The canonical exit fact supplies no execution or production authority.

The local harness creates inert owned processes, reserves and starts through the
public APIs with explicitly modeled admission authority/issuer, observes actual
native exit, retains the same canonical lock, reopens its owned SQLite DB and
calls public repair. Downstream delivering-state corruption is labeled; there
is no real provider/send. Faults and owned-process exit/SIGKILL at repair CAS,
projection and commit verify WAL all-or-none state. Native/SQL/snapshot/cleanup
receipts and all failed setup attempts are retained. The test-only module loader
resolves the canonical lock to its exact precompiled module because Node strip-only
mode cannot execute its parameter properties; no inherited assertions change.

`bot_incarnations` is planned R8 DDL, absent from implemented `schema.sql` and
`schema.ts`, and explicitly deferred by DEV02. It is not child-exit proof.
Schema/DDL/index/dependency/native/runtime/host/provenance bytes remain unchanged.
Original 24 inherited failures per profile and TS2345/exit 2 remain unwaived;
no green full build/suite or product acceptance is claimed.

Production host/pre-DB/shared-home orchestration, authority/issuer, real App
Server, Linux/packaging/live/UI/device and full MAN/REPLAY/BOUNDARY/OP/DEV04/08/09–11
acceptance remain pending. This implements bounded store behavior only. All
security/provenance/takeover and remote Git/PR/push/merge/deploy/release/live/
configuration/credential/scanner/runner/daemon holds remain. Ambient UNAVAILABLE
is not evidence of zero exposure. PjM owns the next independent review handoff.
