# Additive fixture reconciliation (XIN-2729)

Parent: `cdf152f934f6ed25e46e5d621f1ceb877cce2cf0`, tree
`1aa0f8ec4f002798aa64a55b85c3334f892b4cc6`. Production source is unchanged.
All inherited files and probes remain byte-identical. The original selection
continues to report 2,294 PASS / 24 FAIL out of 2,318 per runtime. These failures
retain their historical success expectations; additive results do not replace
or waive them.

The new `test/cron-store/fixture-reconciliation.mjs` has 39 separate cases:
24 valid equivalents, eight explicit none-ownership integrity controls, one
additional auth readiness isolation control, and six strictly-newer information
checks (success/neutral × prior time below/equal/above completion).
All none controls require StoreIntegrityError, full jobs/runs snapshot equality,
zero observed SQL DML, unchanged total_changes and a collected transaction.

Valid equivalents reserve through public admitManual and use issuer-bound
startManual when running is needed. They verify a complete expected run, all
authored job fields unchanged, informational projection, a single run/no retry,
and a changed-outcome duplicate with full snapshots and zero DML. The queued
neutral equivalents preserve null start and terminal replay at T+1. The failure
equivalents preserve date crossing, all reasons, paused variants and phase.

The explicit preconditions remain local models: paused at definitions retain
next_run_at=S via a test-only stored-state update before admission; counters and
alert fields are seeded. Public start creates the running receipt; session-busy
and target-unavailable then model downstream admission/delivering phase only.
No public phase-transition or production issuer/disable workflow is claimed.
The original schedules/counter parameters/times are preserved where material:
terminal recurring every60s, queued/start at natural slot, finish +1500ms; QA-04
every90s anchored T-45s, queued S-5s/start S-4s/finish S+2300ms; failure and
reviewer32 queued/start T, finish S+1000ms; reviewer47 queued T/finish T+1.
Public recurring borrowers retain the authored reference supplied by the public
writer (historical none fixtures used null); corrupt none controls retain the
historical null reference. Fixture owner/run/invocation identities are local
modeled identities, not production grants.

Reviewer32 auth has two defects. Its none+readiness control preserves both; a
separate borrow+bad-readiness control proves fixing ownership alone still
rejects. The valid auth equivalent corrects both. No manual-none success bypass
is introduced.

The evidence packet JSON mapping retains every original row/input/outcome/rejection
and binds the exact new title. T=1793275200000, S=T+60000 for at scenarios.

