// SPDX-License-Identifier: Apache-2.0
// Regression tests for the fake App Server line cap, duplicate client ids and
// the subprocess termination contract (XIN-2512). These check the fixture's
// own contracts; they are not evidence of pinned 0.142.3 behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { FakeAppServer, MAX_LINE_BYTES, RPC_ERRORS } from './lib/fake-app-server.mjs';

const BIN = fileURLToPath(new URL('./bin/fake-app-server.mjs', import.meta.url));
const line = obj => JSON.stringify(obj) + '\n';
const INIT = line({ id: 0, method: 'initialize', params: {} }) + line({ method: 'initialized' });

/** In-process fake whose output lines are collected synchronously. */
function inProcess(scenario = {}) {
  const server = new FakeAppServer(scenario);
  const out = [];
  server.pipeOutput(l => out.push(JSON.parse(l)));
  server.receive(INIT);
  return { server, out, byId: id => out.filter(m => m.id === id && !('method' in m)) };
}

/** A request line of exactly `bytes` bytes including its newline. */
function requestOfSize(id, bytes) {
  const base = line({ id, method: 'thread/loaded/list', params: { pad: '' } });
  return line({ id, method: 'thread/loaded/list', params: { pad: 'x'.repeat(bytes - Buffer.byteLength(base)) } });
}

test('line cap: an oversize line that arrives complete with its newline is dropped and the next line is served', () => {
  const { server, out, byId } = inProcess();
  server.receive(requestOfSize(1, MAX_LINE_BYTES + 2) + line({ id: 2, method: 'thread/loaded/list' }));
  assert.deepEqual(byId(1), []);
  assert.deepEqual(byId(2)[0].result, { data: [] });
  const anomalies = server.anomalies();
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].kind, 'line-too-long');
  assert.equal(anomalies[0].complete, true);
  assert.equal(out.some(m => m.error?.code === RPC_ERRORS.PARSE), false);
});

test('line cap: an oversize line split across chunks is discarded up to its newline, then reading resumes', () => {
  const { server, byId } = inProcess();
  const big = requestOfSize(1, MAX_LINE_BYTES + 200 * 1024);
  const chunk = 64 * 1024;
  for (let i = 0; i < big.length; i += chunk) server.receive(big.slice(i, i + chunk));
  server.receive(line({ id: 2, method: 'thread/loaded/list' }));
  assert.deepEqual(byId(1), []);
  assert.equal(byId(2).length, 1);
  assert.deepEqual(server.anomalies().map(a => [a.kind, a.complete]), [['line-too-long', false]]);
});

test('line cap: a line of exactly MAX_LINE_BYTES (newline excluded) is accepted', () => {
  const { server, byId } = inProcess();
  server.receive(requestOfSize(1, MAX_LINE_BYTES + 1));
  assert.equal(byId(1).length, 1);
  assert.deepEqual(server.anomalies(), []);
});

test('duplicate client request ids are flagged and served by default; 1 and "1" are different ids', () => {
  const { server, byId } = inProcess();
  server.receive(line({ id: 5, method: 'thread/start' }) + line({ id: 5, method: 'thread/loaded/list' }));
  server.receive(line({ id: 1, method: 'thread/loaded/list' }) + line({ id: '1', method: 'thread/loaded/list' }));
  server.receive(line({ id: 0, method: 'thread/loaded/list' }));
  assert.equal(byId(5).length, 2);
  const dups = server.anomalies().filter(a => a.kind === 'duplicate-request-id');
  assert.deepEqual(dups.map(d => [d.id, d.method]), [[5, 'thread/loaded/list'], [0, 'thread/loaded/list']]);
  const first = server.log().find(e => e.dir === 'in' && e.msg.id === 5);
  assert.equal(dups[0].firstSeq, first.seq);
});

test('duplicateRequestIds: reject answers a reused id with -32600 and does not run it', () => {
  const { server, byId } = inProcess({ duplicateRequestIds: 'reject' });
  server.receive(line({ id: 7, method: 'thread/start' }) + line({ id: 7, method: 'thread/start' }));
  const replies = byId(7);
  assert.equal(replies.length, 2);
  assert.ok(replies[0].result.thread.id);
  assert.deepEqual(replies[1].error, { code: RPC_ERRORS.INVALID_REQUEST, message: 'Duplicate request id: 7' });
  assert.equal(server.threads().length, 1);
  assert.throws(() => new FakeAppServer({ duplicateRequestIds: 'ignore' }), /duplicateRequestIds must be one of/);
});

