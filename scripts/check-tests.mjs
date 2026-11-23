// SPDX-License-Identifier: Apache-2.0
// Runs before `npm test`: proves that every test file in the tree is collected
// by a runner, and that no reviewed node:test suite has been dropped or renamed
// out of the globs. New suites are allowed as long as a runner collects them;
// removing a pinned suite needs a reviewed edit to NODE_SUITES below.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { matchesGlob } from 'node:path';
import assert from 'node:assert/strict';
import { loadManifest } from './lib/manifest.mjs';
import { CORE_GLOBS, GUARDED_SUITES, PROVENANCE_SUITE } from './lib/test-suites.mjs';

const VITEST_GLOBS = ['test/host/**/*.test.ts'];
// The cron suites use source-resolution hooks; the native timeout test needs
// extra time to observe the real 30-second deadline and clean up its child.
const CRON_GLOBS = [
  'test/cron-schedule/*.test.mjs',
  'test/cron-store/*.test.mjs',
  'test/cron-store/fixture-reconciliation.mjs',
  'test/cron-store/manual-terminal-regression.mjs',
  'test/cron-store/restart-canonical-method.mjs',
  'test/cron-store/restart-construction.mjs',
  'test/cron-store/restart-crashes.mjs',
  'test/cron-store/restart-nested-lease.mjs',
  'test/cron-store/restart-prerequisite.mjs',
  'test/cron-store/restart-repair.mjs',
];
const CHILD_TIMEOUT_SUITE = 'test/runtime/previous-child-timeout.mjs';
const NODE_GLOBS = [...CORE_GLOBS, ...CRON_GLOBS, CHILD_TIMEOUT_SUITE];
const quoteGlobs = (patterns) => patterns.map((path) => path.includes('*') ? JSON.stringify(path) : path).join(' ');
const TEST_COMMAND = 'node scripts/run-tests.mjs';
const CRON_TEST_COMMAND = `node --import ./test/cron-schedule/register.mjs --import ./test/cron-store/register.mjs --test --test-timeout=90000 ${quoteGlobs(CRON_GLOBS)}`;
const CHILD_TIMEOUT_COMMAND = `node --test --test-timeout=45000 ${CHILD_TIMEOUT_SUITE}`;
const HOST_TEST_COMMAND = 'vitest run --config vitest.config.mjs';
const VITEST_CONFIG_SHA256 = '0bd1ad92b5209b2b70e6ad16cbffdd882d6a24564172800dc687576762c9a3c8';
const NODE_RUNNER_FILES = [
  ['scripts/run-tests.mjs', '0db006e94c5a272dcdfd3d8df72a9392b50783b325e2ba4b1f8806e0af74fd23'],
  ['scripts/lib/test-suites.mjs', '4c490bbd1055b29cfe762ba0ad0a342a7687c3166c49ca86e9992f08a3307109'],
];
const AUTHORED_HOST_SUITE = 'test/host/cron-fire-marker.test.ts';
// node:test suites pinned at the reviewed integration head, plus DEV02/DEV04 coverage.
const NODE_SUITES = [
  'test/app-server/client.test.mjs',
  'test/app-server/errors.test.mjs',
  'test/app-server/framing.test.mjs',
  'test/app-server/raw-wire.test.mjs',
  'test/app-server/server-requests.test.mjs',
  'test/dev02-api.test.mjs',
  'test/dev02-lock.test.mjs',
  'test/dev02-transport.test.mjs',
  'test/foundation.test.mjs',
  'test/foundation/clock.test.mjs',
  'test/foundation/fake-app-server-lifecycle.test.mjs',
  'test/foundation/fake-app-server.test.mjs',
  'test/foundation/fake-octo.test.mjs',
  'test/foundation/fault-plan.test.mjs',
  'test/foundation/goldens.test.mjs',
  'test/foundation/mock-responses.test.mjs',
  'test/foundation/parity-matrix.test.mjs',
  'test/foundation/scope.test.mjs',
  'test/foundation/wire-codec.test.mjs',
  'test/integration-checks.test.mjs',
  'test/runtime/process.test.mjs',
  'test/runtime/runtime.test.mjs',
];

// Pin the full commands and config bytes so runner options cannot omit tests.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.scripts.test, TEST_COMMAND, 'npm test command changed');
assert.equal(pkg.scripts['test:cron'], CRON_TEST_COMMAND, 'npm test:cron command changed');
assert.equal(pkg.scripts['test:child-timeout'], CHILD_TIMEOUT_COMMAND, 'npm test:child-timeout command changed');
assert.equal(pkg.scripts['test:host'], HOST_TEST_COMMAND, 'npm test:host command changed');
assert.equal(createHash('sha256').update(readFileSync('vitest.config.mjs')).digest('hex'), VITEST_CONFIG_SHA256, 'vitest config bytes changed');

for (const [path, expected] of NODE_RUNNER_FILES) {
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected, `node:test runner bytes changed: ${path}`);
}

const tracked = execFileSync('git', ['ls-files', '-z', 'test', 'src', 'scripts'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const byNode = (path) => NODE_GLOBS.some((g) => matchesGlob(path, g));
const byVitest = (path) => VITEST_GLOBS.some((g) => matchesGlob(path, g));
const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_IMPORT = /\bfrom\s+['"](?:node:test|vitest)['"]|\brequire\(\s*['"]node:test['"]\s*\)|\bimport\(\s*['"]node:test['"]\s*\)/;

const failures = [];
if (!tracked.includes(AUTHORED_HOST_SUITE)) failures.push(`reviewed authored host suite missing: ${AUTHORED_HOST_SUITE}`);
const nodeCollected = [];
let vitestCollected = 0;
for (const path of tracked) {
  if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
  const looksLikeTest = TEST_NAME.test(path) || TEST_IMPORT.test(readFileSync(path, 'utf8'));
  if (byNode(path)) nodeCollected.push(path);
  else if (byVitest(path)) vitestCollected += 1;
  else if (looksLikeTest) failures.push(`test file not collected by npm test or test:host: ${path}`);
}
for (const suite of [...new Set([...NODE_SUITES, ...GUARDED_SUITES, PROVENANCE_SUITE]), ...CRON_GLOBS.filter((path) => !path.includes('*')), CHILD_TIMEOUT_SUITE]) {
  if (!tracked.includes(suite)) failures.push(`reviewed node:test suite missing: ${suite}`);
  else if (!byNode(suite)) failures.push(`reviewed node:test suite outside the npm test globs: ${suite}`);
}
// Every imported or authored host test must stay inside the vitest include.
for (const entry of loadManifest().imports) {
  if (entry.destination.startsWith('test/host/') && !byVitest(entry.destination)) failures.push(`host test outside the vitest include: ${entry.destination}`);
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
const added = nodeCollected.filter((p) => !NODE_SUITES.includes(p));
console.log(`Test coverage verified: ${nodeCollected.length} node:test files (${NODE_SUITES.length} reviewed${added.length ? `, ${added.length} new: ${added.join(', ')}` : ''}), ${vitestCollected} vitest files; no uncollected test files.`);
