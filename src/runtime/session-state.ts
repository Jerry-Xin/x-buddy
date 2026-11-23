// SPDX-License-Identifier: Apache-2.0
/** Durable persistence binding. This supplies no issuer or production authorization. */
import { mkdirSync, lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../host/session-store.js';
import type { DbAdapter } from '../host/db-adapter.js';
import { CRON_DDL } from '../cron/store/schema.js';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import { HostExecutionRefusal } from './executor.js';

export const CONTEXT_NOTES_DDL = `
CREATE TABLE IF NOT EXISTS context_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind='cron_result'),
  text TEXT NOT NULL, created_at INTEGER NOT NULL,
  consumed_at INTEGER, consumed_by_thread TEXT, consumed_by_turn TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_notes_pending ON context_notes(session_id, generation, consumed_at);
`;

export interface ContextNoteRow {
  readonly id: number;
  readonly session_id: string;
  readonly run_id: string;
  readonly generation: number;
  readonly kind: 'cron_result';
  readonly text: string;
  readonly created_at: number;
  readonly consumed_at: number | null;
  readonly consumed_by_thread: string | null;
  readonly consumed_by_turn: string | null;
}

// Canonical implementations are captured at module load, never from request data.
const methods = Object.freeze({
  adapter: SessionStore.prototype.assertAdapter, generation: SessionStore.prototype.getResetGeneration,
  transaction: SessionStore.prototype.withGeneration, mapping: SessionStore.prototype.setSdkSessionIdIfGeneration,
  thread: SessionStore.prototype.getSdkSessionId, reset: SessionStore.prototype.resetIfGeneration,
  create: SessionStore.prototype.getOrCreate, user: SessionStore.prototype.appendUser,
  assistant: SessionStore.prototype.appendAssistant, clear: SessionStore.prototype.clearSdkSessionId,
  cursor: SessionStore.prototype.setLastBotReplySeq,
});
const bindings = new WeakMap<SessionState, { ownership: BotStartupOwnership; directory: string; botId: string }>();
export interface SessionTurnState {
  readonly generation: number;
  assertStore(candidate: SessionStore): void;
  assertCurrent(): void;
  write<T>(work: () => T): T;
  mapping(id: string, publish?: () => void): void;
  thread(): string | undefined;
  create(channelId: string, channelType: number): void;
  user(content: string, seq?: number, name?: string): void;
  assistant(content: string, seq?: number, name?: string): void;
  clearResume(): void;
  replyCursor(seq: number): void;
  pendingContextNotes(limit?: number, maxBytes?: number): ReadonlyArray<ContextNoteRow>;
  consumeContextNotes(noteIds: readonly number[], threadId: string, turnId: string): number;
}
export interface SessionState {
  generation(key: string): number;
  thread(key: string, expected: number): string | undefined;
  capture(key: string, expected: number, authority: () => void): SessionTurnState;
  reset(key: string, expected: number, seq: number, authority: () => void): number;
  endIncarnation(): void;
}
export function assertSessionState(state: SessionState | undefined, ownership: BotStartupOwnership, directory: string, botId: string): asserts state is SessionState {
  const binding = state && bindings.get(state);
  if (!binding || binding.ownership !== ownership || binding.directory !== directory || binding.botId !== botId) throw new HostExecutionRefusal('session-state-binding-mismatch');
  assertStartupOwnership(ownership, directory, botId);
}

/** All initialization DDL, including imported initializer callbacks, follows backup. */
function extractLegacyGroupChannelId(sessionKey: string): string | undefined {
  const trimmed = sessionKey.trim();
  const octoMatch = /^octo:(?:group|subgroup):(.+)$/.exec(trimmed);
  if (octoMatch?.[1]) return octoMatch[1].trim();
  const groupMatch = /^(?:group|subgroup):(.+)$/.exec(trimmed);
  if (groupMatch?.[1]) return groupMatch[1].trim();
  return undefined;
}

function migrateLegacyGroupSessionKeys(prepare: DbAdapter['prepare']): Set<number> {
  const migratedNoteIds = new Set<number>();
  const mappings = new Map<string, string>();
  const recordMapping = (legacyKey: string, canonicalKey: string): void => {
    const leg = legacyKey.trim();
    const can = canonicalKey.trim();
    if (!leg || !can || leg === can) return;
    mappings.set(leg, can);
  };

  const jobRows = prepare(
    'SELECT DISTINCT target_session, target_channel_id, target_channel_type FROM cron_jobs WHERE target_channel_type IN (2, 5) AND target_session != target_channel_id',
  ).all() as Array<{ target_session: string; target_channel_id: string; target_channel_type: number }>;
  for (const row of jobRows) {
    recordMapping(row.target_session, row.target_channel_id);
  }

  const sessionRows = prepare(
    "SELECT id, channel_id, channel_type FROM sessions WHERE (channel_type IN (2, 5) AND id != channel_id) OR id LIKE 'group:%' OR id LIKE 'subgroup:%' OR id LIKE 'octo:group:%' OR id LIKE 'octo:subgroup:%'",
  ).all() as Array<{ id: string; channel_id: string; channel_type: number }>;
  for (const row of sessionRows) {
    if ((row.channel_type === 2 || row.channel_type === 5) && row.channel_id?.trim()) {
      recordMapping(row.id, row.channel_id);
    } else {
      const extracted = extractLegacyGroupChannelId(row.id);
      if (extracted) recordMapping(row.id, extracted);
    }
  }

  for (const table of ['session_generations', 'sdk_sessions', 'messages', 'context_notes'] as const) {
    const rows = prepare(
      `SELECT DISTINCT session_id FROM ${table} WHERE session_id LIKE 'group:%' OR session_id LIKE 'subgroup:%' OR session_id LIKE 'octo:group:%' OR session_id LIKE 'octo:subgroup:%'`,
    ).all() as Array<{ session_id: string }>;
    for (const row of rows) {
      const extracted = extractLegacyGroupChannelId(row.session_id);
      if (extracted) recordMapping(row.session_id, extracted);
    }
  }

  if (mappings.size === 0) return migratedNoteIds;

  const now = Date.now();
  for (const [legacyKey, canonicalKey] of mappings.entries()) {
    const legacySession = prepare(
      'SELECT id, channel_type, channel_id, created_at, updated_at FROM sessions WHERE id = ?',
    ).get(legacyKey) as
      | { id: string; channel_type: number; channel_id: string; created_at: number; updated_at: number }
      | undefined;
    const canonSession = prepare(
      'SELECT id, channel_type, channel_id, created_at, updated_at FROM sessions WHERE id = ?',
    ).get(canonicalKey) as
      | { id: string; channel_type: number; channel_id: string; created_at: number; updated_at: number }
      | undefined;
    if (legacySession && !canonSession) {
      prepare(
        'INSERT INTO sessions (id, channel_type, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        canonicalKey,
        legacySession.channel_type,
        canonicalKey,
        legacySession.created_at,
        legacySession.updated_at,
      );
    } else if (legacySession && canonSession) {
      prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?').run(
        Math.min(canonSession.created_at, legacySession.created_at),
        Math.max(canonSession.updated_at, legacySession.updated_at),
        canonicalKey,
      );
    }

    prepare('UPDATE messages SET session_id = ? WHERE session_id = ?').run(canonicalKey, legacyKey);
    if (legacySession) {
      prepare('DELETE FROM sessions WHERE id = ?').run(legacyKey);
    }

    const legacyGen = prepare(
      'SELECT generation, updated_at FROM session_generations WHERE session_id = ?',
    ).get(legacyKey) as { generation: number; updated_at: number } | undefined;
    const canonGen = prepare(
      'SELECT generation, updated_at FROM session_generations WHERE session_id = ?',
    ).get(canonicalKey) as { generation: number; updated_at: number } | undefined;
    const effectiveGen = Math.max(canonGen?.generation ?? 0, legacyGen?.generation ?? 0);
    const effectiveGenUpdatedAt = Math.max(canonGen?.updated_at ?? 0, legacyGen?.updated_at ?? 0);
    if (legacyGen || canonGen) {
      prepare(
        'INSERT INTO session_generations (session_id, generation, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at',
      ).run(canonicalKey, effectiveGen, effectiveGenUpdatedAt || now);
      if (legacyGen) {
        prepare('DELETE FROM session_generations WHERE session_id = ?').run(legacyKey);
      }
    }

    const legacySdk = prepare(
      'SELECT sdk_session_id, updated_at FROM sdk_sessions WHERE session_id = ?',
    ).get(legacyKey) as
      | { sdk_session_id: string; updated_at: number }
      | undefined;
    const canonSdk = prepare(
      'SELECT sdk_session_id, updated_at FROM sdk_sessions WHERE session_id = ?',
    ).get(canonicalKey) as
      | { sdk_session_id: string; updated_at: number }
      | undefined;
    if (legacySdk) {
      const canonResetAfterLegacy =
        canonGen !== undefined &&
        canonGen.generation > (legacyGen?.generation ?? 0) &&
        canonGen.updated_at >= legacySdk.updated_at;
      if (!canonSdk && !canonResetAfterLegacy) {
        prepare(
          'INSERT INTO sdk_sessions (session_id, sdk_session_id, updated_at) VALUES (?, ?, ?)',
        ).run(canonicalKey, legacySdk.sdk_session_id, legacySdk.updated_at);
        prepare('UPDATE conversation_document_state SET session_id = ? WHERE session_id = ?').run(
          canonicalKey,
          legacyKey,
        );
      }
      prepare('DELETE FROM sdk_sessions WHERE session_id = ?').run(legacyKey);
    }

    const legacyNotes = prepare(
      'SELECT id, generation, created_at, consumed_at FROM context_notes WHERE session_id = ?',
    ).all(legacyKey) as Array<{
      id: number;
      generation: number;
      created_at: number;
      consumed_at: number | null;
    }>;
    for (const note of legacyNotes) {
      if (note.consumed_at !== null) {
        prepare('UPDATE context_notes SET session_id = ? WHERE id = ?').run(canonicalKey, note.id);
        continue;
      }
      const legacyNoteStaleOnLegacy =
        legacyGen !== undefined && note.generation !== legacyGen.generation;
      const canonResetAfterNote =
        canonGen !== undefined &&
        canonGen.generation > (legacyGen?.generation ?? 0) &&
        canonGen.updated_at >= note.created_at;
      if (legacyNoteStaleOnLegacy || canonResetAfterNote) {
        prepare(
          'UPDATE context_notes SET session_id = ?, consumed_at = ?, consumed_by_thread = ?, consumed_by_turn = ? WHERE id = ? AND consumed_at IS NULL',
        ).run(canonicalKey, now, 'downgrade-reconciled', 'downgrade-reconciled', note.id);
      } else {
        prepare('UPDATE context_notes SET session_id = ?, generation = ? WHERE id = ?').run(
          canonicalKey,
          effectiveGen,
          note.id,
        );
        migratedNoteIds.add(note.id);
      }
    }

    prepare('UPDATE cron_jobs SET target_session = ? WHERE target_session = ?').run(
      canonicalKey,
      legacyKey,
    );

    const runSnapshots = prepare(
      'SELECT run_id, definition_snapshot_json FROM cron_runs WHERE definition_snapshot_json LIKE ?',
    ).all(`%${legacyKey}%`) as Array<{ run_id: string; definition_snapshot_json: string }>;
    for (const runRow of runSnapshots) {
      try {
        const parsed = JSON.parse(runRow.definition_snapshot_json) as {
          target?: { sessionKey?: string; channelId?: string; channelType?: number };
        };
        if (parsed?.target?.sessionKey === legacyKey) {
          parsed.target.sessionKey = canonicalKey;
          prepare('UPDATE cron_runs SET definition_snapshot_json = ? WHERE run_id = ?').run(
            JSON.stringify(parsed),
            runRow.run_id,
          );
        }
      } catch {
        // ignore malformed snapshot
      }
    }
  }
  return migratedNoteIds;
}

