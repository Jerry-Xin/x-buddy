// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/bot-manager.ts; changes: spdx-header, change-notice.
/**
 * BotManager — runtime registry of live bots for hot-reload (#157).
 *
 * Owns a long-lived `Map<configId, BotStack>` so the gateway can add/remove a
 * single bot at runtime (driven by a config.json watcher) instead of a full
 * process restart. Holds the two-identity discipline (plan B2): the Map is
 * keyed by configId (config.json `bots[].id`), while the SessionRouter loop
 * guard is keyed by robotUid (Octo register id) — never mixed.
 *
 * Concurrency (plan C/C6): all mutations funnel through a single serial queue
 * (`enqueue`), so a watcher burst can never run two add/remove against the same
 * set concurrently. The diff is computed INSIDE the queued task against the
 * freshly-loaded desired set, never precomputed in the watcher callback.
 */
import type { SessionRouter } from './session-router.js';

/**
 * The subset of a started bot the manager needs to track and tear down. The
 * manager keys bots by the configId passed to addBot (not a field here), and the
 * loop-guard uses robotUid — so configId is intentionally NOT carried on the
 * stack (it would be a write-only field; see plan B2 for the identity split).
 */
export interface ManagedBot {
  robotUid: string;
  router: SessionRouter;
  connect: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/**
 * Diff a desired config-id set against the currently-running config-id set.
 *
 * Returns the configIds to add (in desired, not running) and to remove (running,
 * not in desired). Order within each list is the input order of `desired` /
 * `running` respectively.
 */
export function diffBotSets(
  desired: readonly string[],
  running: readonly string[],
): { toAdd: string[]; toRemove: string[] } {
  const runningSet = new Set(running);
  const desiredSet = new Set(desired);
  const toAdd = desired.filter((id) => !runningSet.has(id));
  const toRemove = running.filter((id) => !desiredSet.has(id));
  return { toAdd, toRemove };
}

/**
 * Cross-register the loop-guard known-bot uids for a newly-added bot:
 *  - the new bot's router learns every existing bot's robotUid, AND
 *  - every existing bot's router learns the new bot's robotUid.
 * Bidirectional — a one-way register would let one side treat the other's
 * messages as user input in a mention-free group (plan B). Pure over the
 * passed collections (no I/O), so it is unit-testable.
 */
export function crossRegisterOnAdd(
  newBot: ManagedBot,
  existing: readonly ManagedBot[],
): void {
  for (const e of existing) {
    if (e.robotUid === newBot.robotUid) continue;
    newBot.router.registerKnownBot(e.robotUid);
    e.router.registerKnownBot(newBot.robotUid);
  }
}

/** Symmetric teardown: every remaining bot's router forgets the removed bot. */
export function crossUnregisterOnRemove(
  removed: ManagedBot,
  remaining: readonly ManagedBot[],
): void {
  for (const r of remaining) {
    r.router.unregisterKnownBot(removed.robotUid);
  }
}

/** How a managed bot is brought up from a config entry (injected for tests). */
export type StartFn = (configId: string) => Promise<ManagedBot>;

/** Transfer the original partial-start resources to the manager for collection. */
export class BotStartupCleanupError extends AggregateError {
  constructor(errors: unknown[], readonly cleanup: () => Promise<void>) {
    super(errors, 'Startup failed; owned cleanup remains unconfirmed');
  }
}

interface PendingBot {
  shutdown: () => Promise<void>;
  bot?: ManagedBot;
  cleanupPending: boolean;
}

/**
 * Runtime registry + serial mutation queue for live bots.
 *
 * The manager never opens sockets itself — `StartFn` (wired to startBot in
 * index.ts) does the register+handler work and returns a ManagedBot whose
 * `connect()` opens the socket. addBot enforces the plan-B ordering:
 *   start (register+handler, no socket) → cross-register known bots → connect,
 * with rollback if connect throws.
 */
export class BotManager {
  private readonly bots = new Map<string, ManagedBot>();
  private readonly pending = new Map<string, PendingBot>();
  private queue: Promise<unknown> = Promise.resolve();
  // Set by shutdownAll() so any apply task that was already past the watcher's
  // `closed` guard can't re-add a bot after teardown has begun (plan E / N4
  // shutdown race). Once true, addBot is a permanent no-op.
  private shuttingDown = false;

  constructor(private readonly start: StartFn) {}

  /** Snapshot of currently-running config keys (Map keys). */
  runningKeys(): string[] {
    return [...this.bots.keys()];
  }

  size(): number {
    return this.bots.size;
  }

  has(key: string): boolean {
    return this.bots.has(key);
  }

  /** Cleanup ownership is distinct from successfully connected/running bots. */
  pendingCleanupKeys(): string[] {
    return [...this.pending].filter(([, p]) => p.cleanupPending).map(([id]) => id);
  }

