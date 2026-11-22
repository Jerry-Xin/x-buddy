// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexOptions, ThreadOptions } from '../app-server/params.js';
import type { ExecutorThread, QueryExecutor } from './executor.js';

export const PINNED_CODEX_VERSION = '0.169.1';

export type SdkClientFactory = (settings: CodexOptions) => QueryExecutor;

export interface CodexPackageManifest {
  layoutVersion: number;
  version?: string;
  target?: string;
  variant?: string;
  entrypoint?: string;
  resourcesDir?: string;
  pathDir?: string;
}

export interface ResolvedCodexBinary {
  bin: string;
  vendorPathDirs: string[];
  version: string;
  layoutVersion?: number;
  targetTriple?: string;
  platformPackage?: string;
}

export interface ResolveCodexBinaryOptions {
  anchorUrl?: string | URL;
  platform?: NodeJS.Platform;
  arch?: string;
  resolveFromSdkAnchor?: (specifier: string) => string;
  exists?: (candidatePath: string) => boolean;
}

const TARGET_TRIPLES: Readonly<Record<string, { pkg: string; triple: string }>> = {
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

function resolveDefaultAnchorUrl(anchorUrl?: string | URL): string | URL {
  if (anchorUrl !== undefined) {
    return anchorUrl;
  }
  const localSdkPkg = fileURLToPath(new URL('../../node_modules/@openai/codex-sdk/package.json', import.meta.url));
  if (existsSync(localSdkPkg)) {
    return import.meta.url;
  }
  const offlineNodeModulesPkg = fileURLToPath(
    new URL('../../../offline/node_modules/@openai/codex-sdk/package.json', import.meta.url),
  );
  if (existsSync(offlineNodeModulesPkg)) {
    return new URL('../../../offline/noop.js', import.meta.url);
  }
  return import.meta.url;
}

function resolvePackageJson(
  req: NodeRequire,
  pkgName: string,
  exists: (candidatePath: string) => boolean = existsSync,
): string {
  try {
    return req.resolve(`${pkgName}/package.json`);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      const searchPaths = req.resolve.paths(pkgName) ?? [];
      for (const dir of searchPaths) {
        const candidate = join(dir, ...pkgName.split('/'), 'package.json');
        if (exists(candidate)) {
          return candidate;
        }
      }
    }
    throw err;
  }
}

function readPackageVersion(pkgJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    return '';
  }
}

function assertExactPackageVersion(pkgName: string, pkgJsonPath: string, allowPlatformSuffix = false): void {
  const version = readPackageVersion(pkgJsonPath);
  const ok = allowPlatformSuffix
    ? version === PINNED_CODEX_VERSION || version.startsWith(`${PINNED_CODEX_VERSION}-`)
    : version === PINNED_CODEX_VERSION;
  if (!ok) {
    throw new Error(
      `Pinned ${pkgName} version mismatch: expected ${PINNED_CODEX_VERSION}, got ${version || 'unknown'}`,
    );
  }
}

