# v155 M1 Chat / Commands / Unified OctoEgress Spine (`D1-1A`)

## 1. Scope & Decisions (`D1`–`D4`)

- **`D1` (`D1-1A`)**: Implements the unified M1 chat + commands + `OctoEgress` spine in one coherent increment. Scheduled execution is not implemented in this increment: `/cron` is recognized-disabled (`cron.state === 'disabled'`) under cron authority (`O || C`), not unknown.
- **`D2` (Additive Source Configuration Schema)**:
  - `commands.managers: string[]` (default `[]`).
  - `cron.managers?: string[]` (inherits `commands.managers` when absent; explicit `[]` disables inheritance).
  - `runtime.{chatTurnCeilingMs,laneMaxQueued,interruptConfirmMs,recycleDrainMs}` with accepted R8 (`XIN-2050` §3.3.5) and `src/runtime/runtime.ts:53-56` defaults (`Math.min(7_200_000, Math.max(1_800_000, 3 * dispatchTimeoutMs))` = `1_800_000` at default `dispatchTimeoutMs = 300_000`, `3`, `10_000`, `120_000`) and bounds (`[60_000..7_200_000]`, `[1..10]`, `[1_000..60_000]`, `[0..600_000]`).
  - `egress.keyMode: 'random'` (default `'random'`; per-logical-segment UUID reused across HTTP 429 retries; deterministic keys remain deferred to `SO-17` / cron).
  - `sdk.codexHomeSharedOptIn: boolean` preserves whether an explicit `sdk.codexHome` was configured before deriving `<botRoot>/codex-home`.
- **`D3` (Executor Default & M1 Parity)**:
  - Preserves accepted R8 `'app-server'` default executor (`CODEX_OCTO_EXECUTOR=sdk` remains an explicit rollback lever and disables cron with `disabledReason: 'executor-sdk'`).
  - Enforces M1 command/addressing/copy and `OD-07/09/15/33b/35/36/37/38` effects with the six concrete `DEV-06` corrections.
- **`D4` (Provenance & Offline Harness)**:
  - Expands semantic host overlays from `7 -> 10` (`index`, `gateway`, `bot-manager`, `agent-bridge`, `session-router`, `session-store`, `db-adapter`, plus `commands`, `stream-relay`, `config`), with `0` overlays in `src/octo/**`.
  - Resolves the lockfile-pinned `@openai/codex@0.142.3` binary via `createRequire` anchored at `@openai/codex-sdk/package.json` (`src/runtime/codex-binary.ts`).

## 2. Startup, Authority & Lifecycle (`src/host/index.ts`, `src/runtime/chat-issuer.ts`, `src/runtime/octo-egress.ts`)

1. `OctoEgress`, `ChatTurnIssuer`, and `createHostCaller` are constructed **after** `await gateway.register()` succeeds and **before** `gateway.connect(...)`.
2. `configBotId` (`config.botId ?? ''`) remains the startup ownership/DB tuple; `registeredRobotId` (`gateway.getBotUid()`) is the live registered robot identity and is never silently substituted by `configBotId`.
3. `ChatTurnIssuer` and `OctoEgress` carry `WeakSet` constructor brands (`assertChatTurnIssuer`, `assertOctoEgress`). Callers cannot forge `ready` flags or substitute unbranded objects.
4. `ChatTurnIssuer.prepare(input, scope)` re-verifies startup ownership, caller liveness, `registeredRobotId` continuity across token refresh, captured generation `G`, and `OctoEgress` liveness at both prepare and precommit (`assertCurrent`) boundaries.
5. Post-register setup failure collects runtime/execution work and ownership effects, ends the incarnation, closes SQLite, and releases ownership last via `BotStartupCleanupError`.

## 3. Admission, Addressing, Commands & Queue-Bypass Reset (`src/host/session-router.ts`, `src/host/commands.ts`)

1. **Pre-completion admission**: Channel/stream/event filters, passive group cache, rate and 32KB size gates, `T24` compound-DM filter (`channel_id` containing `@` whose `@`-split parts omit `registeredRobotId`), `E > B > F > U` classification, and slash-command evaluation execute before `execution.withCompletion`.
2. **Mention & fallback rules**:
   - `I5`: `payload.mention.entities` uid match precedes `is_mention_me`.
   - `I6`: `type === 'all' || type === 'humans'` suppresses `ais` unless `entities` explicitly contains `registeredRobotId`.
   - `I7`: Only strict boolean `true` or number `1` counts as a true mention flag (`"1"`, `"true"`, `{}` are ignored).
   - `I8`/`I14`: CJK-safe `@BotName` fallback runs only when `payload.mention` is absent, and strips only this bot's leading entity while preserving non-bot `@alice` text.
3. **Authority & precedence**:
   - `O`: non-empty live `ownerUid` match (`""` is `O=false`).
   - `S`: `commands.managers`.
   - `C`: `cron.managers ?? commands.managers`.
   - Precedence: `U (DROP) -> DENY -> ADDRESS -> command.disabled -> EXEC`. Unauthorized `B` is `DENY`; authorized `B` is `ADDRESS` every time (no 60s suppression).
4. **Queue-bypass `/reset` and `/new`**:
   - Raw or own-mention-cleaned `/reset` and `/new` bypass router session locks and `HostCompletionQueue` while keeping admission and `OwnerAuthZ`.
   - Unauthorized reset performs zero SQLite/generation changes and zero cancellations.
   - Authorized reset calls `execution.resetSession`: atomically commits `G -> G + 1` and clears session/history/map/signature first, then cancels active/queued older-generation work, clears in-memory backfill state, and sends the reset acknowledgement + read receipt.

## 4. Outbound Chokepoint & Delivery Semantics (`src/runtime/octo-egress.ts`, `src/host/stream-relay.ts`)

- **`O4`**: Multi-message `agent_message` outputs are joined with `'\n\n'` for both outbound delivery and `turnState.assistant(...)`.
- **`O14`**: Typing starts only at actual lane dispatch (`completion.onDispatch`) and stops immediately on completion, error, or dispatch timeout.
- **`O15`**: `sendReadReceipt` requires target `channelId` and `channelType`, sends `{ channel_id, channel_type, message_ids }` on `POST /v1/bot/readReceipt`, and runs only after confirmed outbound delivery (never on `U=DROP`, suppressed `NO_REPLY`, synthetic `nomid:*` IDs, or unconfirmed/failed output).
- **`O16`**: Once `>= 1` `chat.reply` segment is confirmed delivered, generic `chat.error` and `chat.stream_interrupt` notices are suppressed.
- **`O17`**: Empty assistant text + failed tool item emits `StringCatalog.chatToolFailure(kind)`.
- **`O18`**: Exact trimmed `NO_REPLY` is silently suppressed with no outbound message, no read receipt, and no `'NO_REPLY'` assistant history row; empty text without tool failure emits `StringCatalog.chatPlaceholder()`.
- **`O19`**: Tool progress emits at most `10` messages per turn, deduplicated by `item.id`.
- **`[AUDIT]`**: Command execution and denials emit `[AUDIT] ts=<iso> bot=<id> actor=<uid> action=<command|deny> target=<session> outcome=<ok|denied> detail=cmd=/<name>,reason=<outcome>,role=<role>,addr=<addressing>` with zero secret identifiers.
