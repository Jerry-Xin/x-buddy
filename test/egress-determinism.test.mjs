// SPDX-License-Identifier: Apache-2.0
/**
 * P11 determinism and the measurement watchdog. Normalized results must be
 * byte-identical across repeated cold processes and shuffled root discovery;
 * per-fixture digests are written as evidence so CI can compare Node 22 and
 * Node 24. The worker runner must fail (never pass) on timeout, memory
 * exhaustion or a missing final record.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanEgress } from '../scripts/egress-bypass-scan.mjs';
import { nearestRank, runWorker } from '../scripts/egress/run-worker.mjs';
import { FIXTURES, fixtureConfig } from './egress-helpers.mjs';

const work = mkdtempSync(join(tmpdir(), 'x-buddy-determinism-'));
after(() => rmSync(work, { recursive: true, force: true }));

const IDENTITY = {
  boundaryModules: ['src/a/api.ts', 'src/b/api.ts', 'src/c/api.ts'],
  classification: {
    sendMessage: { class: 'primitive', reason: 'send' },
    dispatch: { class: 'primitive', reason: 'send alias' },
    notify: { class: 'primitive', reason: 'notify' },
    getGroupMembers: { class: 'read', reason: 'roster' },
  },
};
const configFor = (name) => fixtureConfig(name, name === 'identity' ? IDENTITY : {});
const names = readdirSync(FIXTURES).filter((n) => !n.startsWith('.')).sort();

describe('P11 deterministic normalized results', () => {
  const digests = {};
  it('every fixture yields one digest under shuffled root discovery order', () => {
    for (const name of names) {
      const base = scanEgress(configFor(name));
      digests[name] = base.digest;
      for (const seed of [1, 7, 4242]) {
        assert.equal(scanEgress({ ...configFor(name), rootOrderSeed: seed }).digest, base.digest, `${name} seed ${seed}`);
      }
    }
    const dir = process.env.EGRESS_EVIDENCE_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `egress-fixture-digests-node${process.versions.node.split('.')[0]}.json`), `${JSON.stringify(digests, null, 2)}\n`);
    }
  });

  it('three cold worker processes reproduce the in-process digest', async () => {
    for (const name of ['namespace-origin-deep-negative', 'late-source', 'identity']) {
      const configPath = join(work, `${name}.json`);
      const { root, ...cfg } = configFor(name);
      writeFileSync(configPath, JSON.stringify(cfg));
      const expected = scanEgress(configFor(name)).digest;
      for (let i = 0; i < 3; i++) {
        const run = await runWorker({ args: ['--config', configPath, '--root', root] });
        assert.equal(run.watchdog, 'ok', run.stderr);
        assert.equal(run.record.digest, expected, `${name} cold run ${i}`);
        assert.ok(run.peakRssKb > 0 && run.elapsedMs > 0);
      }
    }
  });

  it('paths are repository-relative with forward slashes', () => {
    const r = scanEgress(configFor('reexport'));
    for (const v of r.violations) assert.ok(!v.file.includes('\\') && !v.file.startsWith('/'), v.file);
    for (const t of r.terminals) assert.ok(JSON.parse(t.terminalId)[1].every(([path]) => path.startsWith('src/')));
  });

  it('timing statistics do not enter the digest', () => {
    const a = scanEgress(configFor('deep'));
    const b = scanEgress(configFor('deep'));
    assert.equal(a.digest, b.digest);
    assert.ok(typeof a.stats.elapsedMs === 'number');
  });
});

describe('measurement watchdog', () => {
  const script = (name, body) => {
    const path = join(work, name);
    writeFileSync(path, body);
    return path;
  };
  it('a hanging worker is killed and fails', async () => {
    const run = await runWorker({ script: script('hang.mjs', 'setInterval(() => {}, 1000);\n'), timeoutMs: 400 });
    assert.equal(run.watchdog, 'timeout');
    assert.equal(run.ok, false);
  });
  it('a worker exceeding the memory limit is killed and fails', async () => {
    const run = await runWorker({
      script: script('hog.mjs', 'const keep = []; setInterval(() => { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); }, 5);\n'),
      rssBytes: 160 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    assert.equal(run.watchdog, 'rss');
    assert.equal(run.ok, false);
  });
  it('a crash or missing final record is never a pass', async () => {
    const crash = await runWorker({ script: script('crash.mjs', 'console.log(JSON.stringify({ partial: true })); process.exit(3);\n') });
    assert.equal(crash.ok, false);
    assert.equal(crash.watchdog, 'no-record');
  });
  it('watchdog limits cannot be raised', async () => {
    await assert.rejects(runWorker({ timeoutMs: 61_000 }), /may not exceed/);
    await assert.rejects(runWorker({ rssBytes: 2 * 1024 * 1024 * 1024 }), /may not exceed/);
  });
  it('p95 is the nearest-rank sample (sample 19 of 20)', () => {
    const samples = Array.from({ length: 20 }, (_, i) => 20 - i);
    const { rank, value } = nearestRank(samples, 95);
    assert.equal(rank, 19);
    assert.equal(value, 19);
  });
});
