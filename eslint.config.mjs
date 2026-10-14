// SPDX-License-Identifier: Apache-2.0
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' } } },
  {
    // Adversarial analyzer fixtures intentionally erase types with `any`, keep
    // write-once `let` bindings and dead stores, and merge a namespace into a
    // function. They must still compile cleanly: the analyzer reports any
    // compiler error in its closure as UNKNOWN.
    files: ['test/fixtures/egress/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-namespace': 'off',
      'prefer-const': 'off',
      'no-useless-assignment': 'off',
    },
  },
];
