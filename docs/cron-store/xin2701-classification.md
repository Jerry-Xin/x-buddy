# XIN-2701: terminal delivery classification correction

The second CHANGES_REQUESTED finding applies to parent
`1fd3d773b495080b2fd62b43d4492c1b04787e12`, tree
`6617a80c0c2496bd5849130b9e2358737d74df54`. Its earlier six-case omission is
closed; the original evidence and tests remain unchanged. This correction is
limited to the remaining confirmed-segment classification contradiction.

R8 §3.5.3 defines not-delivered as known pre-send rejection and partial/uncertain
sends as unknown. Section 3.5.4 defines segments_sent as confirmed segments.
A terminal failed/not-delivered receipt therefore requires zero confirmed
segments. The shared stored-outcome validator previously omitted that state
from its zero-segment predicate. Both execution and terminal replay could return
existing for segments_sent=1 or3. They must instead raise StoreIntegrityError
with quarantine required, before returning the inconsistent outcome. Replay
does not repair or relabel the stored facts.

The source change adds not-delivered to the **terminal** zero-segment check.
Unknown remains valid with zero, one or three confirmed segments: zero locally
confirmed segments does not establish that an ambiguous request had no effect.
Active delivering representations and active-finalizer typed no-write deferrals
remain unchanged; this does not implement an egress producer or publication.

## Bounded terminal representation matrix

| Status / completion | Delivery | History | Confirmed segments |
| --- | --- | --- | --- |
| ok / succeeded, announce | suppressed | skipped_suppressed | 0 |
| ok / succeeded, none | not-requested | skipped_not_requested | 0 |
| ok / succeeded | delivered | published, skipped_reset or skipped_session_mode | positive |
| ok / failed | not-delivered | skipped_not_delivered | **0** |
| ok / unknown | unknown | skipped_not_delivered | 0 or positive |
| error / failed | not-requested or suppressed | corresponding skipped history | 0 |
| skipped or neutral interrupted / NULL | not-requested or suppressed | corresponding skipped history | 0 |
| interrupted / unknown, restart | unknown | skipped_not_delivered | 0 or positive |

The new finite table test covers all4 terminal status families ×4 completion
values ×7 delivery states ×8 history states ×3 segment counts (0,1,3), at both
execution and terminal replay for base and retry: **10,752 observed cells in448
test groups per runtime**. Its explicit allowed-disposition table is separate
from implementation predicates. Every cell records complete before/after
job/run snapshots and SQL DML trace, checks zero DML, transaction closure and
either a frozen existing receipt or StoreIntegrityError/quarantine. There are80
valid representation cells and10,672 invalid cells. These cells are internal
assertions, not10,752 additional test cases.

Every group begins with real public reservation/start and supported success.
Retries first use public base network-failure finalization, queued successor and
actual retry admission. Only the subsequent terminal representation is seeded;
its classification does not prove actual delivery/history/restart production or
recompute job effects. Immutable identity, chain, timing and original requests
remain intact. Unsupported policy is not inferred from absent production data.
The unchanged supplied controls additionally retain none/suppression, neutral,
queued skips, nullable-start session-busy, active duplicates and overlap coverage.

## Reproduction and acceptance boundary

The exact unchanged new reviewer file has34 cases. On both pinned runtimes the
parent has26 PASS/8 FAIL and the correction has34 PASS. Selecting the same eight
segments1/3 cases gives0/8 →8/8; the selection is a subset of34. The original
19-case file retains SHA256
`a3f31ee2e8ef019601d76d769ccecab0170e49ecfa8f150942283cd11f129189`;
its selected six and all19 remain passing. No prior assertion/title is changed.

Each actual Node22.23.2/ABI127 and24.22.0/ABI137 passes1668 unchanged supplied
+34 unchanged new reviewer+448 new groups = **2150 tests**, independently
repeated from fresh offline extraction. Better-sqlite3 12.11.1 / SQLite3.53.2
and their native SHA256 pins are verified. The12 admission and8 prior
failure-finalization actual exit/SIGKILL/WAL cases, unseeded chains, one-shot
keep/delete, owner entry/precommit loss, contention, idempotency, default issuer
deferral and mandatory notice gates remain covered by unchanged tests.

Current behavioral/typecheck children have explicit credential-free environment
allowlists and owned HOME/DB directories; all connections/children are collected
and empty test directories removed. Targeted parent/head TypeScript5.9.3 retains
byte-identical inherited TS2345 exit2. There is no full-build/full-suite claim.
The full packet retains every current attempt and immutable reviewer/author
history, including earlier failures and source snapshots. The old ambient
typecheck was not replayed: its original environment/access scope is unavailable,
and its shipped diagnostic copies a later receipt. No concrete exposure is
evidenced; zero exposure is not established. No credential files/values were
inspected.

Execution replay and terminal replay already share this validator; the bounded
matrix finds no additional mismatch in these terminal classification families.
Legacy reservation replay/get/list and active unsupported finalization preserve
their approved contracts. DDL/indexes/dependencies/lock/pins/CI/host/prior tests
are unchanged. This adds no actor, authority, reset, permit, lane or deadline
policy. Trusted structural DI and freely callable modeled test registration
remain non-production authorization evidence; no production issuer/host means
default typed no-write deferral. Alerts/disable-notice/publication gates,
supersession/manual/startup/pruning/history and real scheduler/executor/live
remain pending. No push/PR/merge/deploy, downstream dispatch, self-approval or
full DEV09/REPLAY/BOUNDARY/OP acceptance is implied. PjM owns routing to the same
formal review, with independent testing only after APPROVED.
