// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { cron, every, normalizeAt, validateAt, validateTimezone } from './schedule/engine.js';
import type { JobRow, RunRow, ScheduleInput, StoredSchedule } from './store/types.js';

const CROCKFORD_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

export function generateJobId(isTaken?: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const bytes = randomBytes(6);
    let suffix = '';
    for (let i = 0; i < 6; i += 1) {
      suffix += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
    }
    const candidate = `j${suffix}`;
    if (!isTaken || !isTaken(candidate)) {
      return candidate;
    }
  }
  throw new Error('Failed to allocate unique job ID');
}

const SECRET_REGEXES: readonly RegExp[] = [
  new RegExp('-----' + 'BEGIN [A-Z0-9 ]*PRIVATE KEY' + '-----'),
  new RegExp('\\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_' + 'pat_[A-Za-z0-9_]{20,})\\b'),
  new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b'),
  new RegExp('\\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\\b'),
  new RegExp('\\bBearer\\s+[A-Za-z0-9._~+/=-]{16,}\\b', 'i'),
  new RegExp('\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b'),
  new RegExp('\\b(?:bf|app)_[A-Za-z0-9_-]{16,}\\b'),
];

export function containsSecretPattern(text: string): boolean {
  return SECRET_REGEXES.some((re) => re.test(text));
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_REGEXES) {
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    out = out.replace(globalRe, '[REDACTED]');
  }
  return out;
}

export function sanitizeDisplayText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/@\[([^\]:]+):([^\]]+)\]/g, '@[$1\u200B:$2]')
    .replace(/@all\b/gi, '@\u200Ball');
}

export function formatDurationShort(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

export function formatZonedTime(timestampMs: number | null, tz: string): string {
  if (timestampMs === null || !Number.isFinite(timestampMs)) return '—';
  let zone: string;
  try {
    zone = validateTimezone(tz);
  } catch {
    zone = 'UTC';
  }
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(timestampMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  const offset = offsetName === 'GMT' ? '+00:00' : (offsetName?.replace(/^GMT/, '') ?? '+00:00');
  const sign = offset.startsWith('-') ? -1 : 1;
  const offsetMinutes =
    /^[+-]\d{2}:\d{2}$/.test(offset) ? sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4))) : 0;
  const localDate = new Date(timestampMs + offsetMinutes * 60_000);
  const iso = localDate.toISOString();
  const ymd = iso.slice(0, 10);
  const hm = iso.slice(11, 16);
  const sec = iso.slice(17, 19);
  return sec === '00' ? `${ymd} ${hm} ${offset}` : `${ymd} ${hm}:${sec} ${offset}`;
}

export function formatNormalizedSchedule(
  schedule: StoredSchedule | ScheduleInput,
  tz: string,
  nowMs?: number,
): string {
  if (schedule.kind === 'at') {
    let zone: string;
    try {
      zone = validateTimezone(tz);
    } catch {
      zone = 'UTC';
    }
    const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(schedule.atMs))
      .find((p) => p.type === 'timeZoneName')?.value;
    const offset = offsetName === 'GMT' ? '+00:00' : (offsetName?.replace(/^GMT/, '') ?? '+00:00');
    const sign = offset.startsWith('-') ? -1 : 1;
    const offsetMinutes =
      /^[+-]\d{2}:\d{2}$/.test(offset) ? sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4))) : 0;
    const wall = new Date(schedule.atMs + offsetMinutes * 60_000).toISOString().slice(0, 19);
    void nowMs;
    return `at ${wall}${offset}`;
  }
  if (schedule.kind === 'every') {
    return `every ${formatDurationShort(schedule.everyMs)}`;
  }
  const staggerMs = 'staggerMs' in schedule && typeof schedule.staggerMs === 'number' ? schedule.staggerMs : 0;
  return staggerMs > 0 ? `cron ${schedule.expr} (stagger ${formatDurationShort(staggerMs)})` : `cron ${schedule.expr}`;
}

export function normalizeCommandLine(line: string): string {
  return line
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u3000/g, ' ')
    .replace(/\uFF0F/g, '/')
    .replace(/\uFF0D/g, '-')
    .normalize('NFKC');
}

export interface SplitCronCommandResult {
  readonly commandLine: string;
  readonly promptText?: string;
  readonly hasDelimiter: boolean;
  readonly multilineWithoutDelimiter: boolean;
}

