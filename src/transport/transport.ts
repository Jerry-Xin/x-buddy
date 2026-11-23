// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { WKSocket } from '../octo/socket.js';
import type { BotMessage } from '../octo/types.js';
import { isAllowedWsUrl } from '../host/url-policy.js';
import { isConversationMdEvent } from '../host/conversation-md.js';
import { OctoApiError, type OctoApiClient } from './api-client.js';
import { type Clock, systemClock } from './clock.js';
import type { BotOwnershipLock } from './ownership-lock.js';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
export interface SocketOptions {
  wsUrl: string; uid: string; token: string;
  onMessage: (message: BotMessage) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: Error) => void;
}
export interface SocketDriver { connect(): void; disconnectAndWait(): Promise<void> }
interface Registration { robot_id: string; im_token: string; ws_url: string; owner_uid: string; owner_channel_id: string }
type State = 'idle' | 'registering' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** Staged transport; the host must hold ownership until all DB resources close. */
export class OctoTransport {
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly lifetime = new AbortController();
  private socket: SocketDriver | null = null;
  private epoch = 0;
  private stopped = false;
  private socketAttempts = 0;
  private rebuilding = false;
  private heartbeatInFlight = false;
  private lastRefresh = -Infinity;
  private connectedAt: number | null = null;
  private rapidDisconnectCount = 0;
  private backoff = 0;
  private pending: unknown = null;
  private deadline: unknown = null;
  private stable: unknown = null;
  private heartbeat: unknown = null;
  private watchdog: unknown = null;
  private readonly work = new Set<Promise<void>>();
  private handler: ((message: BotMessage) => void | Promise<void>) | null = null;
  private startup: Promise<void> | null = null;
  private acceptStart: (() => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private phase: State = 'idle';
  private who: Readonly<{ botUid: string; ownerUid: string; ownerChannelId: string }> = Object.freeze({ botUid: '', ownerUid: '', ownerChannelId: '' });
  private readonly counters = { reconnects: 0, watchdogFires: 0, heartbeat429Count: 0,
    heartbeatFailures: 0, heartbeatFailureStreak: 0, handlerFailures: 0 };

  constructor(private readonly options: {
    lock: BotOwnershipLock;
    api: Pick<OctoApiClient, 'request'>;
    wsUrl?: string;
    clock?: Clock;
    random?: () => number;
    socketFactory?: (options: SocketOptions) => SocketDriver;
  }) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    if (options.wsUrl !== undefined) this.validateUrl(options.wsUrl);
  }

