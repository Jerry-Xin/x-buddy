# DEV09 pure schedule increment (XIN-2637)

This local increment adds deterministic product functions under
`src/cron/schedule` and targeted tests under `test/cron-schedule`. The accepted
input is commit `1811e091830b84a4a13905d92cb8cd5c5a00ed21`, tree
`7211dcde4938d8460f5b689ee28fdd7e9987c811`, recovered from XIN-2573's
registered source bundles. Its registered delivery archive SHA256 is
`9610b01312d45b4fef11dc27b00f643c370b8016a7572df3ba149c52db70a73b`.
A complete input bundle was backed up before edits. No shared checkout changed.

## Contract and API

Authority: accepted XIN-2050 R8 comment
`709cfb70-e0aa-49e2-8163-d4a4142abc1e`, sections 3.4.5–8, DEV-09 in
section 9, and the M2 selections in section 10.9. XIN-2042 comment
`f7227392-0d5d-4b9f-a94b-b74cc55443ab` supplies source background; R8
overrides its withdrawn gap-to-transition wording.

`engine.ts` provides integer-millisecond validation, explicit timezone validation,
one-shot grace/cap validation, ISO instants with offsets, UTC offsetless ISO input,
explicit every anchors, strict `next`, inclusive `previousOrBefore`, activation
and watermark eligibility, and canonical JSON `[jobId,generation,effectiveSlotMs]`
identities. `next` returning undefined for an overdue at does not consume it:
`dueAt` continues returning its authored instant until fenced by the supplied
watermark. Dates before the epoch and non-integer/invalid numbers are rejected.
The ten-year cap uses the pinned 365.25-day year, with inclusive boundaries.

Timezone input is mandatory where parsing is involved; it never falls back to
the host timezone. Explicit offsets identify the instant independently of zone.
Offsetless input in a non-UTC zone fails explicitly pending the approved adapter;
it is never silently interpreted as UTC or host-local time. Callers may supply an
already normalized `atMs`; confirmation formatting and command parsing are deferred.

Stagger default detection and effective cursor arithmetic are adapted from the
pinned OpenClaw helpers, with MIT license/notices retained next to the source.
Definition widths are integer 0..300000; exact resolves to zero; at/every reject
positive widths. Default detection is not expression validation. The copied
default-detection corpus comes from pinned `stagger.test.ts`. Explicit config
coercion from that source is intentionally replaced with R8's stricter definition
validation. The job ID hash uses only the first big-endian uint32: j7f3k2q with
width 300000 yields 253353 ms.

`effectiveNext` and `effectivePreviousOrBefore` take a strict raw lookup as an
explicit parameter. They implement only the bounded cursor/offset arithmetic;
production must inject the pinned DST-normalized lookup. The tests use R8's
specified UTC arithmetic vector and finite synthetic base slots. These are not
generated OpenClaw cron/DST fixtures. No cron parser or production adapter is
provided or implied.

`decisions.ts` returns policy intentions. Inputs include explicit clock,
generation, stored ownership, counters and precomputed effective natural next
slot. Outcomes of borrowed/stale work return `unchanged`. Due checks distinguish
recurring overlap from the one-shot borrower boundary. Outcome decisions keep
retry readiness separate from natural recurrence; an equal/later retry is
exhausted. Catch-up accepts one latest candidate and a zero-based overflow ordinal.
No input is mutated and no store, timer, model, transport or filesystem effect occurs.

These functions do not prove authority, receipt uniqueness, atomicity, canonical
provenance or ownership CAS. A future store must re-read and fence those conditions
transactionally before applying any intention. The outcome helper does not advance
watermarks; durable terminal projection remains separate.

## R8 section 3.4.5 disposition

Every entry below describes pure coverage only. No row's storage/execution effects
are implemented by this increment.

