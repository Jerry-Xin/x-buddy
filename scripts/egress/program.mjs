// SPDX-License-Identifier: Apache-2.0
/**
 * Program construction for the capability provenance analyzer.
 *
 * Builds one TypeScript Program for the supported single-project profile
 * (TypeScript 5.9.3, ES2022 target, NodeNext modules, strict), canonicalizes
 * every source path against the repository root and records anything that
 * prevents a complete analysis. Nothing here approves a scan: callers must
 * treat `complete === false` as UNKNOWN.
 */
import ts from 'typescript';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const SUPPORTED_TYPESCRIPT = '5.9.3';
const SUPPORTED_ROOT_EXTENSIONS = ['.ts', '.d.ts'];
const UNSUPPORTED_EXTENSIONS = ['.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Stable SyntaxKind names, skipping the First and Last range markers. */
const KIND_NAMES = (() => {
  const names = [];
  for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value === 'number' && !/^(First|Last)/.test(name) && names[value] === undefined) names[value] = name;
  }
  return names;
})();
export const kindName = (kind) => KIND_NAMES[kind] ?? `Kind${kind}`;

function walkInventory(dir, out, problems, base) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walkInventory(path, out, problems, base);
    } else if (entry.endsWith('.d.ts') || entry.endsWith('.ts')) {
      if (UNSUPPORTED_EXTENSIONS.some((ext) => entry.endsWith(ext))) problems.push(relative(base, path));
      else out.push(path);
    } else if (UNSUPPORTED_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      problems.push(relative(base, path));
    }
  }
  return out;
}

/** Deterministic permutation used only by order-independence tests. */
function permute(list, seed) {
  const out = list.slice();
  let state = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function defaultOptions() {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
  };
}

function validateProfile(options, diagnostics) {
  const problems = [];
  if (options.module !== ts.ModuleKind.NodeNext) problems.push('module must be NodeNext');
  if (options.moduleResolution !== ts.ModuleResolutionKind.NodeNext) problems.push('moduleResolution must be NodeNext');
  if ((options.target ?? ts.ScriptTarget.ES5) < ts.ScriptTarget.ES2022) problems.push('target must be ES2022 or later');
  if (options.strict !== true) problems.push('strict must be enabled');
  if (options.allowJs || options.checkJs) problems.push('JavaScript sources are not supported');
  if (options.jsx !== undefined) problems.push('JSX is not supported');
  if (options.composite) problems.push('composite projects are not supported');
  for (const problem of problems) diagnostics.push({ code: 'unsupported-project', file: '', reason: problem });
}

/**
 * @param {object} cfg scanner configuration (root, srcDir, tsconfig, boundaryModules, rootOrderSeed)
 */
