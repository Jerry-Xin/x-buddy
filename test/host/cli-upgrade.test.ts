// SPDX-License-Identifier: Apache-2.0
// Derived from Mininglamp-OSS/codex-channel-octo@dd1298083d01 src/__tests__/cli-upgrade.test.ts; changes: spdx-header, change-notice, import-path.
import { describe, it, expect } from 'vitest';
import { buildUpgradeArgs } from '../../src/host/cli.js';

describe('buildUpgradeArgs', () => {
  it('builds npm args for an explicit version', () => {
    expect(buildUpgradeArgs('1.2.3')).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/codex-channel-octo@1.2.3',
    ]);
  });

  it('falls back to @latest when no version is given', () => {
    expect(buildUpgradeArgs()).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/codex-channel-octo@latest',
    ]);
  });

  it('treats blank/whitespace version as latest', () => {
    expect(buildUpgradeArgs('   ')).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/codex-channel-octo@latest',
    ]);
  });

  it('accepts a prerelease/build-metadata semver', () => {
    expect(buildUpgradeArgs('1.2.3-rc.1+build5')).toEqual([
      'install',
      '-g',
      '@mininglamp-oss/codex-channel-octo@1.2.3-rc.1+build5',
    ]);
  });

  it('rejects a version with shell metacharacters (injection guard)', () => {
    expect(() => buildUpgradeArgs('1.2.3; rm -rf /')).toThrow();
    expect(() => buildUpgradeArgs('$(whoami)')).toThrow();
    expect(() => buildUpgradeArgs('1.2.3 && curl evil')).toThrow();
  });
});
