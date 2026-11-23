// SPDX-License-Identifier: Apache-2.0
// Owns every process, lock and DB in this crash fixture. Supervisor collects paths.
import { writeFileSync } from 'node:fs';
import { repairFixture, state } from './restart-fixture.mjs';
const [checkpoint, point, mode, kind] = process.argv.slice(2), cleanup = [];
try {
  const f = await repairFixture({ after(fn) { cleanup.push(fn); } }, kind === 'borrow' ? { manual: 'if-enabled' }
    : kind === 'queued' ? { running: false } : {});
  f.db.pragma('journal_mode=WAL');
  writeFileSync(checkpoint, JSON.stringify({ db: f.path, dbDir: f.dir, lifecycleDir: f.o.dir,
    driverPid: process.pid, before: state(f.db), expected: f.expected, nativeScope: f.binding.expected }));
  const crash = () => {
    if (mode === 'exit') process.exit(73);
    process.send({ crash: true }); // Supervisor signals only its directly created handle.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
    throw new Error('Supervisor did not collect requested SIGKILL');
  };
  const result = f.repair(f.makeStore(point === 'afterCommit' ? {} : { [point]: crash }));
  if (result.kind !== (kind === 'queued' ? 'resumed' : 'repaired') || f.db.inTransaction) throw new Error('Repair did not commit');
  if (point !== 'afterCommit') throw new Error('Crash seam was not reached');
  crash();
} catch (error) {
  for (const fn of cleanup.reverse()) await fn();
  throw error;
}
