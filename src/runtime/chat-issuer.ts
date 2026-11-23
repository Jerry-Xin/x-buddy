// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { assertStartupOwnership, type BotStartupOwnership } from './bootstrap.js';
import { assertSessionState, type SessionState } from './session-state.js';
import { HostExecutionRefusal } from './executor.js';
import type { HostQueryInput, HostTurnIssuer, PreparedHostTurn } from './host-caller.js';
import { assertOctoEgress, type OctoEgress } from './octo-egress.js';

export type TurnPrerequisite =
  | 'authority'
  | 'creator-target'
  | 'reset'
  | 'permit'
  | 'runtime'
  | 'lane'
  | 'deadline'
  | 'mandatory-effects';

export interface ChatTurnIssuerOptions {
  ownership: BotStartupOwnership;
  dataDir: string;
  configBotId?: string;
  registeredRobotId: string;
  getRegisteredRobotId: () => string;
  getOwnerUid: () => string;
  sessionState: SessionState;
  egress: OctoEgress;
  commandsManagers?: readonly string[];
  chatTurnCeilingMs?: number;
  isCallerLive?: () => boolean;
  now?: () => number;
}

const CHAT_ISSUER_BRAND = new WeakSet<ChatTurnIssuer>();

export function isChatTurnIssuer(candidate: unknown): candidate is ChatTurnIssuer {
  return typeof candidate === 'object' && candidate !== null && CHAT_ISSUER_BRAND.has(candidate as ChatTurnIssuer);
}

export function assertChatTurnIssuer(candidate: unknown): asserts candidate is ChatTurnIssuer {
  if (!isChatTurnIssuer(candidate)) {
    throw new HostExecutionRefusal('reset-cas-unavailable');
  }
}

const ALL_READY: Readonly<Record<TurnPrerequisite, true>> = Object.freeze({
  authority: true,
  'creator-target': true,
  reset: true,
  permit: true,
  runtime: true,
  lane: true,
  deadline: true,
  'mandatory-effects': true,
});

export class ChatTurnIssuer implements HostTurnIssuer {
  readonly #ownership: BotStartupOwnership;
  readonly #dataDir: string;
  readonly #configBotId: string;
  readonly #registeredRobotId: string;
  readonly #getRegisteredRobotId: () => string;
  readonly #getOwnerUid: () => string;
  readonly #sessionState: SessionState;
  readonly #egress: OctoEgress;
  readonly #managers: ReadonlySet<string>;
  readonly #chatTurnCeilingMs: number;
  readonly #isCallerLive?: () => boolean;
  readonly #now: () => number;

