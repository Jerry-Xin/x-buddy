// SPDX-License-Identifier: Apache-2.0
/**
 * Mutation controls: each analyzer mutant removes one propagation edge class,
 * disables uncertainty, turns budget exhaustion into success or omits a
 * source module. Every mutant must be killed by a specific AssertionError on
 * a fixture that loads without compiler/project failures, and the same
 * assertion must pass on the unmutated analyzer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MUTATIONS, runScan } from '../scripts/egress/analyzer.mjs';
import { fixtureConfig, keyed, tally } from './egress-helpers.mjs';

const LOAD_FAILURES = ['compiler-error', 'unsupported-project', 'missing-boundary', 'unexplained-omission', 'ambiguous-canonical-path'];

const CASES = {
  'drop-import-alias': {
    fixture: 'direct',
    check: (r) => assert.deepEqual(tally(r), { 'src/named.ts#sendMessage': 2, 'src/renamed.ts#sendTyping': 1, 'src/rich.ts#sendRichTextMessage': 1 }),
  },
  'drop-assignment': {
    fixture: 'values',
    check: (r) => assert.equal(tally(r)['src/assigned.ts#sendMessage'], 1),
  },
  'drop-property-selection': {
    fixture: 'values',
    check: (r) => assert.equal(tally(r)['src/chain.ts#sendMessage'], 1),
  },
  'drop-mapped-value': {
    fixture: 'mapped-rename',
    check: (r) => assert.equal(tally(r)['src/renamed.ts#sendMessage'], 1),
  },
  'drop-generic-substitution': {
    fixture: 'nest-guarded',
    check: (r) => assert.ok(keyed(r).filter((k) => k === 'unresolved-boundary-extraction:src/nest.ts:[key]').length === 2, 'far dynamic selection beyond widening'),
  },
  'drop-call-return': {
    fixture: 'callable',
    check: (r) => assert.ok(r.operations.some((o) => o.file === 'src/runtime-factory.ts' && o.symbol === 'sendMessage')),
  },
  'drop-union-member': {
    fixture: 'deep',
    check: (r) => assert.ok(keyed(r).includes('unresolved-boundary-extraction:src/wrappers.ts:[k6]')),
  },
  'ignore-unknown': {
    fixture: 'late-unsupported',
    check: (r) => { assert.equal(r.outcome, 'UNKNOWN'); assert.equal(r.complete, false); },
  },
  'budget-success': {
    fixture: 'deep',
    extra: { limits: { transfers: 60 } },
    check: (r) => { assert.equal(r.complete, false); assert.ok(r.violations.some((v) => v.code === 'analysis-budget-exhausted')); },
  },
  'omit-source-module': {
    fixture: 'module-flow',
    mutation: { file: 'src/holder.ts' },
    check: (r) => assert.deepEqual(tally(r), { 'src/consumer.ts#sendTyping': 1 }),
  },
};

describe('mutation controls', () => {
  it('every declared mutant has a killing case', () => {
    assert.deepEqual(Object.keys(CASES).sort(), [...MUTATIONS].sort());
  });
  for (const [name, c] of Object.entries(CASES)) {
    it(`${name} is killed on ${c.fixture} with a green unmutated control`, () => {
      const cfg = fixtureConfig(c.fixture, c.extra);
      const control = runScan(cfg);
      c.check(control);
      const mutant = runScan(cfg, { mutation: { name, ...c.mutation } });
      assert.deepEqual(mutant.violations.filter((v) => LOAD_FAILURES.includes(v.code)), [], 'mutant run must load the fixture');
      assert.throws(() => c.check(mutant), assert.AssertionError, `${name} survived`);
    });
  }
});
