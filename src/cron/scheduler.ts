// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, connect as connectSocket, type Server as NetServer, type Socket } from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { previousOrBefore, type Schedule } from './schedule/engine.js';
import type { ResolvedCronConfig } from './config.js';
import { formatZonedTime, redactSecrets, sanitizeDisplayText } from './parser.js';
import type { CronAdmissionIssuer, CronService } from './service.js';
import { CronStore, terminalExpectation } from './store/index.js';
import type {
  AlertIntent,
  Definition,
  DisableNoticeIntent,
  FailureReason,
  RunRow,
  Target,
} from './store/types.js';
import {
  isSilentNoReply,
  StringCatalog,
  type EgressSegmentItem,
  type OctoEgress,
} from '../runtime/octo-egress.js';
import { sanitizePromptBody } from '../host/prompt-safety.js';

export interface CronTimerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export const defaultCronClock: CronTimerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export interface CronTurnExecutionInput {
  readonly run: Readonly<RunRow>;
  readonly snapshot: Definition & {
    readonly policy: { readonly tools: 'none' | 'octo-standard' };
  };
  readonly jobName: string;
  readonly tz: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly timeoutMs: number;
  readonly admissionWaitMs: number;
  readonly signal: AbortSignal;
}

export type CronTurnExecutionOutcome =
  | {
      readonly kind: 'ok';
      readonly text: string;
      readonly threadId?: string | null;
      readonly turnId?: string | null;
      readonly model?: string | null;
      readonly usageJson?: string | null;
      readonly laneWaitMs?: number | null;
    }
  | {
      readonly kind: 'busy';
      readonly laneWaitMs?: number | null;
    }
  | {
      readonly kind: 'cancelled';
      readonly reason: 'reset' | 'shutdown' | 'reload' | 'job-removed' | 'job-disabled' | 'job-edited';
    }
  | {
      readonly kind: 'error';
      readonly reason: FailureReason;
      readonly error: string;
    };

export interface CronExecutorDependencies {
  readonly botId: string;
  readonly botName?: string;
  readonly cwdBase: string;
  readonly store: CronStore;
  readonly config: ResolvedCronConfig;
  readonly issuer: CronAdmissionIssuer;
  readonly clock: CronTimerClock;
  readonly egress: OctoEgress;
  readonly getOwnerUid: () => string | undefined;
  readonly getOwnerChannelId?: () => string | undefined;
  readonly executeIsolatedTurn: (input: CronTurnExecutionInput) => Promise<CronTurnExecutionOutcome>;
  readonly executeSessionTurn: (input: CronTurnExecutionInput) => Promise<CronTurnExecutionOutcome>;
  readonly prepareOutboundSegments?: (
    text: string,
    target: Target,
  ) => Promise<readonly (string | EgressSegmentItem)[]>;
  readonly emitAudit?: (params: {
    actor: string;
    action: string;
    target: string;
    outcome: 'ok' | 'denied' | 'error';
    detail?: string;
  }) => void;
  readonly onRunFinalized?: () => void;
}

interface ActiveExecutionHandle {
  readonly runId: string;
  readonly jobId: string;
  readonly sessionKey: string;
  readonly execMode: 'isolated' | 'session';
  readonly controller: AbortController;
  cancelReason?: 'reset' | 'shutdown' | 'reload' | 'job-removed' | 'job-disabled' | 'job-edited';
  promise?: Promise<void>;
}

export function classifyExecutionError(error: unknown): { reason: FailureReason; message: string } {
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'execution failed');
  const msg = redactSecrets(rawMessage).slice(0, 500) || 'execution failed';
  const code = (error as { code?: string; reason?: string })?.code ?? (error as { reason?: string })?.reason ?? '';
  const lower = `${code} ${msg}`.toLowerCase();

  if (lower.includes('session-busy') || lower.includes('lane_overflow') || lower.includes('lane-overflow')) {
    return { reason: 'session-busy', message: msg };
  }
  if (lower.includes('quarantin')) {
    return { reason: 'quarantined', message: msg };
  }
  if (
    lower.includes('circuit-open') ||
    lower.includes('circuit_open') ||
    lower.includes('runtime_unavailable') ||
    lower.includes('runtime-unavailable') ||
    lower.includes('child_unavailable') ||
    lower.includes('not started') ||
    lower.includes('process exited')
  ) {
    return { reason: 'runtime_unavailable', message: msg };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('ceiling')) {
    return { reason: 'timeout', message: msg };
  }
  if (lower.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit')) {
    return { reason: 'rate_limited', message: msg };
  }
  if (lower.includes('overload') || lower.includes('503') || lower.includes('529')) {
    return { reason: 'overloaded', message: msg };
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_api_key') ||
    lower.includes('auth')
  ) {
    return { reason: 'auth', message: msg };
  }
  if (
    lower.includes('econn') ||
    lower.includes('enet') ||
    lower.includes('enotfound') ||
    lower.includes('socket') ||
    lower.includes('network') ||
    lower.includes('fetch failed')
  ) {
    return { reason: 'network', message: msg };
  }
  return { reason: 'model_error', message: msg };
}

function classifyDeliveryFailure(
  error: unknown,
  segmentsSent: number,
): { kind: 'not-delivered' | 'unknown'; error: string } {
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'delivery failed');
  const redacted = redactSecrets(rawMessage).slice(0, 500) || 'delivery failed';
  if (segmentsSent > 0) {
    return { kind: 'unknown', error: redacted };
  }
  const status = (error as { status?: number })?.status;
  const code = (error as { code?: string | number; prerequisite?: string })?.code;
  const prereq = (error as { prerequisite?: string })?.prerequisite;
  if (
    prereq === 'invalid-read-receipt-channel' ||
    prereq === 'invalid-outbound-channel' ||
    status === 400 ||
    status === 403 ||
    status === 404 ||
    code === 'DEFINITE_REJECT' ||
    rawMessage.includes('target-unavailable') ||
    rawMessage.includes('definite-reject')
  ) {
    return { kind: 'not-delivered', error: redacted };
  }
  return { kind: 'unknown', error: redacted };
}

