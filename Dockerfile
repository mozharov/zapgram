FROM oven/bun:1.3-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Required at runtime: Bun resolves the "@core/*", "@infra/*", ... path aliases
# from tsconfig.json. Without it every import in src/ fails to resolve.
COPY tsconfig.json ./

COPY src src
COPY drizzle drizzle

# SQLite + WAL files live here when DB_URL=/app/data/main.db
RUN mkdir -p /app/data

CMD ["bun", "src/main.ts"]
