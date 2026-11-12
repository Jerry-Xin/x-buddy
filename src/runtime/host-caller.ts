// SPDX-License-Identifier: Apache-2.0
import { delimiter } from 'node:path';
import { createBotExecutorFactory, HostExecutionRefusal, type QueryExecutor, type AppServerBinding } from './executor.js';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import { AppServerClient, type AppServerClientOptions } from '../app-server/client.js';
import type { CodexOptions } from '../app-server/params.js';
import { HostCompletionQueue, type CompletionScope } from './completion.js';
import { realClock, bounded } from './support.js';
import { assertSessionState, type SessionState, type SessionTurnState } from './session-state.js';
import { createDefaultSdkFactory, resolveCodexBinary } from './codex-binary.js';
import type { OctoEgress } from './octo-egress.js';

export interface HostQueryInput {
  sessionKey: string; principalUid: string; channelId: string; channelType: 1 | 2 | 5;
  messageId: string; messageSeq: number;
}
type Requirement = 'authority' | 'creator-target' | 'reset' | 'permit' | 'runtime' | 'lane' | 'deadline' | 'mandatory-effects';
export interface PreparedHostTurn {
  readonly request: AppServerBinding['request'];
  readonly ready: Readonly<Record<Requirement, boolean>>;
  assertCurrent(): void;
}
/** Constructor-only trusted seam bound at bot startup. */
export interface HostTurnIssuer {
  prepare(input: Readonly<HostQueryInput>, scope: Readonly<{ botId: string; incarnationId: string }>): PreparedHostTurn | undefined;
}
export type HostExecutorSetup = Omit<Parameters<typeof createBotExecutorFactory>[0], 'ownership' | 'directory' | 'botId' | 'env' | 'bin' | 'clientInfo'> &
  Partial<Pick<Parameters<typeof createBotExecutorFactory>[0], 'env' | 'bin' | 'clientInfo'>> & {
  issuer?: HostTurnIssuer;
  egress?: OctoEgress;
  egressFetcher?: typeof fetch;
  egressUuidFactory?: () => string;
  now?: () => number;
};
export interface HostCaller<Q> {
  assertAvailable(): void;
  forTurn(input: HostQueryInput): Q;
  withCompletion<T>(input: HostQueryInput, work: (scope: CompletionScope & { readonly query: Q; readonly state: SessionTurnState; onDispatch(listener: () => void): () => void }) => Promise<T>): Promise<T>;
  resetSession(input: HostQueryInput): Promise<{ generation: number; cancellationError?: unknown }>;
  /** Observes an already committed trusted generation; never performs reset CAS. */
  observeReset(sessionKey: string): Promise<void>;
  stopAdmission(): void;
  shutdown(): Promise<void>;
  readonly cron: ReturnType<typeof createBotExecutorFactory>['cron'];
  readonly issuer?: HostTurnIssuer;
  readonly egress?: OctoEgress;
}

function createDefaultAppServerFactory(explicitBin?: string, explicitVendorDirs?: readonly string[]) {
  return (clientOptions: AppServerClientOptions) => {
    const useExplicitBin = typeof explicitBin === 'string' && explicitBin.trim().length > 0;
    const resolved = useExplicitBin ? undefined : resolveCodexBinary();
    const bin = useExplicitBin ? explicitBin : resolved!.bin;
    const vendorPathDirs = explicitVendorDirs ?? resolved?.vendorPathDirs;
    const baseEnv = clientOptions.env ?? (process.env as Record<string, string | undefined>);
    const env = vendorPathDirs && vendorPathDirs.length > 0
      ? {
          ...baseEnv,
          PATH: [...vendorPathDirs, baseEnv.PATH].filter(Boolean).join(delimiter),
        }
      : clientOptions.env;
    return new AppServerClient({
      ...clientOptions,
      bin,
      ...(env ? { env } : {}),
    });
  };
}

