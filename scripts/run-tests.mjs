// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CORE_GLOBS, GUARDED_SUITES, PROVENANCE_SUITE } from './lib/test-suites.mjs';

const require = createRequire(import.meta.url);
const sqlite = dirname(require.resolve('better-sqlite3/package.json'));
const typescript = dirname(require.resolve('typescript/package.json'));
const pinRepo = process.env.HOST_PIN_REPO;
if (!pinRepo) {
  console.error('Set HOST_PIN_REPO to a Git repository containing the pinned host source commit (see .github/workflows/ci.yml).');
  process.exit(1);
}

const root = mkdtempSync(join(realpathSync(tmpdir()), 'x-buddy-tests-'));
try {
  const fixtureEnv = {
    HOST_PIN_REPO: resolve(pinRepo),
    HOST_SQLITE: process.env.HOST_SQLITE ?? sqlite,
    HOST_TYPESCRIPT: process.env.HOST_TYPESCRIPT ?? typescript,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
  };
  mkdirSync(fixtureEnv.HOME, { mode: 0o700 });
  mkdirSync(fixtureEnv.TMPDIR, { mode: 0o700 });
  const guardedEnv = {
    ...fixtureEnv,
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    CALLER_GUARD_ROOT: root,
    HOST_REAL_BRIDGE: '1',
  };
  const ordinaryEnv = {
    ...process.env,
    ...fixtureEnv,
    CRON_STORE_SQLITE_PACKAGE: process.env.CRON_STORE_SQLITE_PACKAGE ?? sqlite,
    CRON_STORE_SCRATCH: process.env.CRON_STORE_SCRATCH ?? root,
  };
  const guarded = new Set([...GUARDED_SUITES, PROVENANCE_SUITE]);
  const ordinary = [...new Set(globSync(CORE_GLOBS))].filter((file) => !guarded.has(file)).sort();
  const preload = './test/runtime/query-agent-harness.mjs';
  const steps = [
    ['npm', ['run', 'build'], ordinaryEnv],
    [process.execPath, ['--test', '--test-timeout=90000', ...ordinary], ordinaryEnv],
    [process.execPath, ['--import', preload, '--test', '--test-timeout=90000', ...GUARDED_SUITES], guardedEnv],
    [process.execPath, ['--import', preload, '--test', '--test-timeout=600000', PROVENANCE_SUITE], guardedEnv],
    ['npm', ['run', 'test:cron'], ordinaryEnv],
    ['npm', ['run', 'test:child-timeout'], ordinaryEnv],
  ];
  const run = ([command, args, env]) => {
    const result = spawnSync(command, args, { stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.signal) console.error(`Test command terminated by ${result.signal}.`);
    return result.status ?? 1;
  };
  if (run(steps[0]) !== 0) process.exitCode = 1;
  else for (const step of steps.slice(1)) if (run(step) !== 0) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
