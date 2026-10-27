// SPDX-License-Identifier: Apache-2.0
/**
 * Subprocess entry for the scripted fake App Server, so a client can spawn it
 * exactly like the real binary: `node fake-app-server.mjs [--scenario file.json]`.
 * Exits 0 on stdin EOF; SIGTERM exits 143. Scenario files are JSON (no functions).
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { FakeAppServer } from '../lib/fake-app-server.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--scenario');
const scenario = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : {};
const unknown = args.filter((a, i) => !(a === '--scenario' || i === at + 1));
if (unknown.length > 0) {
  process.stderr.write(`error: unexpected argument '${unknown[0]}'\n`);
  process.exit(2);
}
const server = new FakeAppServer(scenario);
server.pipeOutput(line => process.stdout.write(line));
process.stdin.on('data', chunk => server.receive(chunk));
process.stdin.on('end', () => { server.exit({ code: 0, reason: 'stdin-eof' }); process.exit(0); });
process.on('SIGTERM', () => process.exit(143));