test('exit record lists the in-flight turns and server requests it abandons', () => {
  const { server, out } = inProcess({ turns: [[{ request: 'item/tool/call', params: {} }], [{ waitInterrupt: true }]] });
  server.receive(line({ id: 1, method: 'thread/start' }));
  server.receive(line({ id: 2, method: 'turn/start', params: { threadId: 'thr_1' } }));
  server.receive(line({ id: 3, method: 'turn/start', params: { threadId: 'thr_1' } }));
  server.exit({ code: 0, reason: 'stdin-eof' });
  const exit = server.log().find(e => e.dir === 'exit');
  assert.deepEqual(exit.abandonedTurns, ['turn_1', 'turn_2']);
  assert.deepEqual(exit.pendingServerRequests, [0]);
  assert.equal(out.some(m => m.method === 'turn/completed'), false);
});

/** Spawn the subprocess entry; resolves with everything it printed and how it ended. */
function runBin(scenario, input, { signalAfter, readDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x-buddy-fake-as-'));
  const file = join(dir, 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario));
  const child = spawn(process.execPath, [BIN, '--scenario', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', c => { stdout += c; if (signalAfter && stdout.includes(signalAfter.text)) child.kill(signalAfter.signal); });
  child.stderr.on('data', c => { stderr += c; });
  if (readDelayMs > 0) {
    // A slow reader lets the pipe fill, so output is still queued in the child when stdin closes.
    child.stdout.pause();
    globalThis.setTimeout(() => child.stdout.resume(), readDelayMs);
  }
  return new Promise(resolve => {
    child.on('close', (code, signal) => {
      rmSync(dir, { recursive: true, force: true });
      const messages = stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
      resolve({ code, signal, stderr, messages, trailing: stdout.endsWith('\n') || stdout === '' });
    });
    if (input.end === false) child.stdin.write(input.text);
    else child.stdin.end(input.text);
  });
}

const TURN = INIT + line({ id: 1, method: 'thread/start' }) + line({ id: 2, method: 'turn/start', params: { threadId: 'thr_1' } });

test('subprocess: runtime.killChild from the scenario file kills the process with SIGKILL after flushing earlier output', async () => {
  const scenario = {
    faults: [{ point: 'runtime.killChild', action: 'kill', skip: 1 }],
    defaultTurn: [{ notify: 'item/started', params: { n: 1 } }, { notify: 'item/started', params: { n: 2 } }, { complete: 'completed' }],
  };
  const r = await runBin(scenario, { text: TURN, end: false });
  assert.equal(r.code, null);
  assert.equal(r.signal, 'SIGKILL');
  assert.deepEqual(r.messages.filter(m => m.method === 'item/started').map(m => m.params.n), [1]);
  assert.equal(r.messages.some(m => m.method === 'turn/completed'), false);
  assert.equal(r.trailing, true, 'no partial line on stdout');
  assert.equal(r.stderr, '');
});

test('subprocess: stdin EOF flushes all output written before it and exits 0, even to a slow reader', async () => {
  const count = 2000;
  const pad = 'y'.repeat(4096);
  const scenario = { defaultTurn: Array.from({ length: count }, (_, n) => ({ notify: 'item/updated', params: { n, pad } })) };
  const r = await runBin(scenario, { text: TURN }, { readDelayMs: 300 });
  assert.equal(r.code, 0);
  assert.equal(r.messages.filter(m => m.method === 'item/updated').length, count);
  assert.equal(r.messages.at(-1).method, 'turn/completed');
  assert.equal(r.trailing, true);
});

test('subprocess: stdin EOF abandons an in-flight turn without turn/completed and exits 0', async () => {
  const r = await runBin({ defaultTurn: [{ waitInterrupt: true }] }, { text: TURN });
  assert.equal(r.code, 0);
  assert.ok(r.messages.some(m => m.method === 'turn/started'));
  assert.equal(r.messages.some(m => m.method === 'turn/completed'), false);
});

test('subprocess: unconsumed faults are reported on stderr; unknown fault points exit 2; SIGTERM exits 143', async () => {
  const unfired = await runBin({ faults: [{ point: 'runtime.killChild', action: 'kill', skip: 100 }] }, { text: TURN });
  assert.equal(unfired.code, 0);
  assert.match(unfired.stderr, /^fake-app-server: FaultPlan has unconsumed faults: runtime\.killChild/);

  const bad = await runBin({ faults: [{ point: 'egress.afterFence', action: 'drop' }] }, { text: '' });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /fault point egress\.afterFence is not used by the fake App Server/);

  const term = await runBin({ defaultTurn: [{ waitInterrupt: true }] }, { text: TURN, end: false }, { signalAfter: { text: 'turn/started', signal: 'SIGTERM' } });
  assert.equal(term.code, 143);
  assert.ok(term.messages.some(m => m.method === 'turn/started'));
});

// XB-F10: multibyte UTF-8 split across chunks must be decoded byte-exactly.
const TEXT = '日本語テスト 😀👍🏽 é ü 中文';

test('utf-8: every byte split of two frames with CJK and emoji decodes exactly', () => {
  const bytes = Buffer.from(line({ id: 1, method: 'thread/start', params: { text: TEXT } }) + line({ id: 2, method: 'thread/start', params: { text: TEXT + '2' } }));
  for (let i = 1; i < bytes.length; i++) {
    const { server } = inProcess();
    server.receive(bytes.subarray(0, i));
    server.receive(bytes.subarray(i));
    assert.deepEqual(server.requests('thread/start').map(r => r.params.text), [TEXT, TEXT + '2'], `split at byte ${i}`);
    assert.deepEqual(server.anomalies(), [], `split at byte ${i}`);
  }
});

test('utf-8: byte-by-byte feeding decodes exactly', () => {
  const { server } = inProcess();
  const bytes = Buffer.from(line({ id: 1, method: 'thread/start', params: { text: TEXT } }));
  for (let i = 0; i < bytes.length; i++) server.receive(bytes.subarray(i, i + 1));
  assert.equal(server.requests('thread/start')[0].params.text, TEXT);
});

test('utf-8: a line ending in a 4-byte emoji split at the cap boundary is accepted at the cap and dropped above it', () => {
  const at = (bytes) => {
    const base = line({ id: 1, method: 'thread/start', params: { text: '😀' } });
    return Buffer.from(line({ id: 1, method: 'thread/start', params: { text: 'x'.repeat(bytes - Buffer.byteLength(base)) + '😀' } }));
  };
  for (const [size, accepted] of [[MAX_LINE_BYTES + 1, true], [MAX_LINE_BYTES + 2, false]]) {
    const { server } = inProcess();
    const buf = at(size);
    const cut = buf.length - 5; // inside the emoji: its 4 bytes are followed by `"}}` + newline
    server.receive(buf.subarray(0, cut - 2));
    server.receive(buf.subarray(cut - 2));
    server.receive(line({ id: 2, method: 'thread/loaded/list' }));
    assert.equal(server.requests('thread/start').length, accepted ? 1 : 0, `size ${size}`);
    if (accepted) assert.ok(server.requests('thread/start')[0].params.text.endsWith('😀'));
    assert.equal(server.requests('thread/loaded/list').length, 1);
  }
});

test('utf-8: a 270 KB CJK prompt fed in 64 KiB pipe-sized chunks arrives byte-exact (XIN-2510 repro)', () => {
  const prompt = '漢字かなカナ😀'.repeat(13000);
  const bytes = Buffer.from(line({ id: 1, method: 'thread/start', params: { prompt } }));
  assert.ok(bytes.length > 270_000);
  const { server } = inProcess();
  for (let i = 0; i < bytes.length; i += 64 * 1024) server.receive(bytes.subarray(i, i + 64 * 1024));
  const got = server.requests('thread/start')[0].params.prompt;
  assert.equal(got.includes('\uFFFD'), false);
  assert.equal(got, prompt);
});

// XB-F11: the subprocess entry accepts exactly [--scenario <file>].
test('subprocess args: any argument other than --scenario <file> exits 2 with a usage error', async () => {
  const run = (args) => new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end();
  });
  for (const [args, msg] of [
    [['--bogus'], /unexpected argument '--bogus'/],
    [['app-server'], /unexpected argument 'app-server'/],
    [['--bogus', 'x'], /unexpected argument '--bogus'/],
    [['--scenario'], /'--scenario' requires a file/],
    [['--scenario', '--bogus'], /'--scenario' requires a file/],
    [['--scenario', '/nonexistent/x-buddy-scenario.json'], /cannot read scenario/],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, msg, args.join(' '));
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
  }
  assert.equal((await run([])).code, 0);
});
