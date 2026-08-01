# ZapGram — agent notes

Canonical agent instructions. `CLAUDE.md` is a symlink to this file.

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

## Checks

```bash
bun run ci   # biome + tsc + tests
```

Do not generate drizzle migrations unless the schema intentionally changes. Schema moves must stay byte-identical when only relocating files.

## Style

Biome: single quotes, no semicolons, `bracketSpacing: false`, line width 100.
