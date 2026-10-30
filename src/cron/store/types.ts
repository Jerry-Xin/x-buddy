// SPDX-License-Identifier: Apache-2.0
/** Structural injection seam: compatible with the existing synchronous SQLite adapter. */
export interface StoreDatabase {
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export type StoredSchedule =
  | Readonly<{ kind: 'at'; atMs: number }>
  | Readonly<{ kind: 'every'; everyMs: number; anchorMs: number }>
  | Readonly<{ kind: 'cron'; expr: string; tz: string; staggerMs: number }>;
export type ScheduleInput = Exclude<StoredSchedule, { kind: 'cron' }>
  | Readonly<{ kind: 'cron'; expr: string; tz: string; staggerMs?: number; exact?: boolean }>;
export type Payload = Readonly<{ kind: 'reminder'; text: string }>
  | Readonly<{ kind: 'agentTurn'; message: string; model?: string; effort?: string; timeoutSeconds?: number }>;
export type ExecMode = 'session' | 'isolated';
export type DeliveryMode = 'announce' | 'none';
export type Target = Readonly<{ sessionKey: string; channelId: string; channelType: 1 | 2 | 5 }>;
/** This selects data scope; it does not authenticate or authorize a caller. */
export type StoreScope = Readonly<{ targetSession: string }> | Readonly<{ allConversations: true }>;
export interface CreateJob {
  readonly id: string;
  readonly name: string;
  readonly schedule: ScheduleInput;
  readonly tz: string;
  readonly payload: Payload;
  readonly execMode: ExecMode;
  readonly target: Target;
  readonly creatorUid: string;
  readonly deliveryMode?: DeliveryMode;
  readonly deleteAfterRun?: boolean;
  readonly enabled?: boolean;
}
export interface JobPatch {
  readonly name?: string;
  readonly schedule?: ScheduleInput;
  readonly tz?: string;
  readonly payload?: Payload;
  readonly execMode?: ExecMode;
  readonly deliveryMode?: DeliveryMode;
  readonly enabled?: boolean;
}
export interface JobRow {
  id: string; name: string; enabled: number; deleted_at: number | null; generation: number;
  schedule_kind: StoredSchedule['kind']; schedule_json: string; tz: string; stagger_ms: number;
  payload_kind: Payload['kind']; payload_json: string; exec_mode: ExecMode;
  target_session: string; target_channel_id: string; target_channel_type: 1 | 2 | 5;
  delivery_mode: DeliveryMode; delete_after_run: number; creator_uid: string;
  schedule_activated_at: number; last_slot_watermark: number | null;
  created_at: number; updated_at: number; next_run_at: number | null;
  last_run_at: number | null; last_status: string | null; last_completion: string | null;
  last_error: string | null; last_error_reason: string | null; last_duration_ms: number | null;
  consecutive_errors: number; consecutive_skipped: number; consecutive_target_failures: number;
  schedule_error_count: number; auto_disabled_reason: string | null; auto_disabled_at: number | null;
  alert_incident_key: string | null; alert_occurrence: number; last_alert_at: number | null;
}
/** Definition only. Admission adds immutable policy, reset and occurrence provenance later. */
export interface Definition {
  readonly schemaVersion: 1;
  readonly jobGeneration: number;
  readonly schedule: StoredSchedule;
  readonly payload: Payload;
  readonly execMode: ExecMode;
  readonly target: Target;
  readonly deliveryMode: DeliveryMode;
  readonly deleteAfterRun: boolean;
  readonly creatorUid: string;
}

/** Already validated by the caller; this library does not resolve bot authority. */
export interface AdmissionAuthority {
  readonly jobId: string;
  readonly definition: Definition;
  readonly creatorAuthorized: true;
  readonly targetAuthorized: true;
  readonly ownerIncarnation: string;
  readonly resetGeneration: number;
  readonly policy: AdmissionPolicy;
}
export interface AdmissionPolicy {
  readonly tools: 'none' | 'octo-standard' | 'doc-task';
  readonly egressAllowlist?: readonly string[];
}
export interface AdmissionRequest {
  readonly trigger: 'scheduled' | 'catchup';
  readonly generation: number;
  readonly slot: number;
  readonly runId: string;
  readonly authority: AdmissionAuthority;
  /** Held across the entire synchronous call. This is a proof seam, not lock acquisition. */
  readonly ownership: {
    readonly ownerIncarnation: string;
    readonly resetGeneration: number;
    assertHeld(): void;
  };
}
export interface AdmissionSnapshot extends Definition {
  readonly occurrenceId: string;
  readonly policy: AdmissionPolicy;
  readonly manualMode?: 'if-enabled' | 'due' | 'force';
  readonly scheduleOwnership: 'consume';
  readonly authoredOccurrenceId: string;
  readonly authoredSlot: number;
  readonly admittedEnabled: true;
  readonly admittedNextRunAt: number;
}
export interface RunRow {
  run_id: string; job_id: string; trigger: 'scheduled' | 'catchup' | 'retry' | 'manual';
  manual_mode: 'if-enabled' | 'due' | 'force' | null;
  schedule_ownership: 'consume' | 'borrow' | 'none';
  authored_occurrence_id: string | null; authored_slot: number | null;
  admitted_enabled: number; admitted_next_run_at: number | null; scheduled_for: number | null;
  attempt: number; occurrence_id: string; ready_at: number;
  status: 'queued' | 'running' | 'ok' | 'error' | 'skipped' | 'interrupted';
  phase: 'admission' | 'executing' | 'delivering' | null;
  completion: 'succeeded' | 'failed' | 'unknown' | null;
  delivery_state: 'not-started' | 'started' | 'delivered' | 'not-delivered' | 'unknown' | 'suppressed' | 'not-requested';
  segments_sent: number; history_state: string | null; reason: string | null; error: string | null;
  admitted_generation: number; definition_snapshot_json: string;
  reset_generation: number; owner_incarnation: string; exec_mode: ExecMode;
  thread_id: string | null; turn_id: string | null; model: string | null; usage_json: string | null;
  summary: string | null; lane_wait_ms: number | null; queued_at: number;
  started_at: number | null; ended_at: number | null;
}
export type AdmissionResult =
  | Readonly<{ kind: 'reserved' | 'existing' | 'overlap'; run: Readonly<RunRow> }>
  | Readonly<{ kind: 'already-consumed' }>
  | Readonly<{ kind: 'deferred'; reason: 'queued-retry-supersession' | 'one-shot-busy'; activeRunId: string; recheckAfterMs: 30000 }>;

/** Synchronous fault injection only; never a production callback or asynchronous work. */
export interface AdmissionTestSeams {
  afterReceiptInsert?(): void;
  afterJobProjection?(): void;
  afterTerminalCas?(): void;
}

/** Capture from the admitted receipt. Never rebuild this from the current job. */
export type TerminalExpectation = Readonly<Pick<RunRow,
  'run_id' | 'job_id' | 'trigger' | 'manual_mode' | 'schedule_ownership' |
  'authored_occurrence_id' | 'authored_slot' | 'admitted_enabled' | 'admitted_next_run_at' |
  'scheduled_for' | 'attempt' | 'occurrence_id' | 'admitted_generation' |
  'definition_snapshot_json' | 'reset_generation' | 'owner_incarnation' | 'exec_mode' |
  'queued_at' | 'ready_at'>> & { readonly status: 'queued' | 'running' };
export type TerminalOutcome =
  | Readonly<{ kind: 'success'; deliveryState: 'not-requested' | 'suppressed' | 'delivered' | 'not-delivered' | 'unknown' }>
  | Readonly<{ kind: 'neutral'; reason: 'stopped' | 'reset' | 'reload' | 'shutdown' }>
  | Readonly<{ kind: 'error' | 'target-failure' | 'restart' | 'session-busy' | 'retry-superseded' }>;
export interface TerminalRequest {
  readonly expected: TerminalExpectation;
  readonly ownership: AdmissionRequest['ownership'];
  readonly outcome: TerminalOutcome;
}
export type TerminalResult =
  | Readonly<{ kind: 'finalized' | 'existing'; run: Readonly<RunRow> }>
  | Readonly<{ kind: 'miss'; run?: Readonly<RunRow> }>
  | Readonly<{ kind: 'deferred'; reason: 'retry-chain' | 'outcome-policy' | 'publication-or-delivery' | 'queued-success' | 'schedule-exhausted' }>;
