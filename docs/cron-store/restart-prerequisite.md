XIN-2737: restart reconciliation prerequisite
============================================

Actual restart receipt repair is **blocked** on the exact continuation input
e2d2ee035ae479b31d70e5d5ae2f317a47a55e6e (tree
f10cd556b8cc2d94cf07bd412f00d5c529107730). Accepted local ae9f4b64 and the
distinct integrated 1811e091 lane are unchanged. This bounded change adds a
typed NO-WRITES entry point; it does not implement or activate recovery.

The accepted R8 contract, XIN-2050 comment
709cfb70-e0aa-49e2-8163-d4a4142abc1e, sections 2.6, 3.4.4 and 8.1, requires
the ownership lock and proof that the previous incarnation's child terminated
before repair. A dead parent, a receipt owner string, a boolean, or an execution
permit does not prove that fact.

Exact dependency evidence
-------------------------

| Existing source | What exists | Missing prerequisite |
| --- | --- | --- |
| `src/cron/store/index.ts`, CronStore constructor | Database, clock, test seams, optional ExecutionAdmissionVerifier | No constructor-bound previous-incarnation termination/authority capability |
| `src/cron/store/types.ts`, ExecutionAdmissionVerifier and ExecutionAdmissionRequest | A verifier for the frozen execution envelope and current authority/reset/permit/runtime/lane/deadline | No previous-child PID/start-identity reconciliation or binding to the old receipt owner |
| `src/transport/ownership-lock.ts`, BotOwnershipLock.acquire | Refuses every existing lock; explicitly defers child identity reconciliation to DEV04 | No stale-lock takeover or proof that the prior child exited |
| `src/runtime/runtime.ts`, private ProcessOwner, shutdown and recover | Tracks and awaits its own in-memory child exit | No exported capability for a replacement host to prove an earlier incarnation's child termination |
| `src/runtime/types.ts`, TurnOutcome.termination | A current turn's terminal disposition | No durable previous-incarnation process identity or canonical store authorization |
| `src/cron/store/schema.sql`, bot_incarnations | Incarnation, parent PID and timestamps | No child start identity or termination proof; ended_at is not such proof |

PjM must route this existing-mainline dependency to the existing runtime and
ownership lifecycle owners (DEV04/DEV08), with the original writer retaining
this store task. This document does not dispatch work, design a new producer or
trust policy, or authorize host wiring, process termination, takeover or schema
changes. The indispensable missing interface is a canonical constructor-bound
capability that authenticates the previous incarnation's child identity and
confirmed termination under the current ownership/reset/authority fences.
Its production implementation and approval are outside this store-only scope.

Bounded API
-----------

`reconcileRestart(scope, jobId, { expected, ownership })` returns the frozen
value `{ kind: 'deferred', reason: 'restart-reconciliation', prerequisite:
'previous-child-termination-unavailable' }` for a structurally valid request
with synchronous held-ownership guards. It checks the existing request envelope
and ownership guards at entry and return, then stops **before any DB access**.
There is no BEGIN, CAS, projection, commit, execution grant or stored-outcome
acceptance. It never calls the execution verifier. Request-selected verifiers,
proof callbacks, authority objects and termination booleans are rejected as
unknown fields. The ownership guard remains the existing modeled seam; it is
not promoted to termination authority.

The method deliberately has no successful result variant. A deferral says
nothing about stored receipt validity, scope membership, current generation,
owner/status matches or retained-chain integrity. Even same-incarnation work,
already-terminal receipts and changed definitions defer without inspection.
No information from next_run_at is treated as permission. Existing finalize,
manual/R1 validation, execution fences and common terminal projection are
unchanged. No schema, dependency, imported provenance, host or runtime is edited.

Evidence and limits
-------------------

The focused tests use actual public admitBase/admitManual and issuer-bound
startBase/startManual/admitRetry before persistent close/reopen. Owner and issuer
prerequisites are explicitly modeled, with no model or send operation. The
tests cover timed/manual consume, future/disabled/recurring borrow across dates,
queued/running retries, same/old incarnation, replacement generation and terminal
replay. Complete jobs/runs and SQLite total_changes stay equal, and the observed
store receives zero SQL calls. Two connections include a held SQLite writer.
Entry/return ownership loss and request-selected trust substitutes also perform
zero writes. Four actual exit/SIGKILL/WAL controls stop before/after the typed
deferral and reopen unchanged; they are **not repair-CAS/projection crash tests**.

Successful old-owner running-to-interrupted repair, delivering-to-unknown,
queued-manual terminal skip, queued-timed owner transfer/resumed admission,
repair precommit proof loss, repair duplicates, repair common projection and
repair CAS/projection/commit crash tests remain **unimplemented and unpassed**.
They cannot be exercised legitimately without the missing capability. Existing
74 crash families exercise the inherited manual/supersession/admission/failure
paths, independently of those missing repair paths. Do not use finalization
with an impersonated old owner, UPDATE-to-running, a process boolean or a
request-selected verifier to manufacture a successful recovery demonstration.

The unchanged inherited selection remains 2294 PASS/24 FAIL per profile. The
205 manual, 15 R1, seven unchanged review, 39 additive, three future-cadence
and three independent temporal cases retain their separate identities; no
original assertion or failure is waived. Targeted TypeScript retains TS2345,
exit2 and diagnostic SHA256
ac952c2f2df29ca7dab8175fd7786fcba3a1ef5113d0a6b133bf25735499a3fa.
No green full suite/build, baseline promotion or production acceptance is claimed.

Scanner/runner/startup orchestration, termination producer, timers, pruning,
watermark rebuild, alerts/notices/publication/history, real host/commands,
Octo-to-AppServer-to-reply, UI/device/Linux/live/product acceptance remain pending.
All existing remote Git/PR/push/merge/deploy/release/live/configuration/credential
and security/provenance/takeover holds remain. Ambient UNAVAILABLE/later-copy
diagnostic, no concrete exposure evidenced and zero exposure unestablished,
remain the inherited qualifications.
