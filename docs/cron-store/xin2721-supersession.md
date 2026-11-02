# Atomic queued-retry supersession

XIN-2721 implements the existing R8 §§3.4.4–3.4.5 and OD-39 rule in the local store. When `admitBase` validates a newly due natural recurring occurrence, it can retire the same-owner, same-generation queued retry and reserve the new canonical attempt 0 in its single ownership-fenced `BEGIN IMMEDIATE` transaction.

The branch validates retained attempt 0 and every predecessor, current definition/policy, effective slot, activation, watermark, clean queued lifecycle and owner/reset identity. Its exact-row CAS records `skipped/retry-superseded`, with no start, completion, delivery or error. It uses the common neutral terminal projection, then inserts the new queued base under the unchanged unique active index. Precommit checks cover authority/ownership, job, both receipts, the complete retained chain and single-flight. A CAS, insertion, projection, provenance or ownership failure rolls everything back.

The retry does not advance the watermark or change error/target/skipped counters. Its informational outcome uses the existing newer-only rule. Neutral cadence and the new reservation retain the later effective cadence. Only the new base's later valid terminal consumption commits its watermark. Supersession never executes a run, creates a permit or retry, sends a message, publishes history, disables/deletes a job, prunes provenance, or resets a start/deadline.

| Condition | Result |
| --- | --- |
| Valid duplicate base reservation/outcome | Existing admission validators and stored result, before new eligibility; no repeated effects |
| New due recurring slot and validated owned queued retry | Neutral retry retirement and queued base reservation, atomically |
| Foreign owner/reset or stale-generation queued retry | Existing `queued-retry-supersession` no-write deferral; recovery remains separate |
| Running retry/manual or another active recurring receipt | Existing direct-terminal recurring overlap; active receipt unchanged |
| One-shot / borrowed one-shot boundary | Existing duplicate, eligibility rejection or one-shot busy deferral; no new authored consumption |
| Corrupt retained chain or queued provenance | Integrity error/quarantine before CAS |
| Unsupported outcome/publication facts, exhausted cadence | Typed no-write deferral before CAS |
| Lost ownership/authority, failed CAS/insertion/precommit | No committed changes |

Developer self-tests pass on Node 22.23.2/ABI127 and 24.22.0/ABI137 with offline better-sqlite3 12.11.1 / SQLite 3.53.2: 85 new cases plus 2,214 unchanged inherited cases per runtime. The packet records the initial 34-case parent RED run, intermediate failures and their fixes. No inherited assertion, probe, schema/index, dependency, lock, CI, host or package script changed. The existing targeted TypeScript 5.9.3 TS2345 failure remains disclosed; this is not a green full build or full suite.

New cases include an unseeded public base reservation/start/failure/queued-retry/supersession/new-base start/finalization chain, exact due boundaries, stagger and DST controls, duplicate lower/higher callbacks, owner/authority/provenance negatives, two SQLite connections, rollback faults and ten actual exit/SIGKILL/WAL reopen cases. All twelve inherited admission and eight finalization crash cases remain. SQL and complete job/run snapshots are retained. NULL watermark with an existing retry is deliberately invalid: a valid retry requires its base consumption watermark.

Retry 1 uses fully unseeded local receipt transitions. Retry 2/3 controls observe the mandatory alert deferral first, then explicitly seed only aggregate error counts to exercise the higher-attempt representation; they never seed a running receipt or bypass a product gate. Constructor issuer registration, borrowed/manual/replacement and publication fixtures remain labeled models/representations, not production authority or real sending.

The offline packet's `reproduce.py --work <new-owned-directory>` verifies the source/bundle/patch and immutable input manifests, prepares only the supplied offline prerequisites, and reruns the inherited and new cases using credential-free child allowlists and owned HOME/DB paths. It retains commands, runtime/native/source/probe hashes, case ledgers, SQL snapshots, crash receipts, failures and cleanup results.

Production issuer freshness/reset/creator-target/permit/lane authority, host/scheduler/executor wiring, manual writers, startup/recovery/pruning, alert/disable-notice/publication/history effects and real Octo → App Server → reply remain pending. Default execution construction still defers without a trusted issuer; no trust or deadline policy was added. Full DEV09–11, REPLAY/BOUNDARY/OP, UI/device/deployment/live and product acceptance remain pending. This local increment requires independent formal review and testing routed by PjM; it grants no approval or dispatch authority.