export function resolveCodexBinary(options: ResolveCodexBinaryOptions = {}): ResolvedCodexBinary {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = TARGET_TRIPLES[`${platform}-${arch}`];
  if (!target) {
    throw new Error(`Unsupported platform/arch for pinned @openai/codex binary: ${platform}-${arch}`);
  }
  const exists = options.exists ?? existsSync;
  let codexPkgJsonPath: string;
  let platformPkgJsonPath: string;
  if (options.resolveFromSdkAnchor) {
    codexPkgJsonPath = options.resolveFromSdkAnchor('@openai/codex/package.json');
    platformPkgJsonPath = options.resolveFromSdkAnchor(`${target.pkg}/package.json`);
    if (!codexPkgJsonPath || !platformPkgJsonPath) {
      throw new Error(`Pinned ${target.pkg} package could not be resolved from @openai/codex-sdk anchor`);
    }
    if (existsSync(codexPkgJsonPath)) {
      assertExactPackageVersion('@openai/codex', codexPkgJsonPath);
    }
    if (existsSync(platformPkgJsonPath)) {
      assertExactPackageVersion(target.pkg, platformPkgJsonPath, true);
    }
  } else {
    const rootRequire = createRequire(resolveDefaultAnchorUrl(options.anchorUrl));
    const sdkPkgJson = resolvePackageJson(rootRequire, '@openai/codex-sdk', exists);
    assertExactPackageVersion('@openai/codex-sdk', sdkPkgJson);
    const sdkRequire = createRequire(sdkPkgJson);
    codexPkgJsonPath = resolvePackageJson(sdkRequire, '@openai/codex', exists);
    assertExactPackageVersion('@openai/codex', codexPkgJsonPath);
    const codexRequire = createRequire(codexPkgJsonPath);
    platformPkgJsonPath = resolvePackageJson(codexRequire, target.pkg, exists);
    assertExactPackageVersion(target.pkg, platformPkgJsonPath, true);
  }
  const vendorRoot = join(dirname(platformPkgJsonPath), 'vendor', target.triple);
  const binName = platform === 'win32' ? 'codex.exe' : 'codex';
  const manifestPath = join(vendorRoot, 'codex-package.json');
  let layoutVersion = 1;
  let entrypointRel = join('bin', binName);
  let pathDirRel = 'codex-path';
  if (exists(manifestPath)) {
    let manifest: CodexPackageManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CodexPackageManifest;
    } catch (err) {
      throw new Error(
        `Invalid Codex package manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (manifest.layoutVersion !== 1) {
      throw new Error(
        `Unsupported Codex package layoutVersion in ${manifestPath}: expected 1, got ${String(manifest.layoutVersion)}`,
      );
    }
    if (typeof manifest.version === 'string' && manifest.version !== PINNED_CODEX_VERSION) {
      throw new Error(
        `Pinned Codex binary manifest version mismatch in ${manifestPath}: expected ${PINNED_CODEX_VERSION}, got ${manifest.version}`,
      );
    }
    if (typeof manifest.target === 'string' && manifest.target !== target.triple) {
      throw new Error(
        `Pinned Codex binary manifest target mismatch in ${manifestPath}: expected ${target.triple}, got ${manifest.target}`,
      );
    }
    if (typeof manifest.entrypoint === 'string' && manifest.entrypoint.trim().length > 0) {
      entrypointRel = join(...manifest.entrypoint.split('/'));
    }
    if (typeof manifest.pathDir === 'string' && manifest.pathDir.trim().length > 0) {
      pathDirRel = join(...manifest.pathDir.split('/'));
    }
  }
  const primaryBin = join(vendorRoot, entrypointRel);
  const legacyBin = join(vendorRoot, 'codex', binName);
  let bin = primaryBin;
  let pathDir = join(vendorRoot, pathDirRel);
  if (!exists(primaryBin)) {
    if (!exists(manifestPath) && exists(legacyBin)) {
      bin = legacyBin;
      pathDir = join(vendorRoot, 'path');
      layoutVersion = 0;
    } else {
      throw new Error(`Pinned Codex binary not found at ${primaryBin}`);
    }
  }
  const vendorPathDirs = exists(pathDir) ? [pathDir] : [];
  return {
    bin,
    vendorPathDirs,
    version: PINNED_CODEX_VERSION,
    layoutVersion,
    targetTriple: target.triple,
    platformPackage: target.pkg,
  };
}

export function createDefaultSdkFactory(
  resolveBin: () => ResolvedCodexBinary = () => resolveCodexBinary(),
  baseEnv?: NodeJS.ProcessEnv,
  anchorUrl?: string | URL,
): SdkClientFactory {
  return (settings: CodexOptions): QueryExecutor => {
    const resolved = resolveBin();
    const rootRequire = createRequire(resolveDefaultAnchorUrl(anchorUrl));
    const sdkPkgJson = resolvePackageJson(rootRequire, '@openai/codex-sdk');
    assertExactPackageVersion('@openai/codex-sdk', sdkPkgJson);
    let sdkModule: {
      Codex: new (opts: Record<string, unknown>) => {
        startThread(opts?: ThreadOptions): ExecutorThread;
        resumeThread(id: string, opts?: ThreadOptions): ExecutorThread;
      };
    };
    try {
      sdkModule = rootRequire('@openai/codex-sdk');
    } catch (err) {
      if ((err as { code?: string })?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        sdkModule = rootRequire(join(dirname(sdkPkgJson), 'dist', 'index.js'));
      } else {
        throw err;
      }
    }
    const baseResolvedEnv =
      settings.env ??
      (baseEnv
        ? Object.fromEntries(
            Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined);
    const resolvedEnv =
      baseResolvedEnv && resolved.vendorPathDirs.length > 0
        ? {
            ...baseResolvedEnv,
            PATH: [
              ...resolved.vendorPathDirs,
              ...(baseResolvedEnv.PATH ? baseResolvedEnv.PATH.split(delimiter) : []),
            ]
              .filter((segment, idx, arr) => Boolean(segment) && arr.indexOf(segment) === idx)
              .join(delimiter),
          }
        : baseResolvedEnv;
    const instance = new sdkModule.Codex({
      codexPathOverride: resolved.bin,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      env: resolvedEnv,
    });
    return {
      startThread: (opts?: ThreadOptions) => instance.startThread(opts),
      resumeThread: (id: string, opts?: ThreadOptions) => instance.resumeThread(id, opts),
    };
  };
}
