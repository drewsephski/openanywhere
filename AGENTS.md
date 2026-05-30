# AGENTS.md — openanywhere

Companion daemon that makes OpenCode reachable from any device via Tailscale's encrypted mesh network. Single-file TypeScript daemon + static HTML marketing/docs. By vaultzero.dev.

## Architecture

- **Daemon** (`daemon/src/index.ts`) — single file, runs as a long-lived process. Launches `opencode serve` as a child, starts an auth proxy, displays QR codes.
- **Auth proxy** — HTTP server (Node `http` module, no framework) listening on `0.0.0.0` with a random port. Enforces password + session token auth before proxying to OpenCode.
- **Tailscale** — the proxy binds to `0.0.0.0` so it's reachable via the machine's Tailscale IP. No port forwarding, no public internet exposure.
- **Data dir** — `~/.local/share/openanywhere/` (password, token, daemon.pid, daemon.log, proxy-port).

## Build & dev

```bash
# Install deps
cd daemon && bun install

# TypeScript compile (then run with node)
cd daemon && npm run build    # tsc → dist/
cd daemon && npm run dev      # tsc && node dist/index.js

# Production binary (used by CI)
bun build --compile ./daemon/src/index.ts --outfile openanywhere
```

- Dev uses `tsc` (not `bun build`). CI uses `bun build --compile` for standalone binaries.
- The `openanywhere` binary at the repo root is **gitignored** (`.gitignore` explicitly ignores `openanywhere` and `openanywhere-*`).

## Daemon commands

```
openanywhere               # start (default subcommand)
openanywhere start         # start daemon (explicit)
openanywhere stop          # kill running daemon via PID file
openanywhere status        # health check (fetches /health from proxy)
openanywhere url           # print connection URL (Tailscale IP + proxy port + token)
openanywhere password      # print the auth password
openanywhere install-boot  # install macOS LaunchAgent (~/Library/LaunchAgents/)
openanywhere uninstall-boot
```

## Auth model

- 16-char random password generated on first run, stored at `~/.local/share/openanywhere/password` (mode `0600`).
- First connection: URL includes `?t=<token>` query param. The proxy validates it against the stored token file, then sets an HTTP-only session cookie (`oc_session`, 24h TTL).
- Subsequent requests: session cookie checked. If valid, proxy forwards to OpenCode with Basic auth.
- Reset password/token: delete the file from the data dir and restart.
- The auth login page HTML is inlined as the `AUTH_PAGE` constant in `daemon/src/index.ts`.

## Release flow

- Push a `v*` tag (e.g. `v1.0.0`).
- CI builds via `bun build --compile` for `darwin-arm64`, `darwin-x64`, `linux-x64`.
- Creates a GitHub Release with the binaries.
- The `install.sh` script downloads from `https://github.com/drewsephski/openanywhere/releases/latest/download/openanywhere-<os>-<arch>`.

## Static site

- `index.html` (landing page) and `docs.html` (docs) — standalone HTML with inline CSS/JS, no build step.
- Deployed to Vercel (`vercel.json`: `cleanUrls: true`).
- Docs page uses hash-anchor sidebar with scroll spy (no JS framework, vanilla).

## Key gotchas

- **No tests.** There is no test suite, no test config, no test files.
- The repo's GitHub org/repo is `drewsephski/openanywhere` (not "opencode-remote").
- The install script references `vaultzero.dev` domain — the daemon's PLIST label is `com.vaultzero.openanywhere`.
- OpenCode process crash protection: max 5 crashes in 60s → daemon gives up. Must restart manually.
- The daemon also monitors for OpenCode binary updates (checks mtime every 5 min) and restarts if detected.
- The `proxy-port` file in the data dir can be stale — the live port is held in the daemon's `proxyPort` variable. Use `/health` endpoint or `openanywhere status` for the current port.
