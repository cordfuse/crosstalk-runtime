# TODO

## Resume here — local relay verified, ready to commit (paused for lunch 2026-05-11)

**Goal of the session:** stand up the relay server locally on `steve-cachyos`, smoke-test WSS + HTTP REST, then move to Render-hosted deployment from the same repo.

**Status: local relay is built, running, fully smoke-tested. One real bug discovered + fixed mid-session. Nothing committed yet.**

---

### What's done

**Post-reboot sanity (all clean):**
- All 7 `unless-stopped` containers (caddy, open-webui, anythingllm, bc-mcp-core, cors-proxy, mighty-ai-qr-web, portainer) came back automatically after reboot
- Kernel `7.0.3-1-cachyos` and docker `29.4.2` confirmed live (was 6.18.9 / older)
- `docker run --rm hello-world` ran cleanly — no `Yunix` shim error

**Repo edits (all on disk, none committed):**

- `Dockerfile` — removed `EXPOSE 8080`. Port fully env-driven via `PORT` (read in `src/config.ts:51`). `RELAY_MODE=server` stays baked in so the same image runs locally and on Render.
- `docker-compose.yaml` — **new file** in repo root. Builds Dockerfile, joins external network `proxy_net`, container name `crosstalk-relay`, sets `PORT=3003`, publishes host port `3003:3003` for direct `ws://localhost:3003` access. `RELAY_SECRET` and `WEBHOOK_SECRET` empty for first-run open-mode smoke test.
- **`src/index.ts` — server-mode short-circuit fix (real bug, not config).** First `docker compose up` revealed the runtime-only setup (`loadRegistry`, `watchRegistry`, `startWatcher`, startup scan, `announceOnline`) was running unconditionally — even when `loadConfig()` correctly returned `transport: ''` for server mode. Container crash-looped on `watch('channels')` ENOENT. Fix: wrapped runtime-only path in an `else` branch; server mode now goes `loadConfig` → `startRelayServer` → SIGINT handler → idle on `Bun.serve`. **Render deployments will need this same fix** — server mode never worked end-to-end before.
- `CLAUDE.md` — added "Local development on steve-cachyos" block under v0.4 config example showing both `wss://crosstalk-relay.linux.internal` (via Caddy) and `ws://localhost:3003` (direct). Swapped `relay.crosstalk.dev` → `relay.crosstalk.sh` (`crosstalk.sh` registered via Namecheap on 2026-05-11; tracked in librarian `DOMAINS.md`).
- `PLAN.md` — corrected stale "separate repo: `cordfuse/crosstalk-relay`" framing to "in-repo: `src/relay-server.ts`". Same `.dev` → `.sh` domain swap. Added local-dev port note.
- Caddy route (out of this repo): `~/Repos/steve-krisjanovs/caddy/Caddyfile` route #10 added — `crosstalk-relay.linux.internal` → `crosstalk-relay:3003` (HTTPS via `tls internal` + HTTP fallback). README table updated. AdGuard DNS already resolves the hostname → `192.168.0.104` (steve-cachyos).

---

### Smoke tests — all PASS

| Test | Endpoint | Result |
|------|----------|--------|
| HTTP `/health` direct | `http://localhost:3003/health` | `200 {"status":"ok","clients":0}` |
| HTTP `/health` via Caddy | `http://crosstalk-relay.linux.internal/health` | `200 {"status":"ok","clients":0}` |
| HTTPS `/health` via Caddy (TLS internal) | `https://crosstalk-relay.linux.internal/health` | `200 {"status":"ok","clients":0}` |
| WSS connect direct | `ws://localhost:3003/ws` | server sent `{"type":"ready"}` |
| WSS connect via Caddy | `wss://crosstalk-relay.linux.internal/ws` (CA bypass for test) | server sent `{"type":"ready"}` |
| Webhook → broadcast end-to-end | POST `/webhook` (open mode, no `WEBHOOK_SECRET`) → connected WS client | client received `{"type":"notify","repo":"cordfuse/crosstalk-demo-test","event":"push","sha":"deadbeef..."}` |

Open-mode auth path (no `RELAY_SECRET`, no `WEBHOOK_SECRET`) is fully exercised. **Authenticated paths NOT tested yet** — see open questions.

---

### Resume after lunch

**Commit plan (decided 2026-05-11 pre-lunch):** individual commits per logical change. Sequence in `cordfuse/crosstalk-runtime`:

1. **Commit 1 — `fix(index): short-circuit runtime-only setup in server mode`**
   - File: `src/index.ts`
   - Standalone bug fix. Server mode never started cleanly before — runtime/registry/watcher/announce all ran unconditionally and crashed on missing transport. Now wrapped in `else` for client mode.

2. **Commit 2 — `chore(config): default relay port 8080 → 3003`**
   - File: `src/config.ts`
   - Eliminates dead-code default. Local and Render both override via `PORT` env anyway, but the in-code default now matches the canonical port the relay listens on.

3. **Commit 3 — `feat(v0.4): dockerize relay server for local + Render deploy`**
   - Files: `Dockerfile`, new `docker-compose.yaml`, `CLAUDE.md`, `PLAN.md`, this `TODO.md`
   - The v0.4 dockerization ship. `Dockerfile` drops `EXPOSE`, compose joins `proxy_net` and binds host `3003:3003`, docs cover the local-dev path through Caddy or direct.

Then in `~/Repos/steve-krisjanovs/caddy/` (separate repo):

4. **Commit 4 — `caddy: add crosstalk-relay.linux.internal route`**
   - Files: `Caddyfile`, `README.md`
   - Caddyfile route #10 (HTTPS via `tls internal` + HTTP fallback) and README table row.

**Then: Render deployment.**

Steve approved `render.yaml` in repo root over dashboard-only config (recommended for IaC reproducibility, secret hygiene unchanged either way, mighty-ai-qr-web already on Render so the pattern compounds).

5. **Commit 5 — `feat: render.yaml blueprint for relay.crosstalk.sh`**
   - File: new `render.yaml` in repo root
   - Same Dockerfile/image. Render injects `PORT` / `RELAY_SECRET` / `WEBHOOK_SECRET` via its own env config (set in Render dashboard, not committed). Maps `relay.crosstalk.sh` (Namecheap) to the Render service hostname via DNS CNAME.

---

### Open questions held over

- **Production secrets** — `RELAY_SECRET` and `WEBHOOK_SECRET` values, generated where, stored where. Right now both empty in `docker-compose.yaml` (open mode = first-run smoke only). Auth-mode WSS handshake + signed-webhook paths still untested locally — worth exercising before Render rollout.
- **Stale YAML-style config examples in `CLAUDE.md` (lines 74-85)** — actual config format is TOML (`~/.crosstalk/config.toml`, `smol-toml` parser). My local-dev addition inherited the staleness — clean both up in a follow-up doc pass.
- **Sweep stale `relay.crosstalk.dev` → `relay.crosstalk.sh`** in operator-facing `cordfuse/crosstalk` repo: `TODO.md`, `CLAUDE.md`, `ROADMAP.md` still reference `.dev`. Separate commit in that repo when convenient.
