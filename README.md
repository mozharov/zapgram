# ZapGram: Bitcoin Lightning Wallet in Telegram

<div align="center">
  <a href="https://t.me/zap_gram_bot">
    <img src="https://img.shields.io/badge/RUN-Telegram%20Bot-blue?logo=telegram&style=for-the-badge" alt="Run Telegram Bot" width="250">
  </a>
</div>

## Development

```bash
# install
bun install

# typecheck + lint + tests
bun run ci

# local bot (needs .env; HOST must be a public HTTPS URL)
bun run start:dev
```

## Architecture

Layered + vertical slices. See **[docs/architecture.md](./docs/architecture.md)**.

```
core → infra → modules → telegram / http / jobs
                ↑
            bootstrap (composition root)
```

Entry: `src/main.ts` → `createContainer()` → `createApp()` → start / graceful shutdown.

## Stack

Bun, TypeScript, grammY, Elysia, Drizzle (SQLite), LNbits, pino, Biome.
