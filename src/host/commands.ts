// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/commands.ts; changes: spdx-header, change-notice.
/**
 * In-chat slash commands (v0.3 + M1 OwnerAuthZ & Addressing matrix).
 *
 * Users can control their session without leaving the chat:
 *   /reset            — clear this session's conversation history
 *   /new              — alias of /reset
 *   /config           — show the effective per-session settings
 *   /help             — list available commands
 *   /cron             — recognized (disabled in M1)
 *   /fork             — recognized owner-only (disabled in M1)
 */

import type { Config } from './config.js';
import type { SessionStore } from './session-store.js';
import { selectExecutor } from '../runtime/executor.js';
import { StringCatalog, type EgressKind } from '../runtime/octo-egress.js';

export type AddressingClass = 'E' | 'B' | 'F' | 'U';
export type CommandOutcomeKind = 'EXEC' | 'DENY' | 'ADDRESS' | 'DISABLED' | 'UNKNOWN' | 'DROP' | 'NOT_COMMAND';

export interface OwnerAuthZ {
  readonly isOwner: boolean;
  readonly isSessionManager: boolean;
  readonly isCronManager: boolean;
  readonly role: 'owner' | 'dual-manager' | 'session-manager' | 'cron-manager' | 'member';
}

export interface CronCommandServiceLike {
  executeSlashCommand(
    rawBody: string,
    caller: {
      senderUid: string;
      isOwner: boolean;
      isCronManager: boolean;
      isGroup: boolean;
      sessionKey: string;
      channelId: string;
      channelType: 1 | 2 | 5;
    },
  ): { reply: string; isError: boolean; scopeDenied?: boolean };
}

export interface CommandEvaluationContext {
  senderUid?: string;
  ownerUid?: string;
  channelId?: string;
  channelType?: 1 | 2 | 5;
  addressing?: AddressingClass;
  cronEnabled?: boolean;
  cronDisabledReason?: string;
  authorizedCronJobCount?: number;
  cronService?: CronCommandServiceLike;
  forkEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
  performLegacyStoreReset?: boolean;
  auditLogger?: (entry: CommandAuditEntry) => void;
}

export interface CommandAuditEntry {
  command: string;
  outcome: CommandOutcomeKind;
  senderUid: string;
  role: OwnerAuthZ['role'];
  channelId: string;
  channelType: 1 | 2 | 5;
  addressing: AddressingClass;
  sessionKey: string;
  auditLine: string;
}

/** Result of attempting to handle a command. */
export interface CommandResult {
  /** True when the text was a recognized command (or unknown slash command) and was handled. */
  handled: boolean;
  /** Reply to send back to the user (only meaningful when handled and outcome !== 'DROP'). */
  reply?: string;
  /** Detailed M1 outcome classification. */
  outcome?: CommandOutcomeKind;
  /** Egress kind for OctoEgress routing. */
  egressKind?: EgressKind;
  /** Parsed command name when matched. */
  commandName?: string;
  /** Parsed command arguments when matched. */
  commandArgs?: string;
  /** True when this is an authorized /reset or /new ready for execution.resetSession. */
  isAuthorizedReset?: boolean;
  /** True when --all-conversations was authorized for owner in owner's DM. */
  allConversations?: boolean;
  /** Resolved principal authorization state. */
  auth?: OwnerAuthZ;
  /** Emitted audit record for non-DROP command outcomes. */
  audit?: CommandAuditEntry;
}

/** Not a command at all — let the normal agent pipeline take over. */
const NOT_A_COMMAND: CommandResult = { handled: false, outcome: 'NOT_COMMAND' };

/**
 * Parse the command token from a message body. Returns the lowercased command
 * name (without the leading slash) and the trimmed argument string, or null
 * when the text does not start with a slash command.
 */
