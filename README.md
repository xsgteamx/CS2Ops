# CS2Ops

Lightweight Counter-Strike 2 RCON administration panel.

CS2Ops keeps the original browser-based RCON workflow, adds a cleaner bilingual dashboard, and supports three live log modes:

- `docker`: read local CS2 container logs with `docker logs -f`
- `http`: receive CS2 logs through `logaddress_add_http`
- `none`: disable live logs while keeping RCON features available

Simplified Chinese documentation: [README_ZH.md](README_ZH.md)

## What It Does

- Browser dashboard protected by login session cookies, with Basic Auth fallback
- RCON console for arbitrary CS2 commands
- CVAR presets for match, economy, and practice workflows
- Standard map switching and Workshop map launch by ID
- Browser-local Workshop favorites
- Player list, search, kick action, and SteamID64 detection from logs
- Live log viewer powered by Server-Sent Events
- Docker log source, HTTP remote log receiver, or no-log mode

CS2Ops is not a full game-server deployment panel. It does not manage CS2 installation, Docker containers, or host-level orchestration.

## Architecture

```text
Browser
  -> CS2Ops Express panel
  -> RCON
  -> CS2 dedicated server
```

Live logs can come from either local Docker logs:

```text
CS2 Docker container -> docker logs -f -> LogHub -> /api/logs/stream
```

or CS2 HTTP remote logs:

```text
CS2 server -> logaddress_add_http -> HTTP log receiver -> LogHub -> /api/logs/stream
```

HTTP remote logs are useful when CS2 runs on a LAN machine or appliance, while CS2Ops runs on a VPS that must not access the CS2 host Docker socket.

## Requirements

- Node.js 18+ recommended
- npm
- A reachable CS2 dedicated server with RCON enabled
- Optional for `LOG_SOURCE=docker`: local Docker access to the CS2 container
- Optional for `LOG_SOURCE=http`: a TCP port reachable by the CS2 server

## Installation

```bash
git clone https://github.com/xsgteamx/CS2Ops.git
cd CS2Ops
npm install
cp env.example .env
```

Edit `.env` before starting.

```bash
npm start
```

Default panel URL:

```text
http://127.0.0.1:8080
```

## Configuration

Minimal panel and RCON settings:

```env
PANEL_PORT=8080
PANEL_BIND_HOST=127.0.0.1
PANEL_USER=admin
PANEL_PASS=change_me
PANEL_SESSION_SECRET=change_me_long_random_session_secret

CS2_HOST=127.0.0.1
CS2_PORT=27015
CS2_RCON_PASSWORD=change_me
```

Choose one live log source:

```env
LOG_SOURCE=docker
LOG_SOURCE=http
LOG_SOURCE=none
```

Common log settings:

```env
LOG_LINES=200
LOG_TTL_MS=3600000
```

## Docker Log Mode

Use this when CS2Ops can access the same Docker host as the CS2 container.

```env
LOG_SOURCE=docker
DOCKER_CONTAINER=cs2-dedicated
```

CS2Ops starts one shared log follower:

```bash
docker logs -f --tail <LOG_LINES> <DOCKER_CONTAINER>
```

It does not start one Docker process per browser tab.

## HTTP Remote Log Mode

Use this when the CS2 server can reach CS2Ops over HTTP, but CS2Ops cannot or should not access Docker on the CS2 host.

```env
LOG_SOURCE=http
LOG_HTTP_BIND_HOST=0.0.0.0
LOG_HTTP_PORT=27500
LOG_HTTP_PATH=/cs2log
LOG_HTTP_SECRET=change_me_long_random_token
LOG_HTTP_PUBLIC_URL=http://10.6.0.2:27500/cs2log/change_me_long_random_token
LOG_HTTP_MAX_BODY=64kb
LOG_HTTP_ALLOW_IPS=
LOG_HTTP_RCON_REGISTER=true
```

`LOG_HTTP_PUBLIC_URL` is the exact URL written into CS2 through RCON. The panel only shows a masked version and never exposes the full secret to the frontend.

Health check:

```bash
curl http://127.0.0.1:27500/healthz
```

Manual log post test:

```bash
curl -v -X POST \
  --data-binary 'hello from cs2' \
  http://127.0.0.1:27500/cs2log/<secret>
```

Expected result:

- HTTP status `204`
- The log line appears in the panel
- `/api/logs/status` reports an updated `lastReceivedAt`

## Register HTTP Logs Through RCON

When `LOG_SOURCE=http` and `LOG_HTTP_RCON_REGISTER=true`, click **Enable push** in the log panel.

CS2Ops runs:

```text
log on
logaddress_delall_http
logaddress_add_http "<LOG_HTTP_PUBLIC_URL>"
mp_logdetail 3
logaddress_list_http
```

`mp_logdetail 3` is best-effort. If it fails, the registration can still succeed.

To unregister, click **Disable push**. CS2Ops runs:

```text
logaddress_delall_http
logaddress_list_http
```

It does not run `log off`, so local server logging is not disabled.

## No-Log Mode

```env
LOG_SOURCE=none
```

This disables both Docker and HTTP live logs. RCON, CVARs, maps, Workshop maps, and player actions continue to work.

## Security Notes

- Keep `.env` private.
- Do not expose `CS2_RCON_PASSWORD`.
- Do not expose `LOG_HTTP_SECRET`.
- The HTTP log receiver does not use Basic Auth because CS2 cannot send Basic Auth headers for `logaddress_add_http`.
- Protect the HTTP receiver with a long URL secret, firewall rules, and optionally `LOG_HTTP_ALLOW_IPS`.
- Use HTTPS in front of the panel when exposing it publicly.
- Prefer binding the panel to `127.0.0.1` behind a reverse proxy.

## Reverse Proxy Notes

CS2Ops itself listens on `PANEL_BIND_HOST:PANEL_PORT`. You can place Nginx, Apache, Caddy, or another reverse proxy in front of it.

Make sure Server-Sent Events are not buffered for:

```text
/api/logs/stream
```

If you deploy under a subpath such as `/admin/`, ensure the proxy forwards static assets, API routes, login, logout, and SSE consistently.

## Useful Endpoints

Panel:

```text
GET  /
GET  /login
POST /login
POST /logout
```

RCON and dashboard:

```text
POST /api/command
POST /api/cvar
GET  /api/maps
POST /api/map/standard
POST /api/map/workshop
GET  /api/players
GET  /api/autocomplete
```

Logs:

```text
GET  /api/logs/stream
GET  /api/logs/status
POST /api/logs/register-http
POST /api/logs/unregister-http
POST /api/logs/test
```

HTTP receiver:

```text
GET  /healthz
POST <LOG_HTTP_PATH>/<LOG_HTTP_SECRET>
```

## systemd Example

For `LOG_SOURCE=http` or `LOG_SOURCE=none`, do not require Docker:

```ini
[Unit]
Description=CS2Ops Web RCON Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/CS2Ops
EnvironmentFile=/opt/CS2Ops/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
User=cs2ops

[Install]
WantedBy=multi-user.target
```

For `LOG_SOURCE=docker`, the service account must be allowed to read Docker logs, and you may add Docker ordering if appropriate.

## Development Checks

```bash
node --check server.js
node --check public/app.js
npm start
```

Manual log-mode checks:

- `LOG_SOURCE=none`: panel starts, RCON works, no Docker/HTTP receiver required
- `LOG_SOURCE=http`: HTTP receiver starts, test POST reaches the panel
- `LOG_SOURCE=docker`: local Docker log follower writes to the panel

## License

MIT.
