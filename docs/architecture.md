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
| `src/http/` | Elysia webhook + health route. |
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
2. `settleService.complete` → grant access (idempotent via `settledAt`) → pay owner → fee → notify → delete row.
3. Failures leave the row; cron retries with `MAX_SETTLE_ATTEMPTS` budget.
4. Auto-renew: create row → charge balance → `complete` (same settle path).

## Callback data

All parameterized `callback_data` strings go through `src/telegram/callback-data.ts` (`defineCallback` → `build` / `parse` / `pattern`) so keyboards and handlers cannot drift.
