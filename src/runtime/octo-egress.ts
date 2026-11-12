// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { HostExecutionRefusal } from './executor.js';
import { OctoApiClient } from '../transport/api-client.js';
import type { Clock } from '../transport/clock.js';

export interface OctoMentionEntity {
  uid: string;
  offset: number;
  length: number;
}

export type EgressKind =
  | 'chat.reply'
  | 'chat.placeholder'
  | 'chat.error'
  | 'chat.stream_interrupt'
  | 'chat.timeout_notice'
  | 'chat.ceiling_notice'
  | 'chat.busy_notice'
  | 'chat.unavailable'
  | 'chat.tool_failure'
  | 'progress'
  | 'router.rate_limited'
  | 'router.oversize'
  | 'command.reply'
  | 'command.reset'
  | 'command.denied'
  | 'command.address_required'
  | 'command.scope_denied'
  | 'command.disabled'
  | 'command.unknown';

export type ToolFailureKindLabel = 'Command' | 'File change' | 'MCP tool' | 'Web search';

export const StringCatalog = {
  chatTimeoutNotice(): string {
    return '⚠️ 处理超时，请稍后重试。';
  },
  routerRateLimited(): string {
    return '请稍后再试';
  },
  routerOversize(): string {
    return '消息过长，请缩短后重试';
  },
  chatPlaceholder(): string {
    return '[No response generated. Please try rephrasing your question.]';
  },
  chatError(): string {
    return 'An error occurred while processing your message. Please try again.';
  },
  chatStreamInterrupt(): string {
    return '模型服务连接中断（上游返回不完整），已自动重试仍未成功，请稍后重发或换个问法。';
  },
  progress(label: string): string {
    return `🔧 Running ${label}…`;
  },
  commandReset(): string {
    return '✓ Conversation history cleared (long-term memory is kept).';
  },
  commandUnknown(name: string, helpText: string): string {
    return `Unknown command: /${name}\n\n${helpText}`;
  },
  commandDenied(name: string): string {
    return `⛔ /${name} is limited to the bot owner or managers here.`;
  },
  commandAddressRequired(name: string): string {
    return `Please mention this bot explicitly to use /${name}.`;
  },
  commandScopeDenied(): string {
    return "⛔ --all-conversations is limited to the bot owner in the owner's DM.";
  },
  commandDisabled(name: string): string {
    return `/${name} is disabled for this bot.`;
  },
  chatBusyNotice(): string {
    return '⚠️ 上一条消息仍在处理中，请稍后再试。';
  },
  chatCeilingNotice(): string {
    return '⚠️ 处理时间过长，本次回复已终止，请重试或换个问法。';
  },
  chatUnavailable(): string {
    return '⚠️ 智能体服务暂时不可用，请稍后重试。';
  },
  chatToolFailure(kind: ToolFailureKindLabel): string {
    return `⚠️ 🛠️ ${kind} failed（详情见日志）`;
  },
  responseTruncatedSuffix(): string {
    return '\n\n[response truncated]';
  },
} as const;

export interface OctoEgressOptions {
  apiUrl: string;
  getToken: () => string;
  refreshToken?: () => Promise<string>;
  keyMode?: 'random';
  fetcher?: typeof fetch;
  clock?: Clock;
  uuidFactory?: () => string;
  assertLive?: () => void;
}

export interface EgressSegmentItem {
  content: string;
  mentionUids?: readonly string[];
  mentionEntities?: readonly OctoMentionEntity[];
  mentionAll?: boolean;
}

export interface EgressSendSegmentsParams {
  kind: EgressKind;
  channelId: string;
  channelType: 1 | 2 | 5;
  segments: readonly (string | EgressSegmentItem)[];
  mentionUids?: readonly string[];
  assertCurrent?: () => void;
  signal?: AbortSignal;
  onSegmentDelivered?: (segmentIndex: number, clientMsgNo: string) => void;
}

export interface EgressSendResult {
  deliveredSegments: number;
  clientMsgNos: string[];
  suppressedNoReply: boolean;
}

export interface TypingLoopHandle {
  stop(): void;
  readonly active: boolean;
}

