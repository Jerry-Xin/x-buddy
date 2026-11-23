// SPDX-License-Identifier: Apache-2.0
/** Pinned 0.142.3 exec-effective parameters; host config resolution stays upstream. */
import { delimiter } from 'node:path';
import type { TurnRequest } from '../runtime/types.js';

/** Structural input subset from the pinned SDK; no SDK runtime import. */
export interface CodexOptions { apiKey?: string; baseUrl?: string; env?: Record<string, string> }
export interface ThreadOptions {
  workingDirectory?: string; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  model?: string; additionalDirectories?: string[]; modelReasoningEffort?: string;
  networkAccessEnabled?: boolean; webSearchMode?: 'disabled' | 'cached' | 'live';
  webSearchEnabled?: boolean; approvalPolicy?: string;
}

export function normalizeTurnParams(options: ThreadOptions): Pick<TurnRequest, 'threadParams' | 'turnParams'> {
  const cwd = options.workingDirectory;
  if (!cwd) throw new Error('workingDirectory is required at the executor boundary');
  const sandbox = options.sandboxMode ?? 'read-only';
  return {
    threadParams: { cwd, sandbox, ...(options.model ? { model: options.model } : {}),
      ...(sandbox === 'workspace-write' && options.additionalDirectories?.length ? { runtimeWorkspaceRoots: [cwd, ...options.additionalDirectories] } : {}) },
    turnParams: { cwd, ...(options.modelReasoningEffort ? { effort: options.modelReasoningEffort } : {}) },
  };
}

/** Build only process-lifetime settings. The caller owns binary selection and restart. */
export function normalizeProcessParams(codex: CodexOptions, options: ThreadOptions, baseEnv: NodeJS.ProcessEnv, vendorPathDirs: readonly string[] = []) {
  const env: NodeJS.ProcessEnv = { ...(codex.env ?? baseEnv) };
  if (!env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_sdk_ts';
  if (codex.apiKey) env.CODEX_API_KEY = codex.apiKey;
  if (vendorPathDirs.length) env.PATH = [...vendorPathDirs, env.PATH ?? ''].join(delimiter);
  const args = ['app-server', '--listen', 'stdio://'];
  const set = (key: string, value: unknown) => args.push('-c', `${key}=${JSON.stringify(value)}`);
  if (codex.baseUrl) set('openai_base_url', codex.baseUrl);
  if (options.networkAccessEnabled !== undefined) set('sandbox_workspace_write.network_access', options.networkAccessEnabled);
  // Exec's effective resolver returns cached for disabled, too (R8 §3.3.6).
  set('web_search', options.webSearchMode === 'live' || (!options.webSearchMode && options.webSearchEnabled) ? 'live' : 'cached');
  if (options.modelReasoningEffort) set('model_reasoning_effort', options.modelReasoningEffort);
  set('approval_policy', 'never');
  if (codex.apiKey) set('cli_auth_credentials_store', 'ephemeral');
  return { args, env, ...(codex.apiKey ? { login: { type: 'apiKey' as const, apiKey: codex.apiKey } } : {}) };
}
