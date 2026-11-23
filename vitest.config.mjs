// SPDX-License-Identifier: Apache-2.0
// Host suites imported from codex-channel-octo@dd12980 (see docs/host-baseline).
// The node:test suites under test/*.test.mjs, test/foundation and test/app-server
// run through `npm test`; vitest only collects the host tree.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/host/**/*.test.ts'],
  },
});
