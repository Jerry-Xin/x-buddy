// SPDX-License-Identifier: Apache-2.0
// Shared reader for docs/import-manifest.json (schema v2). Exceptions are bound
// to the exact destination bytes of a listed import and to one line of it, so
// any edit to the file or the line invalidates the exception instead of
// silently widening it.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function loadManifest() {
  const manifest = JSON.parse(readFileSync('docs/import-manifest.json', 'utf8'));
  assert.equal(manifest.schemaVersion, 2, 'import manifest must be schema v2');
  return manifest;
}

const EXCEPTION_RULES = {
  eslint: new Set(['preserve-caught-error', 'no-useless-escape', 'no-empty', 'no-useless-assignment', 'require-yield']),
  security: new Set(['private-endpoint']),
};
const SECURITY_KINDS = new Set(['comment', 'error-string', 'test-url']);

export function exceptionsFor(manifest, check) {
  const imports = new Map(manifest.imports.map((entry) => [entry.destination, entry]));
  const seen = new Set();
  const result = [];
  for (const exception of manifest.exceptions.filter((e) => e.check === check)) {
    const { destination, line, rule } = exception;
    const key = `${destination}:${line}:${rule}`;
    assert.ok(!seen.has(key), `duplicate ${check} exception ${key}`);
    seen.add(key);
    assert.ok(EXCEPTION_RULES[check].has(rule), `${check} exception rule not allowed: ${key}`);
    assert.ok(Number.isInteger(line) && line > 0, `bad exception line: ${key}`);
    assert.match(exception.reason ?? '', /\S/, `exception without reason: ${key}`);
    const entry = imports.get(destination);
    assert.ok(entry && entry.kind === 'imported', `exception for a file that is not a listed import: ${key}`);
    const bytes = readFileSync(destination);
    assert.equal(sha256(bytes), entry.destinationSha256, `exception file changed since import: ${destination}`);
    const text = bytes.toString('utf8').split('\n')[line - 1];
    assert.ok(text !== undefined && sha256(text) === exception.lineSha256, `exception line changed: ${key}`);
    if (check === 'security') {
      assert.ok(SECURITY_KINDS.has(exception.kind), `security exception kind not allowed: ${key}`);
      if (exception.kind === 'test-url') assert.ok(destination.startsWith('test/'), `test-url exception outside test/: ${key}`);
      else assert.ok(!destination.startsWith('test/'), `${exception.kind} exception must be a source line: ${key}`);
      if (exception.kind === 'comment') assert.match(text.trim(), /^(?:\*|\/\/|\/\*)/, `comment exception is not a comment line: ${key}`);
    }
    result.push({ ...exception, text });
  }
  return result;
}
