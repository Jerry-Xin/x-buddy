# Test foundation (DEV-01a)

Reusable, deterministic test seams and fixtures for x-buddy. Everything here is test-only: nothing is exported from the package entry, nothing is packed (`files` lists only `dist`), and no product runtime, egress scanner, or production behavior is implemented.

Authority: the accepted R8 architecture record (XIN-2050 comment `709cfb70`, plus AMEND-R8-01), DEV-01 items 1–8 and 10 (XIN-2098). This lane is tracked as XIN-2504. The egress scanner (item 9) is out of scope and stays with XIN-2157.

## Ownership

| Path | Owner |
| --- | --- |
| `test/foundation/**`, `docs/test-foundation/**` | foundation lane |
| `package.json`, `package-lock.json`, `.github/workflows/**` | foundation lane is the only writer for this batch; other lanes request changes |
| `src/**`, `test/host/**`, `test/app-server/**`, `scripts/check-*.mjs`, `eslint.config.mjs` | not touched |

`npm run check:foundation-scope -- <base>` fails if a foundation change touches any other path.

## Contents

| Module | Purpose | R8 |
| --- | --- | --- |
| `lib/clock.mjs` | `FakeClock`: `now`, `monotonicNow`, `setTimeout`, `clearTimeout`, plus `advance`, `runNext`, `runAll` (bounded), `jumpWall` | §10.4 |
| `lib/fault-plan.mjs` | `FaultPlan` with the closed set of §10.4 points, `forceStatus(endpoint, code, count)`, ordered hit log, `assertExhausted()`; `NO_FAULTS` default | §10.4 |
| `lib/wukong-codec.mjs` | WuKongIM packet codec, 4-byte varint cap, 1 MiB assembler cap, X25519 / MD5-derived AES-128-CBC session crypto (`node:crypto` only) | §3.1, P1/P2, T1–T7 |
| `lib/ws-server.mjs` | Minimal RFC 6455 server on `node:http` upgrade (no WebSocket dependency) | — |
| `lib/fake-octo.mjs` | `FakeOctoServer`: REST `/v1/bot/*` and WS on one loopback port; Bearer check, 404/401/413 fail-closed, bare int64 `message_id`, recorded log, encrypted RECV push, redelivery, kick, abort, CONNACK overrides | §10.1 layer 2 |
| `lib/reference-client.mjs` | Independent minimal WuKongIM client (built-in WebSocket) for harness tests and as a later oracle | — |
| `lib/fake-app-server.mjs`, `bin/fake-app-server.mjs` | Scripted App Server JSONL peer, in process or as a subprocess; init gating, typed server request ids from 0, interrupt, injected clock, runtime faults (subprocess: `faults` array in the scenario file), per-line 8 MiB cap, duplicate client id detection | §3.3, §6.3 |
| `lib/mock-responses.mjs` | Scripted `POST /v1/responses` SSE server; records an Authorization digest, never the value | §10.4 |
| `goldens/` | `wire.v1.json` + deterministic generator + `manifest.json` (SHA-256 pins, pending generators) | §10.3 |
| `parity/` | `parity-matrix.json` (266 rows) seeded from R8 by `extract-r8.mjs`; immutable `parity-seed.v1.json` (`seed.mjs`); `validate-parity-matrix.mjs` | §4 SF-5, §10.2 |
| `tools/check-goldens.mjs`, `tools/check-scope.mjs` | Golden provenance check; path-ownership guard | §10.1, §10.3 |

### Fake App Server fixture contracts

These are choices made for client tests. They are not pinned 0.142.3 behavior.

- **Line cap.** Every line is capped at 8 MiB, newline excluded, whether it arrives complete or in pieces. An oversize line is dropped up to its newline, without a reply, and recorded as the anomaly `line-too-long` (`complete` says whether its newline had arrived when the cap was hit). Reading resumes with the next line.
- **Duplicate client ids.** A client request id that was already used in the process is recorded as the anomaly `duplicate-request-id` (with `firstSeq`), compared by type and value. By default the request is still served. `scenario.duplicateRequestIds: "reject"` answers it with `-32600 "Duplicate request id: <id>"` instead.
- **Exit.** Output already sent stays sent. In-flight turns are abandoned without `turn/completed`, and pending server requests are dropped. The `exit` log record lists `abandonedTurns` and `pendingServerRequests`.
- **Subprocess termination.** Every line written before termination is flushed first. Stdin EOF exits 0. `runtime.killChild` makes the process kill itself with SIGKILL, so the parent sees signal `SIGKILL`. SIGTERM exits 143. Faults come from a `faults` array in the scenario file (`[{"point":"runtime.killChild","action":"kill","skip":1}]`); only the four `runtime.*` points the fake consults are accepted, anything else exits 2. Armed faults that never fired are reported on stderr as `fake-app-server: FaultPlan has unconsumed faults: …`.

Fakes model wire shapes only. They are not evidence of live Octo behavior or of the pinned App Server 0.142.3; class-G facts (SB-1..SB-14, SP-T1) are proven only by the real-binary job.

## Commands

