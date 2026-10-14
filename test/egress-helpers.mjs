// SPDX-License-Identifier: Apache-2.0
import { URL, fileURLToPath } from 'node:url';
import { scanEgress } from '../scripts/egress-bypass-scan.mjs';

export const FIXTURES = fileURLToPath(new URL('./fixtures/egress/', import.meta.url));

export const CLASSIFICATION = Object.freeze({
  sendMessage: { class: 'primitive', reason: 'message send' },
  sendRichTextMessage: { class: 'primitive', reason: 'rich message send' },
  sendTyping: { class: 'primitive', reason: 'typing control' },
  registerBot: { class: 'infrastructure', reason: 'transport registration' },
  getGroupMembers: { class: 'read', reason: 'roster read' },
});

export function fixtureConfig(name, extra = {}) {
  return {
    root: `${FIXTURES}${name}`,
    srcDir: 'src',
    boundaryModules: ['src/octo/api.ts'],
    egressModules: ['src/egress/'],
    classification: CLASSIFICATION,
    baselinePermittedCallers: [],
    ...extra,
  };
}

export const scan = (name, extra) => scanEgress(fixtureConfig(name, extra));

/** `code:file:symbol` keys, sorted, optionally restricted to codes. */
export function keyed(result, codes) {
  return result.violations
    .filter((v) => !codes || codes.includes(v.code))
    .map((v) => `${v.code}:${v.file}:${v.symbol}`)
    .sort();
}

/** Legacy reference tally `file#symbol -> count`. */
export function tally(result) {
  const out = {};
  for (const u of result.usages) out[`${u.file}#${u.symbol}`] = (out[`${u.file}#${u.symbol}`] ?? 0) + 1;
  return out;
}

export const inFile = (result, file, codes) => keyed(result, codes).filter((k) => k.split(':')[1] === file);
export const LEGACY = ['unauthorized-call', 'stale-baseline', 'unauthorized-reexport', 'unauthorized-dynamic-import', 'unresolved-boundary-extraction'];
