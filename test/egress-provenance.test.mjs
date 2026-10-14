// SPDX-License-Identifier: Apache-2.0
/**
 * Capability provenance analyzer (DEV-01 B-2 design v2): fixture-level
 * requirements P01–P10 and the normative R1.4 / R2.4 traces.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanEgress } from '../scripts/egress-bypass-scan.mjs';
import { fixtureConfig, inFile, keyed, LEGACY, scan, tally } from './egress-helpers.mjs';

const operations = (r) => r.operations.map((o) => `${o.file}:${o.line}:${o.symbol}`).sort();
const deny = (file, symbols) => symbols.map((s) => `unresolved-boundary-extraction:${file}:${s}`);

describe('P01/P02 sources, identity and basic selection', () => {
  it('clean egress-only fixture is ALLOW with no references', () => {
    const r = scan('clean');
    assert.equal(r.outcome, 'ALLOW');
    assert.equal(r.complete, true);
    assert.deepEqual(r.usages, []);
    assert.deepEqual(r.violations, []);
  });

  it('named, renamed and type-only imports: references counted per site, type positions ignored', () => {
    const r = scan('direct');
    assert.equal(r.outcome, 'DENY');
    assert.deepEqual(tally(r), { 'src/named.ts#sendMessage': 2, 'src/renamed.ts#sendTyping': 1, 'src/rich.ts#sendRichTextMessage': 1 });
    assert.deepEqual(keyed(r, ['unauthorized-call']), [
      'unauthorized-call:src/named.ts:sendMessage', 'unauthorized-call:src/rich.ts:sendRichTextMessage', 'unauthorized-call:src/renamed.ts:sendTyping',
    ].sort());
    assert.equal(r.operations.length, 4);
    assert.deepEqual(inFile(r, 'src/type-only.ts'), []);
  });

  it('namespace property and literal element access count once each; permitted exports stay clean', () => {
    const r = scan('namespace');
    assert.deepEqual(tally(r), { 'src/handler.ts#sendMessage': 1, 'src/handler.ts#sendTyping': 1 });
  });

  it('every boundary export is classified; guarded labels are stable', () => {
    const r = scan('namespace');
    assert.deepEqual(r.unclassified, []);
    assert.deepEqual(r.primitives, ['sendMessage', 'sendRichTextMessage', 'sendTyping']);
    for (const t of r.terminals) assert.match(t.terminalId, /^\["terminal-v2",\[\["src\/octo\/api\.ts",\d+,\d+,"FunctionDeclaration"\]\]\]$/);
  });

  it('a new unclassified export is guarded and reported', () => {
    const r = scan('unclassified');
    assert.deepEqual(r.unclassified, ['sendCard']);
    assert.ok(keyed(r).includes('unauthorized-call:src/cards.ts:sendCard'));
    assert.equal(r.outcome, 'DENY');
  });

  it('permitted infrastructure/read exports stay ALLOW outside egress', () => {
    assert.equal(scan('permitted').outcome, 'ALLOW');
  });

  it('shorthand, renamed, parameter, nested, default, computed, numeric, unique-symbol, template and optional selections', () => {
    const r = scan('destructuring');
    assert.deepEqual(tally(r), {
      'src/computed.ts#sendTyping': 2,
      'src/defaults.ts#sendMessage': 1,
      'src/nested.ts#sendMessage': 1,
      'src/numeric.ts#sendTyping': 2,
      'src/optional.ts#sendMessage': 1,
      'src/param.ts#sendTyping': 1,
      'src/renamed.ts#sendMessage': 1,
      'src/shorthand.ts#sendMessage': 1,
      'src/template.ts#sendTyping': 1,
      'src/unique-symbol.ts#sendMessage': 2,
    });
    // Shorthand and renamed bindings account identically; later alias calls are operations, not new references.
    assert.equal(tally(r)['src/shorthand.ts#sendMessage'], tally(r)['src/renamed.ts#sendMessage']);
    assert.equal(r.operations.filter((o) => o.file === 'src/shorthand.ts').length, 2);
    // A default initializer joins the selected fact: the alias call through the default is an operation.
    assert.ok(operations(r).includes('src/defaults.ts:6:sendMessage'));
    assert.deepEqual(keyed(r, ['unresolved-boundary-extraction']), []);
  });
});

describe('P03 value propagation', () => {
  const r = scan('values');
  it('assignments, logical writes, conditionals, assertion chains, cycles, spreads and shorthand keep origins', () => {
    for (const key of ['src/assigned.ts#sendMessage', 'src/logical.ts#sendTyping', 'src/conditional.ts#sendTyping', 'src/chain.ts#sendMessage',
      'src/cycle.ts#sendTyping', 'src/spread.ts#sendRichTextMessage', 'src/shorthand-property.ts#sendMessage']) {
      assert.equal(tally(r)[key], 1, key);
    }
  });
  it('a property store of a capability is an escape; a mutable key narrowed by assertion is not trusted', () => {
    assert.deepEqual(keyed(r, ['unresolved-boundary-extraction']), [
      "unresolved-boundary-extraction:src/mutable-key.ts:[key as 'registerBot']",
      'unresolved-boundary-extraction:src/store.ts:box.fn = api.sendTyping',
    ]);
  });
  it('unrelated local values with guarded spellings stay clean', () => {
    assert.deepEqual(inFile(r, 'src/unrelated-values.ts'), []);
    assert.equal(r.operations.some((o) => o.file === 'src/unrelated-values.ts'), false);
  });
});

describe('P04 module closure', () => {
  it('named, two-hop, star, namespace and local re-exports are reported; consumers resolve one terminal', () => {
    const r = scan('reexport');
    assert.deepEqual(keyed(r, ['unauthorized-reexport']), [
      'unauthorized-reexport:src/barrel.ts:sendMessage',
      'unauthorized-reexport:src/barrel2.ts:sendMessage',
      'unauthorized-reexport:src/local-barrel.ts:apiNs',
      'unauthorized-reexport:src/ns-barrel.ts:* as ns',
      'unauthorized-reexport:src/star.ts:*',
    ]);
    assert.deepEqual(tally(r), { 'src/consumer.ts#sendMessage': 2, 'src/consumer.ts#sendTyping': 2, 'src/consumer.ts#sendRichTextMessage': 1 });
    const ids = new Set(r.usages.filter((u) => u.symbol === 'sendMessage').map((u) => u.terminalId));
    assert.equal(ids.size, 1, 'both barrel routes reach the same TerminalId');
    assert.deepEqual(inFile(r, 'src/read-barrel.ts'), []);
  });

  it('literal dynamic import of the boundary is reported; a non-literal specifier is UNKNOWN', () => {
    assert.deepEqual(keyed(scan('dynamic-import')), ['unauthorized-dynamic-import:src/late.ts:src/octo/api.ts']);
    const r = scan('dynamic-nonliteral');
    assert.equal(r.outcome, 'UNKNOWN');
    assert.equal(r.complete, false);
    assert.ok(keyed(r).includes('unresolved-module:src/loader.ts:import(specifier)'));
  });

  it('cyclic modules terminate; an imported module outside src keeps its origin', () => {
    const r = scan('cycles');
    assert.deepEqual(keyed(r, LEGACY), [
      'unauthorized-call:src/a.ts:sendTyping',
      'unauthorized-call:src/consumer.ts:sendMessage',
      'unauthorized-reexport:lib/relay.ts:sendMessage',
    ]);
  });

  it('a capability written into an erased module-level binding reaches its importer', () => {
    const r = scan('module-flow');
    assert.deepEqual(tally(r), { 'src/consumer.ts#sendTyping': 1 });
    assert.equal(r.operations.length, 1);
  });

  it('missing imports, compiler errors and unsupported files are UNKNOWN, never ALLOW', () => {
    for (const [name, code] of [['missing-import', 'unresolved-module'], ['compiler-error', 'compiler-error'], ['unsupported-file', 'unsupported-project']]) {
      const r = scan(name);
      assert.equal(r.outcome, 'UNKNOWN', name);
      assert.equal(r.complete, false, name);
      assert.ok(r.violations.some((v) => v.code === code), `${name}: ${code}`);
    }
  });

  it('a missing boundary module is fatal', () => {
    const r = scan('clean', { boundaryModules: ['src/octo/absent.ts'] });
    assert.equal(r.outcome, 'UNKNOWN');
    assert.ok(keyed(r).includes('missing-boundary:src/octo/absent.ts:configured boundary module is not in the program'));
  });
});

describe('P05 mapped renames (retained review probes)', () => {
  const r = scan('mapped-rename');
  it('literal rename selects the original sendMessage terminal', () => {
    const usage = r.usages.find((u) => u.file === 'src/renamed.ts');
    assert.equal(usage.symbol, 'sendMessage');
    assert.equal(usage.terminalId, r.terminals.find((t) => t.label === 'sendMessage').terminalId);
    assert.ok(operations(r).includes('src/renamed.ts:5:sendMessage'));
  });
  it('dynamic and rest selection over the renamed shape are DENY with retained candidates', () => {
    assert.deepEqual(inFile(r, 'src/renamed.ts', ['unresolved-boundary-extraction']), deny('src/renamed.ts', ['...all', '[key]']).sort());
    const d = r.diagnostics.find((x) => x.file === 'src/renamed.ts' && x.selector === '[key]');
    assert.deepEqual([...d.capabilities].sort(), ['sendMessage', 'sendRichTextMessage', 'sendTyping']);
  });
  it('helper-only renamed mapping stays ALLOW for literal, dynamic and rest selection', () => {
    assert.deepEqual(inFile(r, 'src/helper-rename.ts'), []);
  });
  it('intrinsic key change, nested Pick/Omit/Readonly and collisions keep the original identity', () => {
    assert.equal(tally(r)['src/upper.ts#sendTyping'], 1);
    assert.deepEqual(inFile(r, 'src/nested.ts', LEGACY), ['unauthorized-call:src/nested.ts:sendMessage']);
    assert.deepEqual(Object.keys(tally(r)).filter((k) => k.startsWith('src/collide.ts')).sort(),
      ['src/collide.ts#sendMessage', 'src/collide.ts#sendRichTextMessage', 'src/collide.ts#sendTyping']);
  });
});

describe('P06/P09 typed wrappers, recursion and widening (R1.4)', () => {
  it('literal extraction through nested property, array, index signature and asserted types counts exactly', () => {
    const r = scan('deep');
    assert.deepEqual(tally(r), { 'src/literal.ts#sendMessage': 2, 'src/literal.ts#sendRichTextMessage': 1, 'src/literal.ts#sendTyping': 2 });
    assert.deepEqual(inFile(r, 'src/wrappers.ts'), deny('src/wrappers.ts', ['[k1]', '[k2]', '[k3]', '[k4]', '[k5]', '[k6]']));
    assert.deepEqual(inFile(r, 'src/recursive.ts'), deny('src/recursive.ts', ['[k1]', '[k2]', '[k3]']));
    assert.deepEqual(inFile(r, 'src/rest-variants.ts'), deny('src/rest-variants.ts', ['...captured', '...inner']));
    assert.deepEqual(inFile(r, 'src/reflect.ts'), deny('src/reflect.ts', ['Reflect.get(x, key)', '[k as keyof typeof x]']).sort());
  });

  it('EG-36 exact case: Nest<typeof other> / Nest<string> stay ALLOW with zero usages after widening', () => {
    const r = scanEgress(fixtureConfig('namespace-origin-deep-negative', { observations: true }));
    assert.equal(r.outcome, 'ALLOW');
    assert.equal(r.complete, true);
    assert.deepEqual(r.usages, []);
    assert.deepEqual(r.violations, []);
    const expanding = r.observations.filter((o) => o.file === 'src/unrelated.ts' && o.line === 20 && o.operation === 'dynamic-selection');
    assert.equal(expanding.length, 2, 'dynamic selection and Reflect.get over both Nest receivers');
    for (const o of expanding) {
      assert.deepEqual(o.mayC, []);
      assert.equal(o.complete, true);
      assert.equal(o.sourceFree, true);
      assert.equal(o.widened, true, 'the growing Nest<T[]>/Nest<[T,T]> receiver crossed the widening limit');
    }
    assert.ok(r.stats.summaryEnvironments >= 1);
  });

  it('paired guarded Nest: dynamic, Reflect, rest and far (beyond widening) DENY; literal helper ALLOW; literal send one event', () => {
    const r = scanEgress(fixtureConfig('nest-guarded', { observations: true }));
    assert.deepEqual(inFile(r, 'src/nest.ts', ['unresolved-boundary-extraction']), deny('src/nest.ts', ['...copy', 'Reflect.get(n, key)', '[key]', '[key]']).sort());
    assert.deepEqual(tally(r), { 'src/nest.ts#sendMessage': 1 });
    const far = r.observations.find((o) => o.line === 22 && o.operation === 'dynamic-selection');
    assert.equal(far.widened, true);
    assert.equal(far.complete, true);
    assert.deepEqual([...far.mayC].sort(), ['sendMessage', 'sendRichTextMessage', 'sendTyping']);
  });

  it('late conditional source beyond 16 environments: Layer<20> leaf DENY, helper leaf ALLOW, unsupported leaf UNKNOWN', () => {
    const late = scan('late-source');
    assert.deepEqual(inFile(late, 'src/layer.ts', LEGACY), [
      'unauthorized-call:src/layer.ts:sendMessage',
      ...deny('src/layer.ts', ['...rest', '[key]']),
    ].sort());
    const d = late.diagnostics.find((x) => x.file === 'src/layer.ts' && x.selector === '[key]');
    assert.deepEqual(d.capabilities, ['sendMessage'], 'the selected leaf is Pick<typeof api, "sendMessage">, not every export');
    assert.deepEqual(inFile(late, 'src/early.ts'), deny('src/early.ts', ['...rest', '...rest']));
    const helper = scan('late-helper');
    assert.equal(helper.outcome, 'ALLOW');
    assert.deepEqual(helper.usages, []);
    const unsupported = scan('late-unsupported');
    assert.equal(unsupported.outcome, 'UNKNOWN');
    assert.equal(unsupported.complete, false);
    for (const v of unsupported.violations) {
      assert.equal(v.code, 'analysis-incomplete');
      assert.deepEqual(v.reasons, ['unsupported-infer']);
    }
    assert.equal(unsupported.violations.length, 2);
  });

  it('an imported ambient wrapper retains nested namespace origins', () => {
    const r = scan('ambient');
    assert.ok(keyed(r).includes('unresolved-boundary-extraction:src/handler.ts:[key]'));
  });

  it('key-domain overflow widens to the wildcard slot instead of losing the source', () => {
    const r = scan('keys-overflow');
    assert.deepEqual(tally(r), { 'src/keys.ts#sendMessage': 1 });
    assert.ok(r.stats.keyOverflows >= 1);
  });
});

describe('P07 callable flow', () => {
  const r = scan('callable');
  it('a capability returned by an authorized egress factory stays protected at its consumer', () => {
    assert.ok(operations(r).includes('src/runtime-factory.ts:5:sendMessage'));
    assert.ok(r.violations.some((v) => v.code === 'unauthorized-operation' && v.file === 'src/runtime-factory.ts'));
  });
  it('identity wrappers, bind and recursive returns keep the capability; guarded arguments escape', () => {
    assert.deepEqual(keyed(r, ['unresolved-boundary-extraction']), [
      'unresolved-boundary-extraction:src/identity.ts:identity(api.sendTyping)',
      'unresolved-boundary-extraction:src/identity.ts:return value;',
      'unresolved-boundary-extraction:src/recursive.ts:return n <= 0 ? api.sendMessage : pick(n - 1);',
    ]);
    for (const op of ['src/identity.ts:6:sendTyping', 'src/callback.ts:5:sendTyping', 'src/recursive.ts:7:sendMessage']) assert.ok(operations(r).includes(op), op);
  });
  it('a helper with a namespace-typed parameter used only for reads, and a permitted factory, stay ALLOW', () => {
    assert.deepEqual(inFile(r, 'src/helper-use.ts'), []);
    assert.equal(r.operations.some((o) => o.file === 'src/helper-use.ts'), false);
  });
  it('library containers cannot launder a capability created in egress', () => {
    const l = scan('laundering');
    assert.deepEqual(operations(l), [
      'src/consumer.ts:4:sendMessage', 'src/consumer.ts:5:sendTyping', 'src/consumer.ts:6:sendMessage',
      'src/consumer.ts:7:sendTyping', 'src/consumer.ts:8:sendMessage',
    ]);
    assert.equal(l.outcome, 'DENY');
  });
});

describe('P08 dynamic, rest and unknown', () => {
  const r = scan('unresolved');
  it('dynamic keys, rest, Reflect, escapes and erased dynamic selections are DENY', () => {
    assert.deepEqual(keyed(r, ['unresolved-boundary-extraction']), [
      ...deny('src/dynamic-key.ts', ['[pick]']),
      ...deny('src/erased-dynamic.ts', ['[pick]', '[pick]']),
      ...deny('src/escape.ts', ['[api]', 'console.log(api)', 'holder.ns = api', 'return api;']),
      ...deny('src/reflect.ts', ['Reflect.get(api, key)']),
      ...deny('src/rest.ts', ['...rest']),
    ].sort());
  });
  it('a literal Reflect.get and a destructuring assignment are selections of one terminal', () => {
    assert.deepEqual(tally(r), { 'src/destructure-assign.ts#sendTyping': 1, 'src/reflect.ts#sendTyping': 1 });
  });
  it('proven helper-only dynamic and rest selections stay ALLOW', () => {
    assert.deepEqual(inFile(r, 'src/helper-dynamic.ts'), []);
  });
});

describe('P01/P10 controls and authorization location', () => {
  it('no false positives: egress, helpers/reads, unrelated namespaces, locals, identical signatures, cycles', () => {
    const r = scan('negative');
    assert.equal(r.outcome, 'ALLOW');
    assert.deepEqual(r.usages, []);
    assert.deepEqual(r.operations, []);
    assert.deepEqual(r.violations, []);
  });
  it('egress authorization is an exact directory segment: src/egress-evil does not inherit it', () => {
    const r = scan('egress-prefix');
    assert.deepEqual(keyed(r, LEGACY), ['unauthorized-call:src/egress-evil/bypass.ts:sendMessage']);
    const loose = scan('egress-prefix', { egressModules: ['src/egress'] });
    assert.deepEqual(keyed(loose, LEGACY), ['unauthorized-call:src/egress-evil/bypass.ts:sendMessage']);
  });
});

describe('R2.4 terminal identity, route policy and events', () => {
  const base = {
    boundaryModules: ['src/a/api.ts', 'src/b/api.ts', 'src/c/api.ts'],
    classification: {
      sendMessage: { class: 'primitive', reason: 'send' },
      dispatch: { class: 'primitive', reason: 'send alias' },
      notify: { class: 'primitive', reason: 'notify' },
      getGroupMembers: { class: 'read', reason: 'roster' },
    },
  };
  const r = scan('identity', base);
  const ts = r.terminals.find((t) => t.routes.includes('["export-v2","src/b/api.ts","dispatch"]'));
  const tu = r.terminals.find((t) => t.routes.includes('["export-v2","src/b/api.ts","sendMessage"]'));
  const to = r.terminals.find((t) => t.label === 'notify');

  it('one terminal for two routes; distinct same-spelling declarations stay distinct', () => {
    assert.deepEqual(ts.routes, ['["export-v2","src/a/api.ts","sendMessage"]', '["export-v2","src/b/api.ts","dispatch"]']);
    assert.notEqual(ts.terminalId, tu.terminalId);
    assert.equal(ts.label, 'sendMessage');
    assert.equal(tu.label, 'sendMessage');
    assert.equal(ts.display, 'src/a/api.ts::sendMessage', 'colliding labels are qualified for display');
  });

  it('a selection reached through both type and export evidence yields exactly one event', () => {
    const at7 = r.usages.filter((u) => u.line === 7);
    assert.equal(at7.length, 1);
    assert.equal(at7[0].terminalId, ts.terminalId);
    const ops7 = r.operations.filter((o) => o.line === 7);
    assert.equal(ops7.length, 1);
  });

  it('a union selection reaching two terminals yields two events at one site', () => {
    const at13 = r.usages.filter((u) => u.line === 13).map((u) => u.terminalId).sort();
    assert.deepEqual(at13, [ts.terminalId, tu.terminalId].sort());
  });

  it('overloads and a merged namespace form one terminal; nested namespace members are separate', () => {
    assert.equal(JSON.parse(to.terminalId)[1].length, 4);
    assert.deepEqual(r.usages.filter((u) => u.symbol === 'notify').map((u) => u.line), [16, 17, 18]);
    assert.deepEqual(r.operations.filter((o) => o.symbol === 'notify').map((o) => o.line), [16, 17]);
  });

  it('route enumeration order does not change identities, events or the stable digest', () => {
    const reversed = scan('identity', { ...base, boundaryModules: [...base.boundaryModules].reverse() });
    assert.equal(reversed.digest, r.digest);
  });

  it('a guarded/read alias conflict is reported and cannot declassify the terminal', () => {
    const conflict = scan('identity', { ...base, boundaryClassification: { 'src/b/api.ts': { dispatch: { class: 'read', reason: 'misclassified' } } } });
    assert.ok(keyed(conflict).includes('boundary-policy-alias-conflict:src/a/api.ts:sendMessage'));
    assert.equal(conflict.outcome, 'DENY');
    assert.equal(conflict.usages.filter((u) => u.line === 7).length, 1);
  });

  it('a legacy baseline row naming an ambiguous label is invalid configuration', () => {
    const invalid = scan('identity', { ...base, baselinePermittedCallers: [{ file: 'src/consumer.ts', symbol: 'sendMessage', count: 5 }] });
    assert.equal(invalid.outcome, 'UNKNOWN');
    assert.ok(invalid.violations.some((v) => v.code === 'invalid-config' && v.symbol === 'sendMessage'));
  });
});

describe('analyzer limits and entry point', () => {
  it('budget exhaustion is UNKNOWN with analysis-budget-exhausted, never ALLOW', () => {
    for (const limit of [{ nodes: 40 }, { edges: 40 }, { transfers: 50 }]) {
      const r = scan('deep', { limits: limit });
      assert.equal(r.outcome, 'UNKNOWN', JSON.stringify(limit));
      assert.equal(r.complete, false);
      assert.ok(r.violations.some((v) => v.code === 'analysis-budget-exhausted'));
    }
  });
  it('limits cannot be raised above the reviewed defaults', () => {
    const r = scan('clean', { limits: { transfers: 20_000_000 } });
    assert.equal(r.outcome, 'UNKNOWN');
    assert.ok(r.violations.some((v) => v.code === 'invalid-config'));
  });
  it('the enforcing entry point rejects mutation requests', () => {
    assert.throws(() => scanEgress({ ...fixtureConfig('clean'), mutation: { name: 'ignore-unknown' } }), /mutation testing/);
  });
});
