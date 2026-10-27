// SPDX-License-Identifier: Apache-2.0
/**
 * Subprocess entry for the scripted fake App Server, so a client can spawn it
 * exactly like the real binary: `node fake-app-server.mjs [--scenario file.json]`.
 *
 * Scenario files are JSON (no functions). An optional `faults` array arms a
 * FaultPlan, e.g. `{"faults":[{"point":"runtime.killChild","action":"kill"}]}`;
 * only the points the fake consults are accepted.
 *
 * Termination contract (a fixture choice, not pinned 0.142.3 behaviour):
 *  - every line written before termination is flushed to stdout first;
 *  - stdin EOF exits 0; in-flight turns are abandoned without `turn/completed`;
 *  - `runtime.killChild` makes the process kill itself with SIGKILL, so the
 *    parent sees `(code null, signal 'SIGKILL')`;
 *  - SIGTERM exits 143;
 *  - armed faults that never fired are reported on stderr as
 *    `fake-app-server: FaultPlan has unconsumed faults: ...`.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { FAKE_APP_SERVER_FAULT_POINTS, FakeAppServer } from '../lib/fake-app-server.mjs';
import { FaultPlan, NO_FAULTS } from '../lib/fault-plan.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--scenario');
const { faults: faultSpecs, ...scenario } = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : {};
const unknown = args.filter((a, i) => !(a === '--scenario' || i === at + 1));
if (unknown.length > 0) {
  process.stderr.write(`error: unexpected argument '${unknown[0]}'\n`);
  process.exit(2);
}
const faults = faultSpecs === undefined ? NO_FAULTS : armFaults(faultSpecs);
const server = new FakeAppServer(scenario, { faults });

let lastWrite = Promise.resolve();
let terminating = false;
server.pipeOutput(line => {
  lastWrite = new Promise(resolve => process.stdout.write(line, () => resolve()));
});
process.stdout.on('error', () => process.exit(1));
process.stdin.on('data', chunk => server.receive(chunk));
process.stdin.on('end', () => server.exit({ code: 0, reason: 'stdin-eof' }));
process.on('SIGTERM', () => server.exit({ code: 143, reason: 'sigterm' }));
server.on('exit', (code, signal) => terminate(code, signal));

function terminate(code, signal) {
  if (terminating) return;
  terminating = true;
  process.stdin.pause();
  if (faults instanceof FaultPlan) {
    try { faults.assertExhausted(); } catch (err) { process.stderr.write(`fake-app-server: ${err.message}\n`); }
  }
  lastWrite.then(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function armFaults(specs) {
  if (!Array.isArray(specs)) usage('scenario faults must be an array');
  const plan = new FaultPlan();
  for (const { point, ...spec } of specs) {
    if (!FAKE_APP_SERVER_FAULT_POINTS.includes(point)) usage(`fault point ${point} is not used by the fake App Server`);
    plan.arm(point, spec);
  }
  return plan;
}

function usage(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}
