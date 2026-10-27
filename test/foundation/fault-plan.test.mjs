// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAULT_POINTS, FaultInjectedError, FaultPlan, NO_FAULTS } from './lib/fault-plan.mjs';

test('fault point set matches R8 §10.4 exactly', () => {
  assert.deepEqual(Object.keys(FAULT_POINTS).sort(), [
    'api.forceStatus', 'cron.afterAdmit', 'cron.beforeFinalize', 'egress.afterFence', 'egress.afterSegment', 'egress.beforeFirstSend',
    'runtime.dropInterruptResponse', 'runtime.dropTurnCompleted', 'runtime.failUnsubscribe', 'runtime.killChild',
    'transport.disconnect', 'transport.dropConnack',
  ]);
});

test('unknown points fail closed for arm, hit and NO_FAULTS', () => {
  const plan = new FaultPlan();
  assert.throws(() => plan.arm('egress.afterSegmnt', { action: 'throw' }), /unknown fault point/);
  assert.throws(() => plan.hit('nope'), /unknown fault point/);
  assert.throws(() => NO_FAULTS.hit('nope'), /unknown fault point/);
});

test('parameterised points require their context argument', () => {
  const plan = new FaultPlan();
  assert.throws(() => plan.hit('egress.afterSegment'), /requires context.k/);
  assert.throws(() => NO_FAULTS.hit('api.forceStatus', {}), /requires context.endpoint/);
  assert.throws(() => plan.arm('egress.afterSegment', { action: 'throw', match: { segment: 1 } }), /no parameter segment/);
});

test('egress.afterSegment(k) fires only for the matching segment', () => {
  const plan = new FaultPlan().arm('egress.afterSegment', { action: 'kill', match: { k: 2 } });
  assert.equal(plan.hit('egress.afterSegment', { k: 1 }), null);
  assert.equal(plan.hit('egress.afterSegment', { k: 2 }).action, 'kill');
  assert.equal(plan.hit('egress.afterSegment', { k: 2 }), null);
  plan.assertExhausted();
});

test('api.forceStatus(endpoint, code, count) fires count times for that endpoint', () => {
  const plan = new FaultPlan().forceStatus('sendMessage', 429, 2);
  assert.equal(plan.hit('api.forceStatus', { endpoint: 'typing' }), null);
  assert.equal(plan.hit('api.forceStatus', { endpoint: 'sendMessage' }).status, 429);
  assert.equal(plan.hit('api.forceStatus', { endpoint: 'sendMessage' }).status, 429);
  assert.equal(plan.hit('api.forceStatus', { endpoint: 'sendMessage' }), null);
  plan.assertExhausted();
});

test('skip lets earlier hits pass and apply() throws typed errors', () => {
  const plan = new FaultPlan().arm('cron.beforeFinalize', { action: 'throw', skip: 1, message: 'boom' });
  assert.equal(plan.apply('cron.beforeFinalize'), null);
  assert.throws(() => plan.apply('cron.beforeFinalize'), (e) => e instanceof FaultInjectedError && e.point === 'cron.beforeFinalize');
});

test('assertExhausted fails when an armed fault never fired', () => {
  const plan = new FaultPlan().arm('transport.dropConnack', { action: 'drop' });
  assert.throws(() => plan.assertExhausted(), /unconsumed faults: transport.dropConnack/);
  const unbounded = new FaultPlan().arm('runtime.killChild', { action: 'kill', times: Infinity });
  assert.throws(() => unbounded.assertExhausted(), /0 fired/);
  unbounded.hit('runtime.killChild');
  unbounded.assertExhausted();
});

test('hit log is ordered and immutable', () => {
  const plan = new FaultPlan().arm('egress.beforeFirstSend', { action: 'drop' });
  plan.hit('egress.beforeFirstSend');
  plan.hit('egress.afterFence');
  const log = plan.hits();
  assert.deepEqual(log.map(e => [e.seq, e.point, e.fired]), [[1, 'egress.beforeFirstSend', 'drop'], [2, 'egress.afterFence', null]]);
  assert.throws(() => { log[0].point = 'x'; }, TypeError);
});

test('invalid specs are rejected', () => {
  const plan = new FaultPlan();
  assert.throws(() => plan.arm('api.forceStatus', { action: 'status' }), /integer status/);
  assert.throws(() => plan.arm('cron.afterAdmit', { action: 'delay' }), /delayMs/);
  assert.throws(() => plan.arm('cron.afterAdmit', { action: 'explode' }), /unknown fault action/);
  assert.throws(() => plan.arm('cron.afterAdmit', { action: 'drop', times: 0 }), /times/);
});
