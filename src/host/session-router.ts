// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/session-router.ts; changes: spdx-header, change-notice, import-path.
/**
 * Session Router — routing + concurrency control + mention gate + rate limiting.
 */

import type { Config } from './config.js';
import type { BotMessage, MentionEntity } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';
import { isAuthenticCronFire } from './cron-fire-marker.js';
import { MentionPreferences } from './mention-prefs.js';
import { ConversationMarkdown, type ConversationTurnContext } from './conversation-md.js';
import type { AddressingClass } from './commands.js';
import { OctoEgress, isOctoEgress, StringCatalog, type EgressKind } from '../runtime/octo-egress.js';

export interface RouteResult {
  sessionKey: string;
  shouldProcess: boolean;
  message: BotMessage;
  /** User content with leading @botname stripped (for LLM input). */
  cleanContent?: string;
  /** Resolved M1 addressing class (E > B > F > U). */
  addressing?: AddressingClass;
  /**
   * Reason for rejection when shouldProcess is false.
   */
  rejectionReason?: 'rate_limited' | 'oversized';
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  /** Whether the user has already been notified of rate limiting in this window. */
  notified: boolean;
}

/** Per-invocation reply effect; it carries no execution or reset authority. */
export type RouterReply = (content: string) => Promise<void>;

export type BotNameResolver = (channelId: string | undefined) => string | undefined;
export type OwnerUidResolver = string | (() => string);

const BUCKET_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Global rate limit: 10x per-session limit, shared across all sessions. */
const GLOBAL_RATE_MULTIPLIER = 10;

/** Maximum allowed content length in bytes (Q10). Messages exceeding this are rejected. */
const MAX_CONTENT_BYTES = 32_768; // 32 KB

export class SessionRouter {
  private readonly config: Config;
  private readonly robotId: string;
  /** G18: owner_uid from registerBot (or live getter across token refresh). */
  private readonly ownerUidSource: OwnerUidResolver;
  private readonly botNameResolver?: BotNameResolver;
  private egress?: OctoEgress;
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly tokenBuckets = new Map<string, TokenBucket>();
  /** G20: per-user buckets keyed by from_uid alone (cross-channel rate limit). */
  private readonly userBuckets = new Map<string, TokenBucket>();
  private globalBucket: TokenBucket | null = null;
  /**
   * G14: UIDs known to be bots. Initialized with this bot's robotId; can be
   * extended via registerKnownBot() for future multi-bot deployments.
   */
  private readonly knownBotUids = new Set<string>();
  private readonly mentionPreferences: MentionPreferences;
  private readonly conversationMarkdown: ConversationMarkdown;

  constructor(
    config: Config,
    robotId: string,
    ownerUid: OwnerUidResolver = '',
    documentStore?: import('./conversation-md.js').ConversationDocumentStore,
    botNameResolver?: BotNameResolver,
    egress?: OctoEgress,
  ) {
    this.config = config;
    this.robotId = robotId;
    this.ownerUidSource = ownerUid;
    this.botNameResolver = botNameResolver;
    this.egress = egress;
    this.knownBotUids.add(robotId);
    this.mentionPreferences = new MentionPreferences(config);
    this.conversationMarkdown = new ConversationMarkdown(config, documentStore);
  }

  setEgress(egress: OctoEgress): void {
    this.egress = egress;
  }

  /** G14: register another known bot uid (future multi-bot support). */
  registerKnownBot(uid: string): void {
    if (uid) this.knownBotUids.add(uid);
  }

  /**
   * Unregister a sibling bot uid (hot-reload: a bot was removed at runtime).
   * Never drops this router's OWN robotId — self is always a bot, removing it
   * would let the loop guard treat this bot's own echoes as user input.
   */
  unregisterKnownBot(uid: string): void {
    if (uid && uid !== this.robotId) this.knownBotUids.delete(uid);
  }

  /** Test/diagnostics: snapshot of currently-known bot uids. */
  knownBotUidsSnapshot(): ReadonlySet<string> {
    return new Set(this.knownBotUids);
  }

  /** G18: live owner_uid resolved from registerBot. */
  getOwnerUid(): string {
    return typeof this.ownerUidSource === 'function' ? this.ownerUidSource() : this.ownerUidSource;
  }

  getRobotId(): string {
    return this.robotId;
  }

