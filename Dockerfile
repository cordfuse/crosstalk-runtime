FROM node:20-alpine
WORKDIR /app

# git is required for client mode (transport clone/pull/push via child_process.spawn).
# Server mode (RELAY_MODE=server) doesn't use it but ~13MB is acceptable for
# the one-image-two-modes design.
#
# python3 + make + g++ are required at install time to build @homebridge/node-pty
# from source on Alpine (no Alpine prebuild ships in the npm tarball; node-gyp
# source-builds the native PTY module). They could be moved into a multi-stage
# build later to shrink the final image.
RUN apk add --no-cache git python3 make g++

# Copy ALL build inputs BEFORE npm install so the package's `prepare` script
# (which runs `tsc -p tsconfig.build.json` → `dist/`) has everything it needs:
# tsc itself comes from devDeps (so no --omit=dev), and the source/tsconfig
# must already be in the image when prepare fires.
COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm install --no-audit --no-fund

# Now that dist/ is built and @homebridge's native PTY module is in place,
# drop devDeps to slim the runtime image (typescript + @types/* go away).
RUN npm prune --omit=dev

ENV RELAY_MODE=server

CMD ["node", "dist/index.js"]
