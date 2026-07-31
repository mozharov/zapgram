FROM oven/bun:1.3-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src src
COPY drizzle drizzle

USER bun
CMD ["bun", "src/main.ts"]