export function resolveIsolatedCronCwd(cwdBase: string, jobId: string): string {
  mkdirSync(cwdBase, { recursive: true, mode: 0o700 });
  const baseReal = realpathSync(cwdBase);
  const targetDir = resolve(baseReal, `cron-${jobId}`);
  if (!targetDir.startsWith(baseReal + sep)) {
    throw new Error('Isolated cron cwd escaped cwdBase');
  }
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(targetDir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('Isolated cron cwd must be a real directory');
  }
  return targetDir;
}

export class CronExecutor {
  readonly #deps: CronExecutorDependencies;
  readonly #active = new Map<string, ActiveExecutionHandle>();

  constructor(deps: CronExecutorDependencies) {
    this.#deps = deps;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  isRunning(jobId: string): boolean {
    for (const h of this.#active.values()) {
      if (h.jobId === jobId) return true;
    }
    return false;
  }

  cancelJob(
    jobId: string,
    reason: 'job-removed' | 'job-disabled' | 'job-edited' | 'shutdown' | 'reload',
  ): void {
    for (const h of this.#active.values()) {
      if (h.jobId === jobId) {
        h.cancelReason = reason;
        h.controller.abort(new Error(reason));
      }
    }
  }

  cancelSessionRuns(sessionKey: string, reason: 'reset' = 'reset'): void {
    // 1. Cancel any queued session-mode run for this sessionKey
    const nonTerminal = this.#deps.store.listNonTerminalRuns();
    for (const row of nonTerminal) {
      if (row.status === 'queued' && row.exec_mode === 'session') {
        try {
          const snap = JSON.parse(row.definition_snapshot_json) as Definition;
          if (snap.target?.sessionKey === sessionKey) {
            const ownership = Object.freeze({
              ownerIncarnation: row.owner_incarnation,
              resetGeneration: row.reset_generation,
              assertHeld: () => {
                this.#deps.issuer.buildOwnership(sessionKey).assertHeld();
              },
            });
            this.#deps.store.finalize({ allConversations: true }, row.job_id, {
              expected: terminalExpectation(row),
              ownership,
              outcome: { kind: 'neutral', reason: 'reset' },
              ...(row.attempt > 0 ? { retryChain: true } : {}),
              effects: {},
            });
          }
        } catch {
          // ignore if concurrently finalized
        }
      }
    }
    // 2. Abort any active running session-mode run for this sessionKey
    for (const h of this.#active.values()) {
      if (h.sessionKey === sessionKey && h.execMode === 'session') {
        h.cancelReason = reason;
        h.controller.abort(new Error(reason));
      }
    }
  }

  async cancelAllAndDrain(reason: 'shutdown' | 'reload' = 'shutdown'): Promise<void> {
    for (const h of this.#active.values()) {
      h.cancelReason = reason;
      h.controller.abort(new Error(reason));
    }
    const promises = [...this.#active.values()].map((h) => h.promise).filter(Boolean);
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  executeAdmittedRun(run: Readonly<RunRow>): Promise<void> {
    const existing = this.#active.get(run.run_id);
    if (existing?.promise) return existing.promise;

    const snap = JSON.parse(run.definition_snapshot_json) as Definition & {
      readonly policy: { readonly tools: 'none' | 'octo-standard' };
    };
    const handle: ActiveExecutionHandle = {
      runId: run.run_id,
      jobId: run.job_id,
      sessionKey: snap.target.sessionKey,
      execMode: snap.execMode,
      controller: new AbortController(),
    };
    this.#active.set(run.run_id, handle);

    const promise = this.#runInternal(run, snap, handle).finally(() => {
      this.#active.delete(run.run_id);
      this.#deps.onRunFinalized?.();
    });
    handle.promise = promise;
    return promise;
  }

  #ownershipForRun(run: Readonly<RunRow>, sessionKey: string) {
    return Object.freeze({
      ownerIncarnation: run.owner_incarnation,
      resetGeneration: run.reset_generation,
      assertHeld: () => {
        this.#deps.issuer.buildOwnership(sessionKey).assertHeld();
      },
    });
  }

  async #runInternal(
    run: Readonly<RunRow>,
    snapshot: Definition & { readonly policy: { readonly tools: 'none' | 'octo-standard' } },
    handle: ActiveExecutionHandle,
  ): Promise<void> {
    const scope = { allConversations: true as const };
    const ownership = this.#ownershipForRun(run, snapshot.target.sessionKey);

    // 1. Revalidate creator and target authority at execution start
    if (
      !this.#deps.issuer.isCreatorAuthorized(snapshot.creatorUid) ||
      !this.#deps.issuer.isTargetAuthorized(snapshot.target)
    ) {
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(run),
        ownership,
        outcome: { kind: 'neutral', reason: 'authority_revoked' },
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    const jobRow = this.#deps.store.get(scope, run.job_id);
    const jobName = jobRow?.name ?? run.job_id;
    const tz = jobRow?.tz ?? this.#deps.config.defaultTimezone;

    // 2. Reminder payload path (never starts a model thread)
    if (snapshot.payload.kind === 'reminder') {
      const reminderText = snapshot.payload.text;
      if (snapshot.deliveryMode === 'none') {
        const res = this.#deps.store.finalize(scope, run.job_id, {
          expected: terminalExpectation(run),
          ownership,
          outcome: { kind: 'success', deliveryState: 'not-requested' },
          ...(run.attempt > 0 ? { retryChain: true } : {}),
          effects: {},
        });
        this.#afterFinalize(run, snapshot, res);
        return;
      }
      if (!reminderText.trim() || isSilentNoReply(reminderText)) {
        const res = this.#deps.store.finalize(scope, run.job_id, {
          expected: terminalExpectation(run),
          ownership,
          outcome: { kind: 'success', deliveryState: 'suppressed' },
          ...(run.attempt > 0 ? { retryChain: true } : {}),
          effects: {},
        });
        this.#afterFinalize(run, snapshot, res);
        return;
      }
      await this.#deliverAndFinalize(run, snapshot, jobName, tz, reminderText, 'cron.reminder', {});
      return;
    }

    // 3. agentTurn payload path (isolated or session)
    const timeoutSeconds = snapshot.payload.timeoutSeconds ?? this.#deps.config.defaultTimeoutSeconds;
    const timeoutMs = timeoutSeconds * 1000;
    const timeStr = formatZonedTime(this.#deps.clock.now(), tz);
    const prompt = `[scheduled task ${run.job_id} "${sanitizeDisplayText(jobName)}"] ${timeStr}\n[Unattended scheduled execution — complete the task directly without asking for interactive confirmation; reply NO_REPLY if no notification is needed]\n\n${sanitizePromptBody(snapshot.payload.message)}`;

    let cwd = this.#deps.cwdBase;
    if (snapshot.execMode === 'isolated') {
      try {
        cwd = resolveIsolatedCronCwd(this.#deps.cwdBase, run.job_id);
      } catch (err) {
        const res = this.#deps.store.finalize(scope, run.job_id, {
          expected: terminalExpectation(run),
          ownership,
          outcome: {
            kind: 'failure',
            reason: 'invalid-definition',
            redactedError: redactSecrets(err instanceof Error ? err.message : 'invalid cwd').slice(0, 500),
          },
          retryRunId: `r_${randomUUID()}`,
          ...(run.attempt > 0 ? { retryChain: true } : {}),
          effects: {
            allowAlertIntent: true,
            allowDisableNotice: true,
            alertAfter: this.#deps.config.failureAlert.after,
            alertCooldownMs: this.#deps.config.failureAlert.cooldownMs,
          },
        });
        this.#afterFinalize(run, snapshot, res);
        return;
      }
    }

    let turnOutcome: CronTurnExecutionOutcome;
    try {
      const execInput: CronTurnExecutionInput = {
        run,
        snapshot,
        jobName,
        tz,
        prompt,
        cwd,
        model: snapshot.payload.model,
        effort: snapshot.payload.effort as CronTurnExecutionInput['effort'],
        timeoutMs,
        admissionWaitMs: this.#deps.config.admissionWaitMs,
        signal: handle.controller.signal,
      };
      turnOutcome =
        snapshot.execMode === 'session'
          ? await this.#deps.executeSessionTurn(execInput)
          : await this.#deps.executeIsolatedTurn(execInput);
    } catch (err) {
      if (handle.cancelReason) {
        turnOutcome = { kind: 'cancelled', reason: handle.cancelReason };
      } else {
        const classified = classifyExecutionError(err);
        turnOutcome = { kind: 'error', reason: classified.reason, error: classified.message };
      }
    }

    if (handle.cancelReason && turnOutcome.kind !== 'ok') {
      turnOutcome = { kind: 'cancelled', reason: handle.cancelReason };
    }

    // Check if the job was tombstoned while executing (before delivery starts)
    const currentJob = this.#deps.store.get(scope, run.job_id);
    if (currentJob?.deleted_at !== null && turnOutcome.kind !== 'cancelled') {
      turnOutcome = { kind: 'cancelled', reason: 'job-removed' };
    }

    if (turnOutcome.kind === 'cancelled') {
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(run),
        ownership,
        outcome: { kind: 'neutral', reason: turnOutcome.reason },
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    if (turnOutcome.kind === 'busy') {
      // session-busy happens during admission phase: ensure receipt phase is 'admission' if required by terminal.ts
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(run),
        ownership,
        outcome: {
          kind: 'failure',
          reason: 'session-busy',
          redactedError: 'session busy at admission deadline',
        },
        retryRunId: `r_${randomUUID()}`,
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {
          allowAlertIntent: true,
          allowDisableNotice: true,
          alertAfter: this.#deps.config.failureAlert.after,
          alertCooldownMs: this.#deps.config.failureAlert.cooldownMs,
        },
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    if (turnOutcome.kind === 'error') {
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(run),
        ownership,
        outcome: {
          kind: 'failure',
          reason: turnOutcome.reason,
          redactedError: redactSecrets(turnOutcome.error).slice(0, 500) || 'execution error',
        },
        retryRunId: `r_${randomUUID()}`,
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {
          allowAlertIntent: true,
          allowDisableNotice: true,
          alertAfter: this.#deps.config.failureAlert.after,
          alertCooldownMs: this.#deps.config.failureAlert.cooldownMs,
        },
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    // turnOutcome.kind === 'ok'
    const text = turnOutcome.text ?? '';
    const metadata = {
      threadId: turnOutcome.threadId ?? null,
      turnId: turnOutcome.turnId ?? null,
      model: turnOutcome.model ?? snapshot.payload.model ?? null,
      usageJson: turnOutcome.usageJson ?? null,
      summary: text ? redactSecrets(text).slice(0, 500) : null,
      laneWaitMs: turnOutcome.laneWaitMs ?? null,
    };

    if (snapshot.deliveryMode === 'none') {
      const updated = this.#deps.store.recordExecutionMetadata(scope, run.job_id, run.run_id, metadata, ownership);
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(updated),
        ownership,
        outcome: { kind: 'success', deliveryState: 'not-requested' },
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    if (!text.trim() || isSilentNoReply(text)) {
      const updated = this.#deps.store.recordExecutionMetadata(scope, run.job_id, run.run_id, metadata, ownership);
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(updated),
        ownership,
        outcome: { kind: 'success', deliveryState: 'suppressed' },
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    await this.#deliverAndFinalize(run, snapshot, jobName, tz, text, 'cron.result', metadata);
  }

  async #deliverAndFinalize(
    run: Readonly<RunRow>,
    snapshot: Definition,
    jobName: string,
    tz: string,
    text: string,
    kind: 'cron.result' | 'cron.reminder',
    metadata: {
      threadId?: string | null;
      turnId?: string | null;
      model?: string | null;
      usageJson?: string | null;
      summary?: string | null;
      laneWaitMs?: number | null;
    },
  ): Promise<void> {
    const scope = { allConversations: true as const };
    const ownership = this.#ownershipForRun(run, snapshot.target.sessionKey);

    // Commit phase='delivering', delivery_state='started' BEFORE first outbound send
    let deliveringRun = this.#deps.store.beginDelivery(scope, run.job_id, {
      expected: terminalExpectation(run) as ReturnType<typeof terminalExpectation> & { readonly status: 'running' },
      ownership,
      metadata,
    });

    let segmentsSent = 0;
    try {
      const segments = this.#deps.prepareOutboundSegments
        ? await this.#deps.prepareOutboundSegments(text, snapshot.target)
        : [text];
      await this.#deps.egress.sendSegments({
        kind,
        channelId: snapshot.target.channelId,
        channelType: snapshot.target.channelType,
        segments,
        originId: run.run_id,
        ordinal: 0,
        onSegmentDelivered: (segIdx) => {
          segmentsSent = segIdx + 1;
          deliveringRun = this.#deps.store.recordSegmentDelivered(
            scope,
            run.job_id,
            run.run_id,
            segmentsSent,
            ownership,
          );
        },
      });
    } catch (err) {
      const classified = classifyDeliveryFailure(err, segmentsSent);
      if (classified.kind === 'not-delivered') {
        const res = this.#deps.store.finalize(scope, run.job_id, {
          expected: terminalExpectation(deliveringRun),
          ownership,
          outcome: {
            kind: 'failure',
            reason: 'target-unavailable',
            redactedError: classified.error,
          },
          ...(run.attempt > 0 ? { retryChain: true } : {}),
          effects: {
            allowAlertIntent: true,
            allowDisableNotice: true,
            alertAfter: this.#deps.config.failureAlert.after,
            alertCooldownMs: this.#deps.config.failureAlert.cooldownMs,
          },
        });
        this.#afterFinalize(run, snapshot, res);
        return;
      }

      // Ambiguous or partial send -> unknown (never resent or replayed)
      const res = this.#deps.store.finalize(scope, run.job_id, {
        expected: terminalExpectation(deliveringRun),
        ownership,
        outcome: {
          kind: 'success',
          deliveryState: 'unknown',
          reason: 'network',
          error: classified.error,
        },
        ...(run.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      this.#afterFinalize(run, snapshot, res);
      return;
    }

    const deliveredAtStr = formatZonedTime(this.#deps.clock.now(), tz);
    const noteText = `[scheduled task ${run.job_id} "${sanitizeDisplayText(jobName)}" delivered at ${deliveredAtStr}]\n${text}`;
    const res = this.#deps.store.finalize(scope, run.job_id, {
      expected: terminalExpectation(deliveringRun),
      ownership,
      outcome: { kind: 'success', deliveryState: 'delivered' },
      ...(run.attempt > 0 ? { retryChain: true } : {}),
      effects: {
        allowAlertIntent: true,
        allowDisableNotice: true,
        publication: {
          botName: this.#deps.botName ?? this.#deps.botId,
          content: text,
          noteText,
        },
      },
    });
    this.#afterFinalize(run, snapshot, res);
  }

  #afterFinalize(
    run: Readonly<RunRow>,
    snapshot: Definition,
    result: ReturnType<CronStore['finalize']>,
  ): void {
    if (result.kind !== 'finalized') return;
    const finalRun = result.run;
    this.#deps.emitAudit?.({
      actor: snapshot.creatorUid,
      action: 'cron.finalize',
      target: run.job_id,
      outcome: finalRun.status === 'error' ? 'error' : 'ok',
      detail: `run=${run.run_id},trigger=${run.trigger},attempt=${run.attempt},status=${finalRun.status},completion=${finalRun.completion ?? '-'},delivery=${finalRun.delivery_state},reason=${finalRun.reason ?? '-'}`,
    });

    if (result.alertIntent && this.#deps.config.failureAlert.enabled) {
      void this.dispatchAlertNotice(result.alertIntent);
    }
    if (result.disableNotice) {
      void this.dispatchDisableNotice(result.disableNotice);
    }
  }

  async dispatchAlertNotice(alert: AlertIntent): Promise<void> {
    const nextText = alert.nextRunAt !== null ? formatZonedTime(alert.nextRunAt, alert.tz) : 'none';
    const content = StringCatalog.cronAlert(alert.jobId, alert.name, alert.count, alert.reason, nextText);
    const originId = `${alert.jobId}:${alert.incidentKey}`;
    const targets: Array<{ channelId: string; channelType: 1 | 2 | 5 }> = [];
    const ownerChannel = this.#deps.getOwnerChannelId?.()?.trim() || this.#deps.getOwnerUid()?.trim();
    if (ownerChannel) {
      targets.push({ channelId: ownerChannel, channelType: 1 });
    }
    if (
      this.#deps.config.failureAlert.notifyCreator &&
      alert.target.channelId &&
      !targets.some((t) => t.channelId === alert.target.channelId && t.channelType === alert.target.channelType)
    ) {
      targets.push({ channelId: alert.target.channelId, channelType: alert.target.channelType });
    }
    for (const target of targets) {
      try {
        await this.#deps.egress.sendText({
          kind: 'cron.alert',
          channelId: target.channelId,
          channelType: target.channelType,
          content,
          originId,
          ordinal: alert.occurrence,
        });
      } catch {
        // Best-effort post-commit alert send
      }
    }
  }

  async dispatchDisableNotice(notice: DisableNoticeIntent): Promise<void> {
    const content = StringCatalog.cronDisabledNotice(notice.jobId, notice.name, notice.reason);
    const originId = `${notice.jobId}:${notice.generation}`;
    const targets: Array<{ channelId: string; channelType: 1 | 2 | 5 }> = [
      { channelId: notice.target.channelId, channelType: notice.target.channelType },
    ];
    const ownerChannel = this.#deps.getOwnerChannelId?.()?.trim() || this.#deps.getOwnerUid()?.trim();
    if (ownerChannel && !targets.some((t) => t.channelId === ownerChannel && t.channelType === 1)) {
      targets.push({ channelId: ownerChannel, channelType: 1 });
    }
    for (const target of targets) {
      try {
        await this.#deps.egress.sendText({
          kind: 'cron.disabled_notice',
          channelId: target.channelId,
          channelType: target.channelType,
          content,
          originId,
          ordinal: 0,
        });
      } catch {
        // Best-effort post-commit disable notice send
      }
    }
  }
}