export function splitCronInput(rawBody: string): SplitCronCommandResult {
  const normalizedNewlines = rawBody.replace(/\r\n/g, '\n');
  const lines = normalizedNewlines.split('\n');
  const firstLine = lines[0] ?? '';

  // Check for inline ' -- ' on the first line (outside quotes)
  let inSingle = false;
  let inDouble = false;
  let inlineDelimiterIdx = -1;
  const normFirst = normalizeCommandLine(firstLine);
  for (let i = 0; i < normFirst.length; i += 1) {
    const ch = normFirst[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble && normFirst.slice(i, i + 4) === ' -- ') {
      inlineDelimiterIdx = i;
      break;
    } else if (!inSingle && !inDouble && i + 3 === normFirst.length && normFirst.slice(i) === ' --') {
      inlineDelimiterIdx = i;
      break;
    }
  }

  if (inlineDelimiterIdx >= 0) {
    // Find corresponding split in raw firstLine to preserve raw promptText without NFKC
    const rawMatch = /^(.*?)\s+--(?:\s+(.*))?$/.exec(firstLine);
    const cmdPart = rawMatch ? rawMatch[1]! : normFirst.slice(0, inlineDelimiterIdx);
    const firstPromptRest = rawMatch ? (rawMatch[2] ?? '') : normFirst.slice(inlineDelimiterIdx + 4);
    const remainingLines = lines.slice(1);
    const promptParts = [firstPromptRest, ...remainingLines];
    const promptText =
      firstPromptRest.length === 0 && remainingLines.length > 0
        ? remainingLines.join('\n')
        : promptParts.join('\n');
    return {
      commandLine: normalizeCommandLine(cmdPart).trim(),
      promptText,
      hasDelimiter: true,
      multilineWithoutDelimiter: false,
    };
  }

  // Check for standalone '--' line
  const delimiterLineIdx = lines.findIndex((line, idx) => idx > 0 && line.trim() === '--');
  if (delimiterLineIdx > 0) {
    if (delimiterLineIdx > 1) {
      return {
        commandLine: normalizeCommandLine(firstLine).trim(),
        hasDelimiter: true,
        multilineWithoutDelimiter: true,
      };
    }
    return {
      commandLine: normalizeCommandLine(firstLine).trim(),
      promptText: lines.slice(delimiterLineIdx + 1).join('\n'),
      hasDelimiter: true,
      multilineWithoutDelimiter: false,
    };
  }

  return {
    commandLine: normalizeCommandLine(firstLine).trim(),
    hasDelimiter: false,
    multilineWithoutDelimiter: lines.length > 1,
  };
}