export function parseCommand(
  body: string,
): { name: string; args: string } | null {
  const rawFirstLine = body.split('\n', 1)[0]?.trim() ?? '';
  const firstLine = /^[\uFF0F/]cron(?:\s|$)/i.test(rawFirstLine)
    ? rawFirstLine.replace(/^\uFF0F/, '/').replace(/\u3000/g, ' ').replace(/\uFF0D/g, '-')
    : rawFirstLine;
  const match = firstLine.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

export function isResetCommandText(body: string | undefined): boolean {
  if (typeof body !== 'string') return false;
  const parsed = parseCommand(body);
  return parsed?.name === 'reset' || parsed?.name === 'new';
}

export function resolveOwnerAuthZ(
  senderUid: string | undefined,
  ownerUid: string | undefined,
  config: Config,
): OwnerAuthZ {
  const uid = (senderUid ?? '').trim();
  const liveOwner = (ownerUid ?? '').trim();
  // Empty ownerUid means O=false, never a wildcard.
  const isOwner = Boolean(uid.length > 0 && liveOwner.length > 0 && uid === liveOwner);
  const commandsManagers = config.commands?.managers ?? [];
  const hasExplicitCron = Boolean(config.cron?.explicitManagers);
  const cronManagers = hasExplicitCron
    ? (config.cron?.managers ?? [])
    : (config.cron?.managers !== undefined && config.cron.managers.length > 0
        ? config.cron.managers
        : commandsManagers);
  const isSessionManager = Boolean(uid.length > 0 && commandsManagers.includes(uid));
  const isCronManager = Boolean(uid.length > 0 && cronManagers.includes(uid));
  const role: OwnerAuthZ['role'] = isOwner
    ? 'owner'
    : isSessionManager && isCronManager
      ? 'dual-manager'
      : isSessionManager
        ? 'session-manager'
        : isCronManager
          ? 'cron-manager'
          : 'member';
  return { isOwner, isSessionManager, isCronManager, role };
}

export function renderHelp(
  auth?: OwnerAuthZ,
  channelType: 1 | 2 | 5 = 1,
  options?: Pick<CommandEvaluationContext, 'cronEnabled' | 'forkEnabled'>,
): string {
  const isGroup = channelType === 2 || channelType === 5;
  const canSession = !isGroup || Boolean(auth?.isOwner || auth?.isSessionManager);
  const canCron = Boolean(options?.cronEnabled && (auth?.isOwner || auth?.isCronManager));
  const canFork = Boolean(options?.forkEnabled && auth?.isOwner);

  const lines: string[] = ['Available commands:'];
  if (canSession) {
    lines.push(
      '• `/reset` — clear the conversation history for this session (the whole group, in a group chat); does not clear long-term memory',
    );
    lines.push('• `/new` — alias of /reset');
    lines.push('• `/config` — show the current session settings');
  }
  if (canCron) {
    lines.push('• `/cron` — manage scheduled tasks in this conversation (owner/managers)');
  }
  if (canFork) {
    lines.push('• `/fork <prompt>` — start a separate conversation (owner)');
  }
  lines.push('• `/help` — show this message');
  return lines.join('\n');
}

export function renderConfig(
  config: Config,
  options?: Pick<CommandEvaluationContext, 'cronEnabled' | 'cronDisabledReason' | 'authorizedCronJobCount' | 'env'>,
): string {
  const configuredApproval = config.sdk?.approvalPolicy ?? 'never';
  const configuredWebSearchOn = Boolean(
    config.sdk?.webSearchEnabled ||
      (config.sdk?.webSearchMode && config.sdk.webSearchMode !== 'disabled'),
  );
  const effectiveWebSearchMode =
    config.sdk?.webSearchMode === 'live' || config.sdk?.webSearchEnabled === true
      ? 'live'
      : 'cached';
  let executorKind: 'sdk' | 'app-server';
  try {
    executorKind = selectExecutor(options?.env ?? process.env);
  } catch {
    executorKind = 'app-server';
  }
  const cronEnabled = Boolean(options?.cronEnabled && executorKind !== 'sdk');
  const cronDisabledReason =
    executorKind === 'sdk'
      ? 'executor-sdk'
      : (options?.cronDisabledReason ?? 'm1');
  const cronStatus = cronEnabled ? 'enabled' : `disabled(${cronDisabledReason})`;
  const jobCount = options?.authorizedCronJobCount ?? 0;
  const codexHomeLabel = config.sdk?.codexHomeSharedOptIn
    ? 'shared opt-in; concurrent writers unsupported'
    : 'per-bot';

  return [
    'Current settings:',
    `• model: ${config.sdk?.model ?? '(codex default)'}`,
    `• sandboxMode: ${config.sdk?.sandboxMode ?? 'read-only'}`,
    `• approvalPolicy: never (effective; configured: ${configuredApproval})`,
    `• reasoningEffort: ${config.sdk?.modelReasoningEffort ?? 'medium'}`,
    `• network: ${config.sdk?.sandboxMode === 'danger-full-access'
      ? 'on (Codex sandbox disabled)'
      : config.sdk?.networkAccessEnabled ? 'on' : 'off'}`,
    `• webSearch: ${effectiveWebSearchMode} (effective; configured: ${configuredWebSearchOn ? 'on' : 'off'})`,
    `• toolProgress: ${config.sdk?.toolProgress ? 'on' : 'off'}`,
    `• rateLimit: ${config.rateLimit?.maxPerMinute ?? 5} req/min`,
    `• historyLimit: ${config.context?.historyLimit ?? 40} messages`,
    `• executor: ${executorKind}`,
    `• cron: ${cronStatus}; jobs: ${jobCount}`,
    `• codexHome: ${codexHomeLabel}`,
  ].join('\n');
}

export function handleCommand(
  body: string,
  sessionKey: string,
  store: SessionStore,
  config: Config,
  messageSeq?: number,
  evalCtx?: CommandEvaluationContext,
): CommandResult {
  const parsed = parseCommand(body);
  if (!parsed) return NOT_A_COMMAND;

  const channelType: 1 | 2 | 5 = evalCtx?.channelType ?? 1;
  const isGroup = channelType === 2 || channelType === 5;
  const addressing: AddressingClass = evalCtx?.addressing ?? 'E';
  const senderUid = evalCtx?.senderUid ?? '';
  const channelId = evalCtx?.channelId ?? sessionKey;
  const effectiveAuth: OwnerAuthZ = resolveOwnerAuthZ(
    senderUid,
    evalCtx?.ownerUid,
    config,
  );
  const hasEvalCtx = evalCtx !== undefined;

  const emitAudit = (outcome: CommandOutcomeKind): CommandAuditEntry | undefined => {
    if (outcome === 'DROP' || outcome === 'NOT_COMMAND') return undefined;
    const ts = new Date().toISOString();
    const botId = (config.botId ?? '').trim() || 'default';
    const actor = senderUid.trim() || 'unknown';
    const action = outcome === 'DENY' ? 'deny' : 'command';
    const auditOutcome = outcome === 'DENY' || outcome === 'ADDRESS' ? 'denied' : 'ok';
    const detail = `cmd=/${parsed.name},reason=${outcome},role=${effectiveAuth.role},addr=${addressing}`;
    const auditLine = `[AUDIT] ts=${ts} bot=${botId} actor=${actor} action=${action} target=${sessionKey} outcome=${auditOutcome} detail=${detail}`;
    const entry: CommandAuditEntry = {
      command: parsed.name,
      outcome,
      senderUid,
      role: effectiveAuth.role,
      channelId,
      channelType,
      addressing,
      sessionKey,
      auditLine,
    };
    console.log(auditLine);
    if (evalCtx?.auditLogger) {
      evalCtx.auditLogger(entry);
    }
    return entry;
  };

  if (isGroup && addressing === 'U') {
    return {
      handled: true,
      outcome: 'DROP',
      commandName: parsed.name,
      commandArgs: parsed.args,
      auth: effectiveAuth,
    };
  }

  switch (parsed.name) {
    case 'help': {
      const audit = emitAudit('EXEC');
      return {
        handled: true,
        outcome: 'EXEC',
        egressKind: 'command.reply',
        commandName: parsed.name,
        commandArgs: parsed.args,
        auth: effectiveAuth,
        audit,
        reply: renderHelp(effectiveAuth, channelType, evalCtx),
      };
    }

    case 'reset':
    case 'new': {
      const canSession = !isGroup || effectiveAuth.isOwner || effectiveAuth.isSessionManager;
      if (!canSession) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandDenied(parsed.name),
        };
      }
      if (isGroup && addressing === 'B') {
        const audit = emitAudit('ADDRESS');
        return {
          handled: true,
          outcome: 'ADDRESS',
          egressKind: 'command.address_required',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandAddressRequired(parsed.name),
        };
      }
      const wantsAllConversations = /(?:^|\s)--all-conversations(?:\s|$)/.test(parsed.args);
      if (wantsAllConversations && (!effectiveAuth.isOwner || isGroup)) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.scope_denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandScopeDenied(),
        };
      }
      if (!hasEvalCtx || evalCtx?.performLegacyStoreReset === true) {
        store.deleteSession(sessionKey);
        if (messageSeq !== undefined) {
          store.setResetBarrier(sessionKey, messageSeq);
        }
        store.clearSdkSessionId(sessionKey);
      }
      const audit = emitAudit('EXEC');
      return {
        handled: true,
        outcome: 'EXEC',
        egressKind: 'command.reset',
        commandName: parsed.name,
        commandArgs: parsed.args,
        isAuthorizedReset: true,
        allConversations: wantsAllConversations,
        auth: effectiveAuth,
        audit,
        reply: StringCatalog.commandReset(),
      };
    }

    case 'config': {
      const canSession = !isGroup || effectiveAuth.isOwner || effectiveAuth.isSessionManager;
      if (!canSession) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandDenied('config'),
        };
      }
      if (isGroup && addressing === 'B') {
        const audit = emitAudit('ADDRESS');
        return {
          handled: true,
          outcome: 'ADDRESS',
          egressKind: 'command.address_required',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandAddressRequired('config'),
        };
      }
      const audit = emitAudit('EXEC');
      return {
        handled: true,
        outcome: 'EXEC',
        egressKind: 'command.reply',
        commandName: parsed.name,
        commandArgs: parsed.args,
        auth: effectiveAuth,
        audit,
        reply: renderConfig(config, evalCtx),
      };
    }

    case 'cron': {
      const canCron = effectiveAuth.isOwner || effectiveAuth.isCronManager;
      if (!canCron) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandDenied('cron'),
        };
      }
      if (isGroup && addressing === 'B') {
        const audit = emitAudit('ADDRESS');
        return {
          handled: true,
          outcome: 'ADDRESS',
          egressKind: 'command.address_required',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandAddressRequired('cron'),
        };
      }
      const cmdPartBeforeDelimiter = parsed.args.split(/\s+--(?:\s|$)/, 1)[0] ?? parsed.args;
      const subToken = cmdPartBeforeDelimiter.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
      const wantsAllConversations = /(?:^|\s)--all-conversations(?:\s|$)/.test(cmdPartBeforeDelimiter);
      if (wantsAllConversations && subToken !== 'add' && subToken !== 'remind' && (!effectiveAuth.isOwner || isGroup)) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.scope_denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandScopeDenied(),
        };
      }
      let executorKind: 'sdk' | 'app-server';
      try {
        executorKind = selectExecutor(evalCtx?.env ?? process.env);
      } catch {
        executorKind = 'app-server';
      }
      const isCronActive = Boolean(
        evalCtx?.cronEnabled &&
          executorKind !== 'sdk' &&
          evalCtx?.env?.CODEX_OCTO_SKIP_CRON !== '1' &&
          config.cron?.enabled !== false &&
          evalCtx?.cronService,
      );
      if (!isCronActive || !evalCtx?.cronService) {
        const audit = emitAudit('DISABLED');
        return {
          handled: true,
          outcome: 'DISABLED',
          egressKind: 'command.disabled',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandDisabled('cron'),
        };
      }
      const res = evalCtx.cronService.executeSlashCommand(body, {
        senderUid,
        isOwner: effectiveAuth.isOwner,
        isCronManager: effectiveAuth.isCronManager,
        isGroup,
        sessionKey,
        channelId,
        channelType,
      });
      if (res.scopeDenied) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.scope_denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: res.reply,
        };
      }
      const audit = emitAudit('EXEC');
      return {
        handled: true,
        outcome: 'EXEC',
        egressKind: 'command.reply',
        commandName: parsed.name,
        commandArgs: parsed.args,
        allConversations: wantsAllConversations,
        auth: effectiveAuth,
        audit,
        reply: res.reply,
      };
    }

    case 'fork': {
      if (!effectiveAuth.isOwner) {
        const audit = emitAudit('DENY');
        return {
          handled: true,
          outcome: 'DENY',
          egressKind: 'command.denied',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandDenied('fork'),
        };
      }
      if (isGroup && addressing === 'B') {
        const audit = emitAudit('ADDRESS');
        return {
          handled: true,
          outcome: 'ADDRESS',
          egressKind: 'command.address_required',
          commandName: parsed.name,
          commandArgs: parsed.args,
          auth: effectiveAuth,
          audit,
          reply: StringCatalog.commandAddressRequired('fork'),
        };
      }
      const audit = emitAudit('DISABLED');
      return {
        handled: true,
        outcome: 'DISABLED',
        egressKind: 'command.disabled',
        commandName: parsed.name,
        commandArgs: parsed.args,
        auth: effectiveAuth,
        audit,
        reply: StringCatalog.commandDisabled('fork'),
      };
    }

    default: {
      const audit = emitAudit('UNKNOWN');
      const helpText = renderHelp(effectiveAuth, channelType, evalCtx);
      return {
        handled: true,
        outcome: 'UNKNOWN',
        egressKind: 'command.unknown',
        commandName: parsed.name,
        commandArgs: parsed.args,
        auth: effectiveAuth,
        audit,
        reply: StringCatalog.commandUnknown(parsed.name, helpText),
      };
    }
  }
}