export function loadProgram(cfg) {
  const diagnostics = [];
  const root = realpathSync(resolve(cfg.root));
  const rel = (path) => relative(root, path).split(sep).join('/');
  if (ts.version !== SUPPORTED_TYPESCRIPT) {
    diagnostics.push({ code: 'unsupported-project', file: '', reason: `TypeScript ${ts.version} is not the pinned ${SUPPORTED_TYPESCRIPT}` });
  }
  const srcDir = join(root, cfg.srcDir ?? 'src');
  const unsupportedFiles = [];
  const inventory = existsSync(srcDir) ? walkInventory(srcDir, [], unsupportedFiles, root) : [];
  if (!existsSync(srcDir)) diagnostics.push({ code: 'unsupported-project', file: '', reason: `source directory ${cfg.srcDir ?? 'src'} is missing` });
  for (const file of unsupportedFiles.sort()) {
    diagnostics.push({ code: 'unsupported-project', file: file.split(sep).join('/'), reason: 'unsupported source file extension' });
  }

  let options = defaultOptions();
  let profile = 'fixture-default-es2022-nodenext-v1';
  const tsconfigPath = cfg.tsconfig ? resolve(root, cfg.tsconfig) : join(root, 'tsconfig.json');
  let configured;
  if (cfg.tsconfig || (cfg.useProjectConfig !== false && existsSync(tsconfigPath))) {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error) {
      diagnostics.push({ code: 'unsupported-project', file: rel(tsconfigPath), reason: ts.flattenDiagnosticMessageText(read.error.messageText, ' ') });
    } else {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath), { noEmit: true }, tsconfigPath);
      for (const error of parsed.errors) {
        if (error.code === 18003) continue; // no inputs: the inventory below still decides the roots
        diagnostics.push({ code: 'unsupported-project', file: rel(tsconfigPath), reason: ts.flattenDiagnosticMessageText(error.messageText, ' ') });
      }
      if (parsed.projectReferences?.length) diagnostics.push({ code: 'unsupported-project', file: rel(tsconfigPath), reason: 'project references require a reviewed adapter' });
      options = { ...parsed.options, noEmit: true };
      configured = new Set(parsed.fileNames.map((f) => realpathSync(f)));
      profile = `tsconfig:${rel(tsconfigPath)}`;
    }
  }
  validateProfile(options, diagnostics);

  const roots = inventory.map((f) => realpathSync(f)).filter((f) => SUPPORTED_ROOT_EXTENSIONS.some((ext) => f.endsWith(ext)));
  if (configured) {
    // A config exclusion cannot hide a runtime-reachable module.
    for (const file of roots) {
      if (!configured.has(file) && !file.endsWith('.d.ts')) {
        diagnostics.push({ code: 'unexplained-omission', file: rel(file), reason: 'source file is outside the project configuration' });
      }
    }
  }
  const ordered = cfg.rootOrderSeed === undefined ? roots.slice().sort() : permute(roots.slice().sort(), cfg.rootOrderSeed);
  const program = ts.createProgram({ rootNames: ordered, options });
  const checker = program.getTypeChecker();

  // Canonical file identity: realpath containment, no duplicates.
  const canonical = new Map();
  const fileInfo = new Map();
  for (const sf of program.getSourceFiles()) {
    let real;
    try { real = realpathSync(sf.fileName); } catch { real = resolve(sf.fileName); }
    const path = rel(real);
    const external = path.startsWith('../') || path === '..' || program.isSourceFileDefaultLibrary(sf)
      || program.isSourceFileFromExternalLibrary(sf) || path.split('/').includes('node_modules');
    if (!external) {
      if (canonical.has(path) && canonical.get(path) !== sf) {
        diagnostics.push({ code: 'ambiguous-canonical-path', file: path, reason: 'two program files share one canonical path' });
      }
      canonical.set(path, sf);
    }
    fileInfo.set(sf, { path, external, declaration: sf.isDeclarationFile });
  }

  // Any compiler error inside the scanned closure prevents approval.
  for (const d of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
    if (d.category === ts.DiagnosticCategory.Error) {
      diagnostics.push({ code: 'compiler-error', file: '', reason: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
    }
  }
  const scanned = [...canonical.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, sf]) => sf);
  for (const sf of scanned) {
    const errors = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
      .filter((d) => d.category === ts.DiagnosticCategory.Error);
    for (const d of errors) {
      const pos = d.start === undefined ? undefined : sf.getLineAndCharacterOfPosition(d.start);
      diagnostics.push({
        code: d.code === 2307 || d.code === 2792 ? 'unresolved-module' : 'compiler-error',
        file: fileInfo.get(sf).path,
        line: pos ? pos.line + 1 : undefined,
        reason: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      });
    }
  }

  for (const boundary of cfg.boundaryModules ?? []) {
    if (!canonical.has(boundary)) diagnostics.push({ code: 'missing-boundary', file: boundary, reason: 'configured boundary module is not in the program' });
  }

  return {
    ts,
    program,
    checker,
    root,
    rel,
    profile,
    options,
    scanned,
    fileInfo,
    canonical,
    diagnostics,
    complete: diagnostics.length === 0,
    compilerVersion: ts.version,
  };
}
