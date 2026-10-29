// SPDX-License-Identifier: Apache-2.0
import { registerHooks } from 'node:module';
const scope = new URL('../../src/cron/', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const legacyStore = new URL('../../src/host/session-store.ts', import.meta.url).href;
  if ((context.parentURL?.startsWith(scope) || context.parentURL === legacyStore) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    return nextResolve(specifier.slice(0, -3) + '.ts', context);
  }
  return nextResolve(specifier, context);
} });
