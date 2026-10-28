// SPDX-License-Identifier: Apache-2.0
import type { AppServerClient, AppServerClientOptions } from '../app-server/client.js';
import type { RpcNotification } from '../app-server/protocol.js';

/** Narrow injectable process boundary. Each factory call must return a new owner. */
export type RuntimeClient = Pick<AppServerClient, 'start' | 'request' | 'subscribe' | 'close' | 'closed' | 'state' | 'exitInfo' | 'pid'>;
export interface RuntimeClock {
  now(): number;
  monotonicNow(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}
export interface TurnContext {
  incarnationId: string;
  origin: 'chat' | 'cron';
  principal: { uid: string; role: 'owner' | 'manager' | 'member' | 'cron-creator' };
  session: { sessionKey: string; resetGeneration: number; channelId: string; channelType: 1 | 2 | 5 };
  cron?: { runId: string; jobId: string; creatorUid: string; admittedJobGeneration: number };
  policy: { tools: 'none' | 'octo-standard' | 'doc-task'; egressAllowlist?: string[] };
  delivery: { logicalOrigin: string };
}
export interface TurnRequest {
  laneKey: string;
  sessionKey?: string;
  resumeThreadId?: string;
  prompt: string;
  ctx: TurnContext;
  threadParams: { model?: string; cwd: string; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; runtimeWorkspaceRoots?: string[] };
  turnParams: { cwd: string; effort?: string };
  signal?: AbortSignal;
  /** Absolute wall-clock admission deadline. */
  laneDeadlineMs?: number;
  ceilingMs?: number;
  /** Host owns durable CAS. Called only while the captured reset generation is current. */
  onThread?: (threadId: string, expectedResetGeneration: number) => void;
}
export interface TurnOutcome {
  status: 'completed' | 'failed' | 'interrupted' | 'skipped';
  generation: number;
  threadId?: string;
  turnId?: string;
  text: string;
  error?: { class: string; message: string };
  termination: 'terminal-confirmed' | 'process-exited' | 'quarantined' | 'not-started';
}
/** Staged raw notifications, NOT the eventual SDK ThreadEvent projection. */
export interface TurnHandle {
  events: AsyncIterable<RpcNotification>;
  done: Promise<TurnOutcome>;
  cancel(reason?: string): Promise<TurnOutcome>;
}
export interface RuntimeOptions {
  client: AppServerClientOptions;
  clientFactory?: (generation: number) => RuntimeClient;
  clock?: RuntimeClock;
  laneMaxQueued?: number;
  interruptConfirmMs?: number;
  recycleDrainMs?: number;
  chatTurnCeilingMs?: number;
  /** In-memory fences supplement, never replace, the host's persisted generation. */
  getResetGeneration?: (sessionKey: string) => number;
  /** Resolve the host-owned mapping again when the lane dispatches. */
  resolveThreadId?: (sessionKey: string, resetGeneration: number) => string | undefined;
}