export interface CronStatusSummary {
  readonly state: 'enabled' | 'disabled';
  readonly disabledReason?: 'executor-sdk' | 'config-disabled' | 'env-skip';
  readonly jobs: number;
  readonly enabled: number;
  readonly nextWakeAt: number | null;
  readonly running: number;
  readonly lastErrors: ReadonlyArray<{
    readonly jobId: string;
    readonly reason: string | null;
    readonly error: string | null;
    readonly at: number | null;
  }>;
}

export interface CronSchedulerOptions {
  readonly botId: string;
  readonly dataDir: string;
  readonly store: CronStore;
  readonly service: CronService;
  readonly executor: CronExecutor;
  readonly config: ResolvedCronConfig;
  readonly issuer: CronAdmissionIssuer;
  readonly clock?: CronTimerClock;
  readonly state: 'enabled' | 'disabled';
  readonly disabledReason?: 'executor-sdk' | 'config-disabled' | 'env-skip';
  readonly getIncarnationId: () => string;
  readonly onStatusChanged?: (summary: CronStatusSummary) => void;
}

export class CronScheduler {
  readonly #opts: CronSchedulerOptions;
  readonly #clock: CronTimerClock;
  readonly #catchupNotBefore = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nextWakeAt: number | null = null;
  #lastTickAt: number | null = null;
  #ticking = false;
  #wakePending = false;
  #stopped = false;
  #started = false;

