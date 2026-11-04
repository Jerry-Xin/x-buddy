// SPDX-License-Identifier: Apache-2.0
// Inert JSONL peer: no model, SDK, network, bot, filesystem, or child process.
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n');
});
input.on('close', () => setTimeout(() => process.exit(7), Number(process.argv[2] ?? 700)));
