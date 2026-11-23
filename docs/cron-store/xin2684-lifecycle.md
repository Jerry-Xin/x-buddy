# XIN-2684 correction: retained predecessor lifecycle evidence

This correction is based on reviewed head
`e10a19a07534c31e51f25b219ab22481f95b62fe`, tree
`74d99eaaa57719be122ce317e6950fe0c8268fe1`. It addresses the P2 finding in
XIN-2685 comment `d67b4679-b724-4022-9d0f-531acbe624d3` without changing the
bounded failure/notice/admission contract described in xin2684.md.

## Finding and corrected predicates

A terminal executed-error predecessor with `started_at=NULL` passed the
shared provenance validator because its start requirement applied only to
running receipts. The retry-chain validator checked status/reason,
completion, publication and end/successor timing, but did not require start
evidence for the terminal error. A retry success could therefore reset
counters and retire a one-shot using corrupt retained evidence. The
watermark remained S; this was an invalid-evidence authorization defect.

The shared terminal provenance check now requires:

- Every terminal receipt has an end timestamp and phase=NULL.
- Terminal executed states ok/error/interrupted retain a start timestamp.
- Existing finite timestamp and queue<=start<=end checks still apply.
- Skipped receipts may have no start. Queued neutral skips, direct recurring
  overlaps and valid skipped-admission predecessors retain that distinction.

Retry-chain authorization also explicitly requires a start for an error
predecessor paired with a transient reason. The alternative valid predecessor
is skipped/session-busy; that pair may have no start. Every started chain
member, including attempt0, must start at or after ready_at. Every terminal
predecessor must end at or after ready_at, including a skip that never
started. Successor queue/ready timing still derives from the predecessor's
end and the exact existing Q/busy ladder. Base and intermediate members use
the same rules. All checks run before terminal CAS or other DML and failures
surface as StoreIntegrityError with the existing quarantine message.

## Analogous-path audit

`finalize` validates current receipt provenance before returning a stored
terminal result, and validates every retained member before planning retry
effects. Sharing the executed-terminal check protects both paths, including
terminal duplicate callbacks. Existing running receipts already required a
start; the chain ready-time check continues to protect active retries and now
also covers the base member.

Direct overlap uses its separate strict no-start/terminal-skip validator and
the unchanged common projection. Queued neutral finalization creates a valid
no-start skipped result. Neither path should acquire an executed-start
requirement. `admitBase`'s existing-receipt lookup validates consume identity
and W and returns stored data without a new execution grant or authored
writes; it is not the retry permission path. `admitRetry` remains an explicit
no-write unsupported API. No admission, ownership, schema, host or publication
redesign is included.

## Reproduction and validation

The unchanged32 reviewer probes were independently reproduced against the
input on actual Node22.23.2/ABI127 and24.22.0/ABI137:31 pass/1 fail each. The
original case retains its title and assertion. Its new baseline before/after
traces record three DML statements, errors1->0, enabled1->0 and deleted_at
set with W unchanged. Those are retained failures, not fixture corrections.

After the fix the same32 probes pass on each runtime. The827 supplied cases
are unchanged. A new222-case matrix covers base/intermediate predecessors,
all six transient reasons, missing/early/late/fractional/text start evidence,
missing/early end evidence, terminal live phases, incompatible reason/status
or completion, and exact ready/end boundaries. Each corrupt case asserts
StoreIntegrityError, zero DML and identical receipt/job snapshots. Valid
executed boundary controls, skipped admissions with/without start (including
end==ready), and queued neutral replay controls prevent an overbroad fix.
Terminal duplicate checks cover ok/error/interrupted lifecycle corruption.

The resulting bounded behavioral total is827+32+222=1081 per runtime. Actual
commands, source maps, trace files, repeats and failures are in the packet's
attempt ledger. Exact offline better-sqlite3 12.11.1 / SQLite3.53.2 and native
ABI hashes remain pinned. The inherited TS2345 typecheck remains red with
identical parent/fix output. No full-build/full-suite claim is made.

The previous70 author attempts,28 reviewer behavioral/typecheck attempts,
four reviewer native checks/extraction failure and earlier XIN-2681
conditional qualifications remain in immutable input archives. Full failure
alerts/disable notices, higher backoff effects, retry execution admission,
publication/ContextNotes, manual/startup/pruning, scheduler/host/live and full
REPLAY/BOUNDARY/OP remain pending. Mandatory unavailable outcomes still defer
before DML. Store SQL traps and seeded runtime preconditions are not an
external model/egress oracle. Independent re-review and later testing remain
separate gates assigned by PjM.