  constructor(options: ChatTurnIssuerOptions) {
    const resolvedDir = typeof options?.dataDir === 'string' && options.dataDir ? resolve(options.dataDir) : '';
    const expectedBotId = options?.configBotId ?? '';
    assertStartupOwnership(options?.ownership, resolvedDir, expectedBotId);
    assertSessionState(options?.sessionState, options.ownership, resolvedDir, expectedBotId);
    if (typeof options.registeredRobotId !== 'string' || !options.registeredRobotId.trim()) {
      throw new HostExecutionRefusal('authority-unavailable');
    }
    if (typeof options.getRegisteredRobotId !== 'function' || typeof options.getOwnerUid !== 'function') {
      throw new HostExecutionRefusal('authority-unavailable');
    }
    assertOctoEgress(options.egress);
    this.#ownership = options.ownership;
    this.#dataDir = resolvedDir;
    this.#configBotId = expectedBotId;
    this.#registeredRobotId = options.registeredRobotId.trim();
    this.#getRegisteredRobotId = options.getRegisteredRobotId;
    this.#getOwnerUid = options.getOwnerUid;
    this.#sessionState = options.sessionState;
    this.#egress = options.egress;
    this.#managers = new Set(
      (options.commandsManagers ?? []).filter((u): u is string => typeof u === 'string' && u.trim().length > 0),
    );
    const ceiling = options.chatTurnCeilingMs ?? 1_800_000;
    this.#chatTurnCeilingMs = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 1_800_000;
    this.#isCallerLive = options.isCallerLive;
    this.#now = options.now ?? (() => Date.now());
    CHAT_ISSUER_BRAND.add(this);
  }

  get egress(): OctoEgress {
    return this.#egress;
  }

  get registeredRobotId(): string {
    return this.#registeredRobotId;
  }

  get configBotId(): string {
    return this.#configBotId;
  }

  get dataDir(): string {
    return this.#dataDir;
  }

  resolvePrincipalRole(uid: string): 'owner' | 'manager' | 'member' {
    const liveOwner = this.#getOwnerUid().trim();
    if (liveOwner.length > 0 && uid === liveOwner) {
      return 'owner';
    }
    if (this.#managers.has(uid)) {
      return 'manager';
    }
    return 'member';
  }

  assertResetReady(): void {
    assertStartupOwnership(this.#ownership, this.#dataDir, this.#configBotId);
    assertSessionState(this.#sessionState, this.#ownership, this.#dataDir, this.#configBotId);
    if (this.#isCallerLive && !this.#isCallerLive()) {
      throw new HostExecutionRefusal('runtime-unavailable');
    }
    const currentRobotId = this.#getRegisteredRobotId().trim();
    if (!currentRobotId || currentRobotId !== this.#registeredRobotId) {
      throw new HostExecutionRefusal('authority-unavailable');
    }
    assertOctoEgress(this.#egress);
  }

  prepare(
    input: Readonly<HostQueryInput>,
    scope: Readonly<{ botId: string; incarnationId: string; sessionKey?: string; resetGeneration?: number }>,
  ): PreparedHostTurn {
    this.assertResetReady();
    const expectedIncarnation = this.#ownership.lifecycle.lock.incarnationId;
    if (
      !scope?.incarnationId ||
      scope.incarnationId !== expectedIncarnation ||
      (scope.botId !== undefined && scope.botId !== this.#configBotId) ||
      !input?.sessionKey ||
      (scope.sessionKey !== undefined && scope.sessionKey !== input.sessionKey)
    ) {
      throw new HostExecutionRefusal('authority-unavailable');
    }
    if (typeof input.principalUid !== 'string' || !input.principalUid.trim()) {
      throw new HostExecutionRefusal('authority-unavailable');
    }
    if (
      typeof input.channelId !== 'string' ||
      !input.channelId.trim() ||
      (input.channelType !== 1 && input.channelType !== 2 && input.channelType !== 5)
    ) {
      throw new HostExecutionRefusal('creator-target-unavailable');
    }
    if (
      input.channelType === 1 &&
      input.channelId.includes('@') &&
      !input.channelId.split('@').includes(this.#registeredRobotId)
    ) {
      throw new HostExecutionRefusal('creator-target-unavailable');
    }
    if (typeof input.messageId !== 'string' || !input.messageId.trim()) {
      throw new HostExecutionRefusal('mandatory-effects-unavailable');
    }
    const capturedSessionKey = input.sessionKey;
    const currentGen = this.#sessionState.generation(capturedSessionKey);
    const capturedGeneration =
      typeof scope.resetGeneration === 'number' ? scope.resetGeneration : currentGen;
    if (currentGen !== capturedGeneration) {
      throw new HostExecutionRefusal('reset-fenced');
    }
    const now = this.#now();
    const ceilingMs = this.#chatTurnCeilingMs;
    const laneDeadlineMs = now + ceilingMs;
    if (!Number.isFinite(laneDeadlineMs) || laneDeadlineMs <= now) {
      throw new HostExecutionRefusal('deadline-unavailable');
    }
    const role = this.resolvePrincipalRole(input.principalUid);
    const assertCurrent = (): void => {
      this.assertResetReady();
      if (this.#sessionState.generation(capturedSessionKey) !== capturedGeneration) {
        throw new HostExecutionRefusal('reset-fenced');
      }
    };
    return {
      ready: ALL_READY,
      assertCurrent,
      request: {
        sessionKey: capturedSessionKey,
        laneKey: `chat:${capturedSessionKey}`,
        laneDeadlineMs,
        ceilingMs,
        ctx: {
          incarnationId: expectedIncarnation,
          origin: 'chat',
          principal: {
            uid: input.principalUid,
            role,
          },
          session: {
            sessionKey: capturedSessionKey,
            resetGeneration: capturedGeneration,
            channelId: input.channelId,
            channelType: input.channelType,
          },
          policy: {
            tools: 'octo-standard',
          },
          delivery: {
            logicalOrigin: input.messageId,
          },
        },
      },
    };
  }
}
