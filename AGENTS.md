# ZapGram — agent notes

Canonical agent instructions.

## Agent working files

Local agent artifacts (marketing context, copy drafts, plans, design briefs, audit notes) live under **`.agents/`** (gitignored). Prefer `.agents/` for anything the agent reads or writes as working material.

**On-chain paid chat MVP (in progress):** start at `.agents/onchain-paid-chat-mvp-plan.md` and `.agents/lnbits-satspay-watchonly-api.md`. App Phases 0–3 are largely implemented; remaining work is live LNbits spike + E2E fakes/scenario.

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
