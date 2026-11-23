// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { validateTimezone } from './schedule/engine.js';
import type { ResolvedCronConfig } from './config.js';
import {
  containsSecretPattern,
  formatAddReply,
  formatListReply,
  formatRunsReply,
  formatShowReply,
  formatZonedTime,
  generateJobId,
  parseScheduleSpec,
  splitCronInput,
  tokenizeCommandLine,
} from './parser.js';
import {
  CronStore,
  DeferredOperation,
  JobNotFound,
  StoreConflict,
  terminalExpectation,
} from './store/index.js';
import type {
  AdmissionAuthority,
  AdmissionRequest,
  CreateJob,
  Definition,
  ExecutionAdmissionRequest,
  ExecutionAdmissionVerifier,
  JobPatch,
  ManualAdmissionRequest,
  Payload,
  RunRow,
  StoreScope,
  Target,
} from './store/types.js';
import type { DynamicToolSpec, TurnContext } from '../runtime/types.js';
import { StringCatalog } from '../runtime/octo-egress.js';

export const CODEX_BUDDY_CRON_TOOL_SPEC: DynamicToolSpec = Object.freeze({
  name: 'codex_buddy_cron',
  description:
    'Create, list, show, edit, enable, disable, remove, inspect run history, or manually run scheduled tasks and reminders in this conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'remind', 'edit', 'list', 'show', 'runs', 'enable', 'disable', 'rm', 'run'],
        description: 'Operation to perform on scheduled tasks.',
      },
      id: {
        type: 'string',
        description: 'Job ID (e.g. j7f3k2q) for show, runs, edit, enable, disable, rm, or run.',
      },
      schedule: {
        type: 'string',
        description: 'Schedule expression: ISO-8601 datetime, relative duration (10m, 2h), "every <duration>", or "cron <5|6 fields>".',
      },
      prompt: {
        type: 'string',
        description: 'Task prompt (for add) or reminder text (for remind).',
      },
      name: {
        type: 'string',
        description: 'Short descriptive name for the scheduled task.',
      },
      tz: {
        type: 'string',
        description: 'IANA timezone (e.g. Asia/Shanghai, UTC).',
      },
      mode: {
        type: 'string',
        enum: ['isolated', 'session', 'force', 'due'],
        description: 'Execution mode for add (isolated|session) or manual run mode (force|due).',
      },
      delivery: {
        type: 'string',
        enum: ['announce', 'none'],
        description: 'Whether to announce output to the conversation or run silently locally.',
      },
      keep: {
        type: 'boolean',
        description: 'Keep a one-shot task definition after it finishes instead of deleting it.',
      },
      exact: {
        type: 'boolean',
        description: 'Disable default top-of-hour stagger on a cron schedule.',
      },
      revision: {
        type: 'integer',
        description: 'Expected job revision (generation) required for edit.',
      },
      field: {
        type: 'string',
        description: 'Field to update for edit (name|schedule|tz|prompt|text|mode|enabled|delivery|model|effort|timeout).',
      },
      value: {
        type: 'string',
        description: 'New field value for edit.',
      },
      all: {
        type: 'boolean',
        description: 'Include disabled and deleted tasks in list.',
      },
      page: {
        type: 'integer',
        description: '1-based page number for list or runs.',
      },
    },
    required: ['action'],
  },
});

export interface CronAuthorityContext {
  readonly botId: string;
  readonly getOwnerUid: () => string | undefined;
  readonly getRegisteredRobotId: () => string | undefined;
  readonly getIncarnationId: () => string;
  readonly assertOwnershipHeld: () => void;
  readonly getResetGeneration: (sessionKey: string) => number;
  readonly getRuntimeGeneration: () => number;
  readonly isRuntimeAvailable?: () => boolean;
}

interface IssuedProofRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly ownerIncarnation: string;
  readonly resetGeneration: number;
  readonly permitGrantedAtMs: number;
  readonly admissionDeadlineMs: number;
  readonly runtimeGeneration: number;
  readonly checkLive: () => void;
}

export class CronAdmissionIssuer implements ExecutionAdmissionVerifier {
  readonly #ctx: CronAuthorityContext;
  readonly #config: ResolvedCronConfig;
  readonly #clock: { now(): number };
  readonly #proofs = new WeakMap<ExecutionAdmissionRequest['executionProof'], IssuedProofRecord>();

  constructor(ctx: CronAuthorityContext, config: ResolvedCronConfig, clock: { now(): number }) {
    this.#ctx = ctx;
    this.#config = config;
    this.#clock = clock;
  }

  isCreatorAuthorized(uid: string): boolean {
    if (typeof uid !== 'string' || !uid.trim()) return false;
    const trimmed = uid.trim();
    const ownerUid = this.#ctx.getOwnerUid()?.trim() ?? '';
    if (ownerUid.length > 0 && trimmed === ownerUid) return true;
    return this.#config.managers.includes(trimmed);
  }

  isTargetAuthorized(target: Target): boolean {
    if (!target || typeof target.sessionKey !== 'string' || !target.sessionKey.trim()) return false;
    if (typeof target.channelId !== 'string' || !target.channelId.trim()) return false;
    if (![1, 2, 5].includes(target.channelType)) return false;
    if (target.channelType === 1 && target.channelId.includes('@')) {
      const suffix = target.channelId.slice(target.channelId.lastIndexOf('@') + 1);
      const robotId = this.#ctx.getRegisteredRobotId()?.trim() ?? '';
      const botId = this.#ctx.botId.trim();
      if (suffix && suffix !== robotId && suffix !== botId) {
        return false;
      }
    }
    return true;
  }

