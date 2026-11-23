// SPDX-License-Identifier: Apache-2.0
// Loads the better-sqlite3 native addon on the running Node and opens an
// in-memory database, so an ABI mismatch fails here and not at host start.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE t (v TEXT)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('ok');
  assert.equal(db.prepare('SELECT v FROM t').get().v, 'ok');
  const sqlite = db.prepare('SELECT sqlite_version() AS v').get().v;
  const { version } = require('better-sqlite3/package.json');
  console.log(`better-sqlite3 ${version} loaded on Node ${process.version} (ABI ${process.versions.modules}, ${process.platform}-${process.arch}); SQLite ${sqlite}.`);
} finally {
  db.close();
}
