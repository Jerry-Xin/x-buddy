# Capability provenance analyzer (DEV-01 B-2)

Implementation of the approved DEV-01 B-2 design v2 (XIN-2137 comment `6169516b-17c5-4c01-b9d5-6fd3e5490499`, approval XIN-2139 comment `494165e2-23f4-4713-81a8-bf758dd29cf2`). It is a harness-layer static scanner: no product runtime, configuration or API changes. All code and fixtures are newly authored; nothing is copied from the reference prototype.

```sh
node scripts/egress-bypass-scan.mjs --config <boundary.json> [--root <dir>] [--events] [--observations]
npm run test:egress
npm run egress:bench -- --reference <checkout> --ledger <ledger.json> [--runs 20] [--scale 10] [--out <dir>]
```

The CLI exits 0 only for outcome `ALLOW`. `DENY` means a known protected operation outside authorization; `UNKNOWN` (`complete: false`) means the analysis could not be completed and never approves.

## Modules

| Module | Responsibility (design section) |
| --- | --- |
| `scripts/egress-bypass-scan.mjs` | Synchronous `scanEgress(cfg)` facade and CLI; legacy fields `primitives`, `unclassified`, `usages`, `violations` plus `analysisVersion`, `complete`, `outcome`, `diagnostics`, `operations`, `terminals`, `stats`, `policyHash`, `digest`. |
| `scripts/egress/program.mjs` | Program construction, supported profile, canonical real paths, compiler errors, inventory omissions (Project closure). |
| `scripts/egress/policy.mjs` | TerminalId / ExportRouteId, anchor equivalence classes, conservative route policy join, display labels, baseline-to-terminal mapping (R2.1, R2.2). |
| `scripts/egress/graph.mjs` | Finite fact graph `(C,U)`, slots and wildcard slots, budgets (Graph, lattice, solver step 6). |
| `scripts/egress/type-transfer.mjs` | Declaration templates, 16 exact environments per declaration, summary widening, mapped/indexed/Pick/Omit/conditional selection (R1.1, R1.3, mapped types). |
| `scripts/egress/value-transfer.mjs` | Expression/statement transfers and policy-site discovery (Transfer rules). |
| `scripts/egress/function-transfer.mjs` | Functions, classes, call wiring, library summaries (Function flow, External functions). |
| `scripts/egress/solve.mjs` | Constraint generation / fixed-point loop, SCC condensation and closure certificates (R1.2, solver steps 1-5). |
| `scripts/egress/diagnostics.mjs` | Extraction/operation event normalization, structural addresses, typed-AST digests, legacy counts, frozen ledger (R2.3, Authorization). |
| `scripts/egress/analyzer.mjs` | Pipeline, failure handling, stable digest; mutation hooks are reachable only from this internal entry point. |
| `scripts/egress/generate-corpus.mjs` | Deterministic metamorphic generator (guarded variants and paired controls). |
| `scripts/egress/worker.mjs`, `run-worker.mjs`, `bench.mjs`, `compare-evidence.mjs` | Measured cold workers, 60 s / 1 GiB watchdog, nearest-rank p95, performance gates, cross-runtime digest comparison. |

## Semantics in brief

- **Identity.** `TerminalId = JSON.stringify(['terminal-v2', sortedAnchors])` over the alias-resolved merged value declaration group (overloads, implementation, merged namespace); anchors are `[repoRelativePath, start, end, SyntaxKind]`. `ExportRouteId = ['export-v2', boundary, exportedName]`. Policy joins over all routes of a terminal: any guarded or unclassified route makes it guarded; a guarded/permitted mix also reports `boundary-policy-alias-conflict`. Colliding labels are displayed as `path::name`; a legacy baseline row must name exactly one terminal.
- **Facts.** Each node holds the abstract objects it may denote (guarded terminals are objects) and a bitmask of uncertainty reasons. Propagation is flow-insensitive and monotone: reassignment, assertion or overwrite never erases an origin. Selections read the selected slot; wildcard element slots of arrays reach index keys only.
- **Types as evidence.** Declared parameter/variable/property types and asserted types join their definite provenance (for example `typeof api`, `Pick<typeof api, 'sendMessage'>`, a mapped rename of `typeof api`). Generic declarations are finite templates: after 16 exact environments (or nesting depth 64) every further instantiation joins one summary environment whose conditional predicates are undecidable, so both branches are kept and late sources survive. `infer` and unresolved type references attach uncertainty.
- **Certificates.** After convergence the object/slot graph is condensed into SCCs; an envelope is `(MayC, OpaqueReasons, widened)`. `Complete` requires no opacity anywhere downstream; `SourceFree` additionally requires an empty `MayC`. Shape widening alone never invalidates a complete source-free envelope.
- **Authorization.** Outside authorized egress (exact file or directory segment) and the boundary modules: every extraction is a reference event and every call/new of a guarded terminal an operation event, each normalized to `(file, structural address, role, TerminalId)`. Layer 1 checks exact legacy counts (`unauthorized-call`, `stale-baseline`); layer 2 requires one matching frozen ledger row per event (`unauthorized-operation`, `unledgered-reference`, `stale-ledger-row`, `ledger-missing`). Both layers must pass. Escapes (call arguments, returns, throws, array elements, property stores, default exports), dynamic selections and rest extractions whose envelope contains a guarded terminal are `unresolved-boundary-extraction` and are never creditable; incomplete envelopes are `analysis-incomplete` (UNKNOWN).
- **Budgets.** 250,000 nodes, 1,000,000 edges, 10,000,000 transfer evaluations, 512 keys per selection, 16 environments per declaration, depth 64. Limits can be lowered, never raised. Exhaustion is `analysis-budget-exhausted` and UNKNOWN.

