<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local host ownership integration

`startBot` uses the stable configured bot key to acquire `BotStartupOwnership`
before cwd cleanup, timers, SQLite open, session initialization or context load.
The startup object privately retains the exact incarnation, path and lease inode
for fresh ownership too; observed scope loss remains refused after restoration.
A fresh directory uses canonical acquisition. An existing lock explicitly uses
native previous-child reconciliation. Unknown/corrupt/live/unsupported/timed-out
state refuses; there is no stale-PID unlink fallback. Canonical held and, when
applicable, previous-child scope checks run synchronously immediately before
protected startup effects. They sample the filesystem; they are not atomic with
an external filesystem change or a subsequent effect.

The gateway receives that same branded ownership object. Register/connect and
service startup validate its exact configured key and directory; copied objects
or a different bot's lease cannot supply authority. The gateway cannot claim or
release a separate lock. The manager still starts all bots, cross-registers all
siblings, then connects them. The configured key remains distinct from the REST
robot identifier.

Shutdown and partial-start failure stop intake/services and collect handlers.
An unsettled handler deadline refuses instead of authorizing resource release.
The ownership lifecycle permanently stops new child creation, ends only its
actual owned child's input, and waits at most 30 seconds for native owned-exit
persistence. Timeout/uncertainty retains the lease and owned DB. After native
exit, every generation's remaining pipe readers get the existing bounded
two-second drain and detach before DB close, including already-exited children.
After collection,
only initialized resources close, then the DB closes before canonical release.
DB-close failure retains ownership and allows cleanup retry. Lock loss never
permits deleting a replacement lock. No recorded/unowned PID is signaled.

This stage wires the existing host ownership boundaries. It does not merge the
later executor adapter or change `agent-bridge.ts`. The legacy SDK message path
remains unchanged and is not a proven native-owned App Server lifetime. Tests
guard all model/send/config/network boundaries and attach only inert owned
clients through the concrete lifecycle. These are local source tests, not bot
activation, SDK/real App Server, production model/send or product acceptance.
Production issuer/authority, incarnation tables, backup/migration integration,
cron construction/recovery and mandatory effects remain separate gaps. Native
exit grants no execution authority. Existing direct sends are not unified
OctoEgress. Shared-home concurrent writers remain unsupported.

Two imported files alone have exact semantic overlays: `src/host/index.ts` and
`src/host/gateway.ts`. Both provenance validators pin their original mechanically
ported bytes and exact patches under `docs/host-baseline/semantic/`. They require
exact forward application and inverse recovery before the original six
mechanical inversions recover the pinned Git blob/SHA. The 84-source digest,
licences and other imports remain fixed. A deleted legacy gateway catch also
removes its obsolete line exception; restoring that stale exception fails.
There is no blanket semantic transform or editable-JSON-only authorization.

The finite host selection uses a 90-second file deadline to include the actual
30-second refusal plus fixture child collection. Existing normal and long
lifecycle selections remain separate. Package/glob/CI/shared suite pins are
unchanged; no green full-suite/build claim follows. The approved prior repair
11576-row evidence and original 96 repeated failures/TS2345 remain historical,
unwaived evidence, not new passes in this host increment.

Rollback is the complete local source/provenance patch as a unit, after owned
children are collected and the DB closed. Never restore the former DB-open-first
order while a child or resource lifetime remains active. Governance v146 grants
this bounded source scope only; accepted LOCAL and integration branches remain
distinct. Independent review and separately released local testing precede any
later adapter handoff. Remote/live/configuration/credential gates remain held.
# Manager cleanup ownership

The manager keeps pending cleanup separate from its connected bot set.
Failed partial startup transfers the original shutdown closure in
`BotStartupCleanupError`; the manager consumes it. Removal, single/batch connect
rollback and global shutdown retain the same resources and canonical lease until
collection succeeds. Cleanup failure rejects removal/shutdown or appears in the
batch failure result. `pendingCleanupKeys()` reports retained cleanup; a repeated
remove or shutdown retries it. A pending key cannot start replacement resources.

Sibling loop guards remain registered until collection succeeds, including
siblings started while another bot is pending cleanup. The actual process shutdown
caller retains its keepalive and signal listeners after cleanup failure, allowing
an ordinary repeated shutdown. A failed initial batch with retained resources
keeps that owner alive; its startup failure is raised after cleanup completes.
DB close still precedes final release. No automatic unbounded retry occurs.
