// SPDX-License-Identifier: Apache-2.0
// Scripted stand-in for `codex app-server --listen stdio://`. It reproduces the
// framing and handshake rules pinned for 0.142.3 (XIN-2043 §3.1–3.2) and adds
// `test/*` control methods. It is not a model or a protocol implementation.
import process from 'node:process';
import { setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const scenario = process.argv[2] ?? 'default';
const received = [];
const counters = new Map();
const waiting = new Map();
let initialized = false;
let initializeParams = null;
let nextServerId = 0;

const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const bump = key => {
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return n;
};

if (scenario === 'crash-on-start') {
  process.stderr.write('fatal: auth failed for Bearer abc.def sk-secret1234567890\n');
  process.exit(3);
}

async function handle(msg) {
  received.push(msg);
  if (Object.hasOwn(msg, 'id') && !Object.hasOwn(msg, 'method')) {
    const key = JSON.stringify(msg.id);
    const resolve = waiting.get(key);
    if (resolve) {
      waiting.delete(key);
      resolve(msg);
    }
    return;
  }
  if (!Object.hasOwn(msg, 'id')) return; // notification (e.g. `initialized`)
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    if (scenario === 'no-init-response') return;
    if (scenario === 'init-error') return fail(id, -32600, 'Invalid request: bad clientInfo');
    if (initialized) return fail(id, -32600, 'Already initialized');
    initialized = true;
    initializeParams = params;
    return reply(id, { userAgent: `${params.clientInfo?.name}/0.142.3`, codexHome: '/fake/codex-home', platformFamily: 'unix', platformOs: 'macos' });
  }
  if (!initialized) return fail(id, -32600, 'Not initialized');
  switch (method) {
    case 'test/echo':
      return reply(id, params);
    case 'test/initializeParams':
      return reply(id, initializeParams);
    case 'test/received':
      return reply(id, received.slice(0, -1));
    case 'test/notify':
      for (const n of params.notifications) send(n);
      return reply(id, {});
    case 'test/serverRequest': {
      const serverId = params.id ?? nextServerId++;
      const answer = new Promise(resolve => waiting.set(JSON.stringify(serverId), resolve));
      send({ id: serverId, method: params.method, params: params.params });
      return reply(id, await answer);
    }
    case 'test/split': {
      const line = Buffer.from(`${JSON.stringify({ id, result: { text: params.text } })}\n`);
      for (let i = 0; i < line.length; i += params.chunk) {
        process.stdout.write(line.subarray(i, i + params.chunk));
        await delay(2);
      }
      return;
    }
    case 'test/batch': {
      const lines = [
        '',
        'not json at all',
        JSON.stringify({ method: 'test/n', params: { i: 1 } }),
        '   ',
        JSON.stringify([1, 2]),
        JSON.stringify({ id: 'stray', result: 1 }),
        JSON.stringify({ method: 'test/n', params: { i: 2 } }),
        JSON.stringify({ id, result: { ok: true } }),
      ];
      process.stdout.write(lines.join('\r\n') + '\r\n');
      return;
    }
    case 'test/never':
      return;
    case 'test/later':
      await delay(params.delayMs);
      return reply(id, { late: true });
    case 'test/exit':
      if (params.stderr) process.stderr.write(params.stderr);
      await delay(5);
      process.exit(params.code ?? 1);
      return;
    case 'test/kill':
      process.kill(process.pid, 'SIGKILL');
      return;
    case 'test/oversize':
      process.stdout.write(`${JSON.stringify({ method: 'test/big', params: { blob: 'x'.repeat(params.bytes) } })}\n`);
      return;
    case 'test/malformed':
      return send({ id, result: 1, error: { code: 1, message: 'both' } });
    case 'test/wrongIdType':
      return send({ id: String(id), result: {} });
    case 'test/overload':
      return bump(method) <= params.times ? fail(id, -32001, 'Server overloaded; retry later.') : reply(id, { attempts: counters.get(method) });
    case 'test/closing':
      return bump(method) <= params.times
        ? fail(id, -32600, `thread ${params.threadId} is closing; retry thread/resume after the thread is closed`)
        : reply(id, { attempts: counters.get(method) });
    case 'thread/resume':
      return fail(id, -32600, `no rollout found for thread id ${params.threadId}`);
    default:
      return fail(id, -32600, `Invalid request: unknown variant \`${method}\``);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // undeserializable lines are skipped silently
    }
    void handle(msg);
  }
});
process.stdin.on('end', () => {
  if (scenario === 'ignore-eof') {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});
