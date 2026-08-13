# ZapGram — agent notes

Canonical agent instructions.

## Agent working files

Local agent artifacts (marketing context, copy drafts, plans, design briefs, audit notes) live under **`.agents/`** (gitignored). Prefer `.agents/` for anything the agent reads or writes as working material.

**On-chain paid chat MVP:** see `.agents/onchain-paid-chat-mvp-plan.md` and `.agents/lnbits-satspay-watchonly-api.md`. Live-validated on dev; E2E `onchain-join.e2e.test.ts` covers enable → charge → webhook/cron → grant.

## Stack

Bun 1.3, TypeScript 7, grammY, Elysia, Drizzle + bun:sqlite, LNbits, pino, Biome.

## Architecture (must follow)

Dependency rule (lint-enforced):

```
core → ∅
infra → core, config
modules → core, infra, config
telegram / http / jobs → as in docs/architecture.md
bootstrap → everything
```

Do **not** import `@modules/*` from `core` or `infra`. Do **not** import `@http/*` / `@jobs/*` / `@bootstrap/*` from `modules`. Non-UI module code (`*.service.ts`, repositories, jobs) must not import `@telegram/*`. Co-located UI under `modules/*/telegram/**` may use `@telegram/*` and `getRuntime()` from `src/runtime.ts`.

Full write-up: `docs/architecture.md`.

## Composition

- `createContainer()` builds deps and calls `setRuntime(container)`.
- `createApp(container)` registers handlers, HTTP, scheduler.
- `main.ts` only starts and handles signals.
- No module-level singletons for config/db/logger/bot/masterWallet.

## Money code

Preserve idempotency comments in settle/grant/payment repositories verbatim when moving code. Prefer extending `createSettleService` over duplicating payout logic in jobs.

## Callbacks

Use `src/telegram/callback-data.ts` for any new `callback_data` route (`build` + `pattern` + `parse`).

## Living menu (private chat)

Exactly one message in the private chat is a live menu, and exactly one message carries the
"Open wallet" button. `users.last_menu_message_id` and `users.last_notification_message_id` /
`last_notification_base_markup` are the pointers; `notificationChrome`
(`src/telegram/helpers/notification-chrome.ts`) owns all three. Design:
`docs/superpowers/specs/2026-08-12-private-chat-declutter-design.md`.

Two helpers in `src/telegram/helpers/living-menu.ts`, and every menu render must use one of them:

- `showLivingMenu(ctx, send)` — a **new** menu message. Deletes the user's triggering message, the
  previously tracked menu, and the open-menu row on the last notification, then records the new one.
  Commands, the private text fallback, `open-menu`, `cancel`, and a conversation's first prompt.
- `editLivingMenu(ctx, edit)` — an **in-place** repaint of a menu screen. Edits first (a vanished
  message must not cost us the tracked menu), then adopts the clicked message: the previously
  tracked menu is deleted and the pointer moves here. That adoption is what stops a click on an
  orphaned menu from leaving two live menus. When the clicked message was the last notification, its
  notification pointers are cleared — the receipt is a menu now, so nothing may restore its keyboard.

Flow surfaces stay outside **both**: invoice/QR and payment routes (`pay-lightning`, `pay-onchain`,
`pay-subscription`, `pay-join-balance`, `subscription-renew`), every `editHost*` path in
`conversation-host.ts`, `onchain/telegram/edit-status-message.ts`, and the join-request payment
chooser (`chat-join-request.ts`). Adopting them would let the next `/wallet` delete a payment screen
the user is working in.

Every private push goes through `notifier.*` (wrapped by `createChromeNotifier` in the container),
never `bot.api.sendMessage` — that includes bot error messages. The error handler deliberately sends
no wallet screen of its own: the open-menu button on the error message *is* the recovery path.

## Group messages

`/tip` is registered for group chats with `is_ephemeral: true`: the typed command reaches the bot
but no other member sees it. Those updates carry `message_id: 0` + `ephemeral_message_id`.
`deleteMessageSafely` deletes them with `deleteEphemeralMessage` (never `deleteMessage` on id 0).

Only successful money movements are public in a group. Every failure or usage hint goes through
`replyOnlyToSender` (`src/telegram/helpers/ephemeral-message.ts`), which sends a Telegram ephemeral
message (`receiver_user_id`) that only the acting member sees and Telegram expires on its own — so
it is never deleted afterwards. Anonymous admins, send-as channel, and other non-identifiable
senders have no deliverable user: skip ephemeral and use `replyWithTempMessage` (timed delete).

