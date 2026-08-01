FROM oven/bun:1.3-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src src
COPY drizzle drizzle

# SQLite + WAL files live here when DB_URL=/app/data/main.db
RUN mkdir -p /app/data

CMD ["bun", "src/main.ts"]
