// SPDX-License-Identifier: Apache-2.0
import { createBotExecutorFactory, HostExecutionRefusal, type QueryExecutor, type AppServerBinding } from './executor.js';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import type { CodexOptions } from '../app-server/params.js';
import { HostCompletionQueue, type CompletionScope } from './completion.js';
import { realClock, bounded } from './support.js';

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
/** Constructor-only trusted seam. No production issuer or mandatory-effects implementation exists. */
export interface HostTurnIssuer {
  prepare(input: Readonly<HostQueryInput>, scope: Readonly<{ botId: string; incarnationId: string }>): PreparedHostTurn | undefined;
}
export type HostExecutorSetup = Omit<Parameters<typeof createBotExecutorFactory>[0], 'ownership' | 'directory' | 'botId'> & {
  issuer?: HostTurnIssuer;
  now?: () => number;
};
export interface HostCaller<Q> {
  assertAvailable(): void;
  forTurn(input: HostQueryInput): Q;
  withCompletion<T>(input: HostQueryInput, work: (scope: CompletionScope & { readonly query: Q }) => Promise<T>): Promise<T>;
  /** Observes an already committed trusted generation; never performs reset CAS. */
  observeReset(sessionKey: string): Promise<void>;
  stopAdmission(): void;
  shutdown(): Promise<void>;
  readonly cron: ReturnType<typeof createBotExecutorFactory>['cron'];
}

/** Per-bot factory; each returned query closes over its own immutable prepared turn. */
export function createHostCaller<Q>(ownership: BotStartupOwnership, directory: string, botId: string,
  setup: HostExecutorSetup | undefined,
  makeBridge: (factory: (settings: CodexOptions) => QueryExecutor, assertCurrent: () => void) => Q): HostCaller<Q> {
  const issuer = setup?.issuer;
  const prepare = typeof issuer?.prepare === 'function' ? issuer.prepare.bind(issuer) : undefined;
  const scope = Object.freeze({ botId, incarnationId: ownership.lifecycle.lock.incarnationId });
  const now = setup?.now ?? Date.now;
  const factory = createBotExecutorFactory({ env: {}, bin: '', clientInfo: { name: 'codex_sdk_ts', title: null, version: '0.142.3' },
    ...setup, ownership, directory, botId });
  let stopped = false;
  const completion = new HostCompletionQueue(setup?.runtime?.clock ?? realClock, now,
    bounded(setup?.runtime?.laneMaxQueued, 3, 1, 10, 'laneMaxQueued'));
  const readGeneration = setup?.runtime?.getResetGeneration;
  const available = (): void => {
    if (stopped) throw new HostExecutionRefusal('caller-stopped');
    assertStartupOwnership(ownership, directory, botId);
    if (!prepare) throw new HostExecutionRefusal('issuer-unavailable');
    if (factory.kind === 'sdk' && !setup?.sdkFactory) throw new HostExecutionRefusal('sdk-constructor-unavailable');
    if (factory.kind === 'app-server' && !setup?.appServerFactory) throw new HostExecutionRefusal('app-server-constructor-unavailable');
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
      };
      current();
      return { query: makeBridge(settings => { current(); return factory.create(settings, request, current); }, current),
        request, current, originalSignal: original.signal };
  };
  const stopAdmission = (): void => { stopped = true; completion.stop(); };
  return Object.freeze({
    cron: factory.cron,
    assertAvailable: available,
    forTurn: (input: HostQueryInput): Q => bind(input).query,
    withCompletion<T>(input: HostQueryInput, work: (scope: CompletionScope & { readonly query: Q }) => Promise<T>): Promise<T> {
      const controller = new AbortController();
      const bound = bind(input, controller);
      return completion.run(bound.request.ctx.session.sessionKey, bound.request.ctx.session.resetGeneration,
        bound.request.laneDeadlineMs!, controller, bound.originalSignal, bound.current,
        scope => work(Object.freeze({ ...scope, query: bound.query })));
    },
    async observeReset(sessionKey: string): Promise<void> {
      available();
      if (!readGeneration) throw new HostExecutionRefusal('reset-cas-unavailable');
      const generation = readGeneration(sessionKey);
      if (!Number.isSafeInteger(generation) || generation < 0) throw new HostExecutionRefusal('reset-cas-unavailable');
      if (completion.cancelBefore(sessionKey, generation)) await factory.cancelSession(sessionKey);
    },
    stopAdmission,
    async shutdown(): Promise<void> { stopAdmission(); await completion.drain(); await factory.shutdown(); },
  });
}