`/tip` (and other attachUser money paths) only debit a real human account. Bots, `sender_chat`
identities (channel / group / anonymous admin), and Group Anonymous Bot raise `FromBotError` with
user-facing copy; recipients may still be a channel/group owner via `getUserFromChatCreator`.

## Dates

Every timestamp a user sees goes through `TGTIME($var, format: "Dt")` in the `.ftl` files
(`src/telegram/i18n/tg-time.ts`), which emits a Telegram `date_time` entity so the client renders it
in the viewer's own timezone. Pass the raw `Date` as the translation variable — never a
pre-formatted string. Fluent's built-in `DATETIME` is banned in locale files and a test enforces it:
it can only render a timezone we choose, and the Bot API exposes no user timezone.

## Logging

Full rules: `docs/architecture.md` → Logging.

- Log the interaction, not the transport. `src/telegram/middlewares/logger.ts` writes one
  `Update handled` / `Update failed` line per update; ignored updates stay at `debug`. Do not add
  per-request info logging at the HTTP layer.
- In handlers/conversations use `ctx.log`; it already carries `reqId`, `action`, `userId`, `chatId`,
  so log only what is new (ids, amounts, outcome). Services take `log` through `deps`; leaf
  jobs/services use `getRuntime().log`.
- Add an info line for every state change and money movement; skip it for read-only screens.
- Never log message text, NWC URLs, LNbits keys, or whole `ctx.user` / wallet objects.
- Inside conversations, log after the last `wait()` or inside `conversation.external` — anything
  else re-runs on every replay.

## Tests

Choose the narrowest test level that still crosses the boundary under test:

| Level | Location | Replaced dependencies | Use for |
|---|---|---|---|
| Unit | Co-located `*.test.ts` | All external dependencies through a `deps` object | Pure logic in `core/**`, policies, and calculations |
| Repository | Co-located `*.test.ts` | Database only, through `createTestDb()` | Queries, filters, and idempotency |
| E2E | `test/e2e/scenarios/*.e2e.test.ts` | Telegram Bot API and LNbits, both over HTTP | Anything that passes through a handler, conversation, or job |

- Build an E2E world only through `createContainer()`. Hand-assembling dependencies misses wiring
  bugs; that is how completely broken private-message routing escaped detection.
- Name scenario files `*.e2e.test.ts`. `bun test` does not discover `*.e2e.ts`.
- `createTestDb()` returns `AppDatabase` directly, not `{db}`.
- Never mock the conversations plugin in tests. `createConversation()` throws without it.
- Fake LNbits in E2E with an HTTP server, not replacement wallet objects. Object replacement
  bypasses `got`, Bottleneck, zod schemas, and 520/404 error mapping.
- Do not replace LNbits wallets with objects above the unit level. The object fake at
  `test/helpers/fakes/lnbits.ts` was removed for this reason. The only live helper in that directory
  is `test/helpers/fakes/notifier.ts`, used by `settle.service` unit tests.
- The LNbits fake must produce real, decodable BOLT11 invoices. Placeholder strings break
  `decodeInvoice` and silently remove assertions.
- NWC cannot be faked over HTTP. It is the only integration where `mock.module` is allowed in E2E.
- Do not call `createApp()` in tests: cron constructs `runOnInit` jobs immediately.
- Do not assert `randomUUID()` values or absolute timestamps. Read generated values from the
  database and compare deltas.
- End every money scenario by asserting exact owner, fee, and duplicate-refund payout counts,
  including the legs that must remain at zero.
- Add every new `callback_data` route to the E2E coverage registry immediately; otherwise CI must
  fail.
- `test/setup.ts` supplies test environment variables through the `bunfig.toml` preload.
  `NODE_ENV=test` must remain in the config enum. On top of that preload, the E2E harness passes a
  complete explicit env object to `createContainer(env)`, including `DB_MIGRATE=true`,
  `BOT_API_ROOT`, `SUBSCRIPTION_FEE_PERCENT`, `CHAT_RIGHTS_DELAY_MS`, and
  `TEMP_MESSAGE_DELAY_MS`.
- UI language uses the valid IETF tag in the update's `from.language_code`; a missing or invalid
  update tag falls back to `users.language_code`, then English. Background notifications use
  `users.language_code` directly. Both paths resolve primary `ru` to Russian and everything else
  to English, so tests must choose the path and stored/update values they exercise.

## Checks

```bash
bun run ci   # biome + tsc + tests
```

Do not generate drizzle migrations unless the schema intentionally changes. Schema moves must stay byte-identical when only relocating files.

## Style

Biome: single quotes, no semicolons, `bracketSpacing: false`, line width 100.
