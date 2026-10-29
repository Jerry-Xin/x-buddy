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