  constructor(opts: CronSchedulerOptions) {
    this.#opts = opts;
    this.#clock = opts.clock ?? defaultCronClock;
  }

  get state(): 'enabled' | 'disabled' {
    return this.#opts.state;
  }

  get disabledReason(): 'executor-sdk' | 'config-disabled' | 'env-skip' | undefined {
    return this.#opts.disabledReason;
  }

  statusSummary(): CronStatusSummary {
    const scope = { allConversations: true as const };
    const totalJobs = this.#opts.store.countJobs(scope, { includeDisabled: true, includeDeleted: false });
    const enabledJobs = this.#opts.store.countJobs(scope, { includeDisabled: false, includeDeleted: false });
    const allJobs = totalJobs > 0 ? this.#opts.store.list(scope, { includeDisabled: true, limit: 100 }) : [];
    const lastErrors = allJobs
      .filter((j) => j.last_status === 'error' || j.auto_disabled_reason !== null)
      .slice(0, 5)
      .map((j) => ({
        jobId: j.id,
        reason: j.last_error_reason ?? j.auto_disabled_reason,
        error: j.last_error,
        at: j.last_run_at ?? j.auto_disabled_at,
      }));
    return Object.freeze({
      state: this.#opts.state,
      ...(this.#opts.disabledReason ? { disabledReason: this.#opts.disabledReason } : {}),
      jobs: totalJobs,
      enabled: enabledJobs,
      nextWakeAt: this.#nextWakeAt,
      running: this.#opts.executor.activeCount,
      lastErrors: Object.freeze(lastErrors),
    });
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    if (this.#opts.state !== 'enabled') {
      this.#opts.onStatusChanged?.(this.statusSummary());
      return;
    }
    this.#recoverOnStartup();
    this.#lastTickAt = this.#clock.now();
    this.wake();
  }

  #recoverOnStartup(): void {
    const scope = { allConversations: true as const };
    const currentIncarnation = this.#opts.getIncarnationId();
    const nonTerminal = this.#opts.store.listNonTerminalRuns();

    // 1. Reconcile any active/queued receipts from previous incarnations
    for (const row of nonTerminal) {
      if (row.owner_incarnation === currentIncarnation) continue;
      try {
        const snap = JSON.parse(row.definition_snapshot_json) as Definition;
        const ownership = Object.freeze({
          ownerIncarnation: currentIncarnation,
          resetGeneration: row.reset_generation,
          assertHeld: () => {
            this.#opts.issuer.buildOwnership(snap.target.sessionKey).assertHeld();
          },
        });
        const res = this.#opts.store.reconcileRestart(scope, row.job_id, {
          expected: terminalExpectation(row),
          ownership,
          effects: {
            allowAlertIntent: true,
            allowDisableNotice: true,
            alertAfter: this.#opts.config.failureAlert.after,
            alertCooldownMs: this.#opts.config.failureAlert.cooldownMs,
          },
        });
        if (res.kind === 'repaired' || res.kind === 'finalized') {
          if ('alertIntent' in res && res.alertIntent && this.#opts.config.failureAlert.enabled) {
            void this.#opts.executor.dispatchAlertNotice(res.alertIntent);
          }
          if ('disableNotice' in res && res.disableNotice) {
            void this.#opts.executor.dispatchDisableNotice(res.disableNotice);
          }
        }
      } catch {
        // Ignore if receipt cannot be reconciled without previous-child scope
      }
    }

    // 2. Prune expired history only if there are runs in the store
    const anyJobCount = this.#opts.store.countJobs(scope, { includeDisabled: true, includeDeleted: true });
    if (anyJobCount > 0) {
      try {
        this.#opts.store.pruneHistory(this.#opts.config.history);
      } catch {
        // Non-fatal on startup if integrity check defers pruning
      }
    }

    // 3. Plan startup catch-up for overdue enabled jobs
    const now = this.#clock.now();
    const dueJobs = this.#opts.store.dueCandidates(scope, now, 100);
    if (dueJobs.length === 0) return;

    let catchupOrdinal = 0;
    for (const job of dueJobs) {
      try {
        const definition = this.#opts.store.definition(scope, job.id);
        const schedule: Schedule =
          definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: job.id } : definition.schedule;

        if (this.#opts.config.skipMissedJobs && definition.schedule.kind !== 'at') {
          // Advance recurring schedule to slot(now) without firing missed slots
          this.#opts.store.enable(scope, job.id, job.generation);
          continue;
        }

        const slot =
          definition.schedule.kind === 'at'
            ? definition.schedule.atMs <= now
              ? definition.schedule.atMs
              : undefined
            : previousOrBefore(schedule, now);
        if (
          slot === undefined ||
          slot < job.schedule_activated_at ||
          (job.last_slot_watermark !== null && slot <= job.last_slot_watermark)
        ) {
          continue;
        }

        const ownership = this.#opts.issuer.buildOwnership(definition.target.sessionKey);
        const authority = this.#opts.issuer.buildAuthority(job.id, definition, ownership);
        if (!authority.creatorAuthorized || !authority.targetAuthorized) {
          continue;
        }

        const admitted = this.#opts.store.admitBase(scope, job.id, {
          trigger: 'catchup',
          slot,
          generation: job.generation,
          runId: `r_${randomUUID()}`,
          authority,
          ownership,
        });
        if (admitted.kind === 'reserved') {
          const staggerDelayMs = catchupOrdinal >= 5 ? (catchupOrdinal - 4) * 5_000 : 0;
          const agentDeferMs = definition.payload.kind === 'agentTurn' ? this.#opts.config.catchupDeferMs : 0;
          const totalDeferMs = Math.max(staggerDelayMs, agentDeferMs);
          if (totalDeferMs > 0) {
            this.#catchupNotBefore.set(admitted.run.run_id, now + totalDeferMs);
          }
          catchupOrdinal += 1;
        }
      } catch {
        // Record schedule error if definition evaluation fails
        try {
          const ownership = this.#opts.issuer.buildOwnership(job.target_session);
          const errRes = this.#opts.store.recordScheduleError(scope, job.id, job.generation, ownership);
          if (errRes.disableNotice) {
            void this.#opts.executor.dispatchDisableNotice(errRes.disableNotice);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  wake(): void {
    if (!this.#started || this.#stopped || this.#opts.state !== 'enabled') return;
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#runTick();
  }

  #runTick(): void {
    if (this.#stopped || this.#opts.state !== 'enabled') return;
    if (this.#ticking) {
      this.#wakePending = true;
      return;
    }
    this.#ticking = true;
    try {
      const now = this.#clock.now();
      const forwardJump = this.#lastTickAt !== null && now - this.#lastTickAt > 120_000;
      this.#lastTickAt = now;

      const scope = { allConversations: true as const };
      let earliestWakeAt: number | null = null;
      const updateEarliest = (candidate: number | null | undefined): void => {
        if (candidate === null || candidate === undefined || !Number.isFinite(candidate)) return;
        if (earliestWakeAt === null || candidate < earliestWakeAt) {
          earliestWakeAt = candidate;
        }
      };

      // 1. Reserve due base occurrences
      const dueJobs = this.#opts.store.dueCandidates(scope, now, 50);
      for (const job of dueJobs) {
        try {
          const definition = this.#opts.store.definition(scope, job.id);
          const schedule: Schedule =
            definition.schedule.kind === 'cron' ? { ...definition.schedule, jobId: job.id } : definition.schedule;
          const latestSlot =
            definition.schedule.kind === 'at' ? definition.schedule.atMs : previousOrBefore(schedule, now);
          if (latestSlot === undefined) continue;

          const useCatchup =
            forwardJump ||
            (job.next_run_at !== null &&
              definition.schedule.kind !== 'at' &&
              latestSlot > job.next_run_at);
          const trigger = useCatchup ? 'catchup' : 'scheduled';
          const slot = useCatchup ? latestSlot : (job.next_run_at ?? latestSlot);

          const ownership = this.#opts.issuer.buildOwnership(definition.target.sessionKey);
          const authority = Object.freeze({
            ...this.#opts.issuer.buildAuthority(job.id, definition, ownership),
            creatorAuthorized: true as const,
            targetAuthorized: true as const,
          });

          const res = this.#opts.store.admitBase(scope, job.id, {
            trigger,
            slot,
            generation: job.generation,
            runId: `r_${randomUUID()}`,
            authority,
            ownership,
          });
          if (res.kind === 'deferred' && 'recheckAfterMs' in res) {
            updateEarliest(now + res.recheckAfterMs);
          }
        } catch {
          try {
            const ownership = this.#opts.issuer.buildOwnership(job.target_session);
            const errRes = this.#opts.store.recordScheduleError(scope, job.id, job.generation, ownership);
            if (errRes.disableNotice) {
              void this.#opts.executor.dispatchDisableNotice(errRes.disableNotice);
            }
          } catch {
            updateEarliest(now + 30_000);
          }
        }
      }

      // 2. Dispatch ready queued receipts within maxConcurrentRuns semaphore
      const nonTerminal = this.#opts.store.listNonTerminalRuns();
      for (const row of nonTerminal) {
        if (row.status !== 'queued') continue;
        const deferUntil = this.#catchupNotBefore.get(row.run_id);
        if (deferUntil !== undefined && now < deferUntil) {
          updateEarliest(deferUntil);
          continue;
        }
        if (row.ready_at > now) {
          updateEarliest(row.ready_at);
          continue;
        }
        if (this.#opts.executor.activeCount >= this.#opts.config.maxConcurrentRuns) {
          break;
        }
        this.#dispatchQueuedRun(row, now, updateEarliest);
      }

      // 3. Compute next wake from earliest enabled job next_run_at
      const upcomingJobs = this.#opts.store.list(scope, { includeDisabled: false, limit: 50 });
      for (const j of upcomingJobs) {
        if (j.next_run_at !== null) {
          updateEarliest(j.next_run_at);
        }
      }

      this.#nextWakeAt = earliestWakeAt;
      const delayMs =
        earliestWakeAt !== null
          ? Math.min(30_000, Math.max(10, earliestWakeAt - now))
          : 30_000;
      this.#timer = this.#clock.setTimeout(() => {
        this.#timer = null;
        this.#runTick();
      }, delayMs);
      this.#timer.unref?.();
      this.#opts.onStatusChanged?.(this.statusSummary());
    } finally {
      this.#ticking = false;
      if (this.#wakePending && !this.#stopped) {
        this.#wakePending = false;
        this.wake();
      }
    }
  }

  #dispatchQueuedRun(
    row: Readonly<RunRow>,
    now: number,
    updateEarliest: (ms: number) => void,
  ): void {
    const scope = { allConversations: true as const };
    let snapshot: Definition;
    try {
      snapshot = JSON.parse(row.definition_snapshot_json) as Definition;
    } catch {
      return;
    }

    // Check creator and target authority before execution admission
    if (
      !this.#opts.issuer.isCreatorAuthorized(snapshot.creatorUid) ||
      !this.#opts.issuer.isTargetAuthorized(snapshot.target)
    ) {
      const ownership = Object.freeze({
        ownerIncarnation: row.owner_incarnation,
        resetGeneration: row.reset_generation,
        assertHeld: () => {
          this.#opts.issuer.buildOwnership(snapshot.target.sessionKey).assertHeld();
        },
      });
      this.#opts.store.finalize(scope, row.job_id, {
        expected: terminalExpectation(row),
        ownership,
        outcome: { kind: 'neutral', reason: 'authority_revoked' },
        ...(row.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      return;
    }

    const job = this.#opts.store.get(scope, row.job_id);
    if (!job || job.deleted_at !== null) {
      const ownership = Object.freeze({
        ownerIncarnation: row.owner_incarnation,
        resetGeneration: row.reset_generation,
        assertHeld: () => {
          this.#opts.issuer.buildOwnership(snapshot.target.sessionKey).assertHeld();
        },
      });
      this.#opts.store.finalize(scope, row.job_id, {
        expected: terminalExpectation(row),
        ownership,
        outcome: { kind: 'neutral', reason: 'job-removed' },
        ...(row.attempt > 0 ? { retryChain: true } : {}),
        effects: {},
      });
      return;
    }

    try {
      const definition = this.#opts.store.definition(scope, row.job_id);
      const execReq = this.#opts.issuer.issueExecutionRequest(row, definition);
      const admitRes =
        row.trigger === 'manual'
          ? this.#opts.store.startManual(scope, row.job_id, execReq)
          : row.trigger === 'retry'
            ? this.#opts.store.admitRetry(scope, row.job_id, execReq)
            : this.#opts.store.startBase(scope, row.job_id, execReq);

      if (admitRes.kind === 'admitted') {
        this.#catchupNotBefore.delete(row.run_id);
        void this.#opts.executor.executeAdmittedRun(admitRes.run);
      } else if (admitRes.kind === 'deferred') {
        if ('recheckAfterMs' in admitRes) {
          updateEarliest(now + admitRes.recheckAfterMs);
        } else if (admitRes.prerequisite === 'issuer-unavailable' || admitRes.prerequisite === 'permit-not-current') {
          // Runtime unavailable at cron fire -> transition to running and finalize error(runtime_unavailable) or retry
          updateEarliest(now + 5_000);
        }
      }
    } catch {
      updateEarliest(now + 5_000);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== null) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#catchupNotBefore.clear();

    if (this.#opts.state !== 'enabled') return;

    // 1. Transition any queued runs to skipped(stopped)
    const scope = { allConversations: true as const };
    const nonTerminal = this.#opts.store.listNonTerminalRuns();
    for (const row of nonTerminal) {
      if (row.status === 'queued') {
        try {
          const snap = JSON.parse(row.definition_snapshot_json) as Definition;
          const ownership = Object.freeze({
            ownerIncarnation: row.owner_incarnation,
            resetGeneration: row.reset_generation,
            assertHeld: () => {
              this.#opts.issuer.buildOwnership(snap.target.sessionKey).assertHeld();
            },
          });
          this.#opts.store.finalize(scope, row.job_id, {
            expected: terminalExpectation(row),
            ownership,
            outcome: { kind: 'neutral', reason: 'stopped' },
            ...(row.attempt > 0 ? { retryChain: true } : {}),
            effects: {},
          });
        } catch {
          // ignore if concurrently finalized
        }
      }
    }

    // 2. Abort and drain any active running executions (interrupted(shutdown))
    await this.#opts.executor.cancelAllAndDrain('shutdown');
  }
}

