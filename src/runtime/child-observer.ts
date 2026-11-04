// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { DARWIN_CHILD_OBSERVER } from './darwin-child.js';

export class ChildLifecycleRefusal extends Error {
  constructor(readonly reason: string) { super(`Child lifecycle refused: ${reason}`); }
}

export interface NativeChildIdentity { pid: number; start: [number, number] }
export type ChildExitObservation =
  | { source: 'owned-child-exit'; code: number | null; signal: NodeJS.Signals | null }
  | { source: 'kqueue-note-exit'; waitStatus: number; code: number | null; signal: number | null };
export interface ChildDiagnostic {
  version: 1; bot: string; incarnation: string; host: NativeChildIdentity; child: NativeChildIdentity;
  state: 'running' | 'exited'; exit: ChildExitObservation | null; lease: [number, number];
}
export interface ReconciledChild {
  kind: 'reconciled'; previous: ChildDiagnostic; exit: ChildExitObservation; lease: [number, number];
}
type Observation = { kind: 'recorded'; record: ChildDiagnostic } | ReconciledChild;

/** Internal fixed observer, not a request-selected proof/verifier seam. */
export async function observeChild(request: Record<string, unknown>): Promise<Observation> {
  if (process.platform !== 'darwin') throw new ChildLifecycleRefusal('unsupported-platform');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-c', DARWIN_CHILD_OBSERVER], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; let overflow = false; let unavailable = false;
    child.stdout.on('data', (data: Buffer) => {
      if (output.length + data.length > 16_384) overflow = true;
      else output += data.toString('utf8');
    });
    // Native stderr may contain local paths. It is not an outward diagnostic.
    child.stderr.resume();
    child.stdin.on('error', () => { unavailable = true; });
    child.once('error', () => { unavailable = true; });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || overflow || unavailable) return reject(new ChildLifecycleRefusal('observer-unavailable'));
      try {
        const value = JSON.parse(output);
        if (value.kind === 'refused') throw new ChildLifecycleRefusal(value.reason);
        if (value.kind !== 'recorded' && value.kind !== 'reconciled') throw new Error('shape');
        freeze(value);
        resolve(value);
      } catch (error) {
        reject(error instanceof ChildLifecycleRefusal ? error : new ChildLifecycleRefusal('observer-unavailable'));
      }
    });
    // This bounds the owned helper, never the recorded App Server PID. Killing
    // this helper cannot grant ownership: close must yield a complete receipt.
    const timer = setTimeout(() => { unavailable = true; child.kill('SIGKILL'); }, 35_000);
    child.stdin.end(JSON.stringify(request));
  });
}

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
