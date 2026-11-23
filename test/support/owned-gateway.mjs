// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OctoGateway } from '../../src/host/gateway.js';
import { BotStartupOwnership } from '../../src/runtime/bootstrap.js';

export async function ownedGateway(input, registerCleanup) {
  const dataDir = mkdtempSync(join(tmpdir(), 'x-buddy-gateway-'));
  const config = { ...input, botId: input.botId ?? 'gateway-test', dataDir };
  let ownership;
  try {
    ownership = await BotStartupOwnership.acquire(dataDir, config.botId);
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const gateway = new OctoGateway(config, { ownership, handleSignals: false });
  registerCleanup(async () => {
    try {
      await gateway.stop();
      ownership.release();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  return gateway;
}