export interface ControlSocketRequest {
  readonly id: string;
  readonly method: 'cron.command' | 'cron.status';
  readonly params?: {
    readonly command?: string;
    readonly sessionKey?: string;
    readonly channelId?: string;
    readonly channelType?: 1 | 2 | 5;
    readonly creatorId?: string;
  };
}

export interface ControlSocketResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly reply?: string;
  readonly isError?: boolean;
  readonly status?: CronStatusSummary;
  readonly error?: string;
}

function withSocketDir<T>(sockPath: string, fn: (bindTarget: string) => T): T {
  if (Buffer.byteLength(sockPath, 'utf8') < 100) {
    return fn(sockPath);
  }
  const prevCwd = process.cwd();
  process.chdir(dirname(sockPath));
  try {
    return fn(basename(sockPath));
  } finally {
    process.chdir(prevCwd);
  }
}

export class CronControlServer {
  readonly #sockPath: string;
  readonly #service: CronService;
  readonly #scheduler: CronScheduler;
  readonly #getOwnerUid: () => string | undefined;
  readonly #sockets = new Set<Socket>();
  #server: NetServer | null = null;

  constructor(opts: {
    dataDir: string;
    service: CronService;
    scheduler: CronScheduler;
    getOwnerUid: () => string | undefined;
  }) {
    this.#sockPath = join(opts.dataDir, 'control.sock');
    this.#service = opts.service;
    this.#scheduler = opts.scheduler;
    this.#getOwnerUid = opts.getOwnerUid;
  }

