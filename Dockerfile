FROM oven/bun:1-alpine
WORKDIR /app

# git is required for client mode (transport clone/pull/push via Bun.spawn).
# Server mode (RELAY_MODE=server) doesn't use it but ~13MB is acceptable for
# the one-image-two-modes design.
RUN apk add --no-cache git

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/

ENV RELAY_MODE=server

CMD ["bun", "run", "src/index.ts"]
