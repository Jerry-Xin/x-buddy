// SPDX-License-Identifier: Apache-2.0
/**
 * P10 exact policy: legacy reference counts and the frozen site ledger
 * (R2.3). The committed fixture ledger is reviewed security policy; variants
 * are derived from the fixture by textual edits in a temporary directory.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanEgress } from '../scripts/egress-bypass-scan.mjs';
import { FIXTURES, fixtureConfig } from './egress-helpers.mjs';

const ledger = JSON.parse(readFileSync(join(FIXTURES, 'sites/ledger.json'), 'utf8'));
const baseline = [
  { file: 'src/handler.ts', symbol: 'sendMessage', count: 1 },
  { file: 'src/handler.ts', symbol: 'sendTyping', count: 1 },
];
const work = mkdtempSync(join(tmpdir(), 'x-buddy-ledger-'));
writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
after(() => rmSync(work, { recursive: true, force: true }));

let variants = 0;
function variant(edit) {
  const root = join(work, `v${variants++}`);
  cpSync(join(FIXTURES, 'sites'), root, { recursive: true });
  const file = join(root, 'src/handler.ts');
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
  return root;
}
const run = (root, extra = {}) => scanEgress({ ...fixtureConfig('sites'), root, baselinePermittedCallers: baseline, siteLedger: ledger, ...extra });
const codes = (r) => r.violations.map((v) => `${v.code}:${v.symbol}`).sort();

describe('P10 frozen site ledger', () => {
  it('the exact frozen sites with matching counts and rows are ALLOW', () => {
    const r = run(join(FIXTURES, 'sites'));
    assert.equal(r.outcome, 'ALLOW');
    assert.deepEqual(r.violations, []);
    assert.ok([...r.usages, ...r.operations].every((e) => e.credited));
  });

  it('comments and formatting do not change addresses or digests', () => {
    const root = variant((src) => src.replace('  await sendMessage(channel, \'first\');', '  // reviewed site\n  await sendMessage(\n    channel,\n    \'first\',\n  );'));
    assert.equal(run(root).outcome, 'ALLOW');
  });

  it('an extra direct call fails both the legacy count and the operation ledger', () => {
    const root = variant((src) => src.replace("  await sendMessage(channel, 'first');", "  await sendMessage(channel, 'first');\n  await sendMessage(channel, 'extra');"));
    const r = run(root);
    assert.equal(r.outcome, 'DENY');
    assert.ok(codes(r).includes('unauthorized-call:sendMessage'));
    assert.ok(codes(r).includes('unauthorized-operation:sendMessage'));
  });

  it('an extra call through an already extracted alias keeps legacy counts but is DENY', () => {
    const root = variant((src) => src.replace('  await sendTyping(channel);', '  await sendTyping(channel);\n  await sendTyping(channel);'));
    const r = run(root);
    assert.deepEqual(codes(r), ['unauthorized-operation:sendTyping']);
    assert.equal(r.outcome, 'DENY');
  });

  it('moving a frozen site leaves its row stale and the moved site unledgered', () => {
    const root = variant((src) => `${src.replace("  await sendMessage(channel, 'first');\n", '')}export async function moved(channel: string): Promise<void> {\n  await sendMessage(channel, 'first');\n}\n`);
    const r = run(root);
    assert.equal(r.outcome, 'DENY');
    assert.ok(codes(r).includes('unledgered-reference:sendMessage'));
    assert.ok(codes(r).includes('unauthorized-operation:sendMessage'));
    assert.ok(codes(r).includes('stale-ledger-row:sendMessage'));
  });

  it('a replaced call at the same address fails its digest', () => {
    const root = variant((src) => src.replace("await sendMessage(channel, 'first')", "await sendMessage(channel, 'replaced')"));
    const r = run(root);
    assert.ok(codes(r).includes('unauthorized-operation:sendMessage'));
    assert.ok(codes(r).includes('stale-ledger-row:sendMessage'));
  });

  it('substituting a different capability at a frozen site is DENY even with an adjusted count', () => {
    const root = variant((src) => src.replace('  const { sendTyping } = api;', '  const { sendRichTextMessage: sendTyping } = api;').replace('await sendTyping(channel);', 'await sendTyping(channel, []);'));
    const r = run(root, { baselinePermittedCallers: [baseline[0], { file: 'src/handler.ts', symbol: 'sendRichTextMessage', count: 1 }] });
    assert.equal(r.outcome, 'DENY');
    assert.ok(codes(r).includes('unledgered-reference:sendRichTextMessage'));
    assert.ok(codes(r).includes('stale-ledger-row:sendTyping'));
  });

  it('a stale row fails even when every site is credited', () => {
    const extra = { ...ledger.rows[0], address: `${ledger.rows[0].address}/Extra` };
    const r = run(join(FIXTURES, 'sites'), { siteLedger: [...ledger.rows, extra] });
    assert.deepEqual(codes(r), ['stale-ledger-row:sendMessage']);
  });

  it('one row credits one event: a reference row cannot credit the paired operation', () => {
    const r = run(join(FIXTURES, 'sites'), { siteLedger: ledger.rows.filter((row) => !(row.kind === 'operation' && row.symbol === 'sendMessage')) });
    assert.deepEqual(codes(r), ['unauthorized-operation:sendMessage']);
  });

  it('duplicate rows are a ledger error, not double credit', () => {
    const r = run(join(FIXTURES, 'sites'), { siteLedger: [...ledger.rows, ledger.rows[0]] });
    assert.ok(codes(r).includes('ambiguous-ledger-row:sendMessage'));
    assert.equal(r.outcome, 'UNKNOWN');
  });

  it('a nonzero legacy allowance without a ledger is a migration failure', () => {
    const r = run(join(FIXTURES, 'sites'), { siteLedger: undefined });
    assert.ok(codes(r).includes('ledger-missing:sendMessage'));
    assert.ok(codes(r).includes('ledger-missing:sendTyping'));
    assert.equal(r.outcome, 'DENY');
  });

  it('raising the legacy count cannot satisfy the new checks', () => {
    const root = variant((src) => src.replace('  await sendTyping(channel);', '  await sendTyping(channel);\n  await sendTyping(channel);'));
    const r = run(root, { baselinePermittedCallers: [baseline[0], { ...baseline[1], count: 2 }] });
    assert.ok(codes(r).includes('unauthorized-operation:sendTyping'));
    assert.ok(codes(r).includes('stale-baseline:sendTyping'));
  });

  it('legacy counts stay exact: over-stated counts are stale, under-stated counts are unauthorized', () => {
    assert.ok(codes(run(join(FIXTURES, 'sites'), { baselinePermittedCallers: [{ ...baseline[0], count: 2 }, baseline[1]] })).includes('stale-baseline:sendMessage'));
    assert.ok(codes(run(join(FIXTURES, 'sites'), { baselinePermittedCallers: [baseline[1]] })).includes('unauthorized-call:sendMessage'));
  });
});
