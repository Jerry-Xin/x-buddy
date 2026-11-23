// SPDX-License-Identifier: Apache-2.0
// ESLint over the whole repository with no path-wide disables. A message is
// tolerated only when docs/import-manifest.json lists that exact rule on that
// exact line of an imported file at its pinned hash. Unused exceptions fail too.
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { exceptionsFor, loadManifest, sha256 } from './lib/manifest.mjs';

const manifest = loadManifest();
const exceptions = exceptionsFor(manifest, 'eslint');
// These immutable upstream preimages are checked by check:imports.
// Preserve their exact bytes, without exempting any other diagnostic.
const preimageDiagnostics = [
  ['docs/host-baseline/semantic/config.original.ts', 317],
  ['docs/host-baseline/semantic/gateway.original.ts', 224],
  ['docs/host-baseline/semantic/session-store.original.ts', 144],
];
for (const [path, line] of preimageDiagnostics) {
  const overlay = manifest.imports.find(({ semanticPatch }) => semanticPatch?.original === path)?.semanticPatch;
  if (overlay && sha256(readFileSync(path)) === overlay.preimageSha256) {
    exceptions.push({ destination: path, line, rule: 'preserve-caught-error' });
  }
}
const pending = new Map(exceptions.map((e) => [`${e.destination}:${e.line}:${e.rule}`, e]));
const eslint = new ESLint();
const results = await eslint.lintFiles(['.']);
const failures = [];
let excepted = 0;
for (const result of results) {
  const path = relative(process.cwd(), result.filePath);
  for (const message of result.messages) {
    const key = `${path}:${message.line}:${message.ruleId}`;
    if (!message.fatal && message.ruleId && pending.has(key)) {
      pending.delete(key);
      excepted += 1;
      continue;
    }
    failures.push(`${path}:${message.line}:${message.column} ${message.ruleId ?? 'fatal'} ${message.message}`);
  }
}
for (const key of pending.keys()) failures.push(`unused eslint exception ${key}`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`eslint: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log(`ESLint clean on ${results.length} files; ${excepted} manifest-bound line exception(s) applied.`);
