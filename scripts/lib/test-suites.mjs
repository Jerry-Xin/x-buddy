// SPDX-License-Identifier: Apache-2.0
export const CORE_GLOBS = [
  'test/*.test.mjs',
  'test/foundation/**/*.test.mjs',
  'test/app-server/**/*.test.mjs',
  'test/runtime/**/*.test.mjs',
  'test/transport/**/*.test.mjs',
];

// These suites use the fail-closed caller harness and must never inherit
// developer credentials or use the real installed SDK.
export const PROVENANCE_SUITE = 'test/integration-checks.test.mjs';
export const GUARDED_SUITES = [
  'test/runtime/chat-spine.test.mjs',
  'test/runtime/persistence.test.mjs',
  'test/runtime/runtime.test.mjs',
  'test/runtime/sdk-refusal.test.mjs',
];
