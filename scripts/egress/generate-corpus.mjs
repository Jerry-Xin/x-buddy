// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic metamorphic corpus generator.
 *
 * Each seed produces a guarded variant (a boundary capability carried through
 * 1–32 composed transforms: aliases, erased assignments, destructuring,
 * barrels, mapped renames, generics, unions, optional chains, spreads, rest,
 * stores and authorized-factory relocation) and its paired control, in which
 * only the origin is replaced by a read export or an unrelated module with
 * identical spellings. A supported guarded variant must never be ALLOW; its
 * control must be ALLOW.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HEADER = '// SPDX-License-Identifier: Apache-2.0\n';
export const API_SOURCE = `${HEADER}export async function sendMessage(channel: string, text: string): Promise<void> { void channel; void text; }
export async function sendRichTextMessage(channel: string, blocks: unknown[]): Promise<void> { void channel; void blocks; }
export async function sendTyping(channel: string): Promise<void> { void channel; }
export async function registerBot(): Promise<{ robotId: string }> { return { robotId: 'robot' }; }
export async function getGroupMembers(group: string): Promise<string[]> { return [group]; }
`;
export const OTHER_SOURCE = `${HEADER}export async function sendMessage(channel: string, text: string): Promise<void> { void channel; void text; }
export async function sendRichTextMessage(channel: string, blocks: unknown[]): Promise<void> { void channel; void blocks; }
export async function sendTyping(channel: string): Promise<void> { void channel; }
export async function registerBot(): Promise<{ robotId: string }> { return { robotId: 'robot' }; }
export async function getGroupMembers(group: string): Promise<string[]> { return [group]; }
`;
export const GENERATED_CLASSIFICATION = Object.freeze({
  sendMessage: { class: 'primitive', reason: 'message send' },
  sendRichTextMessage: { class: 'primitive', reason: 'rich message send' },
  sendTyping: { class: 'primitive', reason: 'typing control' },
  registerBot: { class: 'infrastructure', reason: 'transport registration' },
  getGroupMembers: { class: 'read', reason: 'roster read' },
});