  get socketPath(): string {
    return this.#sockPath;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    try {
      if (existsSync(this.#sockPath)) {
        unlinkSync(this.#sockPath);
      }
    } catch {
      // ignore
    }

    const server = createServer((socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => {
        this.#sockets.delete(socket);
      });
      let buf = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          void this.#handleLine(line).then((resp) => {
            try {
              socket.write(JSON.stringify(resp) + '\n');
            } catch {
              // ignore socket write error
            }
          });
        }
      });
    });

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      withSocketDir(this.#sockPath, (bindTarget) => {
        server.listen(bindTarget, () => {
          server.removeListener('error', rejectPromise);
          try {
            chmodSync(this.#sockPath, 0o600);
          } catch {
            // ignore
          }
          resolvePromise();
        });
      });
    });
    server.unref();
    this.#server = server;
  }

  async #handleLine(line: string): Promise<ControlSocketResponse> {
    let req: ControlSocketRequest;
    try {
      req = JSON.parse(line) as ControlSocketRequest;
    } catch {
      return { id: 'unknown', ok: false, error: 'Invalid JSON request' };
    }
    if (req.method === 'cron.status') {
      return {
        id: req.id,
        ok: true,
        status: this.#scheduler.statusSummary(),
      };
    }
    if (req.method === 'cron.command') {
      const command = req.params?.command ?? '';
      const ownerUid = req.params?.creatorId?.trim() || this.#getOwnerUid()?.trim() || 'local-operator';
      const sessionKey = req.params?.sessionKey?.trim() || ownerUid;
      const channelId = req.params?.channelId?.trim() || sessionKey;
      const channelType = req.params?.channelType ?? 1;
      const res = await this.#service.executeSlashCommand(command, {
        senderUid: ownerUid,
        isOwner: true,
        isCronManager: true,
        isGroup: channelType !== 1,
        sessionKey,
        channelId,
        channelType,
        allowGlobalOperator: true,
      });
      return {
        id: req.id,
        ok: !res.isError,
        reply: res.reply,
        isError: res.isError,
      };
    }
    return { id: req.id, ok: false, error: `Unknown method: ${String(req.method)}` };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const s of this.#sockets) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    this.#sockets.clear();
    if (server) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    }
    try {
      if (existsSync(this.#sockPath)) {
        unlinkSync(this.#sockPath);
      }
    } catch {
      // ignore
    }
  }
}