  getConversationMd(channelId: string, channelType: ChannelType): Promise<string | undefined> {
    return this.conversationMarkdown.get(channelId, channelType);
  }

  prepareConversationMd(channelId: string, channelType: ChannelType, threadId?: string): Promise<ConversationTurnContext> {
    return this.conversationMarkdown.prepareTurn(channelId, channelType, threadId);
  }

  /**
   * Acquire a per-session lock for the full message handling pipeline.
   */
  async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inboundQueues.get(key) ?? Promise.resolve();
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    this.inboundQueues.set(key, gate);

    try {
      await prev;
      return await fn();
    } finally {
      resolveGate();
      if (this.inboundQueues.get(key) === gate) {
        this.inboundQueues.delete(key);
      }
    }
  }

  /**
   * Route a message and, if it should be processed, run the handler callback
   * under the same per-session lock.
   */
  async routeAndHandle(
    msg: BotMessage,
    handler: (result: RouteResult) => Promise<void>,
    reply?: RouterReply,
    onTimeout?: () => void,
  ): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, async () => {
      const result = await this.processMessage(msg, key, reply);
      if (result && result.shouldProcess) {
        await this.runHandlerWithTimeout(result, handler, reply, onTimeout);
      }
      return result;
    });
  }

  /**
   * Admit a message without acquiring the per-session router lock (used for
   * queue-bypass /reset and /new while preserving all admission, rate, size,
   * T24, addressing, and mention-stripping rules).
   */
  async admitBypass(msg: BotMessage, reply?: RouterReply): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.processMessage(msg, key, reply);
  }

  /**
   * Pre-inspect whether a message is a candidate for queue-bypass /reset or
   * /new after own-mention stripping, without mutating rate-limit buckets.
   */
  isBypassResetCandidate(msg: BotMessage): boolean {
    if (!this.isSupportedChannel(msg.channel_type)) return false;
    if (msg.streamOn || msg.payload?.event) return false;
    if (msg.from_uid === this.robotId) return false;
    if (msg.payload?.type !== MessageType.Text) return false;
    if (
      msg.channel_type === ChannelType.DM &&
      typeof msg.channel_id === 'string' &&
      msg.channel_id.includes('@') &&
      !msg.channel_id.split('@').includes(this.robotId)
    ) {
      return false;
    }
    const content = msg.payload.content ?? '';
    if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) return false;
    const cleaned = this.computeCleanContent(msg, this.isExplicitBotMention(msg));
    const firstLine = (cleaned ?? content).split('\n', 1)[0]?.trim() ?? '';
    const match = firstLine.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
    if (!match) return false;
    const cmd = match[1].toLowerCase();
    return cmd === 'reset' || cmd === 'new';
  }

  private async runHandlerWithTimeout(
    result: RouteResult,
    handler: (result: RouteResult) => Promise<void>,
    reply?: RouterReply,
    onTimeout?: () => void,
  ): Promise<void> {
    const timeoutMs = this.config.dispatchTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      await handler(result);
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(`dispatch timed out after ${timeoutMs}ms`);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError), timeoutMs);
    });

    const handlerPromise = handler(result);
    handlerPromise.catch(() => { /* swallow late rejection after timeout */ });

    try {
      await Promise.race([handlerPromise, timeoutPromise]);
    } catch (err) {
      if (err === timeoutError) {
        console.warn(
          `session-router: dispatch hung past ${timeoutMs}ms, releasing session lock (session=${result.sessionKey})`,
        );
        try {
          onTimeout?.();
        } catch {
          /* ignore callback error */
        }
        await this.replySafe(
          result.message,
          StringCatalog.chatTimeoutNotice(),
          reply,
          'chat.timeout_notice',
        );
        return;
      }
      console.error(
        `session-router: handler error (session=${result.sessionKey}): ${String(err)}`,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async route(msg: BotMessage): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, () => this.processMessage(msg, key));
  }

  sessionKey(msg: BotMessage): string {
    const spaceId = this.extractSpaceId(msg);
    if (msg.channel_type === ChannelType.DM) {
      if (!msg.from_uid) {
        throw new Error('DM message has no from_uid — cannot derive a session key');
      }
      return spaceId ? `${spaceId}:${msg.from_uid}` : msg.from_uid;
    }
    if (!msg.channel_id) {
      throw new Error('Group message has no channel_id — cannot derive a session key');
    }
    return msg.channel_id;
  }

  private extractSpaceId(msg: BotMessage): string {
    if (this.isGroupLike(msg.channel_type)) return "";
    const uid = msg.from_uid;
    if (uid.startsWith("s")) {
      const lastUnderscore = uid.lastIndexOf("_");
      if (lastUnderscore > 0) {
        return uid.substring(1, lastUnderscore);
      }
    }
    const channelId = msg.channel_id;
    if (channelId && channelId.startsWith("s")) {
      const atIdx = channelId.indexOf("@");
      const firstPart = atIdx > 0 ? channelId.substring(0, atIdx) : channelId;
      if (firstPart.startsWith("s")) {
        const lastUnderscore = firstPart.lastIndexOf("_");
        if (lastUnderscore > 0) {
          return firstPart.substring(1, lastUnderscore);
        }
      }
    }
    return "";
  }

  private isBlockedBot(uid: string): boolean {
    return this.config.botBlocklist?.includes(uid) ?? false;
  }

  private looksLikeBot(uid: string): boolean {
    if (this.knownBotUids.has(uid)) return true;
    if (uid.endsWith('_bot')) return true;
    return false;
  }

  private isAllowedBot(uid: string): boolean {
    return this.config.allowedBotUids?.includes(uid) ?? false;
  }

  private isGroupLike(channelType: ChannelType | undefined): boolean {
    return channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic;
  }

  private isSupportedChannel(channelType: ChannelType | undefined): boolean {
    return channelType === ChannelType.DM || this.isGroupLike(channelType);
  }

  private static isStrictFlag(value: unknown): boolean {
    return value === true || value === 1;
  }

  /**
   * I5: Extract mentioned UIDs from mention.entities first (when present and non-empty),
   * falling back to mention.uids.
   */
  private extractMentionUids(mention: BotMessage['payload']['mention']): string[] {
    if (!mention || typeof mention !== 'object') return [];
    const entities = (mention as { entities?: unknown }).entities;
    if (Array.isArray(entities)) {
      const entityUids = entities
        .filter((e): e is MentionEntity =>
          Boolean(
            e &&
              typeof e === 'object' &&
              typeof (e as MentionEntity).uid === 'string' &&
              (e as MentionEntity).uid.length > 0,
          ),
        )
        .map((e) => e.uid);
      if (entityUids.length > 0) return entityUids;
    }
    const uids = mention.uids;
    if (!Array.isArray(uids)) return [];
    return uids.filter((u): u is string => typeof u === 'string' && u.length > 0);
  }

  private resolveBotName(channelId: string | undefined): string | undefined {
    const name = this.botNameResolver?.(channelId)?.trim();
    return name && name.length > 0 ? name : undefined;
  }

  /**
   * I8: CJK-safe @BotName text fallback ONLY when payload.mention is absent.
   */
  private matchesFallbackBotName(msg: BotMessage): boolean {
    if (msg.payload?.mention !== undefined) return false;
    if (msg.payload?.type !== MessageType.Text) return false;
    const content = msg.payload.content ?? '';
    if (!content) return false;
    const botName = this.resolveBotName(msg.channel_id);
    if (!botName) return false;
    const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-zA-Z0-9_.\\-])@${escaped}(?![a-zA-Z0-9_.\\-])`);
    return re.test(content);
  }

  private isExplicitBotMention(msg: BotMessage): boolean {
    const mention = msg.payload?.mention;
    if (mention) {
      const uids = this.extractMentionUids(mention);
      return uids.includes(this.robotId);
    }
    return this.matchesFallbackBotName(msg);
  }

  /**
   * I6 + I7: Broadcast (@all / @humans) suppresses @AI unless this bot is
   * explicitly mentioned (E).
   */
  private isAisBroadcastOnly(msg: BotMessage): boolean {
    const mention = msg.payload?.mention as
      | { all?: unknown; ais?: unknown; humans?: unknown }
      | undefined;
    if (!mention) return false;
    const mentionAis = SessionRouter.isStrictFlag(mention.ais);
    if (!mentionAis) return false;
    const mentionAll = SessionRouter.isStrictFlag(mention.all);
    const mentionHumans = SessionRouter.isStrictFlag(mention.humans);
    return !mentionAll && !mentionHumans;
  }

  private isCronFire(msg: BotMessage): boolean {
    return isAuthenticCronFire(msg.payload);
  }

  /**
   * I14: Strip only this bot's leading mention entity or leading @botName,
   * never an arbitrary @Alice addressed to another user.
   */
  private computeCleanContent(msg: BotMessage, isExplicitMention: boolean): string | undefined {
    if (msg.payload.type !== MessageType.Text) return undefined;
    const content = msg.payload.content ?? '';
    if (!this.isGroupLike(msg.channel_type)) return content;

    let cleanContent = content;
    const mention = msg.payload.mention;
    if (mention?.entities && Array.isArray(mention.entities) && mention.entities.length > 0) {
      const botEntity = mention.entities.find(
        (e: MentionEntity) => e && e.uid === this.robotId && e.offset === 0,
      );
      if (botEntity && typeof botEntity.length === 'number') {
        cleanContent = content.substring(botEntity.length).trimStart();
      } else {
        const leadingEntity = mention.entities.find(
          (e: MentionEntity) => e && e.offset === 0 && typeof e.length === 'number',
        );
        if (!leadingEntity && isExplicitMention) {
          const botName = this.resolveBotName(msg.channel_id);
          if (botName) {
            const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const leadRe = new RegExp(`^@${escaped}(?![a-zA-Z0-9_.\\-])\\s*`);
            cleanContent = content.replace(leadRe, '').trimStart();
          }
        }
      }
    } else if (isExplicitMention) {
      const botName = this.resolveBotName(msg.channel_id);
      if (botName) {
        const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const leadRe = new RegExp(`^@${escaped}(?![a-zA-Z0-9_.\\-])\\s*`);
        if (leadRe.test(content)) {
          cleanContent = content.replace(leadRe, '').trimStart();
        } else if (mention) {
          const uids = this.extractMentionUids(mention);
          if (uids.length === 1 && uids[0] === this.robotId) {
            cleanContent = content.replace(/^@\S+\s*/, '').trimStart();
          }
        }
      } else if (mention) {
        const uids = this.extractMentionUids(mention);
        if (content.startsWith(`@${this.robotId}`)) {
          cleanContent = content.slice(`@${this.robotId}`.length).trimStart();
        } else if (uids.length === 1 && uids[0] === this.robotId) {
          cleanContent = content.replace(/^@\S+\s*/, '').trimStart();
        }
      }
    } else if (this.isAisBroadcastOnly(msg)) {
      cleanContent = content.replace(/^@(?:所有AI|AI|ais|all|所有人)\s*/i, '').trimStart();
    }

    if (!cleanContent) cleanContent = content;
    return cleanContent;
  }

  private async processMessage(msg: BotMessage, key: string, reply?: RouterReply): Promise<RouteResult | null> {
    if (!this.isSupportedChannel(msg.channel_type)) return null;
    if (msg.streamOn) return null;

    if (msg.payload.event) {
      this.conversationMarkdown.onEvent(msg);
      if (this.isGroupLike(msg.channel_type)
        && msg.from_uid === this.robotId
        && msg.payload.event.type === 'mention_pref_updated') {
        this.mentionPreferences.invalidate(msg.channel_id!);
      }
      return null;
    }

    if (msg.from_uid === this.robotId) return null;

    // T24: Drop compound DM channel IDs containing '@' whose components omit this robotId.
    if (
      msg.channel_type === ChannelType.DM &&
      typeof msg.channel_id === 'string' &&
      msg.channel_id.includes('@') &&
      !msg.channel_id.split('@').includes(this.robotId)
    ) {
      return null;
    }

    if (msg.channel_type === ChannelType.DM && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    if (
      msg.channel_type === ChannelType.DM &&
      this.looksLikeBot(msg.from_uid) &&
      !this.isAllowedBot(msg.from_uid)
    ) {
      return null;
    }

    if (this.isGroupLike(msg.channel_type) && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    let addressing: AddressingClass = 'E';
    if (this.isGroupLike(msg.channel_type)) {
      const explicit = this.isExplicitBotMention(msg);
      const cronFire = this.isCronFire(msg);
      if (explicit || cronFire) {
        addressing = 'E';
      } else if (this.isAisBroadcastOnly(msg)) {
        addressing = 'B';
      } else {
        if (this.looksLikeBot(msg.from_uid) && !this.isAllowedBot(msg.from_uid)) {
          return null;
        }
        const isMentionFree = this.config.mentionFreeGroups?.includes(msg.channel_id!) ?? false;
        if (
          !isMentionFree &&
          !(await this.mentionPreferences.allows(
            msg.channel_id!,
            msg.from_uid,
            this.isAllowedBot(msg.from_uid),
          ))
        ) {
          return null;
        }
        addressing = 'F';
      }
    }

    if (!this.isCronFire(msg)) {
      const blocker = this.checkAllRateLimits(key, msg.from_uid);
      if (blocker) {
        if (!blocker.notified) {
          blocker.notified = true;
          await this.replySafe(
            msg,
            StringCatalog.routerRateLimited(),
            reply,
            'router.rate_limited',
          );
        }
        return {
          sessionKey: key,
          shouldProcess: false,
          message: msg,
          addressing,
          rejectionReason: 'rate_limited',
        };
      }
    }

    const content = msg.payload.content ?? '';
    if (
      msg.payload.type === MessageType.Text &&
      Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES
    ) {
      await this.replySafe(
        msg,
        StringCatalog.routerOversize(),
        reply,
        'router.oversize',
      );
      return {
        sessionKey: key,
        shouldProcess: false,
        message: msg,
        addressing,
        rejectionReason: 'oversized',
      };
    }

    const cleanContent = this.computeCleanContent(msg, addressing === 'E');

    return { sessionKey: key, shouldProcess: true, message: msg, cleanContent, addressing };
  }

  private checkAllRateLimits(key: string, uid: string): TokenBucket | null {
    this.cleanStaleBuckets();

    const now = Date.now();
    const maxPerMinute = this.config.rateLimit.maxPerMinute;
    const globalMax = maxPerMinute * GLOBAL_RATE_MULTIPLIER;

    const globalBucket = this.getOrCreateGlobalBucket(now, globalMax);
    const sessionBucketKey = `${key}\n${uid}`;
    const sessionBucket = this.getOrCreateBucket(this.tokenBuckets, sessionBucketKey, now, maxPerMinute);
    const userBucket = this.getOrCreateBucket(this.userBuckets, uid, now, maxPerMinute);

    this.refillBucket(globalBucket, now, globalMax);
    this.refillBucket(sessionBucket, now, maxPerMinute);
    this.refillBucket(userBucket, now, maxPerMinute);

    if (globalBucket.tokens < 1) return globalBucket;
    if (userBucket.tokens < 1) return userBucket;
    if (sessionBucket.tokens < 1) return sessionBucket;

    globalBucket.tokens -= 1;
    sessionBucket.tokens -= 1;
    userBucket.tokens -= 1;
    globalBucket.notified = false;
    sessionBucket.notified = false;
    userBucket.notified = false;
    return null;
  }

  private getOrCreateBucket(
    map: Map<string, TokenBucket>,
    key: string,
    now: number,
    capacity: number,
  ): TokenBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now, notified: false };
      map.set(key, bucket);
    }
    return bucket;
  }

  private getOrCreateGlobalBucket(now: number, capacity: number): TokenBucket {
    if (!this.globalBucket) {
      this.globalBucket = { tokens: capacity, lastRefill: now, notified: false };
    }
    return this.globalBucket;
  }

  private refillBucket(bucket: TokenBucket, now: number, capacity: number): void {
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * capacity;
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  private cleanStaleBuckets(): void {
    const now = Date.now();
    for (const [key, bucket] of this.tokenBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.tokenBuckets.delete(key);
      }
    }
    for (const [uid, bucket] of this.userBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.userBuckets.delete(uid);
      }
    }
  }

  private async replySafe(
    msg: BotMessage,
    content: string,
    reply?: RouterReply,
    kind: EgressKind = 'chat.timeout_notice',
  ): Promise<void> {
    if (!msg.channel_id || msg.channel_type === undefined) return;
    try {
      if (reply) {
        await reply(content);
        return;
      }
      const egress = isOctoEgress(this.egress)
        ? this.egress
        : new OctoEgress({ apiUrl: this.config.apiUrl, getToken: () => this.config.botToken });
      await egress.sendText({
        kind,
        channelId: msg.channel_id,
        channelType: msg.channel_type as 1 | 2 | 5,
        content,
      });
    } catch (err) {
      console.error(`session-router: reply failed: ${String(err)}`);
    }
  }
}