  private guardedBots(): ManagedBot[] {
    return [...this.bots.values(), ...[...this.pending.values()].flatMap(p => p.bot ? [p.bot] : [])];
  }

  private async startOwned(configId: string): Promise<ManagedBot> {
    if (this.pending.has(configId)) throw new Error(`bot cleanup pending: ${configId}`);
    try {
      const bot = await this.start(configId);
      this.pending.set(configId, { bot, shutdown: bot.shutdown, cleanupPending: false });
      return bot;
    } catch (error) {
      if (error instanceof BotStartupCleanupError) {
        this.pending.set(configId, { shutdown: error.cleanup, cleanupPending: true });
      }
      throw error;
    }
  }

  private async collect(configId: string): Promise<void> {
    const running = this.bots.get(configId);
    if (running) {
      this.pending.set(configId, { bot: running, shutdown: running.shutdown, cleanupPending: true });
      this.bots.delete(configId);
    }
    const owned = this.pending.get(configId);
    if (!owned) return;
    owned.cleanupPending = true;
    await owned.shutdown(); // Failure retains the exact closure, bot and sibling guards.
    if (owned.bot) crossUnregisterOnRemove(owned.bot, this.guardedBots().filter(b => b !== owned.bot));
    this.pending.delete(configId);
  }

  private async rollback(configId: string, error: unknown): Promise<never> {
    try { await this.collect(configId); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Connect failed; owned cleanup remains pending'); }
    throw error;
  }

  /** Run a mutation on the serial queue so add/remove never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even if a task rejects (so later tasks still run),
    // but propagate the result/rejection to this call's awaiter.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Add one bot by configId: start → cross-register → connect, rolling back all
   * three on failure. Unconfirmed cleanup retains its owner and sibling guards
   * separately from the successfully connected bot set.
   */
  addBot(configId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.shuttingDown) return; // teardown started — don't resurrect bots
      if (this.bots.has(configId)) return; // idempotent — already running
      const bot = await this.startOwned(configId);
      try {
        crossRegisterOnAdd(bot, this.guardedBots());
        await bot.connect();
      } catch (err) {
        await this.rollback(configId, err);
      }
      this.pending.delete(configId);
      this.bots.set(configId, bot);
    });
  }

  /** Remove one bot by configId: shutdown + symmetric unregister + drop. */
  removeBot(configId: string): Promise<void> {
    return this.enqueue(async () => {
      // Only confirmed collection permits siblings to forget this bot.
      await this.collect(configId);
    });
  }

  /**
   * Bring up several bots as ONE two-phase batch: start every bot (register +
   * handler, NO socket) → cross-register the whole set's loop-guard uids
   * pairwise → connect them all. This preserves the "no bot opens its socket
   * before every sibling knows its robotUid" invariant ACROSS the initial set —
   * adding bots one-by-one via addBot would let the first bot connect before
   * later bots exist, so it would never learn them. A bot that fails to start or
   * connect is rolled back and skipped (resilience); the rest still come up.
   * Returns the configIds that failed.
   */
  addBotsBatch(configIds: readonly string[]): Promise<{ failed: { configId: string; error: unknown }[] }> {
    return this.enqueue(async () => {
      const failed: { configId: string; error: unknown }[] = [];
      if (this.shuttingDown) {
        return { failed: configIds.map((configId) => ({ configId, error: new Error('shutting down') })) };
      }
      // Phase 1: start (register + handler, no socket) every not-yet-running bot.
      const started: { configId: string; bot: ManagedBot }[] = [];
      for (const configId of configIds) {
        if (this.bots.has(configId)) continue; // already running — skip
        try {
          started.push({ configId, bot: await this.startOwned(configId) });
        } catch (error) {
          failed.push({ configId, error });
        }
      }
      // Phase 2: cross-register loop-guard uids across the existing set AND the
      // whole freshly-started batch, BEFORE any socket opens.
      const guarded = this.guardedBots();
      for (const s of started) {
        crossRegisterOnAdd(s.bot, guarded);
      }
      // Phase 3: connect every started bot. A connect failure rolls back just
      // that bot (unregister from everyone + shutdown) and is reported.
      for (const s of started) {
        try {
          await s.bot.connect();
          this.pending.delete(s.configId);
          this.bots.set(s.configId, s.bot);
        } catch (error) {
          try { await this.rollback(s.configId, error); }
          catch (failure) { failed.push({ configId: s.configId, error: failure }); }
        }
      }
      return { failed };
    });
  }

  /**
   * Shut down every running bot (process exit). Drains them concurrently — order
   * doesn't matter at teardown. Retains failed collections and reports them to
   * the caller for retry. Runs on the serial queue, including repeated shutdown.
   */
  shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    return this.enqueue(async () => {
      const ids = [...new Set([...this.bots.keys(), ...this.pending.keys()])];
      const results = await Promise.allSettled(ids.map(id => this.collect(id)));
      const failures = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Bot cleanup remains pending');
    });
  }
}