export async function sendControlSocketRequest(
  sockPath: string,
  req: ControlSocketRequest,
  timeoutMs = 5_000,
): Promise<ControlSocketResponse> {
  return new Promise<ControlSocketResponse>((resolvePromise, rejectPromise) => {
    const client = withSocketDir(sockPath, (bindTarget) => connectSocket(bindTarget));
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        rejectPromise(new Error('Control socket request timed out'));
      }
    }, timeoutMs);

    client.setEncoding('utf8');
    client.on('connect', () => {
      client.write(JSON.stringify(req) + '\n');
    });
    client.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        const line = buf.slice(0, idx).trim();
        client.end();
        try {
          resolvePromise(JSON.parse(line) as ControlSocketResponse);
        } catch (err) {
          rejectPromise(err);
        }
      }
    });
    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      }
    });
  });
}

export interface BotStatusSnapshotV2 {
  readonly schemaVersion: 2;
  readonly botId: string;
  readonly pid: number;
  readonly updatedAt: number;
  readonly state: 'running' | 'stopping' | 'stopped';
  readonly executor: 'sdk' | 'app-server';
  readonly cron: CronStatusSummary;
}

export function writeBotStatusSnapshot(dataDir: string, snapshot: BotStatusSnapshotV2): void {
  try {
    const statusPath = join(dataDir, 'status.json');
    const tmpPath = `${statusPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmpPath, statusPath);
  } catch {
    // Never crash bot on status snapshot write
  }
}