export function tokenizeCommandLine(commandLine: string): { ok: true; tokens: string[] } | { ok: false } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let tokenStarted = false;

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i]!;
    if (quote !== null) {
      if (ch === '\\' && i + 1 < commandLine.length && (commandLine[i + 1] === quote || commandLine[i + 1] === '\\')) {
        current += commandLine[i + 1]!;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (quote !== null) {
    return { ok: false };
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return { ok: true, tokens };
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export type ParsedScheduleResult =
  | { readonly ok: true; readonly schedule: ScheduleInput; readonly displayWhen?: string }
  | { readonly ok: false; readonly error: string };

export function parseScheduleSpec(
  rawSpec: string,
  tz: string,
  jobId: string,
  nowMs: number,
  minIntervalMs: number,
  exact = false,
): ParsedScheduleResult {
  const spec = rawSpec.trim();
  if (!spec) {
    return { ok: false, error: '✗ Invalid schedule: empty schedule' };
  }

  // 1. "every <duration>"
  if (/^every(?:\s+|$)/i.test(spec)) {
    const rest = spec.replace(/^every\s*/i, '').trim();
    const match = /^([+-]?\d+(?:\.\d+)?)([smhd])$/i.exec(rest);
    if (!match) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    const rawNum = match[1]!;
    const unit = match[2]!.toLowerCase();
    if (rawNum.includes('.') || rawNum.startsWith('-')) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    const count = Number(rawNum);
    if (!Number.isSafeInteger(count) || count <= 0) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    const everyMs = count * UNIT_MS[unit]!;
    if (!Number.isSafeInteger(everyMs) || everyMs <= 0 || everyMs > 365 * 86_400_000) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    if (everyMs < minIntervalMs) {
      return { ok: false, error: `✗ Interval below minimum (${formatDurationShort(minIntervalMs)})` };
    }
    try {
      every(everyMs, nowMs);
      return {
        ok: true,
        schedule: { kind: 'every', everyMs, anchorMs: nowMs },
      };
    } catch (err) {
      return { ok: false, error: `✗ Invalid schedule: ${err instanceof Error ? err.message : spec}` };
    }
  }

  // 2. "cron <5|6 fields>" or bare 5|6 cron fields
  const isExplicitCron = /^cron(?:\s+|$)/i.test(spec);
  const cronCandidate = isExplicitCron ? spec.replace(/^cron\s*/i, '').trim() : spec;
  const cronFields = cronCandidate.split(/\s+/).filter(Boolean);
  if (isExplicitCron || (cronFields.length >= 5 && cronFields.length <= 7 && !/^\d{4}-\d{2}-\d{2}/.test(spec))) {
    if (cronFields.length < 5 || cronFields.length > 7) {
      return { ok: false, error: `✗ Invalid schedule: expected 5 or 6 cron fields` };
    }
    // Check if it's a per-second 6-field cron below minIntervalMs
    if (cronFields.length >= 6 && minIntervalMs > 1_000) {
      const secField = cronFields[0]!;
      if (secField === '*' || /^\*\/\d+$/.test(secField) || secField.includes(',') || secField.includes('-')) {
        return { ok: false, error: `✗ Interval below minimum (${formatDurationShort(minIntervalMs)})` };
      }
    }
    try {
      const validated = cron(cronCandidate, tz, jobId, undefined, exact);
      if (validated.kind !== 'cron') {
        return { ok: false, error: `✗ Invalid schedule: ${spec}` };
      }
      return {
        ok: true,
        schedule: {
          kind: 'cron',
          expr: validated.expr,
          tz: validated.tz,
          staggerMs: validated.staggerMs,
          ...(exact ? { exact: true } : {}),
        },
      };
    } catch (err) {
      return { ok: false, error: `✗ Invalid schedule: ${err instanceof Error ? err.message : spec}` };
    }
  }

  // 3. Relative one-shot: "[in ]<positive int><s|m|h|d>"
  const relCandidate = spec.replace(/^in\s+/i, '').trim();
  if (/^[+-]?\d+(?:\.\d+)?[smhd]$/i.test(relCandidate)) {
    const match = /^([+-]?\d+(?:\.\d+)?)([smhd])$/i.exec(relCandidate)!;
    const rawNum = match[1]!;
    const unit = match[2]!.toLowerCase();
    if (rawNum.includes('.') || rawNum.startsWith('-')) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    const count = Number(rawNum);
    if (!Number.isSafeInteger(count) || count <= 0) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    const deltaMs = count * UNIT_MS[unit]!;
    if (!Number.isSafeInteger(deltaMs) || deltaMs <= 0) {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    const atMs = nowMs + deltaMs;
    try {
      validateAt(atMs, nowMs);
      return {
        ok: true,
        schedule: { kind: 'at', atMs },
      };
    } catch (err) {
      return { ok: false, error: `✗ Invalid schedule: ${err instanceof Error ? err.message : spec}` };
    }
  }

  // 4. ISO-8601 datetime (with or without seconds / with or without offset)
  const atCandidate = spec.replace(/^at\s+/i, '').trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, '$1T$2');
  const normalizedIso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/.test(atCandidate)
    ? atCandidate.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})?$/, '$1:00$2')
    : atCandidate;
  try {
    const norm = normalizeAt(normalizedIso, tz, nowMs);
    if (norm.schedule.kind !== 'at') {
      return { ok: false, error: `✗ Invalid schedule: ${spec}` };
    }
    return {
      ok: true,
      schedule: { kind: 'at', atMs: norm.schedule.atMs },
      displayWhen: `at ${norm.iso}`,
    };
  } catch (err) {
    return { ok: false, error: `✗ Invalid schedule: ${err instanceof Error ? err.message : spec}` };
  }
}

export function formatAddReply(job: Readonly<JobRow>, displayWhen?: string): string {
  const schedule = JSON.parse(job.schedule_json) as StoredSchedule;
  const whenText = displayWhen ?? formatNormalizedSchedule(schedule, job.tz);
  const nextText = formatZonedTime(job.next_run_at, job.tz);
  const deleteAfterText = job.delete_after_run === 1 ? 'yes' : 'no';
  return [
    `✓ Scheduled ${job.id} "${sanitizeDisplayText(job.name)}"`,
    `• when: ${whenText} (${job.tz})`,
    `• next: ${nextText}`,
    `• mode: ${job.exec_mode} • delete after run: ${deleteAfterText}`,
  ].join('\n');
}

