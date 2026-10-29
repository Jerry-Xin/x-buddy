// SPDX-License-Identifier: MIT
// Structural types for the pure pinned helpers; no host or store types.
export type CronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz: string; staggerMs?: number }
  | { kind: 'on-exit' | 'stream' };
