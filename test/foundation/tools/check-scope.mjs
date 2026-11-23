// SPDX-License-Identifier: Apache-2.0
/**
 * Path-ownership guard for test-foundation changes (R8 §10.1 diff proof).
 *
 *   node test/foundation/tools/check-scope.mjs --base <commit>
 *
 * Lists `git diff --name-status <base>...HEAD` and fails if any changed path
 * falls outside the foundation lane's owned paths. Product source (`src/**`)
 * is never allowed. Run from the repository root.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const OWNED = Object.freeze([
  /^test\/foundation\//,
  /^docs\/test-foundation\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.github\/workflows\//,
  /^CHANGELOG\.md$/,
]);

export function classify(lines) {
  const changes = lines.filter(Boolean).map(l => { const [status, ...paths] = l.split('\t'); return { status, paths }; });
  const outside = changes.filter(c => c.paths.some(p => !OWNED.some(re => re.test(p))));
  return { changes, outside };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf('--base');
  const base = at >= 0 ? process.argv[at + 1] : null;
  if (!base) { console.error('usage: check-scope.mjs --base <commit>'); process.exit(2); }
  const out = execFileSync('git', ['diff', '--name-status', '-M', `${base}...HEAD`], { encoding: 'utf8' });
  const { changes, outside } = classify(out.split('\n'));
  console.log(JSON.stringify({ base, changed: changes.length, outside: outside.map(c => `${c.status}\t${c.paths.join(' -> ')}`) }, null, 2));
  if (outside.length > 0) process.exit(1);
}
