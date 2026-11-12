// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { CodexOptions, ThreadOptions } from '../app-server/params.js';
import type { ExecutorThread, QueryExecutor } from './executor.js';

export const PINNED_CODEX_VERSION = '0.142.3';

export type SdkClientFactory = (settings: CodexOptions) => QueryExecutor;

export interface ResolvedCodexBinary {
  bin: string;
  vendorPathDirs: string[];
  version: string;
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
    const rootRequire = createRequire(options.anchorUrl ?? import.meta.url);
    const sdkPkgJson = rootRequire.resolve('@openai/codex-sdk/package.json');
    assertExactPackageVersion('@openai/codex-sdk', sdkPkgJson);
    const sdkRequire = createRequire(sdkPkgJson);
    codexPkgJsonPath = sdkRequire.resolve('@openai/codex/package.json');
    assertExactPackageVersion('@openai/codex', codexPkgJsonPath);
    const codexRequire = createRequire(codexPkgJsonPath);
    platformPkgJsonPath = codexRequire.resolve(`${target.pkg}/package.json`);
    assertExactPackageVersion(target.pkg, platformPkgJsonPath, true);
  }
  const vendorRoot = join(dirname(platformPkgJsonPath), 'vendor', target.triple);
  const binName = platform === 'win32' ? 'codex.exe' : 'codex';
  const bin = join(vendorRoot, 'codex', binName);
  if (!exists(bin)) {
    throw new Error(`Pinned Codex binary not found at ${bin}`);
  }
  const pathDir = join(vendorRoot, 'path');
  const vendorPathDirs = exists(pathDir) ? [pathDir] : [];
  return { bin, vendorPathDirs, version: PINNED_CODEX_VERSION };
}

export function createDefaultSdkFactory(
  resolveBin: () => ResolvedCodexBinary = () => resolveCodexBinary(),
  baseEnv?: NodeJS.ProcessEnv,
  anchorUrl?: string | URL,
): SdkClientFactory {
  return (settings: CodexOptions): QueryExecutor => {
    const resolved = resolveBin();
    const rootRequire = createRequire(anchorUrl ?? import.meta.url);
    const sdkPkgJson = rootRequire.resolve('@openai/codex-sdk/package.json');
    assertExactPackageVersion('@openai/codex-sdk', sdkPkgJson);
    const sdkModule = rootRequire('@openai/codex-sdk') as {
      Codex: new (opts: Record<string, unknown>) => {
        startThread(opts?: ThreadOptions): ExecutorThread;
        resumeThread(id: string, opts?: ThreadOptions): ExecutorThread;
      };
    };
    const resolvedEnv =
      settings.env ??
      (baseEnv
        ? Object.fromEntries(
            Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined);
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
