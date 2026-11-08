// SPDX-License-Identifier: Apache-2.0
/** Durable persistence binding. This supplies no issuer or production authorization. */
import { mkdirSync, lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../host/session-store.js';
import type { DbAdapter } from '../host/db-adapter.js';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import { HostExecutionRefusal } from './executor.js';

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
      store.init(); const value = initialize();
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('initializer must be synchronous');
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
        });
      },
      reset(key: string, expected: number, seq: number, authority: () => void): number {
        lease();
        const result = methods.reset.call(store, key, expected, seq, authority, lease);
        if (result === undefined) throw new HostExecutionRefusal('stale-session-generation');
        return result;
      },
      endIncarnation(): void {
        transaction(() => { lease(); prepare('UPDATE bot_incarnations SET ended_at = ? WHERE incarnation_id = ? AND ended_at IS NULL').run(Date.now(), incarnationId); lease(); })();
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