export async function initializeSessionState<T>(ownership: BotStartupOwnership, directory: string, botId: string,
  adapter: DbAdapter, store: SessionStore, initialize: () => T): Promise<{ state: SessionState; initialized: T; backup: string }> {
  const lease = (): void => assertStartupOwnership(ownership, directory, botId);
  lease(); methods.adapter.call(store, adapter);
  const exec = adapter.exec.bind(adapter), prepare = adapter.prepare.bind(adapter);
  const transaction = adapter.transaction.bind(adapter), backup = adapter.backup.bind(adapter);
  const incarnationId = ownership.lifecycle.lock.incarnationId;
  const migration = 'session-generation-v1';
  const backupDir = join(directory, 'backup');
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(backupDir).isDirectory() || lstatSync(backupDir).isSymbolicLink()) throw new Error('unsafe backup directory');
  const version = prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    ? (prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migration) ? 1 : 0) : 0;
  const destination = join(backupDir, `cc-octo.${version}.${Date.now()}.${randomUUID()}.db`);
  let phase = 'backup', schemaCommitted = false;
  let backupLocation = destination + '.partial';
  try {
    // Repeated constructor DDL is covered on reopen too; no unprotected CREATE.
    lease(); await backup(destination + '.partial'); lease();
    renameSync(destination + '.partial', destination);
    backupLocation = destination;
    const completed = readdirSync(backupDir).filter(name => /^cc-octo\.[01]\.\d+\.[a-f0-9-]+\.db$/.test(name))
      .map(name => ({ name, stat: lstatSync(join(backupDir, name)) }))
      .filter(item => item.stat.isFile() && !item.stat.isSymbolicLink())
      .sort((a, b) => join(backupDir, a.name) === destination ? -1 : join(backupDir, b.name) === destination ? 1
        : b.stat.mtimeMs - a.stat.mtimeMs || b.name.localeCompare(a.name));
    for (const old of completed.slice(3)) { lease(); unlinkSync(join(backupDir, old.name)); }
    phase = 'migration';
    const initialized = transaction(() => {
      lease();
      exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      exec('CREATE TABLE IF NOT EXISTS bot_incarnations (incarnation_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER)');
      exec('CREATE TABLE IF NOT EXISTS session_generations (session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
      exec(CRON_DDL);
      exec(CONTEXT_NOTES_DDL);
      store.init(); const value = initialize();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('initializer must be synchronous');
      const migratedNoteIds = migrateLegacyGroupSessionKeys(prepare);
      const unconsumed = prepare('SELECT id, session_id, generation FROM context_notes WHERE consumed_at IS NULL').all() as Array<{ id: number; session_id: string; generation: number }>;
      if (unconsumed.length > 0) {
        const nowReconcile = Date.now();
        for (const note of unconsumed) {
          const genRow = prepare('SELECT generation FROM session_generations WHERE session_id = ?').get(note.session_id) as { generation: number } | undefined;
          const currentGen = genRow?.generation ?? 0;
          const msgCount = (prepare('SELECT count(*) as n FROM messages WHERE session_id = ?').get(note.session_id) as { n: number } | undefined)?.n ?? 0;
          const hasSdkSession = prepare('SELECT session_id FROM sdk_sessions WHERE session_id = ?').get(note.session_id);
          if (note.generation !== currentGen || (!migratedNoteIds.has(note.id) && msgCount === 0 && !hasSdkSession)) {
            prepare('UPDATE context_notes SET consumed_at = ?, consumed_by_thread = ?, consumed_by_turn = ? WHERE id = ? AND consumed_at IS NULL')
              .run(nowReconcile, 'downgrade-reconciled', 'downgrade-reconciled', note.id);
          }
        }
      }
      lease(); prepare('INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration, Date.now());
      lease(); return value;
    })();
    schemaCommitted = true; phase = 'incarnation';
    transaction(() => {
      lease(); const now = Date.now();
      prepare('UPDATE bot_incarnations SET ended_at = ? WHERE ended_at IS NULL').run(now);
      prepare('INSERT INTO bot_incarnations (incarnation_id, pid, started_at, ended_at) VALUES (?, ?, ?, NULL)').run(incarnationId, process.pid, now);
      lease();
    })();
    const generation = (key: string): number => { lease(); return methods.generation.call(store, key); };
    const state: SessionState = Object.freeze({
      generation,
      thread(key: string, expected: number): string | undefined {
        if (generation(key) !== expected) throw new HostExecutionRefusal('stale-session-generation');
        const id = methods.thread.call(store, key); lease();
        if (generation(key) !== expected) throw new HostExecutionRefusal('stale-session-generation');
        return id;
      },
      capture(key: string, expected: number, authority: () => void): SessionTurnState {
        let failed: { error: unknown } | undefined;
        const current = (): void => {
          if (failed) throw failed.error;
          lease();
          if (authority() !== undefined) throw new HostExecutionRefusal('permit-not-current');
          lease();
          if (generation(key) !== expected) throw new HostExecutionRefusal('stale-session-generation');
        };
        const write = <V>(work: () => V): V => {
          try {
            const result = methods.transaction.call(store, key, expected, current, work) as { value: V } | undefined;
            if (!result) throw new HostExecutionRefusal('stale-session-generation');
            return result.value;
          } catch (error) { failed = { error }; throw error; }
        };
        current();
        return Object.freeze({
          generation: expected, assertCurrent: current, write,
          assertStore(candidate: SessionStore): void {
            current(); if (candidate !== store) throw new HostExecutionRefusal('session-state-binding-mismatch');
          },
          mapping(id: string, publish: () => void = () => {}): void {
            try {
              if (typeof id !== 'string' || !id) throw new HostExecutionRefusal('thread-binding-mismatch');
              if (!methods.mapping.call(store, key, id, expected, current, publish)) throw new HostExecutionRefusal('stale-session-generation');
            } catch (error) { failed = { error }; console.warn('stale_mapping_write'); throw error; }
          },
          thread: () => { current(); return state.thread(key, expected); },
          create: (channelId: string, channelType: number) => { write(() => methods.create.call(store, key, channelId, channelType)); },
          user: (content: string, seq?: number, name?: string) => { write(() => methods.user.call(store, key, content, seq, name)); },
          assistant: (content: string, seq?: number, name?: string) => { write(() => methods.assistant.call(store, key, content, seq, name)); },
          clearResume: () => { write(() => methods.clear.call(store, key)); },
          // In-memory publication follows a successful transaction and one final check.
          replyCursor: (seq: number) => { write(() => {}); current(); methods.cursor.call(store, key, seq); },
          pendingContextNotes: (limit = 3, maxBytes = 8192): ReadonlyArray<ContextNoteRow> => {
            current();
            const rows = prepare(
              'SELECT id, session_id, run_id, generation, kind, text, created_at, consumed_at, consumed_by_thread, consumed_by_turn FROM context_notes WHERE session_id = ? AND generation = ? AND consumed_at IS NULL ORDER BY created_at ASC, id ASC',
            ).all(key, expected) as ContextNoteRow[];
            current();
            const selected: ContextNoteRow[] = [];
            let usedBytes = 0;
            for (const row of rows) {
              if (selected.length >= limit) break;
              const bytes = Buffer.byteLength(row.text, 'utf8');
              if (selected.length > 0 && usedBytes + bytes > maxBytes) break;
              selected.push(Object.freeze({ ...row }));
              usedBytes += bytes;
            }
            return Object.freeze(selected);
          },
          consumeContextNotes: (noteIds: readonly number[], threadId: string, turnId: string): number => {
            if (!Array.isArray(noteIds) || noteIds.length === 0) {
              current();
              return 0;
            }
            return write(() => {
              const nowConsumed = Date.now();
              let changed = 0;
              const stmt = prepare(
                'UPDATE context_notes SET consumed_at = ?, consumed_by_thread = ?, consumed_by_turn = ? WHERE id = ? AND session_id = ? AND generation = ? AND consumed_at IS NULL',
              );
              for (const noteId of noteIds) {
                const res = stmt.run(nowConsumed, threadId, turnId, noteId, key, expected);
                changed += res.changes;
              }
              return changed;
            });
          },
        });
      },
      reset(key: string, expected: number, seq: number, authority: () => void): number {
        lease();
        const result = methods.reset.call(store, key, expected, seq, authority, lease);
        if (result === undefined) throw new HostExecutionRefusal('stale-session-generation');
        return result;
      },
      endIncarnation(): void {
        // If authority has been lost, leave the old incarnation for recovery.
        // A failed lease check after the update must still roll back the write.
        let leaseFailure: { error: unknown } | undefined;
        const checkLease = (): void => {
          try { lease(); }
          catch (error) { leaseFailure = { error }; throw error; }
        };
        try {
          transaction(() => {
            checkLease();
            prepare('UPDATE bot_incarnations SET ended_at = ? WHERE incarnation_id = ? AND ended_at IS NULL').run(Date.now(), incarnationId);
            checkLease();
          })();
        } catch (error) {
          if (!leaseFailure || error !== leaseFailure.error) throw error;
        }
      },
    });
    bindings.set(state, { ownership, directory, botId });
    return { state, initialized, backup: destination };
  } catch (error) {
    let schema = schemaCommitted ? 'committed' : 'not committed';
    let incarnation = 'not committed';
    try {
      lease();
      if (prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) {
        schema = prepare('SELECT id FROM schema_migrations WHERE id=?').get(migration) ? 'version recorded' : 'not recorded';
        incarnation = prepare('SELECT incarnation_id FROM bot_incarnations WHERE incarnation_id=?').get(incarnationId) ? 'committed' : 'not committed';
      }
    } catch { schema = 'unknown; inspect the retained database'; incarnation = 'unknown'; }
    throw new Error(`Persistence ${phase} failed: ${String(error)}; schema ${schema}; incarnation ${incarnation}; backup at ${backupLocation}`, { cause: error });
  }
}