/** Per-bot factory; each returned query closes over its own immutable prepared turn. */
export function createHostCaller<Q>(ownership: BotStartupOwnership, directory: string, botId: string,
  setup: HostExecutorSetup | undefined,
  makeBridge: (factory: (settings: CodexOptions) => QueryExecutor, assertCurrent: () => void) => Q,
  persistence?: SessionState): HostCaller<Q> {
  const issuer = setup?.issuer;
  const egress = setup?.egress;
  const prepare = typeof issuer?.prepare === 'function' ? issuer.prepare.bind(issuer) : undefined;
  const scope = Object.freeze({ botId, incarnationId: ownership.lifecycle.lock.incarnationId });
  const now = setup?.now ?? Date.now;
  const hasExplicitSdkFactory = Boolean(setup && 'sdkFactory' in setup);
  const hasExplicitAppServerFactory = Boolean(setup && 'appServerFactory' in setup);
  const resolvedSdkFactory = hasExplicitSdkFactory
    ? setup?.sdkFactory
    : createDefaultSdkFactory();
  const resolvedAppServerFactory = hasExplicitAppServerFactory
    ? setup?.appServerFactory
    : createDefaultAppServerFactory(setup?.bin, setup?.vendorPathDirs);
  const dispatchListeners = new Map<string, Set<() => void>>();
  const notifyDispatch = (key: string, expected: number): void => {
    const listeners = dispatchListeners.get(`${key}\u0000${expected}`);
    if (!listeners) return;
    for (const fn of [...listeners]) {
      try { fn(); } catch { /* ignore listener errors */ }
    }
  };
  const factory = createBotExecutorFactory({ env: {}, bin: '', clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.142.3' },
    ...setup,
    sdkFactory: resolvedSdkFactory,
    appServerFactory: resolvedAppServerFactory,
    ownership, directory, botId, runtime: { ...setup?.runtime,
      getResetGeneration: key => { assertSessionState(persistence, ownership, directory, botId); return persistence.generation(key); },
      resolveThreadId: (key, expected) => {
        assertSessionState(persistence, ownership, directory, botId);
        const threadId = persistence.thread(key, expected);
        notifyDispatch(key, expected);
        return threadId;
      },
    } });
  let stopped = false;
  const completion = new HostCompletionQueue(setup?.runtime?.clock ?? realClock, now,
    bounded(setup?.runtime?.laneMaxQueued, 3, 1, 10, 'laneMaxQueued'));
  const readGeneration = (key: string): number => { assertSessionState(persistence, ownership, directory, botId); return persistence.generation(key); };
  const available = (): void => {
    if (stopped) throw new HostExecutionRefusal('caller-stopped');
    assertStartupOwnership(ownership, directory, botId);
    if (!prepare) throw new HostExecutionRefusal('issuer-unavailable');
    assertSessionState(persistence, ownership, directory, botId);
    if (factory.kind === 'sdk' && !resolvedSdkFactory) throw new HostExecutionRefusal('sdk-constructor-unavailable');
    if (factory.kind === 'app-server' && !resolvedAppServerFactory) throw new HostExecutionRefusal('app-server-constructor-unavailable');
  };
  const bind = (input: HostQueryInput, controller?: AbortController) => {
      available();
      const envelope = Object.freeze({ sessionKey: input.sessionKey, principalUid: input.principalUid,
        channelId: input.channelId, channelType: input.channelType, messageId: input.messageId, messageSeq: input.messageSeq });
      if (![envelope.sessionKey, envelope.principalUid, envelope.channelId, envelope.messageId].every(value => typeof value === 'string' && value.length > 0)
        || ![1, 2, 5].includes(envelope.channelType) || !Number.isSafeInteger(envelope.messageSeq) || envelope.messageSeq < 0) throw new HostExecutionRefusal('proof-missing');
      const prepared = prepare!(envelope, scope);
      if (!prepared) throw new HostExecutionRefusal('proof-missing');
      for (const key of ['authority', 'creator-target', 'reset', 'permit', 'runtime', 'lane', 'deadline', 'mandatory-effects'] as const) {
        if (prepared.ready?.[key] !== true) throw new HostExecutionRefusal(key);
      }
      const original = prepared.request;
      if (!original?.ctx?.session || !original.ctx.principal || !original.ctx.delivery || typeof prepared.assertCurrent !== 'function') throw new HostExecutionRefusal('proof-missing');
      // The context is data, not a capability. The issuer's guard authenticates it.
      let ctx: typeof original.ctx;
      try { ctx = structuredClone(original.ctx); } catch { throw new HostExecutionRefusal('proof-missing'); }
      const freeze = (value: unknown): void => {
        if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
      };
      freeze(ctx);
      const signal = controller ? AbortSignal.any([controller.signal, ...(original.signal ? [original.signal] : [])]) : original.signal;
      const request = Object.freeze({ ...original, ctx, ...(signal ? { signal } : {}) });
      if (ctx.incarnationId !== scope.incarnationId || ctx.origin !== 'chat' || ctx.session.sessionKey !== envelope.sessionKey || request.sessionKey !== envelope.sessionKey
        || ctx.delivery.logicalOrigin !== envelope.messageId
        || ctx.principal.uid !== envelope.principalUid || ctx.session.channelId !== envelope.channelId || ctx.session.channelType !== envelope.channelType
        || !request.laneKey || !Number.isSafeInteger(ctx.session.resetGeneration) || ctx.session.resetGeneration < 0
        || !Number.isFinite(request.laneDeadlineMs)) throw new HostExecutionRefusal('turn-binding-mismatch');
      if (now() >= request.laneDeadlineMs!) throw new HostExecutionRefusal('deadline');
      const assertProof = prepared.assertCurrent.bind(prepared);
      const current = (): void => {
        available();
        if (request.signal?.aborted) throw new HostExecutionRefusal('permit-not-current');
        if (readGeneration && readGeneration(envelope.sessionKey) !== ctx.session.resetGeneration) throw new HostExecutionRefusal('permit-not-current');
        try { if (assertProof() !== undefined) throw new Error('asynchronous issuer'); }
        catch { throw new HostExecutionRefusal('permit-not-current'); }
        assertStartupOwnership(ownership, directory, botId);
        if (readGeneration(envelope.sessionKey) !== ctx.session.resetGeneration) throw new HostExecutionRefusal('permit-not-current');
      };
      current();
      assertSessionState(persistence, ownership, directory, botId);
      const state = persistence.capture(envelope.sessionKey, ctx.session.resetGeneration, current);
      const boundRequest = Object.freeze({ ...request, onThread: (id: string, generation: number): void => {
        if (generation !== state.generation) throw new HostExecutionRefusal('turn-binding-mismatch');
        state.mapping(id);
      } });
      return {
        query: makeBridge(settings => {
          state.assertCurrent();
          if (factory.kind === 'sdk') notifyDispatch(envelope.sessionKey, state.generation);
          return factory.create(settings, boundRequest, state.assertCurrent);
        }, state.assertCurrent),
        request: boundRequest, current: state.assertCurrent, state, envelope, originalSignal: original.signal,
      };
  };
  const stopAdmission = (): void => { stopped = true; completion.stop(); };
  // Observe each durable transition once. The inherited runtime cancellation
  // increments its local fence, so duplicate observations must not increment it
  // past SQLite. Coalesce superseded controls before entering that runtime.
  const resetNotifications = new Map<string, { generation: number; collected: Promise<void> }>();
  const cancelCommitted = (key: string, generation: number): Promise<void> => {
    completion.cancelBefore(key, generation);
    const previous = resetNotifications.get(key);
    if (previous && previous.generation >= generation) return previous.collected;
    const entry = { generation, collected: Promise.resolve() };
    entry.collected = (previous?.collected.catch(() => {}) ?? Promise.resolve()).then(async () => {
      if (resetNotifications.get(key) !== entry) return;
      await factory.cancelSession(key);
    });
    resetNotifications.set(key, entry);
    return entry.collected;
  };
  return Object.freeze({
    cron: factory.cron,
    issuer,
    egress,
    assertAvailable: available,
    forTurn: (input: HostQueryInput): Q => bind(input).query,
    withCompletion<T>(input: HostQueryInput, work: (scope: CompletionScope & { readonly query: Q; readonly state: SessionTurnState; onDispatch(listener: () => void): () => void }) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      const bound = bind(input, controller);
      const dispatchKey = `${bound.envelope.sessionKey}\u0000${bound.state.generation}`;
      const onDispatch = (listener: () => void): (() => void) => {
        let set = dispatchListeners.get(dispatchKey);
        if (!set) { set = new Set(); dispatchListeners.set(dispatchKey, set); }
        set.add(listener);
        return () => {
          const currentSet = dispatchListeners.get(dispatchKey);
          if (currentSet) {
            currentSet.delete(listener);
            if (currentSet.size === 0) dispatchListeners.delete(dispatchKey);
          }
        };
      };
      return completion.run(bound.request.ctx.session.sessionKey, bound.request.ctx.session.resetGeneration,
        bound.request.laneDeadlineMs!, controller, bound.originalSignal, bound.current,
        async scope => {
          // A new admitted generation cannot enter the host while its reset's
          // runtime cancellation/termination observation remains uncollected.
          await resetNotifications.get(bound.envelope.sessionKey)?.collected;
          if (now() >= bound.request.laneDeadlineMs!) throw new HostExecutionRefusal('deadline');
          bound.current();
          return work(Object.freeze({ ...scope, query: bound.query, state: bound.state, onDispatch }));
        });
    },
    async resetSession(input: HostQueryInput): Promise<{ generation: number; cancellationError?: unknown }> {
      const bound = bind(input); // Authenticates all existing prerequisites before CAS; no work queue.
      assertSessionState(persistence, ownership, directory, botId);
      const generation = persistence.reset(bound.envelope.sessionKey, bound.state.generation, bound.envelope.messageSeq, bound.current);
      try { await cancelCommitted(bound.envelope.sessionKey, generation); return { generation }; }
      catch (cancellationError) { return { generation, cancellationError }; } // Commit is never retried or undone.
    },
    async observeReset(sessionKey: string): Promise<void> {
      available();
      if (!readGeneration) throw new HostExecutionRefusal('reset-cas-unavailable');
      const generation = readGeneration(sessionKey);
      if (!Number.isSafeInteger(generation) || generation < 0) throw new HostExecutionRefusal('reset-cas-unavailable');
      const older = completion.cancelBefore(sessionKey, generation);
      if (older) await cancelCommitted(sessionKey, generation);
      else if (resetNotifications.get(sessionKey)?.generation === generation) await resetNotifications.get(sessionKey)!.collected;
    },
    stopAdmission,
    async shutdown(): Promise<void> {
      stopAdmission(); await completion.drain();
      await Promise.allSettled([...resetNotifications.values()].map(entry => entry.collected));
      await factory.shutdown();
    },
  });
}