| Rows | Fulfilled pure portion | Deferred integration |
| --- | --- | --- |
| 1–2 | Due eligibility, admit/duplicate intention | Unique receipt and atomic admission; cadence update |
| 3 | Recurring overlap intention; one-shot boundary returns defer-at | Direct-terminal INSERT, fenced projection, max watermark/next and exactly-once skip counter |
| 4 | Recurring success natural-next intention and error/skip resets | Terminal CAS, watermark and publication |
| 5–7 | Three retry delays, session-busy delays, strict next-slot priority, capped backoff | Receipt provenance, persisted retry chain and timer wake selection |
| 8 | Disable intention on tenth execution error | Persisted disable and alerts |
| 9 | Delivery-only natural cadence; permanent target-failure threshold | Delivery completion/publication and one-shot command/repair handling |
| 10 | Successful consume at chooses delete or disabled keep | Watermark-before-delete atomic transaction |
| 11–12 | Consume-at transient retries; terminal disable on permanent/exhaustion | Retry receipts and owned finalization |
| 13–14 | One latest catch-up candidate, activation/watermark fences, five immediate, +5s overflow, explicit agent defer; at ignores skip flag | Startup enumeration/order, admission, store projection and timer |
| 15 | Consume interruption yields recurring backoff/at disable; borrow unchanged | Incarnation repair, delivery unknown classification, ownership fencing |
| 16 | No implementation claimed | Persisted queued retry provenance and same-chain gate bypass |
| 17 | Supplied current-generation watermark rejects repeated/backward-clock slots | Durable terminal projection and actual receipt retention/pruning |
| 18 | Same single-candidate catch-up decision can be used after a forward jump | Clock-jump detection and scheduler invocation |
| 19 | Stale-generation outcome leaves authored schedule unchanged | Actual edit/finalizer CAS race |
| 20–21 | No implementation claimed | Enable mutation/counter reset and manual command admission |

The schedule-error helper returns a disable intention at three failures. Bounded
timer retry, authority validation, reminder delivery, tombstone recovery and
generation-fenced store repair remain deferred.

## Targeted validation

Use the existing pinned Node 22.23.2 or 24.22.0 executable with its built-in
`node:test` runner and native type stripping. No packages are installed and no
new runner is built. From the repository root, create an empty HOME outside the
repository, then run (replace NODE and EMPTY_HOME with explicit local paths):

```sh
env -i HOME="$EMPTY_HOME" PATH=/usr/bin:/bin TZ=UTC "$NODE" \
  --test --test-timeout=10000 \
  test/cron-schedule/engine.test.mjs test/cron-schedule/decisions.test.mjs
```

The delivery includes actual commands, version output, exit codes and all attempt
logs. Tests import only these pure source modules, built-in modules and the local
normalization corpus. They never import the package entrypoint or host. A separate
non-UTC process timezone checks independence from local timezone defaults.
Authored test results are not independent acceptance.

## Pending obligations and retained gates

- Exact integration dependency: `croner@10.0.1`, plus the pinned OpenClaw
  `computeNextRunAtMs` / `computePreviousRunAtMs` helpers and their timezone
  transition normalization, validated-next and year-rollback helpers. That package
  is absent from the accepted package/lock and is not installed here. Non-UTC
  offsetless at conversion also awaits an approved integration adapter.
- Full cron expression validation/matching, OR/+ semantics, skipped spring gaps,
  first fall overlap, year-limited expressions and generated London/NY/Shanghai
  next/previous fixtures/checksums remain pending. DST+offset STAG-07 and generated
  STAG-01..08 conformance are not claimed. Only default normalization and the
  explicit R8 arithmetic vector are covered here.
- New tests are not selected in existing suite pins, package scripts or the sole
  milestone manifest. Their later reviewed integration is mandatory. There is no
  global-green, full DEV09, CR closure, M2, MAN/REPLAY/BOUNDARY/OP acceptance claim.
- No installed pinned TypeScript toolchain is present in this isolated recovery;
  no typecheck/build result is claimed. Native execution validates the targeted
  modules only. No full host suite or SDK/AppServer/Octo activation is run.
- DEV02 persistence/migrations, DEV04/06/08 executor/delivery/status dependencies,
  independent review/testing, runner review and latest full-suite blockers,
  blocked XIN-2157, scanner/provenance, takeover, live and unlocked-smoke holds
  remain. The prior accepted-base evidence is historical, not rerun here.
- No package, lock, CI, import manifest, DB, host, runtime or egress changes. No
  push, PR, mainline merge, deployment, release, live activation, credentials,
  account/config changes or downstream dispatch. Delivery remains local and
  awaits coordinating review; it is not self-completed.