```sh
npm run test:foundation      # all foundation suites
npm run test:goldens         # regenerate-and-compare, digests, source pins
npm run test:parity-matrix   # completeness and claim checks
node test/foundation/parity/validate-parity-matrix.mjs --gate   # milestone gate: fails until every lock row has passed
npm run check:foundation-scope -- <base-commit>
```

`npm test` and `npm run check` include the foundation suites. CI adds a separate `parity-matrix` job and a `workflow_dispatch` trigger.

## Parity matrix rules

- Rows: 155 capability ids (T1–T26, R1–R8, EP-01–EP-28, I1–I36, S1–S17, C1–C16, O1–O24), 59 cron ids (CR-1.1–CR-8.5), K-01–K-17, KA-1–KA-7, BX-1–BX-12 and invariants INV-P1–P10 and INV-C1–C6. The source R8 calls the compatibility invariants C1–C6; they are prefixed `INV-` here so they do not collide with capability rows C1–C16.
- A missing, duplicate or unexpected id fails validation, so no capability can be dropped silently.
- The R8 fields of every row (id, family, label, disposition codes, stage, `lockRequired`, `inheritsFrom`, the R8 OD references and the expansion members) must equal `parity-seed.v1.json`. The seed's SHA-256 is pinned in the validator, and `source` must equal the pinned R8 record. The lock set is exactly the 58 seeded rows, so setting `lockRequired: false` cannot take a row out of `--gate`. Rows may add OD references but not remove R8 ones. Regenerate the seed with `extract-r8.mjs <r8.md> --write-seed` and update the pinned digest in the same change.
- A row may claim `partial`/`implemented`, `passed` or `failed` only with `path#case` test references. The path must be a `test/**` `*.test.*` file, and the case must be declared there by exact title (`test('<case>'`, `it(`, `describe(`, `suite(`); a substring match is not enough.
- `passed` needs evidence entries of the form `{"kind": "node-test-tap", "path": "<repo-relative>", "sha256": "<hex>"}`. The file bytes must match the digest, and the TAP output must report every cited case as `ok`, not `# SKIP`/`# TODO`, and never `not ok`. This makes a claim consistent with committed files; it does not prove the run was honest, so reviewers still read the evidence.
- `not-applicable` needs an OD reference, and every `odRefs` entry must be an `OD-<n>` id.
- Bundled endpoint rows and O24 keep `expansion.status = "pending"` until their method/action rows are added (EP-03/04/12/15–18/20/22/23/26/27; O24 per AMEND-R8-01 PM-05). `pending` is the only expansion status in schema v1. A bundle cannot be marked implemented or passed while its expansion is pending.
- Every row starts as `missing` / `not-run`. The seed digest is pinned; after seeding, DEV changes update rows in place and the extractor refuses to overwrite a diverged matrix.
- R8 names the file `test/parity-matrix.json`; it lives under `test/foundation/parity/` to stay inside this lane's owned paths.

## Readiness against DEV-01 items

| Item | State in this batch | Next step / dependency |
| --- | --- | --- |
| 1. Real-binary job SB-1..14 + SP-T1 | Not started. The fake App Server and mock Responses server it needs are ready | Needs the pinned 0.142.3 binary as a dependency (lockfile change, this lane) and a Linux runner; real API key only for SR, not SB |
| 2. Fake Octo WS/REST, mock Responses / App Server | Implemented and tested | Action-level REST routes are added as each EP expansion lands |
| 3. `Clock` and `FaultPlan` seams | Test-side implementations and the structural contract are done | Product constructors adopt them in their own lanes (`src/**` is not touched here) |
| 4. Wire/AES/framing goldens | `wire.v1` committed with public known-answer vectors and negative vectors | Lock tests against product code once DEV-00 imports `src/octo/socket.ts` |
| 5. Pinned golden generators (B `2e710e9`, OC `f6065d6`) | Not implemented; listed as `pending` in the manifest | B: needs an approved way to execute B sources without importing them. OC: needs `croner@10.0.1` as a dev dependency |
| 6. Parity matrix + CI validator | Implemented; CI job added | Action-level expansion rows; owners for CR rows (stage not recorded in R8 §5 tables) |
| 7. Invariant locks | Not started; rows are marked `lockRequired` | Needs the imported host code (DEV-00) to lock against |
| 8. Downgrade-open harness | Not started | Needs the `dd12980` build and `better-sqlite3` (DEV-00 import and a dependency decision) |
| 10. CI triggers and baseline governance | `workflow_dispatch` added; push and pull_request already ran on all branches; separate `parity-matrix` job | `real-binary`, `downgrade-open` and `egress-bypass-scan` jobs arrive with items 1, 8 and 9 |

## Provenance

No bytes are copied from other repositories. `source-pins.json` records the specification sources, with commit and git blob ids, that the newly authored code follows. The crypto primitives were cross-checked out of tree against the reference libraries used by the `dd12980` client (`curve25519-js` 0.0.4, `crypto-js` 4.2.0, `md5-typescript` 1.0.5), and the fake server was exercised by the `dd12980` `WKSocket` client (transpiled from TypeScript with no source edits) over the `ws` package. Those checks are recorded in the tracking issue, not in this tree.
