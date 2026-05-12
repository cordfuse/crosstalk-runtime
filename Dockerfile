FROM node:20-alpine
WORKDIR /app

# git is required for client mode (transport clone/pull/push via child_process.spawn).
# Server mode (RELAY_MODE=server) doesn't use it but ~13MB is acceptable for
# the one-image-two-modes design.
#
# python3 + make + g++ are required at install time to build @homebridge/node-pty
# from source on Alpine (no darwin-style prebuild exists; node-gyp source-builds
# the native PTY module). They could be moved into a multi-stage build later
# to shrink the final image.
RUN apk add --no-cache git python3 make g++

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.build.json

ENV RELAY_MODE=server

CMD ["node", "dist/index.js"]