| # | Original source and case/parameter | Additive valid title | Integrity control |
| --- | --- | --- | --- |
| 1 | probes/vendor/independent2681/tester/probes.test.mjs:98 — QA-04 none-owned immediate recurring completion cannot mutate authored policy; {'kind': 'success', 'deliveryState': 'not-requested'} | RECON QA-04 success / valid | RECON QA-04 success / none integrity |
| 2 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none rate_limited preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'rate_limited'} | RECON reviewer32 rate_limited / valid | Original rejection retained; valid readiness equivalent |
| 3 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none overloaded preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'overloaded'} | RECON reviewer32 overloaded / valid | Original rejection retained; valid readiness equivalent |
| 4 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none network preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'network'} | RECON reviewer32 network / valid | Original rejection retained; valid readiness equivalent |
| 5 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none runtime_unavailable preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'runtime_unavailable'} | RECON reviewer32 runtime_unavailable / valid | Original rejection retained; valid readiness equivalent |
| 6 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none quarantined preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'quarantined'} | RECON reviewer32 quarantined / valid | Original rejection retained; valid readiness equivalent |
| 7 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none timeout preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'timeout'} | RECON reviewer32 timeout / valid | Original rejection retained; valid readiness equivalent |
| 8 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none model_error preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'model_error'} | RECON reviewer32 model_error / valid | Original rejection retained; valid readiness equivalent |
| 9 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none auth preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'auth'} | RECON reviewer32 auth / valid | RECON reviewer32 auth / none and readiness integrity |
| 10 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none invalid-definition preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'invalid-definition'} | RECON reviewer32 invalid-definition / valid | Original rejection retained; valid readiness equivalent |
| 11 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none session-busy preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'session-busy'} | RECON reviewer32 session-busy / valid | Original rejection retained; valid readiness equivalent |
| 12 | probes/vendor/reviewer32/probes.test.mjs:45 — borrow/none target-unavailable preserves authored fields after due crossing; {'kind': 'failure', 'reason': 'target-unavailable'} | RECON reviewer32 target-unavailable / valid | Original rejection retained; valid readiness equivalent |
| 13 | probes/vendor/reviewer47/probes.test.mjs:56 — future borrowed none queued stopped has valid null-start replay; {'kind': 'neutral', 'reason': 'stopped'} | RECON reviewer47 stopped / valid | RECON reviewer47 stopped / none integrity |
| 14 | probes/vendor/reviewer47/probes.test.mjs:56 — future borrowed none queued reset has valid null-start replay; {'kind': 'neutral', 'reason': 'reset'} | RECON reviewer47 reset / valid | RECON reviewer47 reset / none integrity |
| 15 | probes/vendor/reviewer47/probes.test.mjs:56 — future borrowed none queued reload has valid null-start replay; {'kind': 'neutral', 'reason': 'reload'} | RECON reviewer47 reload / valid | RECON reviewer47 reload / none integrity |
| 16 | probes/vendor/reviewer47/probes.test.mjs:56 — future borrowed none queued shutdown has valid null-start replay; {'kind': 'neutral', 'reason': 'shutdown'} | RECON reviewer47 shutdown / valid | RECON reviewer47 shutdown / none integrity |
| 17 | test/cron-store/failure.test.mjs:161 — borrowed future at crossing due paused=false/network preserves authored definition; {'kind': 'failure', 'reason': 'network', 'redactedError': 'redacted fixture'} | RECON failure paused=false/network / valid | Original rejection retained; valid readiness equivalent |
| 18 | test/cron-store/failure.test.mjs:161 — borrowed future at crossing due paused=false/auth preserves authored definition; {'kind': 'failure', 'reason': 'auth', 'redactedError': 'redacted fixture'} | RECON failure paused=false/auth / valid | Original rejection retained; valid readiness equivalent |
| 19 | test/cron-store/failure.test.mjs:161 — borrowed future at crossing due paused=false/target-unavailable preserves authored definition; {'kind': 'failure', 'reason': 'target-unavailable', 'redactedError': 'redacted fixture'} | RECON failure paused=false/target-unavailable / valid | Original rejection retained; valid readiness equivalent |
| 20 | test/cron-store/failure.test.mjs:161 — borrowed future at crossing due paused=true/network preserves authored definition; {'kind': 'failure', 'reason': 'network', 'redactedError': 'redacted fixture'} | RECON failure paused=true/network / valid | Original rejection retained; valid readiness equivalent |
| 21 | test/cron-store/failure.test.mjs:161 — borrowed future at crossing due paused=true/auth preserves authored definition; {'kind': 'failure', 'reason': 'auth', 'redactedError': 'redacted fixture'} | RECON failure paused=true/auth / valid | Original rejection retained; valid readiness equivalent |
| 22 | test/cron-store/failure.test.mjs:161 — borrowed future at crossing due paused=true/target-unavailable preserves authored definition; {'kind': 'failure', 'reason': 'target-unavailable', 'redactedError': 'redacted fixture'} | RECON failure paused=true/target-unavailable / valid | Original rejection retained; valid readiness equivalent |
| 23 | test/cron-store/terminal.test.mjs:112 — none completion updates only own receipt/newer information; {'kind': 'success', 'deliveryState': 'not-requested'} | RECON terminal success / valid | RECON terminal success / none integrity |
| 24 | test/cron-store/terminal.test.mjs:112 — none completion updates only own receipt/newer information; {'kind': 'neutral', 'reason': 'shutdown'} | RECON terminal neutral / valid | RECON terminal neutral / none integrity |

The inherited 205 manual, 15 R1 and seven reviewer cases remain distinct
selections. Both pinned Node22.23.2/ABI127 and24.22.0/ABI137, SQLite3.53.2 with
better-sqlite3 12.11.1, and fresh outer-archive replay are required. Crash/fence/
contention/single-flight checks remain in their original selections.
The evidence report records actual results and all initial expectation mistakes.
Inherited TS2345/exit2 is retained; no green full build/full suite is claimed.

Production authority/issuer integration, actual commands/host/scheduler/executor/
wake, startup child termination/recovery/pruning and actual mandatory effects
remain pending. Ambient scope remains UNAVAILABLE/later-copy diagnostic; no
concrete exposure is evidenced and zero exposure is not established. No model,
provider, login, outbound send, installation or ambient credential inspection
is part of these checks. Independent review and product/human acceptance remain
separate gates; no deployment or baseline promotion is implied.
