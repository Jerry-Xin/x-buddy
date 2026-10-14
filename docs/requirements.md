# Requirements and status

Authority: XIN-2143 / [GitHub issue #1](https://github.com/Jerry-Xin/x-buddy/issues/1), Charter XIN-2037 Baseline v9 comment `5f81009d-98e8-405c-bedb-8e13345077c7`. This supersedes the old prototype destination and follows v8's clean-history decision. Status describes artifacts in this tree; CI success requires the exact pull request head.

| Obligation | Status | Evidence / next gate |
| --- | --- | --- |
| Standalone Node 22+ / TypeScript package identity | Implemented | package.json, src/index.ts, tsconfig.json |
| Locked deterministic install | Implemented | package-lock.json, npm ci |
| Typecheck, lint, unit test, build, pack smoke | Implemented | npm run check; CI repeats on Node 22/24 |
| License/header, imports and credential-pattern checks | Implemented | LICENSE, manifest, check scripts; independent audit still required |
| Node 22/24 CI configuration | Implemented | .github/workflows/ci.yml; head-specific results in handoff |
| Governance / release conventions | Implemented | CONTRIBUTING, SECURITY, CODEOWNERS, CHANGELOG |
| Branch protection and private vulnerability reporting | Pending | Owner-managed repository settings |
| Independent bootstrap review/test and owner acceptance | Pending | Separate PjM gates after draft PR handoff |
| DEV-01 design v2 and historical prototype evidence | Reference-only | dev01-reference.md; no imported scanner/tests or claimed new execution |
| Provenance graph, adversarial generator, historical fixture port | Pending | Reissue bounded DEV-01 work after bootstrap acceptance |
| App Server transport, bot startup, message/config/session/management parity | Pending | Separate product requirements; no runtime implementation in bootstrap |
| Live Octo integration and real-binary qualification | Blocked | Existing XIN-2099/XIN-2101 resource gates; require fresh verification |
| Stage 2, release, publication, deployment, merge | Blocked | Separate owner/PjM authorization; no bootstrap authorization |

The single bootstrap unit test is not the prototype test corpus. Historical passing, pending or failed counts remain reference evidence and confer no acceptance on this repository.
