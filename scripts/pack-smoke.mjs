// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const temp = mkdtempSync(join(tmpdir(), 'x-buddy-pack-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' }));
  const paths = pack.files.map(file => file.path);
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md', 'package.json']) assert.ok(paths.includes(required), required);
  assert.ok(paths.every(path => path.startsWith('dist/') || ['LICENSE', 'README.md', 'package.json'].includes(path)), 'unexpected packaged file');
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, pack.filename)], { cwd: temp, stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', "import {foundation} from 'x-buddy'; if (foundation.name !== 'x-buddy' || foundation.stage !== 'bootstrap') process.exit(1)"], { cwd: temp, stdio: 'pipe' });
  const types = readFileSync(join(temp, 'node_modules/x-buddy/dist/index.d.ts'), 'utf8');
  assert.ok(types.includes('foundation'));
  console.log('Pack contents and installed ESM entry verified.');
} finally { rmSync(temp, { recursive: true, force: true }); }
