// SPDX-License-Identifier: Apache-2.0
import { validateTimezone } from './schedule/engine.js';

export interface CronFailureAlertConfig {
  readonly enabled: boolean;
  readonly after: number;
  readonly cooldownMs: number;
  readonly notifyCreator: boolean;
}

export interface CronHistoryConfig {
  readonly retentionDays: number;
  readonly maxPerJob: number;
}

export interface CronConfigInput {
  enabled?: boolean;
  managers?: string[];
  explicitManagers?: boolean;
  defaultTimezone?: string;
  maxConcurrentRuns?: number;
  admissionWaitMs?: number;
  defaultTimeoutSeconds?: number;
  catchupDeferMs?: number;
  skipMissedJobs?: boolean;
  maxJobsPerBot?: number;
  maxJobsPerConversation?: number;
  minIntervalMs?: number;
  failureAlert?: Partial<CronFailureAlertConfig>;
  history?: Partial<CronHistoryConfig>;
}

export interface ResolvedCronConfig {
  readonly enabled: boolean;
  readonly managers: string[];
  readonly explicitManagers?: boolean;
  readonly defaultTimezone: string;
  readonly maxConcurrentRuns: number;
  readonly admissionWaitMs: number;
  readonly defaultTimeoutSeconds: number;
  readonly catchupDeferMs: number;
  readonly skipMissedJobs: boolean;
  readonly maxJobsPerBot: number;
  readonly maxJobsPerConversation: number;
  readonly minIntervalMs: number;
  readonly failureAlert: CronFailureAlertConfig;
  readonly history: CronHistoryConfig;
}

function intInRange(value: unknown, field: string, min: number, max: number, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer in [${min}, ${max}], got ${String(value)}`);
  }
  return value;
}

function boolOrDefault(value: unknown, field: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

export function resolveCronConfig(
  raw?: CronConfigInput,
  fallbackManagers: readonly string[] = [],
  hasExplicitManagers = false,
): ResolvedCronConfig {
  const input = raw ?? {};
  const enabled = boolOrDefault(input.enabled, 'cron.enabled', true);
  let defaultTimezone = 'Asia/Shanghai';
  if (input.defaultTimezone !== undefined) {
    if (typeof input.defaultTimezone !== 'string' || !input.defaultTimezone.trim()) {
      throw new RangeError('cron.defaultTimezone must be a valid IANA timezone');
    }
    defaultTimezone = validateTimezone(input.defaultTimezone.trim());
  }
  const explicit = hasExplicitManagers || input.explicitManagers === true || Array.isArray(input.managers);
  const managers = Array.isArray(input.managers)
    ? input.managers.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim())
    : explicit
      ? []
      : [...fallbackManagers];

  const alertInput = input.failureAlert ?? {};
  const historyInput = input.history ?? {};

  return {
    enabled,
    managers,
    ...(explicit ? { explicitManagers: true } : {}),
    defaultTimezone,
    maxConcurrentRuns: intInRange(input.maxConcurrentRuns, 'cron.maxConcurrentRuns', 1, 16, 2),
    admissionWaitMs: intInRange(input.admissionWaitMs, 'cron.admissionWaitMs', 1_000, 1_800_000, 300_000),
    defaultTimeoutSeconds: intInRange(input.defaultTimeoutSeconds, 'cron.defaultTimeoutSeconds', 10, 7_200, 1_800),
    catchupDeferMs: intInRange(input.catchupDeferMs, 'cron.catchupDeferMs', 0, 600_000, 120_000),
    skipMissedJobs: boolOrDefault(input.skipMissedJobs, 'cron.skipMissedJobs', false),
    maxJobsPerBot: intInRange(input.maxJobsPerBot, 'cron.maxJobsPerBot', 1, 1_000, 50),
    maxJobsPerConversation: intInRange(input.maxJobsPerConversation, 'cron.maxJobsPerConversation', 1, 200, 10),
    minIntervalMs: intInRange(input.minIntervalMs, 'cron.minIntervalMs', 1_000, 86_400_000, 60_000),
    failureAlert: {
      enabled: boolOrDefault(alertInput.enabled, 'cron.failureAlert.enabled', true),
      after: intInRange(alertInput.after, 'cron.failureAlert.after', 1, 100, 2),
      cooldownMs: intInRange(alertInput.cooldownMs, 'cron.failureAlert.cooldownMs', 0, 86_400_000 * 30, 3_600_000),
      notifyCreator: boolOrDefault(alertInput.notifyCreator, 'cron.failureAlert.notifyCreator', true),
    },
    history: {
      retentionDays: intInRange(historyInput.retentionDays, 'cron.history.retentionDays', 1, 3_650, 30),
      maxPerJob: intInRange(historyInput.maxPerJob, 'cron.history.maxPerJob', 1, 10_000, 200),
    },
  };
}