const OCTO_EGRESS_BRAND = new WeakSet<OctoEgress>();

export function isOctoEgress(candidate: unknown): candidate is OctoEgress {
  return typeof candidate === 'object' && candidate !== null && OCTO_EGRESS_BRAND.has(candidate as OctoEgress);
}

export function assertOctoEgress(candidate: unknown): asserts candidate is OctoEgress {
  if (!isOctoEgress(candidate)) {
    throw new HostExecutionRefusal('mandatory-effects-unavailable');
  }
}

export function isSilentNoReply(text: string): boolean {
  return text.trim() === 'NO_REPLY';
}

export class OctoEgress {
  readonly #apiClient: OctoApiClient;
  readonly #uuidFactory: () => string;
  readonly #assertLive?: () => void;
  readonly keyMode: 'random';

  constructor(options: OctoEgressOptions) {
    if (!options || typeof options.apiUrl !== 'string' || !options.apiUrl.trim()) {
      throw new HostExecutionRefusal('mandatory-effects-unavailable');
    }
    if (typeof options.getToken !== 'function') {
      throw new HostExecutionRefusal('mandatory-effects-unavailable');
    }
    this.keyMode = options.keyMode ?? 'random';
    this.#uuidFactory = options.uuidFactory ?? (() => randomUUID());
    this.#assertLive = options.assertLive;
    const fetcher = this.#createDefaultFetcher(options.getToken, options.fetcher);
    this.#apiClient = new OctoApiClient({
      apiUrl: options.apiUrl,
      botToken: options.getToken() || 'token',
      clock: options.clock,
      fetch: fetcher,
    });
    OCTO_EGRESS_BRAND.add(this);
  }

  #createDefaultFetcher(getToken: () => string, customFetcher?: typeof fetch): typeof fetch {
    return async (input, init) => {
      const liveToken = getToken();
      const mergedInit = liveToken
        ? {
            ...init,
            headers: {
              ...(init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)
                ? (init.headers as Record<string, string>)
                : {}),
              Authorization: `Bearer ${liveToken}`,
            },
          }
        : init;
      if (customFetcher) {
        return customFetcher(input, mergedInit);
      }
      return globalThis.fetch(input, mergedInit);
    };
  }

  #verify(assertCurrent?: () => void): void {
    this.#assertLive?.();
    assertCurrent?.();
  }

  async sendSegments(params: EgressSendSegmentsParams): Promise<EgressSendResult> {
    this.#verify(params.assertCurrent);
    const normalized: EgressSegmentItem[] = params.segments.map((seg, idx) =>
      typeof seg === 'string'
        ? {
            content: seg,
            ...(idx === 0 && params.mentionUids && params.mentionUids.length > 0
              ? { mentionUids: params.mentionUids }
              : {}),
          }
        : seg,
    );
    if (params.kind === 'chat.reply' && normalized.length === 1 && isSilentNoReply(normalized[0].content)) {
      return { deliveredSegments: 0, clientMsgNos: [], suppressedNoReply: true };
    }
    const nonEmpty = normalized.filter((seg) => seg.content.trim().length > 0);
    if (nonEmpty.length === 0) {
      return { deliveredSegments: 0, clientMsgNos: [], suppressedNoReply: false };
    }
    const clientMsgNos: string[] = [];
    for (let i = 0; i < nonEmpty.length; i += 1) {
      this.#verify(params.assertCurrent);
      const item = nonEmpty[i];
      const clientMsgNo = this.#uuidFactory();
      const hasMention =
        (item.mentionUids && item.mentionUids.length > 0) ||
        (item.mentionEntities && item.mentionEntities.length > 0) ||
        item.mentionAll === true;
      const mention = hasMention
        ? {
            ...(item.mentionUids && item.mentionUids.length > 0 ? { uids: [...item.mentionUids] } : {}),
            ...(item.mentionEntities && item.mentionEntities.length > 0 ? { entities: [...item.mentionEntities] } : {}),
            ...(item.mentionAll !== undefined ? { all: item.mentionAll } : {}),
          }
        : undefined;
      await this.#apiClient.request(
        'POST',
        '/v1/bot/sendMessage',
        {
          channel_id: params.channelId,
          channel_type: params.channelType,
          client_msg_no: clientMsgNo,
          payload: {
            type: 1,
            content: item.content,
            ...(mention ? { mention } : {}),
          },
        },
        { retry429: true, signal: params.signal },
      );
      clientMsgNos.push(clientMsgNo);
      params.onSegmentDelivered?.(i, clientMsgNo);
    }
    return {
      deliveredSegments: clientMsgNos.length,
      clientMsgNos,
      suppressedNoReply: false,
    };
  }

  async sendText(params: {
    kind: EgressKind;
    channelId: string;
    channelType: 1 | 2 | 5;
    content: string;
    mentionUids?: readonly string[];
    mentionEntities?: readonly OctoMentionEntity[];
    mentionAll?: boolean;
    assertCurrent?: () => void;
    signal?: AbortSignal;
    onSegmentDelivered?: (segmentIndex: number, clientMsgNo: string) => void;
  }): Promise<EgressSendResult> {
    if (params.kind === 'chat.reply' && isSilentNoReply(params.content)) {
      this.#verify(params.assertCurrent);
      return { deliveredSegments: 0, clientMsgNos: [], suppressedNoReply: true };
    }
    return this.sendSegments({
      kind: params.kind,
      channelId: params.channelId,
      channelType: params.channelType,
      segments: [
        {
          content: params.content,
          mentionUids: params.mentionUids,
          mentionEntities: params.mentionEntities,
          mentionAll: params.mentionAll,
        },
      ],
      assertCurrent: params.assertCurrent,
      signal: params.signal,
      onSegmentDelivered: params.onSegmentDelivered,
    });
  }

  async sendTyping(params: {
    channelId: string;
    channelType: 1 | 2 | 5;
    assertCurrent?: () => void;
    signal?: AbortSignal;
  }): Promise<void> {
    this.#verify(params.assertCurrent);
    await this.#apiClient.request(
      'POST',
      '/v1/bot/typing',
      { channel_id: params.channelId, channel_type: params.channelType },
      { retry429: false, signal: params.signal },
    );
  }

  async sendReadReceipt(params: {
    channelId: string;
    channelType: 1 | 2 | 5;
    wireMessageIds: readonly (string | undefined | null)[];
    assertCurrent?: () => void;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (
      !params ||
      typeof params.channelId !== 'string' ||
      !params.channelId.trim() ||
      (params.channelType !== 1 && params.channelType !== 2 && params.channelType !== 5)
    ) {
      throw new HostExecutionRefusal('invalid-read-receipt-channel');
    }
    const validIds = params.wireMessageIds.filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0 && !id.startsWith('nomid:'),
    );
    if (validIds.length === 0) {
      return false;
    }
    this.#verify(params.assertCurrent);
    await this.#apiClient.request(
      'POST',
      '/v1/bot/readReceipt',
      {
        channel_id: params.channelId,
        channel_type: params.channelType,
        message_ids: validIds,
      },
      { retry429: false, signal: params.signal },
    );
    return true;
  }

  startTypingLoop(params: {
    channelId: string;
    channelType: 1 | 2 | 5;
    intervalMs?: number;
    assertCurrent?: () => void;
    dispatchNotice?: (send: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  }): TypingLoopHandle {
    let active = true;
    const intervalMs = params.intervalMs ?? 5000;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      active = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const fire = (): void => {
      if (!active) return;
      try {
        this.#verify(params.assertCurrent);
      } catch {
        stop();
        return;
      }
      if (params.dispatchNotice) {
        params
          .dispatchNotice((signal) =>
            this.sendTyping({
              channelId: params.channelId,
              channelType: params.channelType,
              assertCurrent: params.assertCurrent,
              signal,
            }),
          )
          .catch(() => {});
      } else {
        this.sendTyping({
          channelId: params.channelId,
          channelType: params.channelType,
          assertCurrent: params.assertCurrent,
        }).catch(() => {});
      }
    };
    fire();
    timer = setInterval(fire, intervalMs);
    timer.unref?.();
    return {
      stop,
      get active() {
        return active;
      },
    };
  }
}
