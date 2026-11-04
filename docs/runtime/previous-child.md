# Previous child identity and exit prerequisite

R8 XIN-2050 comment `709cfb70-e0aa-49e2-8163-d4a4142abc1e` §§2.6,
3.3.4 and 8.1 require confirmed previous-child termination before shared
CODEX_HOME reuse or DB access. This implements the local macOS prerequisite,
not host startup, cron receipt repair, production authority, or acceptance.

`BotChildLifecycle(lock, botId)` is an optional constructor-bound integration
for the authored AppServerClient (`options.lifecycle`). It owns the actual
spawn, records native host/child PID and microsecond start identity before the
initialize request, and records the actual owned child close status. One
lifecycle binds to each lock; another spawn is refused until the previous
child and diagnostic persistence settle. Runtime shutdown/respawn uses the
client's collected closure. No request can choose a verifier, termination
boolean, recorded PID, diagnostic filename, or signal target through this API.

The fixed observer uses macOS libproc `PROC_PIDTBSDINFO` and kqueue
`EVFILT_PROC / NOTE_EXIT / NOTE_EXITSTATUS` through isolated system Python 3.
It introduces no installed package, compiled addon, dependency, or schema.
Missing Python, libproc, permissions, platform/ABI support, or observation
refuses explicitly. Linux support is not implemented or verified.

The fixed `app-server-child.json` resides beside `gateway.lock`. It binds
version, bot, incarnation, host/child start identity, lease device/inode,
running/exited state, and the observed exit. Persistence uses a private random
temporary file, fsync, atomic rename, and directory fsync. Native access uses
a private current-UID directory descriptor and fixed filenames, O_NOFOLLOW,
regular single-link files, and lock/path/content checks. The diagnostic is a
trusted bot-owned local record, not a cryptographic attestation against code
already able to rewrite the bot's private files or execute in its process.

Ordinary `acquire()` retains its original refusal of every existing lock.
An explicit `await new BotOwnershipLock(dataDir).reconcilePreviousChild(botId)`
serializes on the existing inode with nonblocking flock. It checks the fixed
record against the retained lock and bot. A live host, reused host identity,
malformed/missing diagnostic, unknown identity, unavailable observation,
content/inode ownership loss, and concurrent reconciler refuse before grant.

For a running previous child, the observer registers kqueue before checking
the recorded native start identity, then waits at most 30 monotonic seconds.
Only its bound native exit event admits the lock boundary. PID absence,
stdin EOF, elapsed time, thread state, and a missing JavaScript child do not
prove exit. A child already gone before registration without a recorded owned
exit remains unknown and refuses. A persisted actual owned child exit also
supplies the prerequisite. No recorded PID is signaled. The only observer
watchdog signal targets that invocation's own helper, and never yields grant.

On success the observer writes the new host/incarnation to the same locked
inode and fsyncs it; it never unlinks the old incarnation's lock. The caller
adopts only that exact inode/content. A crash or torn persistence may leave a
lock requiring operator attention; it cannot authorize startup. The returned
receipt is deeply frozen, observational, and grants no cron execution,
authority, repair, DB operation, or CODEX_HOME access. Existing reset, lane,
permit, deadline, and turn fences are unchanged.

The inert process tests cover real spawn/record, parent SIGKILL, immediate
replacement, delayed native child exit and exact status, ordinary owned exit,
live owner, controlled PID/start mismatch, bot/incarnation/inode mismatch,
missing/truncated/unknown records, concurrent replacement, ownership loss,
30-second timeout, a child gone before observation, and an unrelated sentinel.
Caller-side DB/CODEX_HOME counters remain zero; these are local boundary
observations, not a real host or database-open integration test. Native
permission/unavailable-platform error fixtures are labeled modeled cases,
separate from actual macOS observations. Children and owned HOME paths are
collected before completion.

The normal `child-lifecycle.test.mjs` selection contains the bounded fast
cases and fits the repository's 30-second file deadline. The additional real
30-second observation/late-exit case is `previous-child-timeout.mjs`, an
explicit long selection. Run it with `node --test --test-timeout=90000
test/runtime/previous-child-timeout.mjs`; its own 45-second case deadline and
the production 30-second maximum remain enforced. The offline reproducer
selects both files explicitly. No inherited suite or assertion is omitted.

Production host integration, real App Server binary behavior, Linux native
support, shared-home use, actual DB startup, and XIN-2737's repair/CAS/projection
remain deferred. Packaging of this integration has not been exercised.
Independent review must precede a separately authorized independent test and
PjM continuation. No baseline promotion or live activation is implied.

R1 correction: durable owned exit observation listens to the actual owned
`exit` event. A failed spawn produces no exit record and retains spawn refusal.
Client stdout/stderr continue draining under the existing two-second exit
flush budget, then detach even if an owned descendant retains the pipes.
The shutdown grace/confirmation budgets are unchanged. Known exit cancels
the kill timer; diagnostic persistence failure still forbids another spawn
and cannot provide a fabricated durable prerequisite.

R2 correction: a persisted owned-exit record also checks the native child
identity before granting ownership. A positively identified matching live
child refuses with `live-child-contradiction`; a different identity refuses
as a mismatch. Native uncertainty/permission failure propagates refusal.
Genuine persisted exit plus confirmed native absence remains supported.
This handles corruption inside trusted private storage and introduces no
new attestation or account-access policy.

N1 follow-up from XIN-2738: the cron-store prerequisite document incorrectly
attributes planned `bot_incarnations` DDL to implemented `schema.sql`. That
table is absent; this task makes no store or schema edit.
