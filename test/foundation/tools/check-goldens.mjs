// SPDX-License-Identifier: Apache-2.0
/**
 * Golden fixture manifest check (R8 §10.3 golden provenance).
 *
 *   node test/foundation/tools/check-goldens.mjs            # verify
 *   node test/foundation/tools/check-goldens.mjs --update   # regenerate, then re-pin digests
 *
 * For every manifest entry: the committed golden and its generator match their
 * pinned SHA-256; regenerating in-process reproduces the committed bytes
 * exactly; every cited specification source exists in
 * docs/test-foundation/source-pins.json. Planned generators that do not exist
 * yet are reported as `pending`, never skipped silently.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MANIFEST = resolve(ROOT, 'test/foundation/goldens/manifest.json');
const PINS = resolve(ROOT, 'docs/test-foundation/source-pins.json');
const sha256 = (p) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex');

export async function check({ update = false } = {}) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const pins = new Set(JSON.parse(readFileSync(PINS, 'utf8')).sources.map(s => s.id));
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push('manifest schemaVersion must be 1');
  const ids = new Set();
  for (const g of manifest.goldens) {
    if (ids.has(g.id)) errors.push(`${g.id}: duplicate id`);
    ids.add(g.id);
    for (const s of g.specSources) if (!pins.has(s)) errors.push(`${g.id}: unknown spec source ${s}`);
    const mod = await import(pathToFileURL(resolve(ROOT, g.generator)).href);
    if (typeof mod.render !== 'function') { errors.push(`${g.id}: generator has no render()`); continue; }
    const regenerated = mod.render();
    if (update) {
      writeFileSync(resolve(ROOT, g.file), regenerated);
      g.sha256 = sha256(g.file);
      g.generatorSha256 = sha256(g.generator);
      continue;
    }
    if (readFileSync(resolve(ROOT, g.file), 'utf8') !== regenerated) errors.push(`${g.id}: regenerated output differs from ${g.file}`);
    if (sha256(g.file) !== g.sha256) errors.push(`${g.id}: ${g.file} digest does not match manifest`);
    if (sha256(g.generator) !== g.generatorSha256) errors.push(`${g.id}: ${g.generator} digest does not match manifest`);
  }
  if (update) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  const pending = (manifest.pending ?? []).map(p => p.id);
  return { ok: errors.length === 0, verified: manifest.goldens.map(g => g.id), pending, errors };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await check({ update: process.argv.includes('--update') });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
}
