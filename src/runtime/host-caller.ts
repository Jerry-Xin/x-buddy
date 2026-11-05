// SPDX-License-Identifier: Apache-2.0
import { createBotExecutorFactory, HostExecutionRefusal, type QueryExecutor, type AppServerBinding } from './executor.js';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import type { CodexOptions } from '../app-server/params.js';

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
  const available = (): void => {
    if (stopped) throw new HostExecutionRefusal('caller-stopped');
    assertStartupOwnership(ownership, directory, botId);
    if (!prepare) throw new HostExecutionRefusal('issuer-unavailable');
    if (factory.kind === 'sdk' && !setup?.sdkFactory) throw new HostExecutionRefusal('sdk-constructor-unavailable');
    if (factory.kind === 'app-server' && !setup?.appServerFactory) throw new HostExecutionRefusal('app-server-constructor-unavailable');
  };
  return Object.freeze({
    cron: factory.cron,
    assertAvailable: available,
    forTurn(input: HostQueryInput): Q {
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
      const request = Object.freeze({ ...original, ctx });
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
        try { if (assertProof() !== undefined) throw new Error('asynchronous issuer'); }
        catch { throw new HostExecutionRefusal('permit-not-current'); }
      };
      current();
      return makeBridge(settings => { current(); return factory.create(settings, request, current); }, current);
    },
    async shutdown(): Promise<void> { stopped = true; await factory.shutdown(); },
  });
}