export function formatListReply(
  jobs: ReadonlyArray<Readonly<JobRow>>,
  totalCount: number,
  page: number,
  pageSize = 20,
): string {
  if (totalCount === 0) {
    return 'No scheduled tasks in this conversation.';
  }
  if (jobs.length === 0) {
    return 'No more results.';
  }
  const lines = jobs.map((job) => {
    const stateLabel =
      job.deleted_at !== null
        ? 'deleted'
        : job.enabled === 1
          ? 'on'
          : job.auto_disabled_reason !== null
            ? 'auto-off'
            : 'off';
    const nextText = job.enabled === 1 && job.next_run_at !== null ? formatZonedTime(job.next_run_at, job.tz) : '—';
    return `${job.id}  ${stateLabel}  ${nextText}  ${sanitizeDisplayText(job.name)}`;
  });
  const remaining = totalCount - ((page - 1) * pageSize + jobs.length);
  if (remaining > 0) {
    lines.push(`…and ${remaining} more (use /cron list --all --page ${page + 1})`);
  }
  return lines.join('\n');
}

export function formatShowReply(job: Readonly<JobRow>, defaultTimeoutSeconds = 1800): string {
  const schedule = JSON.parse(job.schedule_json) as StoredSchedule;
  const payload = JSON.parse(job.payload_json) as {
    kind: 'reminder' | 'agentTurn';
    text?: string;
    message?: string;
    model?: string;
    effort?: string;
    timeoutSeconds?: number;
  };
  const statusText =
    job.deleted_at !== null
      ? `deleted (${formatZonedTime(job.deleted_at, job.tz)})`
      : job.enabled === 1
        ? 'enabled'
        : job.auto_disabled_reason
          ? `auto-disabled (${job.auto_disabled_reason})`
          : 'disabled';
  const rawBody = payload.kind === 'reminder' ? (payload.text ?? '') : (payload.message ?? '');
  const redactedBody = redactSecrets(rawBody);
  const chars = Array.from(redactedBody);
  const truncatedBody = chars.length > 500 ? `${chars.slice(0, 500).join('')}…` : redactedBody;
  const lastOutcome =
    job.last_status !== null
      ? `${job.last_status}/${job.last_completion ?? '-'}${job.last_error_reason ? ` (${job.last_error_reason})` : ''}${job.last_duration_ms !== null ? ` ${job.last_duration_ms}ms` : ''}`
      : '—';
  const modelLine =
    payload.kind === 'agentTurn'
      ? `• model: ${payload.model ?? 'default'} • effort: ${payload.effort ?? 'default'} • timeout: ${payload.timeoutSeconds ?? defaultTimeoutSeconds}s`
      : `• payload: reminder`;
  return [
    `Job ${job.id} "${sanitizeDisplayText(job.name)}" (revision ${job.generation})`,
    `• status: ${statusText}`,
    `• schedule: ${formatNormalizedSchedule(schedule, job.tz)} (${job.tz})`,
    `• next: ${formatZonedTime(job.next_run_at, job.tz)} • last: ${formatZonedTime(job.last_run_at, job.tz)}`,
    `• mode: ${job.exec_mode} • target: ${job.target_session} (${job.target_channel_id}/${job.target_channel_type})`,
    `• delivery: ${job.delivery_mode} • delete after run: ${job.delete_after_run === 1 ? 'yes' : 'no'}`,
    modelLine,
    `• last outcome: ${lastOutcome}`,
    `• ${payload.kind === 'reminder' ? 'text' : 'prompt'}: ${sanitizeDisplayText(truncatedBody)}`,
  ].join('\n');
}

export function formatRunsReply(
  jobId: string,
  tz: string,
  runs: ReadonlyArray<Readonly<RunRow>>,
  page: number,
): string {
  if (runs.length === 0) {
    return page === 1 ? `No runs for ${jobId}.` : 'No more results.';
  }
  return runs
    .map((r) => {
      const timeText = formatZonedTime(r.started_at ?? r.queued_at, tz);
      const statusText = `${r.status}/${r.completion ?? '-'}`;
      const reasonText = r.reason ?? '-';
      const durationMs =
        r.ended_at !== null ? `${Math.max(0, r.ended_at - (r.started_at ?? r.queued_at))}ms` : 'running';
      return `${timeText}  ${statusText}  ${reasonText}  ${durationMs}`;
    })
    .join('\n');
}
