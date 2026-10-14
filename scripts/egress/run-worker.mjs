// SPDX-License-Identifier: Apache-2.0
/**
 * Measured, watchdog-guarded scanner worker.
 *
 * Spawns one worker process, measures monotonic launch-to-exit time and peak
 * RSS (worker-reported OS accounting via getrusage, combined with the
 * parent's periodic RSS samples), and enforces the hard watchdog: 60 seconds
 * and 1 GiB per invocation. A kill, crash or missing final record is never a
 * pass. Limits may be lowered (for watchdog tests) but never raised.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { setInterval, setTimeout, clearInterval, clearTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';

export const WATCHDOG = Object.freeze({ timeoutMs: 60_000, rssBytes: 1024 * 1024 * 1024 });
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function sampleRssKb(pid) {
  try {
    if (existsSync(`/proc/${pid}/status`)) {
      const match = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      return match ? Number(match[1]) : 0;
    }
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {{args?: string[], script?: string, timeoutMs?: number, rssBytes?: number, pollMs?: number, cwd?: string}} options
 */
export function runWorker(options = {}) {
  const timeoutMs = options.timeoutMs ?? WATCHDOG.timeoutMs;
  const rssBytes = options.rssBytes ?? WATCHDOG.rssBytes;
  if (timeoutMs > WATCHDOG.timeoutMs || rssBytes > WATCHDOG.rssBytes) {
    return Promise.reject(new Error('watchdog limits may not exceed 60 seconds / 1 GiB'));
  }
  const pollMs = options.pollMs ?? 25;
  return new Promise((resolvePromise) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [options.script ?? WORKER, ...(options.args ?? [])], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let watchdog = 'ok';
    let peakPolledKb = 0;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const kill = (reason) => {
      if (watchdog !== 'ok') return;
      watchdog = reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    const poller = setInterval(() => {
      const kb = sampleRssKb(child.pid);
      peakPolledKb = Math.max(peakPolledKb, kb);
      if (kb * 1024 > rssBytes) kill('rss');
    }, pollMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearInterval(poller);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      let record;
      for (const line of stdout.trim().split('\n').reverse()) {
        try { record = JSON.parse(line).record; } catch { record = undefined; }
        if (record) break;
      }
      const peakRssKb = Math.max(peakPolledKb, record?.maxRssKb ?? 0);
      if (watchdog === 'ok' && peakRssKb * 1024 > rssBytes) watchdog = 'rss';
      if (watchdog === 'ok' && !record) watchdog = signal ? 'crash' : 'no-record';
      resolvePromise({ exitCode, signal, elapsedMs, peakRssKb, peakPolledKb, watchdog, ok: watchdog === 'ok', record, stderr: stderr.slice(-2000) });
    });
  });
}

/** Nearest-rank percentile over raw samples (p95 of 20 samples is sample 19). */
export function nearestRank(samples, percentile) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return { rank, value: sorted[rank - 1], sorted };
}
