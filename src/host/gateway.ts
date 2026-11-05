// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/gateway.ts; changes: spdx-header, change-notice, path-literal, import-path.
/**
 * Gateway — WS lifecycle management + bot registration + token refresh.
 */

import { WKSocket } from '../octo/socket.js';
import { registerBot, sendHeartbeat } from '../octo/api.js';
import { isAllowedWsUrl } from './url-policy.js';
import { isConversationMdEvent } from './conversation-md.js';
import type { Config } from './config.js';
import type { BotMessage } from '../octo/types.js';
import { assertStartupOwnership, type BotStartupOwnership } from '../runtime/bootstrap.js';
import { ChildLifecycleRefusal } from '../runtime/child-observer.js';
import { createRequire } from 'node:module';

// Read version from package.json at load time (Q31: no hardcoded version).
const _require = createRequire(import.meta.url);
const PKG_VERSION: string = (_require('../../package.json') as { version: string }).version;

export type MessageHandler = (msg: BotMessage) => void;

export class OctoGateway {
  private socket: WKSocket | null = null;
  private robotId = '';
  // Stored registration result from register(); consumed by connect().
  private registration: Awaited<ReturnType<typeof registerBot>> | null = null;
  // G18: owner_uid from registerBot; used by SessionRouter for future permission model.
  private _ownerUid = '';
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: MessageHandler | null = null;

  /** When true, new messages are silently dropped (shutdown draining). */
  private _draining = false;

  // Token refresh state
  private isRefreshing = false;
  private lastRefreshTime = 0;
  private readonly REFRESH_COOLDOWN_MS = 60_000;

  // Heartbeat failure tracking
  private heartbeatFailCount = 0;
  private readonly MAX_HEARTBEAT_FAILURES = 3;
  /** True while a heartbeat request is in flight — prevents overlapping ticks. */
  private heartbeatInFlight = false;
  /** Bumped on each startHeartbeat() so an orphaned tick from a prior run can't
   *  mutate the new counter (see the generation guard in the tick). */
  private heartbeatGen = 0;

  constructor(
    private readonly config: Config,
    private readonly options: { handleSignals?: boolean; ownership?: BotStartupOwnership } = {},
  ) {

  }

  get botId(): string {
    return this.robotId;
  }

  /** G18: owner_uid returned by registerBot. Empty string until start() succeeds. */
  get ownerUid(): string {
    return this._ownerUid;
  }

