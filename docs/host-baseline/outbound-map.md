# Outbound and process truth map (DEV-00)

Sites are classified **only** against the approved R8 text (XIN-2050). This map adds no allowlist, registry entry, scanner waiver or exemption. Where a site's class depends on a policy check, it says so.

Each site is given at its destination line, with the pinned line in parentheses. Every unconfined send listed below keeps **merge and live integration on HOLD** until the DEV-06 egress chokepoint and the security gates clear.

## B5: message or control primitive called outside an egress module

Basis: R8 §1.2 B5 and §3.5.5, which cover send, typing and receipt.

In the v155 M1 chat/commands/egress spine (`D1-1A`), all host/runtime message, typing, and read-receipt outbound calls in `src/host/index.ts`, `src/host/session-router.ts`, and `src/host/stream-relay.ts` are confined to the single branded `OctoEgress` module (`src/runtime/octo-egress.ts`, backed by `OctoApiClient` in `src/transport/api-client.ts`). Both `scripts/check-imports.mjs` and `docs/host-baseline/verify-port.mjs` enforce static `B5` outbound confinement (`0` `sendMessage`, `sendTyping`, or `sendReadReceipt` imports, aliases, or re-exports in `src/host/**` or `src/runtime/**`, and `0` `OctoApiClient` imports outside `src/runtime/octo-egress.ts`).

| Primitive | Pre-v155 DEV-00 Pin Sites (Retired from `src/host/**`) | v155 Chokepoint Site |
|---|---|---|
| `sendMessage` | `src/host/index.ts` (348, 702, 799, 817); `src/host/session-router.ts` (602); `src/host/stream-relay.ts` (261) — `0` direct imports remain | `src/runtime/octo-egress.ts:236` (`OctoEgress.sendSegments` / `sendText` -> `OctoApiClient.request('POST', '/v1/bot/sendMessage', ...)`) |
| `sendTyping` | `src/host/stream-relay.ts` (173, 175) — `0` direct imports remain | `src/runtime/octo-egress.ts:302` (`OctoEgress.sendTyping` / `startTypingLoop` -> `OctoApiClient.request('POST', '/v1/bot/typing', ...)`) |
| `sendReadReceipt` | `src/host/index.ts` (360, 776) — `0` direct imports remain | `src/runtime/octo-egress.ts:332` (`OctoEgress.sendReadReceipt` -> `OctoApiClient.request('POST', '/v1/bot/readReceipt', ...)`) |

## Named R8 §3.5.5 infrastructure exception wording

The exception covers "register/heartbeat/events-ack and upload preparation".

| Primitive | Sites |
|---|---|
| `registerBot` | `src/host/gateway.ts:95` (93), `:358` (356) |
| `sendHeartbeat` | `src/host/gateway.ts:396` (394) |
| `getUploadCredentials` | `src/host/index.ts:343` (219) |

These sites match the exception's wording. Whether the exception actually applies is still a policy check. They are not declared exempt here.

## Outbound primitive module

This module defines the boundary. R8 does not class it as a caller.

| Primitive | Sites |
|---|---|
| `fetch` | `src/octo/api.ts:66` (64), `:166` (164), `:272` (270), `:405` (403) |
| `WebSocket` | `src/octo/socket.ts:392` (390) |

## Not classified by B5: pending policy check

| Site | Note |
|---|---|
| `src/host/url-policy.ts:230` (228) | `fetch` used for SSRF-guarded inbound media, with per-hop redirect re-validation |
| `src/runtime/codex-binary.ts:68` (`src/host/agent-bridge.ts` pre-v147 pin 340) | `new Codex(...)` in explicit `sdk` rollback factory (`AppServerClient` at `src/runtime/host-caller.ts:60` for default `app-server`). B1 and §7 apply. |
| `src/host/cli.ts:399` (398) | `spawn('npm', …)` for `upgrade` (`npm install -g`) |
| `src/host/cli.ts:190` (189), `:271` (270), `:288` (287) | local `ps` and gateway-process spawns |

No site is asserted to be the "same violation" as another without the policy check. Any 2157 scanner run on this tree must report these sites as produced. DEV-00 does not suppress them.

## Read-only Octo API calls through the primitive module

Added after review XIN-2521 (`28de86ad`) so the map lists every caller of `src/octo/api.ts` before DEV-06. B5 does not class reads. This section records sites only; it adds no allowlist, waiver or exemption, and the reads stay subject to the DEV-06 chokepoint like every other call into the primitive module.

| Call | Site |
|---|---|
| `getThreadMd`, `getGroupMd` | `src/host/conversation-md.ts:124` (122) |
| `getChannelMessages` | `src/host/index.ts:1089` (586) |
| `getGroupMembers` | `src/host/group-context.ts:210` (208) |
| `fetchUserInfo` | `src/host/index.ts:280` (v155 startup bot display-name fetch for I8); `src/host/group-context.ts:301` (299) |
| `getMentionPreference` | `src/host/mention-prefs.ts:62` (60) |
| `getGroupMembers` | `src/host/mention-prefs.ts:64` (62) |
