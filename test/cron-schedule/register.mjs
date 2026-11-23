// SPDX-License-Identifier: Apache-2.0
// Native source-only test resolution; compiled consumers use emitted .js files.
import { registerHooks } from 'node:module';
const scope = new URL('../../src/cron/schedule/', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(scope) && specifier.startsWith('./') && specifier.endsWith('.js')) {
    return nextResolve(specifier.slice(0, -3) + '.ts', context);
  }
  return nextResolve(specifier, context);
} });
