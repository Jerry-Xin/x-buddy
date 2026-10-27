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

// A string or template literal. Template interpolations may only name a
// property path such as `${final.apiUrl}`, so no call or await can hide inside.
const TICK = '`';
const LITERAL = [
  String.raw`(?:'(?:[^'\\\n]|\\.)*'`,
  String.raw`"(?:[^"\\\n]|\\.)*"`,
  `${TICK}(?:[^${TICK}\\\\$]|\\\\.|\\$(?!\\{)|\\$\\{\\s*[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*\\})*${TICK})`,
].join('|');
const ERROR_ONE_LINE = new RegExp(String.raw`^\s*(?:throw\s+)?new\s+Error\(\s*${LITERAL}\s*\)\s*;?\s*$`);
const ERROR_OPEN = /^\s*(?:throw\s+)?new\s+Error\(\s*$/;
const LITERAL_LINE = new RegExp(String.raw`^\s*${LITERAL}\s*(?:\+|,)?\s*$`);
const LITERAL_CONTINUED = new RegExp(String.raw`^\s*${LITERAL}\s*\+\s*$`);

// comment: a whole-line `//` comment, or a ` * ` continuation line that sits
// inside a block comment opened on an earlier line and has no code after `*/`.
export function isCommentLine(lines, index) {
  const text = lines[index].trim();
  if (text.startsWith('//')) return true;
  if (!text.startsWith('*') || text.startsWith('*/')) return false;
  const close = text.indexOf('*/');
  if (close !== -1 && text.slice(close + 2).trim() !== '') return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    const prev = lines[i].trim();
    if (prev.includes('*/')) return false;
    if (prev.startsWith('/*')) return true;
    if (!prev.startsWith('*')) return false;
  }
  return false;
}

// error-string: the line is only the literal argument of `new Error(...)`,
// either on one line or as one piece of a `+`-joined literal message.
export function isErrorStringLine(lines, index) {
  const text = lines[index];
  if (ERROR_ONE_LINE.test(text)) return true;
  if (!LITERAL_LINE.test(text)) return false;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (ERROR_OPEN.test(lines[i])) return true;
    if (!LITERAL_CONTINUED.test(lines[i])) return false;
  }
  return false;
}

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
    const lines = bytes.toString('utf8').split('\n');
    const text = lines[line - 1];
    assert.ok(text !== undefined && sha256(text) === exception.lineSha256, `exception line changed: ${key}`);
    if (check === 'security') {
      assert.ok(SECURITY_KINDS.has(exception.kind), `security exception kind not allowed: ${key}`);
      if (exception.kind === 'test-url') assert.ok(destination.startsWith('test/'), `test-url exception outside test/: ${key}`);
      else assert.ok(!destination.startsWith('test/'), `${exception.kind} exception must be a source line: ${key}`);
      if (exception.kind === 'comment') assert.ok(isCommentLine(lines, line - 1), `comment exception is not a whole comment line: ${key}`);
      if (exception.kind === 'error-string') assert.ok(isErrorStringLine(lines, line - 1), `error-string exception is not a literal Error message: ${key}`);
    }
    result.push({ ...exception, text });
  }
  return result;
}