  /** Set the message handler. Called for every incoming BotMessage. */
  setMessageHandler(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  /**
   * Start the gateway: register → connect WS → heartbeat. Convenience wrapper
   * that does registration and connection in one call (single-bot path + tests).
   * Multi-bot startup calls register() and connect() separately so no socket
   * begins ACKing messages before its message handler is installed.
   */
  async start(): Promise<void> {
    await this.register();
    this.connect();
  }

  /**
   * Phase 1 of startup: validate the host lease and register over REST. This
   * populates botId/ownerUid but does NOT open the WebSocket, so no messages can
   * arrive yet. Safe to call before the message handler is wired.
   */
  async register(): Promise<void> {
    this.assertOwnership();
    const reg = await registerBot({
      apiUrl: this.config.apiUrl,
      botToken: this.config.botToken,
      agentPlatform: 'codex-channel-octo',
      agentVersion: PKG_VERSION,
    });
    this.assertOwnership();
    this.robotId = reg.robot_id;
    this._ownerUid = reg.owner_uid;
    this.registration = reg;
    console.log(`Bot registered: robot_id=${reg.robot_id}`);
    // The host handles partial failure and releases only after DB close.
  }

  /**
   * Phase 2 of startup: open the WebSocket and start the heartbeat. Call only
   * AFTER setMessageHandler() so inbound messages are dispatched, not ACK'd and
   * dropped. Registers signal handlers unless handleSignals is false.
   */
  connect(): void {
    this.assertOwnership();
    if (!this.registration) {
      throw new Error('OctoGateway.connect() called before register()');
    }
    const reg = this.registration;
    // SECURITY: the AES-CBC payload layer is unauthenticated, so transport
    // integrity is the only tamper guarantee. Refuse a plaintext ws:// endpoint
    // for any non-loopback host (a MITM could bit-flip ciphertext undetected).
    // wss:// is required in production; ws://localhost is allowed for local dev.
    if (!isAllowedWsUrl(reg.ws_url)) {
      throw new Error(
        `OctoGateway.connect(): refusing insecure WebSocket URL "${reg.ws_url}" — ` +
        `wss:// is required (ws:// permitted only for localhost). The message layer ` +
        `is unauthenticated, so an unencrypted transport allows undetected tampering.`,
      );
    }
    this.socket = this.createSocket(reg.ws_url, reg.robot_id, reg.im_token);
    this.socket.connect();
    this.startServices();
  }

  /**
   * Start the REST-backed runtime services: the heartbeat / token-refresh loop
   * and (unless handleSignals is false) the SIGINT/SIGTERM shutdown handlers.
   * Called by connect() after the socket is opened. Multi-bot mode passes
   * handleSignals=false so the orchestrator owns a single combined shutdown.
   */
  startServices(): void {
    this.assertOwnership();
    if (!this.registration) {
      throw new Error('OctoGateway.startServices() called before register()');
    }
    this.startHeartbeat();
    // Multi-bot: the orchestrator owns a single combined SIGINT/SIGTERM handler,
    // so individual gateways skip registering their own (default true keeps the
    // single-bot behavior unchanged).
    if (this.options.handleSignals !== false) {
      this.setupShutdownHandlers();
    }
  }

  /** Whether the gateway is draining (rejecting new messages). */
  get draining(): boolean {
    return this._draining;
  }

  /**
   * Gracefully stop: set draining → wait for in-flight handlers →
   * stop heartbeat/disconnect WS → confirm handlers settled. The host retains the lease.
   *
   * @param activeHandlers - Set of in-flight handler promises to drain.
   *   Supplied by the orchestrator (index.ts) that tracks them.
   * @param drainTimeoutMs - Max time (ms) to wait for in-flight handlers
   *   before refusing cleanup. Default 10000, bounded by 30000.
   */
  async stop(
    activeHandlers?: Set<Promise<void>>,
    drainTimeoutMs = 10_000,
  ): Promise<void> {
    // Mark draining — new messages will be dropped by handleMessage
    this._draining = true;

    this.stopHeartbeat();
    if (this.socket) {
      await this.socket.disconnectAndWait();
      this.socket = null;
    }
    // Stop intake first. An unresolved handler may still use DB/home/runtime;
    // a deadline is refusal, never permission to close resources underneath it.
    if (activeHandlers?.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...activeHandlers]), new Promise<void>(resolve => {
          timer = setTimeout(resolve, Math.min(30_000, Math.max(0, drainTimeoutMs)));
        })]);
      } finally { clearTimeout(timer); }
      if (activeHandlers.size) throw new ChildLifecycleRefusal('handlers-unsettled');
    }
  }

  private assertOwnership(): void {
    assertStartupOwnership(this.options.ownership, this.config.dataDir, this.config.botId ?? '');
  }

  // --- Socket factory ---

  private createSocket(wsUrl: string, uid: string, token: string): WKSocket {
    return new WKSocket({
      wsUrl,
      uid,
      token,
      onMessage: (msg) => this.handleMessage(msg),
      onConnected: () => {
        console.log('WS connected');
        this.heartbeatFailCount = 0;
      },
      onDisconnected: () => {
        console.log('WS disconnected');
      },
      onError: (err) => {
        console.error('WS error:', err.message);
        if (err.message.includes('Kicked') || err.message.includes('Connect failed')) {
          void this.attemptTokenRefresh();
        }
      },
    });
  }

  // --- Bot registration + WS connection ---
  // (register() + connect() above split the two phases; see start().)

  private handleMessage(msg: BotMessage): void {
    if (this._draining) return; // Q6: reject new messages during shutdown
    // The server authors preference notifications as this bot. Let the router
    // invalidate its cache; ordinary self echoes must still be filtered.
    if (msg.from_uid === this.robotId && msg.payload.event?.type !== 'mention_pref_updated'
      && !isConversationMdEvent(msg.payload.event?.type)) return;
    this.onMessage?.(msg);
  }

  // --- Token refresh ---

  private async attemptTokenRefresh(): Promise<void> {
    if (this._draining || this.isRefreshing) return;

    const now = Date.now();
    if (now - this.lastRefreshTime < this.REFRESH_COOLDOWN_MS) {
      const remaining = Math.ceil((this.REFRESH_COOLDOWN_MS - (now - this.lastRefreshTime)) / 1000);
      console.log(`Token refresh cooldown (${remaining}s remaining)`);
      return;
    }

    this.assertOwnership();
    this.isRefreshing = true;
    this.lastRefreshTime = now;

    try {
      console.log('Attempting token refresh...');

      // Q33: Stop heartbeat during refresh to avoid empty pings
      this.stopHeartbeat();

      if (this.socket) {
        await this.socket.disconnectAndWait();
        this.socket = null;
      }

      const reg = await registerBot({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        forceRefresh: true,
        agentPlatform: 'codex-channel-octo',
        agentVersion: PKG_VERSION,
      });

      if (this._draining) return;
      this.assertOwnership();
      this.robotId = reg.robot_id;
      this._ownerUid = reg.owner_uid;
      this.registration = reg;
      console.log('Token refreshed, reconnecting...');

      this.socket = this.createSocket(reg.ws_url, reg.robot_id, reg.im_token);
      this.socket.connect();
      this.startHeartbeat(); // Q33: Restart API heartbeat after successful refresh
    } catch (err) {
      console.error('Token refresh failed:', String(err));
      if (!this._draining) this.startHeartbeat(); // No resurrection during shutdown.
    } finally {
      this.isRefreshing = false;
    }
  }

  // --- Heartbeat (API-level, 30s interval) ---

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatFailCount = 0;
    const gen = ++this.heartbeatGen;
    this.heartbeatTimer = setInterval(() => {
      // Overlap guard: if the previous heartbeat hasn't settled (degraded API
      // where a request takes ~>= the 30s interval), skip this tick instead of
      // piling up concurrent requests and racing heartbeatFailCount.
      if (this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      void (async () => {
        try {
          await sendHeartbeat({
            apiUrl: this.config.apiUrl,
            botToken: this.config.botToken,
          });
          // Generation guard: a tick from a superseded startHeartbeat() (e.g.
          // after a token refresh re-armed the timer) must not touch the live
          // counter or it could spuriously reset/trip the new one.
          if (gen !== this.heartbeatGen) return;
          this.heartbeatFailCount = 0;
        } catch (err) {
          if (gen !== this.heartbeatGen) return;
          this.heartbeatFailCount++;
          console.error(
            `Heartbeat failed (${this.heartbeatFailCount}/${this.MAX_HEARTBEAT_FAILURES}):`,
            String(err),
          );
          if (this.heartbeatFailCount >= this.MAX_HEARTBEAT_FAILURES) {
            console.error('Max heartbeat failures reached, triggering reconnect...');
            this.heartbeatFailCount = 0;
            void this.attemptTokenRefresh();
          }
        } finally {
          // Guard the flag reset by generation too: an orphaned tick from a
          // superseded startHeartbeat() must NOT clear the live generation's
          // in-flight flag, or the next live tick could start a 2nd concurrent
          // request — exactly the overlap this guard prevents. stopHeartbeat()
          // resets the flag when it abandons a generation.
          if (gen === this.heartbeatGen) this.heartbeatInFlight = false;
        }
      })();
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Invalidate any in-flight tick so its result is ignored, and allow the next
    // startHeartbeat to issue immediately.
    this.heartbeatGen++;
    this.heartbeatInFlight = false;
  }

  // --- Graceful shutdown ---

  private onShutdown: (() => Promise<void>) | null = null;

  /**
   * Set a shutdown callback. Called on SIGINT/SIGTERM before process.exit.
   * The orchestrator (index.ts) wires this to drain handlers + close store.
   */
  setShutdownCallback(fn: () => Promise<void>): void {
    this.onShutdown = fn;
  }

  private setupShutdownHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down...`);
      if (this.onShutdown) {
        await this.onShutdown();
      } else {
        await this.stop();
      }
      process.exit(0);
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }
}