## Supported profile and toolchain reconciliation

The design's single-project strict profile matches the locked foundation toolchain: TypeScript 5.9.3 (pinned in `package-lock.json`; any other compiler version is `unsupported-project`), ES2022 target, NodeNext modules and resolution, `strict`. A project `tsconfig.json` is honored when present; fixture roots without one use the explicit `fixture-default-es2022-nodenext-v1` profile. JavaScript/TSX/MTS/CTS sources, project references, composite projects, compiler errors anywhere in the closure, unresolved modules and missing boundary modules are UNKNOWN. No conflict with the foundation toolchain was found and no dependency was added.

## Interpretations reviewers should confirm

1. **Closed-world library summary.** Library code is not interpreted. Every value passed into a library call outside egress is an escape and is denied when it may hold a capability. Library containers keep what they receive: method arguments are stored in the receiver (element slot or library slot); results and callbacks read the receiver's contents; members of library objects expose their received contents; static functions such as `Promise.resolve` or `Object.assign` return their data arguments. The library's declared result type decides only the level of the result: primitive-only results carry no object, collection results are a fresh per-site collection, other results are the contents themselves. The laundering fixture covers Map, array, Promise, event and callback-injection routes.
2. **Declared `any`/`unknown` inside the source closure** are representation overlays, not opaque ingress: values come from the analyzed writes, calls and returns, all of which are inside the closure. Opaque uncertainty is reserved for constructs the analyzer does not model (`infer`, unresolved symbols or types, non-literal module specifiers, `arguments`, `with`). Under a literal reading of R1.3, every `JSON.parse` result, `catch` binding or library callback parameter in production code would make each demanded selection UNKNOWN, and no real source tree could ever be approved. This interpretation is the main point for the independent reviewer.
3. **No legacy scanner exists in this repository**, so "legacy OR new" is realized as the two authorization layers above inside one analyzer. There is no fallback path and an UNKNOWN is never overridden.
4. **Witnesses** name each capability's TerminalId, representative declaration and export routes, plus a suggested resolution. They are not a shortest source-to-selection path.

## Coverage map

Historical EG-01..39 tests and fixtures are not imported. Equivalent coverage is newly authored under `test/fixtures/egress/`:

| Requirement | Fixtures | Tests |
| --- | --- | --- |
| P01 identity / P10 location | `clean`, `direct`, `unclassified`, `permitted`, `negative`, `egress-prefix`, `identity` | `egress-provenance.test.mjs` |
| P02 selection | `namespace`, `destructuring` | same |
| P03 value propagation | `values`, `module-flow` | same |
| P04 module closure | `reexport`, `dynamic-import`, `dynamic-nonliteral`, `cycles`, `missing-import`, `compiler-error`, `unsupported-file` | same |
| P05 mapped renames | `mapped-rename` (literal/dynamic/rest rename probes, helper-only rename, intrinsic keys, nested Pick/Omit/Readonly, collisions) | same |
| P06/P09 types, cycles, widening | `deep`, `namespace-origin-deep-negative` (EG-36 case), `nest-guarded`, `late-source`, `late-helper`, `late-unsupported`, `ambient`, `keys-overflow` | same |
| P07 callable flow | `callable` (egress runtime factory), `laundering` | same |
| P08 dynamic / rest / unknown | `unresolved` | same |
| P10 exact policy | `sites` + committed `ledger.json` | `egress-ledger.test.mjs` |
| P11 determinism, watchdog | all fixtures | `egress-determinism.test.mjs`, CI `analyzer-determinism` |
| Generated corpus | committed seeds (1,000) | `egress-generated.test.mjs` |
| Mutation controls | 10 mutants | `egress-mutation.test.mjs` |
| Production scan, performance | reference source at the pinned commit, `test/fixtures/egress-reference/` ledger | CI `analyzer-evidence` |

Historical inventory obligations (155 capability IDs, 59 cron IDs, 250 protected files, PM05-F1, SB07-F1, B-1, B-3, matrix and binary accounting) belong to the reference repository and are not reproduced here; see [DEV-01 reference](dev01-reference.md).