  buildOwnership(sessionKey: string): AdmissionRequest['ownership'] {
    const ownerIncarnation = this.#ctx.getIncarnationId();
    const resetGeneration = this.#ctx.getResetGeneration(sessionKey);
    const assertOwnershipHeld = this.#ctx.assertOwnershipHeld;
    return Object.freeze({
      ownerIncarnation,
      resetGeneration,
      assertHeld() {
        assertOwnershipHeld();
      },
    });
  }

  buildAuthority(jobId: string, definition: Definition, ownership?: AdmissionRequest['ownership']): AdmissionAuthority {
    const own = ownership ?? this.buildOwnership(definition.target.sessionKey);
    return Object.freeze({
      jobId,
      definition,
      creatorAuthorized: this.isCreatorAuthorized(definition.creatorUid) as true,
      targetAuthorized: this.isTargetAuthorized(definition.target) as true,
      ownerIncarnation: own.ownerIncarnation,
      resetGeneration: own.resetGeneration,
      policy: Object.freeze({ tools: 'none' as const }),
    });
  }

  issueExecutionRequest(run: Readonly<RunRow>, definition: Definition): ExecutionAdmissionRequest {
    const ownership = Object.freeze({
      ownerIncarnation: run.owner_incarnation,
      resetGeneration: run.reset_generation,
      assertHeld: () => {
        this.#ctx.assertOwnershipHeld();
      },
    });
    const authority = this.buildAuthority(run.job_id, definition, ownership);
    const now = this.#clock.now();
    const permitGrantedAtMs = now;
    const admissionDeadlineMs = now + this.#config.admissionWaitMs;
    const runtimeGeneration = Math.max(1, this.#ctx.getRuntimeGeneration());
    const checkLive = (): void => {
      this.#ctx.assertOwnershipHeld();
      if (this.#ctx.getIncarnationId() !== run.owner_incarnation) {
        throw new Error('Incarnation changed during execution admission');
      }
      if (!this.isCreatorAuthorized(definition.creatorUid) || !this.isTargetAuthorized(definition.target)) {
        throw new Error('Creator or target authority revoked');
      }
      const currentNow = this.#clock.now();
      if (currentNow < permitGrantedAtMs || currentNow >= admissionDeadlineMs) {
        throw new Error('Admission deadline expired');
      }
    };
    const executionProof: ExecutionAdmissionRequest['executionProof'] = Object.freeze({
      permitGrantedAtMs,
      admissionDeadlineMs,
      runtimeGeneration,
      assertCurrent() {
        checkLive();
      },
    });
    this.#proofs.set(executionProof, {
      jobId: run.job_id,
      runId: run.run_id,
      ownerIncarnation: run.owner_incarnation,
      resetGeneration: run.reset_generation,
      permitGrantedAtMs,
      admissionDeadlineMs,
      runtimeGeneration,
      checkLive,
    });
    return Object.freeze({
      expected: terminalExpectation(run) as ExecutionAdmissionRequest['expected'],
      authority,
      ownership,
      executionProof,
    });
  }

  prepare(request: Readonly<ExecutionAdmissionRequest>): Readonly<{ assertCurrent(): void }> | undefined {
    try {
      const expected = request.expected;
      const proof = request.executionProof;
      const authority = request.authority;
      const ownership = request.ownership;
      if (!expected || !proof || !authority || !ownership) return undefined;
      if (!authority.creatorAuthorized || !authority.targetAuthorized) return undefined;
      if (!this.isCreatorAuthorized(authority.definition.creatorUid)) return undefined;
      if (!this.isTargetAuthorized(authority.definition.target)) return undefined;
      if (authority.ownerIncarnation !== this.#ctx.getIncarnationId()) return undefined;
      if (ownership.ownerIncarnation !== this.#ctx.getIncarnationId()) return undefined;
      return Object.freeze({
        assertCurrent: () => {
          this.#ctx.assertOwnershipHeld();
          proof.assertCurrent();
          if (this.#ctx.getIncarnationId() !== ownership.ownerIncarnation) {
            throw new Error('Owner incarnation mismatch');
          }
          if (!this.isCreatorAuthorized(authority.definition.creatorUid)) {
            throw new Error('Creator authority revoked');
          }
          if (!this.isTargetAuthorized(authority.definition.target)) {
            throw new Error('Target authority revoked');
          }
        },
      });
    } catch {
      return undefined;
    }
  }
}

export interface CronCommandCallerContext {
  readonly senderUid: string;
  readonly isOwner: boolean;
  readonly isCronManager: boolean;
  readonly isGroup: boolean;
  readonly sessionKey: string;
  readonly channelId: string;
  readonly channelType: 1 | 2 | 5;
  readonly allowGlobalOperator?: boolean;
}

export interface CronServiceCallbacks {
  onWake?: () => void;
  onCancelActiveRun?: (jobId: string, reason: 'job-removed' | 'job-disabled' | 'job-edited') => void;
  onManualRunReserved?: (run: Readonly<RunRow>) => void;
  emitAudit?: (params: {
    actor: string;
    action: string;
    target: string;
    outcome: 'ok' | 'denied' | 'error';
    detail?: string;
  }) => void;
}

export class CronService {
  readonly store: CronStore;
  readonly config: ResolvedCronConfig;
  readonly issuer: CronAdmissionIssuer;
  readonly #clock: { now(): number };
  readonly #callbacks: CronServiceCallbacks;

  constructor(
    store: CronStore,
    config: ResolvedCronConfig,
    issuer: CronAdmissionIssuer,
    clock: { now(): number },
    callbacks: CronServiceCallbacks = {},
  ) {
    this.store = store;
    this.config = config;
    this.issuer = issuer;
    this.#clock = clock;
    this.#callbacks = callbacks;
  }

  authorizedJobCount(isOwner: boolean, sessionKey: string): number {
    const scope: StoreScope = isOwner ? { allConversations: true } : { targetSession: sessionKey };
    return this.store.countJobs(scope, { includeDisabled: true, includeDeleted: false });
  }

  #cancelQueuedRunIfPresent(
    scope: StoreScope,
    jobId: string,
    reason: 'job-edited' | 'job-disabled' | 'job-removed',
  ): void {
    const active = this.store.activeRunForJob(jobId);
    if (!active || active.status !== 'queued') return;
    const job = this.store.get(scope, jobId);
    if (!job) return;
    const ownership = Object.freeze({
      ownerIncarnation: active.owner_incarnation,
      resetGeneration: active.reset_generation,
      assertHeld: () => {
        this.issuer.buildOwnership(job.target_session).assertHeld();
      },
    });
    this.store.finalize(scope, jobId, {
      expected: terminalExpectation(active),
      ownership,
      outcome: { kind: 'neutral', reason },
      ...(active.attempt > 0 ? { retryChain: true } : {}),
      effects: {},
    });
  }

  #allocateId(): string {
    return generateJobId((candidate) => {
      try {
        return this.store.get({ allConversations: true }, candidate) !== undefined;
      } catch {
        return false;
      }
    });
  }

  executeSlashCommand(
    rawBody: string,
    caller: CronCommandCallerContext,
  ): { reply: string; isError: boolean; scopeDenied?: boolean } {
    const split = splitCronInput(rawBody);
    if (split.multilineWithoutDelimiter) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const tokenized = tokenizeCommandLine(split.commandLine);
    if (!tokenized.ok || tokenized.tokens.length === 0) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const tokens = tokenized.tokens;
    const first = tokens[0]!.replace(/^\//, '').toLowerCase();
    const args = first === 'cron' ? tokens.slice(1) : tokens;
    if (args.length === 0) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }

    const sub = args[0]!.toLowerCase();
    const rest = args.slice(1);

    // Check --all-conversations flag authorization before any lookup
    const hasAllConversations = rest.includes('--all-conversations');
    if (hasAllConversations) {
      if (sub === 'add' || sub === 'remind') {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      if (!caller.allowGlobalOperator && (!caller.isOwner || caller.isGroup)) {
        return { reply: StringCatalog.commandScopeDenied(), isError: true, scopeDenied: true };
      }
    }

    const scope: StoreScope =
      hasAllConversations || caller.allowGlobalOperator
        ? { allConversations: true }
        : { targetSession: caller.sessionKey };
    const filteredArgs = rest.filter((t) => t !== '--all-conversations');

    try {
      switch (sub) {
        case 'add':
        case 'remind':
          return this.#handleAddOrRemind(sub, filteredArgs, split.hasDelimiter ? split.promptText : undefined, caller);
        case 'list':
          return this.#handleList(filteredArgs, scope);
        case 'show':
          return this.#handleShow(filteredArgs, scope);
        case 'runs':
          return this.#handleRuns(filteredArgs, scope);
        case 'enable':
        case 'disable':
        case 'rm':
          return this.#handleToggleOrRemove(sub, filteredArgs, scope, caller);
        case 'run':
          return this.#handleManualRun(filteredArgs, scope, caller);
        case 'edit':
          return this.#handleEdit(filteredArgs, split.hasDelimiter ? split.promptText : undefined, scope, caller);
        default:
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
    } catch (err) {
      if (err instanceof JobNotFound) {
        const idArg = filteredArgs[0] ?? '';
        return { reply: `✗ Job not found: ${idArg}`, isError: true };
      }
      if (err instanceof StoreConflict) {
        const idArg = filteredArgs[0] ?? '';
        return {
          reply: `✗ Job changed since you viewed it; run /cron show ${idArg} and retry`,
          isError: true,
        };
      }
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
  }

  #handleAddOrRemind(
    kind: 'add' | 'remind',
    args: string[],
    delimitedBody: string | undefined,
    caller: CronCommandCallerContext,
  ): { reply: string; isError: boolean } {
    if (delimitedBody === undefined) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const bodyText = delimitedBody;
    if (!bodyText.trim() || bodyText.includes('\0')) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    if (Array.from(bodyText).length > 4000) {
      return { reply: '✗ Prompt too long (max 4000 chars)', isError: true };
    }
    if (containsSecretPattern(bodyText)) {
      return { reply: '✗ Prompt looks like it contains a secret; not saved', isError: true };
    }

    let tz = this.config.defaultTimezone;
    let execMode: 'isolated' | 'session' = kind === 'remind' ? 'session' : 'isolated';
    let explicitMode = false;
    let name: string | undefined;
    let keep = false;
    let exact = false;
    let deliveryMode: 'announce' | 'none' = 'announce';
    let model: string | undefined;
    let effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    let timeoutSeconds: number | undefined;
    const scheduleTokens: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
      const tok = args[i]!;
      if (tok === '--tz') {
        const val = args[++i];
        if (!val) return { reply: '✗ Invalid command syntax; use /help', isError: true };
        try {
          tz = validateTimezone(val);
        } catch {
          return { reply: `✗ Unknown time zone: ${val}`, isError: true };
        }
      } else if (tok === '--isolated') {
        if (kind === 'remind' || (explicitMode && execMode !== 'isolated')) {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        execMode = 'isolated';
        explicitMode = true;
      } else if (tok === '--session') {
        if (explicitMode && execMode !== 'session') {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        execMode = 'session';
        explicitMode = true;
      } else if (tok === '--name') {
        const val = args[++i];
        if (!val || !val.trim()) return { reply: '✗ Invalid command syntax; use /help', isError: true };
        name = val.trim();
      } else if (tok === '--keep') {
        keep = true;
      } else if (tok === '--exact') {
        if (kind === 'remind') return { reply: '✗ Invalid command syntax; use /help', isError: true };
        exact = true;
      } else if (tok === '--delivery') {
        const val = args[++i];
        if (val !== 'announce' && val !== 'none') {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        deliveryMode = val;
      } else if (tok === '--model') {
        const val = args[++i];
        if (!val || !val.trim() || kind === 'remind') {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        model = val.trim();
      } else if (tok === '--effort') {
        const val = args[++i];
        if (
          !val ||
          kind === 'remind' ||
          !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(val)
        ) {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        effort = val as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      } else if (tok === '--timeout') {
        const val = args[++i];
        const parsed = Number(val);
        if (!val || kind === 'remind' || !Number.isSafeInteger(parsed) || parsed < 10 || parsed > 7200) {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        timeoutSeconds = parsed;
      } else if (tok.startsWith('--')) {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      } else {
        scheduleTokens.push(tok);
      }
    }

    if (execMode === 'session' && (model !== undefined || effort !== undefined)) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    if (scheduleTokens.length === 0) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    if (name && containsSecretPattern(name)) {
      return { reply: '✗ Prompt looks like it contains a secret; not saved', isError: true };
    }

    // Check conversation and bot quotas before creating
    const convCount = this.store.countJobs(
      { targetSession: caller.sessionKey },
      { includeDisabled: true, includeDeleted: false },
    );
    if (convCount >= this.config.maxJobsPerConversation) {
      return {
        reply: `✗ Quota reached (${this.config.maxJobsPerConversation} jobs per conversation)`,
        isError: true,
      };
    }
    const botCount = this.store.countJobs(
      { allConversations: true },
      { includeDisabled: true, includeDeleted: false },
    );
    if (botCount >= this.config.maxJobsPerBot) {
      return {
        reply: `✗ Quota reached (${this.config.maxJobsPerBot} jobs per bot)`,
        isError: true,
      };
    }

    const now = this.#clock.now();
    const jobId = this.#allocateId();
    const rawSchedule = scheduleTokens.join(' ');
    const parsedSchedule = parseScheduleSpec(rawSchedule, tz, jobId, now, this.config.minIntervalMs, exact);
    if (!parsedSchedule.ok) {
      return { reply: parsedSchedule.error, isError: true };
    }
    if (exact && parsedSchedule.schedule.kind !== 'cron') {
      return { reply: '✗ Invalid schedule: --exact is only valid for cron schedules', isError: true };
    }

    const derivedName =
      name ??
      (Array.from(bodyText.trim().split('\n')[0] ?? 'task')
        .slice(0, 40)
        .join('')
        .trim() || 'task');

    const payload: Payload =
      kind === 'remind'
        ? { kind: 'reminder', text: bodyText }
        : {
            kind: 'agentTurn',
            message: bodyText,
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
          };

    const createInput: CreateJob = {
      id: jobId,
      name: derivedName,
      schedule: parsedSchedule.schedule,
      tz,
      payload,
      execMode,
      target: {
        sessionKey: caller.sessionKey,
        channelId: caller.channelId,
        channelType: caller.channelType,
      },
      creatorUid: caller.senderUid,
      deliveryMode,
      deleteAfterRun: keep ? false : parsedSchedule.schedule.kind === 'at',
      enabled: true,
    };

    const created = this.store.create(createInput);
    this.#callbacks.emitAudit?.({
      actor: caller.senderUid,
      action: 'cron.add',
      target: created.id,
      outcome: 'ok',
      detail: `kind=${created.payload_kind},schedule=${created.schedule_kind},mode=${created.exec_mode}`,
    });
    this.#callbacks.onWake?.();
    return {
      reply: formatAddReply(created, parsedSchedule.displayWhen),
      isError: false,
    };
  }

  #handleList(args: string[], scope: StoreScope): { reply: string; isError: boolean } {
    let includeAll = false;
    let page = 1;
    for (let i = 0; i < args.length; i += 1) {
      const tok = args[i]!;
      if (tok === '--all') {
        includeAll = true;
      } else if (tok === '--page') {
        const val = args[++i];
        const parsed = Number(val);
        if (!val || !Number.isSafeInteger(parsed) || parsed < 1) {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        page = parsed;
      } else {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
    }
    const pageSize = 20;
    const total = this.store.countJobs(scope, {
      includeDisabled: includeAll,
      includeDeleted: includeAll,
    });
    const jobs = this.store.list(scope, {
      includeDisabled: includeAll,
      includeDeleted: includeAll,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return {
      reply: formatListReply(jobs, total, page, pageSize),
      isError: false,
    };
  }

  #handleShow(args: string[], scope: StoreScope): { reply: string; isError: boolean } {
    if (args.length !== 1 || !/^j[a-km-np-z2-9]{6}$/.test(args[0]!)) {
      if (args.length === 1 && args[0] && !args[0].startsWith('-')) {
        return { reply: `✗ Job not found: ${args[0]}`, isError: true };
      }
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const jobId = args[0]!;
    const job = this.store.get(scope, jobId);
    if (!job || job.deleted_at !== null) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }
    return {
      reply: formatShowReply(job, this.config.defaultTimeoutSeconds),
      isError: false,
    };
  }

  #handleRuns(args: string[], scope: StoreScope): { reply: string; isError: boolean } {
    if (args.length === 0) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const jobId = args[0]!;
    if (!/^j[a-km-np-z2-9]{6}$/.test(jobId)) {
      if (!jobId.startsWith('-')) {
        return { reply: `✗ Job not found: ${jobId}`, isError: true };
      }
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    let page = 1;
    for (let i = 1; i < args.length; i += 1) {
      const tok = args[i]!;
      if (tok === '--page') {
        const val = args[++i];
        const parsed = Number(val);
        if (!val || !Number.isSafeInteger(parsed) || parsed < 1) {
          return { reply: '✗ Invalid command syntax; use /help', isError: true };
        }
        page = parsed;
      } else {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
    }
    const job = this.store.get(scope, jobId);
    if (!job) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }
    const pageSize = 10;
    const runs = this.store.listRuns(scope, jobId, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    if (job.deleted_at !== null && runs.length === 0) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }
    return {
      reply: formatRunsReply(jobId, job.tz, runs, page),
      isError: false,
    };
  }

  #handleToggleOrRemove(
    action: 'enable' | 'disable' | 'rm',
    args: string[],
    scope: StoreScope,
    caller: CronCommandCallerContext,
  ): { reply: string; isError: boolean } {
    if (args.length !== 1) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const jobId = args[0]!;
    if (!/^j[a-km-np-z2-9]{6}$/.test(jobId)) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }
    const job = this.store.get(scope, jobId);
    if (!job || job.deleted_at !== null) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }

    if (action === 'enable') {
      this.#cancelQueuedRunIfPresent(scope, jobId, 'job-edited');
      const updated = this.store.enable(scope, jobId, job.generation);
      this.#callbacks.emitAudit?.({
        actor: caller.senderUid,
        action: 'cron.enable',
        target: jobId,
        outcome: 'ok',
        detail: `revision=${updated.generation}`,
      });
      this.#callbacks.onWake?.();
      return {
        reply: `✓ Enabled ${jobId} (next: ${formatZonedTime(updated.next_run_at, updated.tz)})`,
        isError: false,
      };
    }

    if (action === 'disable') {
      this.#cancelQueuedRunIfPresent(scope, jobId, 'job-disabled');
      const updated = this.store.disable(scope, jobId, job.generation);
      this.#callbacks.emitAudit?.({
        actor: caller.senderUid,
        action: 'cron.disable',
        target: jobId,
        outcome: 'ok',
        detail: `revision=${updated.generation}`,
      });
      this.#callbacks.onWake?.();
      return {
        reply: `✓ Disabled ${jobId}`,
        isError: false,
      };
    }

    // action === 'rm'
    this.#cancelQueuedRunIfPresent(scope, jobId, 'job-removed');
    const updatedJob = this.store.get(scope, jobId);
    if (!updatedJob || updatedJob.deleted_at !== null) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }
    this.store.tombstone(scope, jobId, updatedJob.generation, { allowActiveRunning: true });
    this.#callbacks.onCancelActiveRun?.(jobId, 'job-removed');
    this.#callbacks.emitAudit?.({
      actor: caller.senderUid,
      action: 'cron.rm',
      target: jobId,
      outcome: 'ok',
    });
    this.#callbacks.onWake?.();
    return {
      reply: `✓ Removed ${jobId}`,
      isError: false,
    };
  }

  #handleManualRun(
    args: string[],
    scope: StoreScope,
    caller: CronCommandCallerContext,
  ): { reply: string; isError: boolean } {
    if (args.length === 0) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const jobId = args[0]!;
    if (!/^j[a-km-np-z2-9]{6}$/.test(jobId)) {
      if (!jobId.startsWith('-')) {
        return { reply: `✗ Job not found: ${jobId}`, isError: true };
      }
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    let manualMode: ManualAdmissionRequest['manualMode'] = 'if-enabled';
    for (let i = 1; i < args.length; i += 1) {
      const tok = args[i]!;
      if (tok === '--force' && manualMode === 'if-enabled') {
        manualMode = 'force';
      } else if (tok === '--due' && manualMode === 'if-enabled') {
        manualMode = 'due';
      } else {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
    }

    const job = this.store.get(scope, jobId);
    if (!job || job.deleted_at !== null) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }
    const definition = this.store.definition(scope, jobId);
    const ownership = this.issuer.buildOwnership(definition.target.sessionKey);
    const authority = this.issuer.buildAuthority(jobId, definition, ownership);
    const runId = `r_${randomUUID()}`;
    const invocationId = `manual:${randomUUID()}`;

    const result = this.store.admitManual(scope, jobId, {
      trigger: 'manual',
      manualMode,
      generation: job.generation,
      runId,
      invocationId,
      authority,
      ownership,
    });

    if (result.kind === 'already-running') {
      return { reply: '✗ Job already running', isError: true };
    }
    if (result.kind === 'disabled') {
      return { reply: '✗ Job is disabled', isError: true };
    }
    if (result.kind === 'not-due' || !('run' in result)) {
      return { reply: '✗ Job is not due', isError: true };
    }

    this.#callbacks.emitAudit?.({
      actor: caller.senderUid,
      action: 'cron.run',
      target: jobId,
      outcome: 'ok',
      detail: `run=${result.run.run_id},mode=${manualMode},ownership=${result.run.schedule_ownership}`,
    });
    this.#callbacks.onManualRunReserved?.(result.run);
    this.#callbacks.onWake?.();
    return {
      reply: `✓ Run requested ${result.run.run_id} for ${jobId}`,
      isError: false,
    };
  }

  #handleEdit(
    args: string[],
    delimitedBody: string | undefined,
    scope: StoreScope,
    caller: CronCommandCallerContext,
  ): { reply: string; isError: boolean } {
    if (args.length < 3) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const jobId = args[0]!;
    if (!/^j[a-km-np-z2-9]{6}$/.test(jobId)) {
      if (!jobId.startsWith('-')) {
        return { reply: `✗ Job not found: ${jobId}`, isError: true };
      }
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const job = this.store.get(scope, jobId);
    if (!job || job.deleted_at !== null) {
      return { reply: `✗ Job not found: ${jobId}`, isError: true };
    }

    const revIdx = args.indexOf('--revision');
    if (revIdx === -1 || revIdx + 1 >= args.length) {
      return { reply: `✗ Expected --revision ${job.generation}; run /cron show ${jobId}`, isError: true };
    }
    const revVal = Number(args[revIdx + 1]);
    if (!Number.isSafeInteger(revVal) || revVal < 1) {
      return { reply: `✗ Expected --revision ${job.generation}; run /cron show ${jobId}`, isError: true };
    }
    if (revVal !== job.generation) {
      return {
        reply: `✗ Job changed since you viewed it; run /cron show ${jobId} and retry`,
        isError: true,
      };
    }

    const remaining = args.filter((_, idx) => idx !== 0 && idx !== revIdx && idx !== revIdx + 1);
    if (remaining.length < 1) {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }
    const field = remaining[0]!.toLowerCase();
    const valueTokens = remaining.slice(1);
    const inlineValue = valueTokens.join(' ').trim();
    const oldDef = this.store.definition(scope, jobId);
    const now = this.#clock.now();
    let patch: JobPatch;

    if (field === 'name') {
      const val = delimitedBody ?? inlineValue;
      if (!val.trim()) return { reply: '✗ Invalid command syntax; use /help', isError: true };
      if (containsSecretPattern(val)) {
        return { reply: '✗ Prompt looks like it contains a secret; not saved', isError: true };
      }
      patch = { name: val.trim() };
    } else if (field === 'tz') {
      if (valueTokens.length !== 1) return { reply: '✗ Invalid command syntax; use /help', isError: true };
      try {
        const zone = validateTimezone(valueTokens[0]!);
        patch = { tz: zone };
      } catch {
        return { reply: `✗ Unknown time zone: ${valueTokens[0]}`, isError: true };
      }
    } else if (field === 'schedule') {
      let exact = false;
      const schedParts: string[] = [];
      for (const tok of valueTokens) {
        if (tok === '--exact') exact = true;
        else schedParts.push(tok);
      }
      const rawSpec = schedParts.join(' ').trim();
      const parsed = parseScheduleSpec(rawSpec, job.tz, jobId, now, this.config.minIntervalMs, exact);
      if (!parsed.ok) return { reply: parsed.error, isError: true };
      patch = { schedule: parsed.schedule };
    } else if (field === 'prompt' || field === 'text') {
      if ((field === 'prompt' && oldDef.payload.kind !== 'agentTurn') || (field === 'text' && oldDef.payload.kind !== 'reminder')) {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      const newText = delimitedBody !== undefined ? delimitedBody : inlineValue;
      if (!newText.trim()) return { reply: '✗ Invalid command syntax; use /help', isError: true };
      if (Array.from(newText).length > 4000) {
        return { reply: '✗ Prompt too long (max 4000 chars)', isError: true };
      }
      if (containsSecretPattern(newText)) {
        return { reply: '✗ Prompt looks like it contains a secret; not saved', isError: true };
      }
      patch = {
        payload:
          oldDef.payload.kind === 'reminder'
            ? { kind: 'reminder', text: newText }
            : { ...oldDef.payload, message: newText },
      };
    } else if (field === 'mode') {
      if (inlineValue !== 'session' && inlineValue !== 'isolated') {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      if (
        inlineValue === 'session' &&
        oldDef.payload.kind === 'agentTurn' &&
        (oldDef.payload.model !== undefined || oldDef.payload.effort !== undefined)
      ) {
        const { message, timeoutSeconds } = oldDef.payload;
        patch = {
          execMode: 'session',
          payload: {
            kind: 'agentTurn',
            message,
            ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
          },
        };
      } else {
        patch = { execMode: inlineValue };
      }
    } else if (field === 'enabled') {
      if (inlineValue !== 'true' && inlineValue !== 'false' && inlineValue !== 'on' && inlineValue !== 'off') {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      patch = { enabled: inlineValue === 'true' || inlineValue === 'on' };
    } else if (field === 'delivery') {
      if (inlineValue !== 'announce' && inlineValue !== 'none') {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      patch = { deliveryMode: inlineValue };
    } else if (field === 'model') {
      if (oldDef.payload.kind !== 'agentTurn' || oldDef.execMode === 'session' || !inlineValue) {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      patch = { payload: { ...oldDef.payload, model: inlineValue } };
    } else if (field === 'effort') {
      if (
        oldDef.payload.kind !== 'agentTurn' ||
        oldDef.execMode === 'session' ||
        !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(inlineValue)
      ) {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      patch = {
        payload: {
          ...oldDef.payload,
          effort: inlineValue as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
        },
      };
    } else if (field === 'timeout') {
      const secs = Number(inlineValue);
      if (oldDef.payload.kind !== 'agentTurn' || !Number.isSafeInteger(secs) || secs < 10 || secs > 7200) {
        return { reply: '✗ Invalid command syntax; use /help', isError: true };
      }
      patch = { payload: { ...oldDef.payload, timeoutSeconds: secs } };
    } else {
      return { reply: '✗ Invalid command syntax; use /help', isError: true };
    }

    this.#cancelQueuedRunIfPresent(scope, jobId, 'job-edited');
    const updated = this.store.edit(scope, jobId, revVal, patch);
    this.#callbacks.emitAudit?.({
      actor: caller.senderUid,
      action: 'cron.edit',
      target: jobId,
      outcome: 'ok',
      detail: `field=${field},revision=${updated.generation}`,
    });
    this.#callbacks.onWake?.();
    return {
      reply: `✓ Updated ${jobId} (revision ${updated.generation})`,
      isError: false,
    };
  }

  /**
   * TurnContext-bound agent tool handler.
   * Caller authority and conversation target are taken strictly from the live TurnContext,
   * never from model-supplied arguments.
   */
  async executeToolCall(
    rawArgs: Record<string, unknown>,
    turnCtx: TurnContext,
  ): Promise<{ text: string; isError: boolean }> {
    if (turnCtx.origin === 'cron') {
      return {
        text: '✗ Scheduled task tool is disabled inside scheduled task turns.',
        isError: true,
      };
    }
    const uid = turnCtx.principal.uid;
    const isOwner = Boolean(
      uid && this.issuer.isCreatorAuthorized(uid) && !this.config.managers.includes(uid),
    );
    const isAuthorized = this.issuer.isCreatorAuthorized(uid);
    if (!isAuthorized) {
      this.#callbacks.emitAudit?.({
        actor: uid || 'unknown',
        action: 'deny',
        target: turnCtx.session.sessionKey,
        outcome: 'denied',
        detail: 'cmd=tool:codex_buddy_cron,reason=DENY',
      });
      return { text: StringCatalog.commandDenied('cron'), isError: true };
    }

    const caller: CronCommandCallerContext = {
      senderUid: uid,
      isOwner,
      isCronManager: isAuthorized,
      isGroup: turnCtx.session.channelType !== 1,
      sessionKey: turnCtx.session.sessionKey,
      channelId: turnCtx.session.channelId,
      channelType: turnCtx.session.channelType,
    };

    // If model supplied a raw `command` string (e.g. "/cron list" or "add every 5m -- check status")
    if (typeof rawArgs.command === 'string' && rawArgs.command.trim() && typeof rawArgs.action !== 'string') {
      const cmd = rawArgs.command.trim();
      const body = cmd.startsWith('/cron') ? cmd : `/cron ${cmd}`;
      const res = await this.executeSlashCommand(body, caller);
      return { text: res.reply, isError: res.isError };
    }

    const action = typeof rawArgs.action === 'string' ? rawArgs.action.trim().toLowerCase() : '';
    const allConvFlag = rawArgs.allConversations === true ? ' --all-conversations' : '';
    const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

    switch (action) {
      case 'create':
      case 'add':
      case 'remind': {
        const sub = action === 'remind' || rawArgs.kind === 'reminder' ? 'remind' : 'add';
        const schedule = typeof rawArgs.schedule === 'string' ? rawArgs.schedule.trim() : '';
        const prompt =
          typeof rawArgs.prompt === 'string'
            ? rawArgs.prompt
            : typeof rawArgs.text === 'string'
              ? rawArgs.text
              : typeof rawArgs.message === 'string'
                ? rawArgs.message
                : '';
        if (!schedule || !prompt) {
          return { text: '✗ Invalid command syntax; use /help', isError: true };
        }
        const flags: string[] = [quote(schedule)];
        if (typeof rawArgs.tz === 'string' && rawArgs.tz.trim()) flags.push('--tz', quote(rawArgs.tz.trim()));
        if (typeof rawArgs.name === 'string' && rawArgs.name.trim()) flags.push('--name', quote(rawArgs.name.trim()));
        if (rawArgs.mode === 'session' || rawArgs.execMode === 'session') flags.push('--session');
        else if (sub === 'add' && (rawArgs.mode === 'isolated' || rawArgs.execMode === 'isolated')) flags.push('--isolated');
        if (rawArgs.keep === true || rawArgs.deleteAfterRun === false) flags.push('--keep');
        if (rawArgs.exact === true && sub === 'add') flags.push('--exact');
        if (rawArgs.delivery === 'none' || rawArgs.deliveryMode === 'none') flags.push('--delivery', 'none');
        else if (rawArgs.delivery === 'announce' || rawArgs.deliveryMode === 'announce') flags.push('--delivery', 'announce');
        if (typeof rawArgs.model === 'string' && rawArgs.model.trim() && sub === 'add') {
          flags.push('--model', quote(rawArgs.model.trim()));
        }
        if (typeof rawArgs.effort === 'string' && rawArgs.effort.trim() && sub === 'add') {
          flags.push('--effort', quote(rawArgs.effort.trim()));
        }
        if (typeof rawArgs.timeoutSeconds === 'number' && sub === 'add') {
          flags.push('--timeout', String(rawArgs.timeoutSeconds));
        }
        const res = await this.executeSlashCommand(`/cron ${sub} ${flags.join(' ')}\n--\n${prompt}`, caller);
        return { text: res.reply, isError: res.isError };
      }
      case 'list': {
        const flags: string[] = [];
        if (rawArgs.all === true || rawArgs.includeDisabled === true) flags.push('--all');
        if (typeof rawArgs.page === 'number') flags.push('--page', String(rawArgs.page));
        const res = await this.executeSlashCommand(`/cron list ${flags.join(' ')}${allConvFlag}`.trim(), caller);
        return { text: res.reply, isError: res.isError };
      }
      case 'show':
      case 'get': {
        const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : typeof rawArgs.jobId === 'string' ? rawArgs.jobId.trim() : '';
        const res = await this.executeSlashCommand(`/cron show ${id}${allConvFlag}`, caller);
        return { text: res.reply, isError: res.isError };
      }
      case 'runs':
      case 'history': {
        const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : typeof rawArgs.jobId === 'string' ? rawArgs.jobId.trim() : '';
        const pageFlag = typeof rawArgs.page === 'number' ? ` --page ${rawArgs.page}` : '';
        const res = await this.executeSlashCommand(`/cron runs ${id}${pageFlag}${allConvFlag}`, caller);
        return { text: res.reply, isError: res.isError };
      }
      case 'enable':
      case 'disable':
      case 'rm':
      case 'remove':
      case 'delete': {
        const sub = action === 'remove' || action === 'delete' ? 'rm' : action;
        const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : typeof rawArgs.jobId === 'string' ? rawArgs.jobId.trim() : '';
        const res = await this.executeSlashCommand(`/cron ${sub} ${id}${allConvFlag}`, caller);
        return { text: res.reply, isError: res.isError };
      }
      case 'run': {
        const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : typeof rawArgs.jobId === 'string' ? rawArgs.jobId.trim() : '';
        const modeFlag =
          rawArgs.mode === 'force' || rawArgs.force === true
            ? ' --force'
            : rawArgs.mode === 'due' || rawArgs.due === true
              ? ' --due'
              : '';
        const res = await this.executeSlashCommand(`/cron run ${id}${modeFlag}${allConvFlag}`, caller);
        return { text: res.reply, isError: res.isError };
      }
      case 'edit':
      case 'update': {
        const id = typeof rawArgs.id === 'string' ? rawArgs.id.trim() : typeof rawArgs.jobId === 'string' ? rawArgs.jobId.trim() : '';
        const revision = typeof rawArgs.revision === 'number' ? rawArgs.revision : typeof rawArgs.generation === 'number' ? rawArgs.generation : undefined;
        const field = typeof rawArgs.field === 'string' ? rawArgs.field.trim() : '';
        const value = typeof rawArgs.value === 'string' ? rawArgs.value : typeof rawArgs.value === 'number' || typeof rawArgs.value === 'boolean' ? String(rawArgs.value) : '';
        if (!id || revision === undefined || !field) {
          return { text: '✗ Invalid command syntax; use /help', isError: true };
        }
        const cmd =
          field === 'prompt' || field === 'text'
            ? `/cron edit ${id} --revision ${revision}${allConvFlag} ${field}\n--\n${value}`
            : `/cron edit ${id} --revision ${revision}${allConvFlag} ${field} ${quote(value)}`;
        const res = await this.executeSlashCommand(cmd, caller);
        return { text: res.reply, isError: res.isError };
      }
      default:
        return { text: '✗ Invalid command syntax; use /help', isError: true };
    }
  }
}

export { DeferredOperation, JobNotFound, StoreConflict };
