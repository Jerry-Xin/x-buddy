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
  threadParams: {
    model?: string;
    cwd: string;
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    runtimeWorkspaceRoots?: string[];
    dynamicTools?: readonly DynamicToolSpec[];
  };
  turnParams: { cwd: string; effort?: string };
  signal?: AbortSignal;
  /** Absolute wall-clock admission deadline. */
  laneDeadlineMs?: number;
  ceilingMs?: number;
  /** Host owns durable CAS. Called only while the captured reset generation is current. */
  onThread?: (threadId: string, expectedResetGeneration: number) => void;
}
export interface DynamicToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
export interface DynamicToolCallInput {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly callId?: string;
  readonly threadId: string;
  readonly turnId?: string;
}
export interface DynamicToolCallOutput {
  readonly text: string;
  readonly isError: boolean;
}
export interface TurnOutcome {
  status: 'completed' | 'failed' | 'interrupted' | 'skipped';
  generation: number;
  threadId?: string;
  turnId?: string;
  text: string;
  error?: { class: string; message: string; rpcMethod?: string };
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
  /** Synthetic/local callers may supply the pinned ephemeral login after initialize. */
  login?: { type: 'apiKey'; apiKey: string };
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
  /** Optional dynamic tool specs registered on thread/start when TurnContext.policy.tools === 'octo-standard'. */
  dynamicTools?: readonly DynamicToolSpec[];
  /** Optional TurnContext-bound dynamic tool handler invoked on item/tool/call. */
  onDynamicToolCall?: (call: DynamicToolCallInput, ctx: Readonly<TurnContext>) => Promise<DynamicToolCallOutput>;
}