const GUARDED = ['sendMessage', 'sendTyping', 'sendRichTextMessage'];
const PERMITTED = ['getGroupMembers', 'registerBot'];
const ARGS = {
  sendMessage: "('channel', 'text')",
  sendTyping: "('channel')",
  sendRichTextMessage: "('channel', [])",
  getGroupMembers: "('group')",
  registerBot: '()',
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Committed-style seed list: deterministic, reproducible from its own definition. */
export function seedList(count, base = 0x5eed) {
  const next = rng(base);
  return Array.from({ length: count }, () => Math.floor(next() * 0xffffffff) >>> 0);
}

// Transforms over a value state {expr, ns, key, typed}. `ns` states hold a
// namespace-like value whose `key` slot is the carried function.
const TRANSFORMS = {
  alias: { any: true, apply: (s, n) => ({ code: [`const v${n} = ${s.expr};`], state: { ...s, expr: `v${n}`, ident: true } }) },
  erase: { any: true, apply: (s, n) => ({ code: [`let v${n}: any;`, `v${n} = ${s.expr};`], state: { ...s, expr: `v${n}`, ident: true, typed: false } }) },
  logical: { any: true, apply: (s, n) => ({ code: [`let v${n}: any;`, `v${n} ??= ${s.expr};`], state: { ...s, expr: `v${n}`, ident: true, typed: false } }) },
  conditional: { any: true, apply: (s, n) => ({ code: [`const v${n} = Math.random() > 2 ? ${s.expr} : ${s.expr};`], state: { ...s, expr: `v${n}`, ident: true } }) },
  wrap: { any: true, apply: (s, n) => ({ code: [`const v${n} = { k${n}: ${s.expr} };`], state: { ...s, expr: `v${n}.k${n}`, ident: false } }) },
  destructure: { any: true, apply: (s, n) => ({ code: [`const { k${n}: v${n} } = { k${n}: ${s.expr} };`], state: { ...s, expr: `v${n}`, ident: true } }) },
  assignPattern: { any: true, apply: (s, n) => ({ code: [`let v${n}: any;`, `({ k${n}: v${n} } = { k${n}: ${s.expr} });`], state: { ...s, expr: `v${n}`, ident: true, typed: false } }) },
  satisfies: { any: true, apply: (s, n) => ({ code: [`const v${n}: any = (${s.expr} satisfies unknown);`], state: { ...s, expr: `v${n}`, ident: true, typed: false } }) },
  box: {
    any: true,
    needsIdent: true,
    apply: (s, n) => ({
      code: [`interface Box${n}<T> { v: T; next?: Box${n}<T[]> }`, `const v${n}: Box${n}<typeof ${s.expr}> = { v: ${s.expr} };`],
      state: { ...s, expr: `v${n}.v`, ident: false },
    }),
  },
  union: {
    any: true,
    needsIdent: true,
    apply: (s, n) => ({ code: [`const v${n}: typeof ${s.expr} | undefined = ${s.expr};`], state: { ...s, expr: `v${n}!`, ident: false } }),
  },
  barrel: {
    any: true,
    apply: (s, n, ctx) => {
      ctx.files[`src/${ctx.id}_b${n}.ts`] = `${HEADER}export { v${n} as r${n} } from './${ctx.id}.js';\n`;
      return {
        code: [`export const v${n} = ${s.expr};`],
        imports: [`import { r${n} } from './${ctx.id}_b${n}.js';`],
        state: { ...s, expr: `r${n}`, ident: true },
      };
    },
  },
  spread: { ns: true, apply: (s, n) => ({ code: [`const v${n} = { ...${s.expr} };`], state: { ...s, expr: `v${n}`, ident: true } }) },
  rename: {
    ns: true,
    needsIdent: true,
    apply: (s, n) => ({
      code: [`type R${n} = { [K in keyof typeof ${s.expr} as \`x${n}\${K & string}\`]: (typeof ${s.expr})[K] };`, `const v${n} = ${s.expr} as unknown as R${n};`],
      state: { ...s, expr: `v${n}`, key: `x${n}${s.key}`, ident: true },
    }),
  },
  pick: {
    ns: true,
    needsIdent: true,
    apply: (s, n) => ({
      code: [`const v${n}: Readonly<Pick<typeof ${s.expr}, '${s.key}'>> = ${s.expr};`],
      state: { ...s, expr: `v${n}`, ident: true },
    }),
  },
  rest: { ns: true, apply: (s, n) => ({ code: [`const { ...v${n} } = ${s.expr};`], state: { ...s, expr: `v${n}`, ident: true } }) },
  store: { any: true, apply: (s, n) => ({ code: [`const h${n}: { slot?: any } = {};`, `h${n}.slot = ${s.expr};`], state: { ...s, expr: `h${n}.slot`, ident: false, typed: false } }) },
  identity: {
    any: true,
    apply: (s, n) => ({ code: [`function id${n}<T>(value: T): T { return value; }`, `const v${n} = id${n}(${s.expr});`], state: { ...s, expr: `v${n}`, ident: true } }),
  },
  array: { any: true, apply: (s, n) => ({ code: [`const v${n} = [${s.expr}][0];`], state: { ...s, expr: `v${n}`, ident: true } }) },
  select: {
    ns: true,
    apply: (s, n) => ({ code: [`const v${n} = ${s.expr}${s.optional ? '?.' : '.'}${s.key};`], state: { ...s, expr: `v${n}`, ns: false, ident: true } }),
  },
  optional: { any: true, apply: (s) => ({ code: [], state: { ...s, optional: true } }) },
};
// Escape-shaped transforms are DENY on their own; weight them lower so most
// variants carry the capability through the whole chain to the final use.
const ESCAPES = new Set(['array', 'identity', 'store', 'barrel']);
const NAMES = Object.keys(TRANSFORMS).flatMap((name) => (ESCAPES.has(name) ? [name] : [name, name, name]));

function usage(s, rand) {
  const call = (callee) => `await ${callee}${s.optional ? '?.' : ''}${ARGS[s.callKey]};`;
  if (!s.ns) return [call(s.expr)];
  const choice = Math.floor(rand() * 4);
  if (choice === 0) return [call(`${s.expr}${s.optional ? '?.' : '.'}${s.key}`)];
  if (choice === 1) return [call(`${s.expr}${s.optional ? '?.' : ''}['${s.key}']`)];
  if (choice === 2) return [`const { ${s.key}: chosen } = ${s.expr};`, call('chosen')];
  return ['const picked: string = String(Math.random());', `void (${s.expr} as any)[picked];`];
}

/**
 * Builds one variant. kind: 'guarded' | 'control'. The same seed yields the
 * same transform sequence for both kinds; only the origin differs.
 */
export function buildVariant(seed, kind, id, overridePlan) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const nsOrigin = rand() < 0.6;
  const viaFactory = rand() < 0.2;
  const guardedKey = pick(GUARDED);
  const permittedKey = pick(PERMITTED);
  const length = 1 + Math.floor(rand() * 32);
  const plan = [];
  for (let i = 0; i < length; i++) plan.push(pick(NAMES));
  if (overridePlan) plan.splice(0, plan.length, ...overridePlan);
  // Controls replace the origin: a namespace origin becomes the unrelated module
  // (identical spellings); a function origin becomes a read export or the
  // unrelated module's same-named function.
  const unrelated = kind === 'control' && (nsOrigin || rand() < 0.5);
  const key = kind === 'guarded' || unrelated ? guardedKey : permittedKey;
  const module = unrelated ? 'other' : 'octo/api';
  const files = {};
  const ctx = { id, files };
  const lines = [];
  const imports = [];
  let state;
  if (viaFactory) {
    files[`src/egress/${id}_factory.ts`] = nsOrigin
      ? `${HEADER}import * as origin from '../${module}.js';\nexport function make(): typeof origin { return origin; }\n`
      : `${HEADER}import { ${key} } from '../${module}.js';\nexport function make(): typeof ${key} { return ${key}; }\n`;
    imports.push(`import { make } from './egress/${id}_factory.js';`);
    lines.push('const v0 = make();');
    state = { expr: 'v0', ident: true };
  } else if (nsOrigin) {
    imports.push(`import * as origin from './${module}.js';`);
    state = { expr: 'origin', ident: true };
  } else {
    imports.push(`import { ${key} as origin } from './${module}.js';`);
    state = { expr: 'origin', ident: true };
  }
  state = { ...state, ns: nsOrigin, key, callKey: key, typed: true, optional: false };
  const applied = [];
  plan.forEach((name, i) => {
    const t = TRANSFORMS[name];
    if (t.ns && !state.ns) return;
    if (t.needsIdent && (!state.ident || !state.typed)) return;
    const n = i + 1;
    const out = t.apply(state, n, ctx);
    lines.push(...out.code);
    imports.push(...(out.imports ?? []));
    state = out.state;
    applied.push(name);
  });
  if (applied.length === 0) {
    const out = TRANSFORMS.alias.apply(state, plan.length + 1, ctx);
    lines.push(...out.code);
    state = out.state;
    applied.push('alias');
  }
  lines.push(...usage(state, rand));
  files[`src/${id}.ts`] = `${HEADER}${[...new Set(imports)].join('\n')}\n${lines.join('\n')}\nexport {};\n`;
  return {
    id,
    seed,
    kind,
    key: kind === 'guarded' ? guardedKey : key,
    module,
    transforms: applied,
    files,
    sourceHash: createHash('sha256').update(Object.entries(files).sort().map(([p, c]) => `${p}\n${c}`).join('\n')).digest('hex'),
  };
}

/** Writes a batch project; returns the scanner configuration for it. */
export function writeProject(root, variants) {
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('package.json', JSON.stringify({ private: true, type: 'module' }));
  write('src/octo/api.ts', API_SOURCE);
  write('src/other.ts', OTHER_SOURCE);
  for (const v of variants) for (const [path, content] of Object.entries(v.files)) write(path, content);
  return {
    root,
    srcDir: 'src',
    boundaryModules: ['src/octo/api.ts'],
    egressModules: ['src/egress/'],
    classification: GENERATED_CLASSIFICATION,
    baselinePermittedCallers: [],
  };
}

/** Files that belong to a variant (its module, barrels and factory). */
export const variantOwns = (id, file) => file === `src/${id}.ts` || file.startsWith(`src/${id}_`) || file.startsWith(`src/egress/${id}_`);