  get identity(): Readonly<{ botUid: string; ownerUid: string; ownerChannelId: string }> { return this.who; }
  get state(): State { return this.phase; }
  get metrics(): Readonly<typeof this.counters> { return Object.freeze({ ...this.counters }); }
  isConnected(): boolean { return this.phase === 'connected'; }
  isConnectingOrConnected(): boolean { return this.isConnected() || this.phase === 'connecting'; }
  hasPendingReconnect(): boolean { return this.pending !== null; }
  onInbound(handler: (message: BotMessage) => void | Promise<void>): void { this.handler = handler; }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Transport is stopped; create a new instance'));
    if (this.startup) return this.startup;
    if (!this.handler) return Promise.reject(new Error('Install inbound handler before starting transport'));
    try { this.options.lock.assertHeld(); } catch { return Promise.reject(new Error('Bot ownership lock is not held')); }
    this.startup = new Promise<void>((resolve, reject) => { this.acceptStart = resolve; this.rejectStart = reject; });
    this.armHeartbeat();
    this.armWatchdog();
    this.track(this.rebuild(false));
    return this.startup;
  }

  /** Disconnect immediately: no frame can be ACKed during the host's drain. */
  stopIntake(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.phase = 'stopped';
    this.lifetime.abort();
    for (const handle of [this.pending, this.deadline, this.stable, this.heartbeat, this.watchdog]) {
      if (handle !== null) this.clock.clearTimeout(handle);
    }
    this.pending = this.deadline = this.stable = this.heartbeat = this.watchdog = null;
    this.detachSocket();
    this.settleStart(new Error('Transport stopped before connecting'));
  }

  async stop(): Promise<void> {
    this.stopIntake();
    // API calls have a lifetime abort; driver shutdown is bounded by its close grace.
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  private track(promise: Promise<void>): void {
    const observed = promise.catch(() => {}).finally(() => this.work.delete(observed));
    this.work.add(observed);
  }
  private settleStart(error?: Error): void {
    if (error) this.rejectStart?.(error);
    else this.acceptStart?.();
    this.acceptStart = this.rejectStart = null;
  }
  private validateUrl(value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('Invalid WebSocket endpoint'); }
    if (!isAllowedWsUrl(value) || url.username || url.password || url.hash) throw new Error('Refusing insecure WebSocket endpoint');
  }
  private jitter(): number { return Math.max(0, Math.min(1, this.random())); }
  private deferredDelay(): number { return 5000 + Math.floor(this.jitter() * 5000); }

  private detachSocket(): void {
    this.epoch++;
    this.connectedAt = null;
    const old = this.socket;
    this.socket = null;
    if (old) {
      // Calling the async method immediately disables WKSocket's own reconnect
      // and invalidates its frame callbacks before its first await.
      try { this.track(old.disconnectAndWait()); } catch { /* closed driver */ }
    }
  }

  private schedule(refresh: boolean, delay: number): void {
    if (this.stopped) return;
    if (this.pending !== null) this.clock.clearTimeout(this.pending);
    this.phase = 'reconnecting';
    this.pending = this.clock.setTimeout(() => {
      this.pending = null;
      if (!this.stopped) this.track(this.rebuild(refresh));
    }, delay);
  }

  private socketFailed(epoch: number, refresh: boolean): void {
    if (this.stopped || epoch !== this.epoch) return;
    // WKSocket is retired on every failure, so its per-instance detector cannot
    // retain a streak. Count only post-CONNACK closes across socket generations.
    if (!refresh && this.connectedAt !== null) {
      this.rapidDisconnectCount = this.clock.monotonicNow() - this.connectedAt < 5000
        ? this.rapidDisconnectCount + 1 : 0;
      if (this.rapidDisconnectCount >= 3) refresh = true;
    }
    if (refresh) this.rapidDisconnectCount = 0;
    if (this.deadline !== null) this.clock.clearTimeout(this.deadline);
    if (this.stable !== null) this.clock.clearTimeout(this.stable);
    this.deadline = this.stable = null;
    this.detachSocket();
    this.settleStart(new Error('WebSocket connection failed or exceeded 15s deadline'));
    const delay = refresh ? this.deferredDelay()
      : Math.floor(Math.min(3000 * 2 ** Math.min(this.backoff++, 5), 60_000) * (0.75 + this.jitter() * 0.5));
    this.schedule(refresh, delay);
  }

  private async rebuild(refresh: boolean): Promise<void> {
    if (this.stopped) return;
    if (this.rebuilding) { this.schedule(refresh, this.deferredDelay()); return; }
    if (refresh && this.clock.monotonicNow() - this.lastRefresh < 60_000) {
      this.schedule(true, 60_000 - (this.clock.monotonicNow() - this.lastRefresh) + this.deferredDelay());
      return;
    }
    this.rebuilding = true;
    this.phase = 'registering';
    const epoch = ++this.epoch;
    try {
      this.options.lock.assertHeld();
      if (refresh) this.lastRefresh = this.clock.monotonicNow();
      const reg = await this.options.api.request<Registration>('POST', refresh
        ? '/v1/bot/register?force_refresh=true' : '/v1/bot/register', {
        agent_platform: 'codex-channel-octo', agent_version: VERSION, plugin_version: VERSION,
      }, { signal: this.lifetime.signal });
      if (this.stopped || epoch !== this.epoch) return;
      this.options.lock.assertHeld();
      if (!reg || ![reg.robot_id, reg.im_token, reg.ws_url].every(v => typeof v === 'string' && v.trim())
        || typeof reg.owner_uid !== 'string' || typeof reg.owner_channel_id !== 'string') throw new Error('Invalid registration');
      // Validate both the server value and the override on every registration.
      this.validateUrl(reg.ws_url);
      const wsUrl = this.options.wsUrl ?? reg.ws_url;
      this.validateUrl(wsUrl);
      if (this.who.botUid && this.who.botUid !== reg.robot_id) throw new Error('Registration identity changed');
      this.who = Object.freeze({ botUid: reg.robot_id, ownerUid: reg.owner_uid, ownerChannelId: reg.owner_channel_id });
      const callbacks: SocketOptions = {
        wsUrl, uid: reg.robot_id, token: reg.im_token,
        onConnected: () => {
          if (this.stopped || epoch !== this.epoch) return;
          try { this.options.lock.assertHeld(); } catch { this.stopIntake(); return; }
          this.phase = 'connected';
          this.connectedAt = this.clock.monotonicNow();
          if (this.deadline !== null) this.clock.clearTimeout(this.deadline);
          this.deadline = null;
          this.stable = this.clock.setTimeout(() => {
            if (this.stopped || epoch !== this.epoch) return;
            this.stable = null;
            this.backoff = this.rapidDisconnectCount = 0;
          }, 30_000);
          this.settleStart();
        },
        onDisconnected: () => this.socketFailed(epoch, false),
        onError: () => this.socketFailed(epoch, true),
        onMessage: (message) => {
          if (this.stopped || epoch !== this.epoch || !this.isConnected()) return;
          try { this.options.lock.assertHeld(); } catch { this.stopIntake(); return; }
          if (message.from_uid === this.who.botUid && message.payload.event?.type !== 'mention_pref_updated'
            && !isConversationMdEvent(message.payload.event?.type)) return;
          try {
            const result = this.handler?.(message);
            // The host owns handler drain, independently of transport shutdown.
            if (result) void Promise.resolve(result).catch(() => { this.counters.handlerFailures++; });
          } catch { this.counters.handlerFailures++; }
        },
      };
      this.phase = 'connecting';
      this.socket = (this.options.socketFactory ?? ((opts) => new WKSocket(opts)))(callbacks);
      this.deadline = this.clock.setTimeout(() => { this.deadline = null; this.socketFailed(epoch, false); }, 15_000);
      if (this.socketAttempts++ > 0) this.counters.reconnects++;
      this.socket.connect();
    } catch {
      if (!this.stopped && epoch === this.epoch) {
        this.detachSocket();
        this.settleStart(new Error('Octo registration or connection failed'));
        this.schedule(false, this.deferredDelay());
      }
    } finally { this.rebuilding = false; }
  }

  private armHeartbeat(): void {
    this.heartbeat = this.clock.setTimeout(() => {
      this.heartbeat = null;
      if (this.stopped) return;
      this.armHeartbeat();
      if (this.heartbeatInFlight || !this.who.botUid) return;
      this.heartbeatInFlight = true;
      this.track((async () => {
        try {
          this.options.lock.assertHeld();
          await this.options.api.request('POST', '/v1/bot/heartbeat', {}, { retry429: false, signal: this.lifetime.signal });
          if (!this.stopped) this.counters.heartbeatFailureStreak = 0;
        } catch (error) {
          if (this.stopped) return;
          if (error instanceof OctoApiError && error.status === 429) this.counters.heartbeat429Count++;
          else { this.counters.heartbeatFailures++; this.counters.heartbeatFailureStreak++; }
        } finally { this.heartbeatInFlight = false; }
      })());
    }, 30_000);
  }

  private armWatchdog(): void {
    this.watchdog = this.clock.setTimeout(() => {
      this.watchdog = null;
      if (this.stopped) return;
      this.armWatchdog();
      if (!this.rebuilding && !this.isConnectingOrConnected() && !this.hasPendingReconnect()) {
        this.counters.watchdogFires++;
        this.track(this.rebuild(false));
      }
    }, 60_000);
  }
}
