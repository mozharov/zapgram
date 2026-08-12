# ZapGram architecture

## Layers

```
core      → (nothing)
config    → core
infra     → core, config
modules   → core, infra, config
telegram  → modules, core, infra, config
http      → telegram, infra, config
jobs      → modules, infra, config
bootstrap → everything
runtime   → bootstrap types (handle set by bootstrap)
```

| Layer | Responsibility |
|---|---|
| `src/core/` | Pure domain: money, subscription policy/grant, payout-state, AppError. Zero I/O. |
| `src/config/` | Env schema + `createConfig()`. No process.exit. |
| `src/infra/` | Adapters: SQLite, LNbits HTTP, NWC, Telegram Bot shell, logger, tunnel. |
| `src/modules/` | Vertical slices (wallet, invoices, chats, subscriptions, tipping). |
| `src/telegram/` | grammY presentation: context, composition, middlewares, i18n, callback-data. |
| `src/http/` | Elysia routes: Telegram webhook, LNbits payment webhook, health. |
| `src/jobs/` | Batch runner + cron scheduler. |
| `src/bootstrap/` | Composition root: container, createApp, configureBot. |
| `src/runtime.ts` | Process-wide handle published by bootstrap for leaf handlers/jobs. |

## Dependency rule

Enforced by Biome `noRestrictedImports` overrides and `test/architecture/layers.test.ts`.

**Forbidden:**

- `core` → any other app layer
- `infra` → `modules` / `telegram` / `http` / `jobs` / `bootstrap`
- `modules` (services, repositories, jobs) → `telegram` / `http` / `jobs` / `bootstrap`

**Allowed exception:** co-located UI under `modules/*/telegram/**` may import `@telegram/*` (context, i18n helpers, keyboards). Those leaves may also call `getRuntime()` from `src/runtime.ts` (set only by bootstrap) — a deliberate service-locator for presentation glue, not a DI container.

## Where to put new code

| Change | Place |
|---|---|
| Pure money / policy rule | `src/core/…` + unit test |
| New env variable | `src/config/schema.ts` + `createConfig` consumers |
| External API / DB table access | `src/infra/…` or `modules/*/repository.ts` |
| Business use-case (settle, renew, tip) | `modules/<feature>/*.service.ts` |
| Telegram UI / handlers | `modules/<feature>/telegram/` + `register.ts` |
| Cron work | `modules/<feature>/jobs/` + entry in `jobs/scheduler.ts` |
| Wire dependencies | `bootstrap/container.ts` only |

## Design decisions (intentional)

| Decision | Why |
|---|---|
| **No `Result<T,E>`** | Keep `throw` + grammY `errorBoundary` and existing status unions (`settled`/`kept`, `RenewalOutcome`). |
| **No domain entities / VOs / mappers** | Six flat tables; Drizzle `$inferSelect` types are enough. Business rules are pure functions. |
| **No DI container library** | Factories (`createX`) + composition root. `runtime` is only a published handle for leaves. |
| **No branded IDs (for now)** | Would touch every signature; can be added later for `Sats`/`Msats`. |
| **Single settle path** | Auto-renew hands off to `settleService` — no duplicated payout/notify logic in cron. |

## Money path (subscriptions)

1. Invoice paid → `subscription_payments` row exists.
2. Detection is push-first: LNbits POSTs `${HOST}/lnbits/webhook/${BOT_WEBHOOK_SECRET}` (secret in path). Cron (`check-subscription-payments`) is the fallback.
3. `settleService.complete` → grant access (idempotent via `settledAt`) → pay owner → fee → notify → complete row.
4. Failures leave the row; cron retries with `MAX_SETTLE_ATTEMPTS` budget.
5. Auto-renew: create row → charge balance (then NWC if unpaid) → `complete` (same settle path).

## Money path (receive invoices)

1. User mint → `pending_invoices` row + LNbits invoice created with the same payment webhook URL.
2. Paid → claim row (delete returning) then notify. Claim is shared by LNbits webhook, internal bot pay (`paying-invoice`), and `check-pending-invoices` cron so internal→internal cannot double-notify.
3. Tips/transfers mint invoices without a pending row; they notify via their own path (`notifySatsReceived`). A webhook for those hashes is a no-op.

## Group messages

The group tip trigger is matched per update by `matchTipRequest`
(`src/modules/tipping/telegram/tip-match.ts`), not by a `hears` regex: clients send
`/tip@this_bot` in every chat that holds more than one bot, and the addressee has to be compared
against `ctx.me.username` rather than a baked-in name. `/tip@other_bot` belongs to that bot and is
ignored silently; a bare `@this_bot` mention is the same trigger as `/tip`.

`/tip` is registered for `all_group_chats` with `is_ephemeral: true`, so the command a member types
is delivered to the bot but stays invisible to the rest of the group and to other bots. Such an
update arrives with `message_id: 0` and an `ephemeral_message_id`, and there is nothing to clean up
— `deleteMessageSafely` returns early for it instead of calling `deleteMessage` on id 0. The
`@zap_gram_bot 21` spelling is not a registered command, so it stays public and is still deleted.

Only a successful money movement earns a public message in a group (`notifyGroupTip`). Every
failure and usage hint goes through `replyOnlyToSender` (`src/telegram/helpers/ephemeral-message.ts`),
which sends a Telegram ephemeral message (`receiver_user_id`): the rest of the group never sees it
and Telegram expires it, so no delete follows. Anonymous admins and channel-post senders have no
user to deliver to, so a refused send falls back to `replyWithTempMessage` — the public notice that
`TEMP_MESSAGE_DELAY_MS` later deletes itself.

## Callback data

All parameterized `callback_data` strings go through `src/telegram/callback-data.ts` (`defineCallback` → `build` / `parse` / `pattern`) so keyboards and handlers cannot drift.

## Logging

The unit of logging is the **interaction**, not the HTTP request. `POST /bot - 4ms` repeated per
update says nothing, so the transport line lives at `debug`
(`src/http/middlewares/request-logger.ts`) and the meaningful record is written one layer down.

- **Correlation.** The HTTP layer mints `reqId`, stamps it on the Telegram update body, and
  `src/telegram/middlewares/logger.ts` builds `ctx.log` as a child logger carrying
  `reqId` + `describeUpdate(ctx)` (`action`, `updateId`, `chatId`, `chatType`, `userId`,
  `callbackData`, `command`). Every line written while handling that update inherits them, so no
  handler has to repeat who/what it is working on.
- **One outcome line per update.** `Update handled` (info, with `ms`) or `Update failed` (warn,
  with `ms`; the error itself comes from the error boundary). Updates the bot ignores — group
  chatter, other bots' commands — stop at `debug` and never reach info.
- **`action` matches the PostHog event name** (`command_wallet`, `callback_pay_onchain`, …) so a
  log line and the analytics event for the same interaction are searchable under one name.
- **What else gets an info line:** state changes (chat price / paid access / payment type /
  on-chain enable-disable, NWC connect-disconnect, donation settings), money movements (invoice
  minted and paid, tip sent, join invoice minted / reused / paid, settle and payout), and every
  webhook outcome. Read-only screens rely on the per-update line alone.
- **Levels.** `error` = we are broken. `warn` = someone else is broken or a request was rejected
  (bad webhook secret, unhandled callback, unreachable user). `info` = a fact worth reconstructing
  later. `debug` = transport and timing detail.
- **Never log:** raw message text, NWC URLs, admin keys, or whole `ctx.user` / wallet objects —
  the user's NWC secret lives on that row. Log ids, amounts, and lengths instead.
