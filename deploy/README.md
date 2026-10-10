# deploy/: production edge

Reverse-proxy configurations that put the whole platform behind **one public
origin**. Use either `Caddyfile` or `nginx.conf`, not both. The wider runbook
(environment, secrets, database roles, migrations, probes, backups, checklist)
is [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

> **Status: unexecuted.** These files were written and reviewed by reading;
> Docker, Caddy and nginx were not available to run them. Before launch, run
> `caddy validate --config deploy/Caddyfile` or `nginx -t`, then the smoke
> tests at the end of this file in staging. `node --test deploy/test/deploy-config.test.mjs`
> (from the repo root) pins the security properties described here.

| File | Purpose |
| --- | --- |
| `Caddyfile` | Edge with automatic certificates. Needs a Caddy built with the `caddy-ratelimit` plugin (see the file header). |
| `nginx.conf` | Same edge for nginx >= 1.25.1; certificates from certbot or your CA. |
| `healthcheck.mjs` | In-container liveness probe used by both Dockerfiles' `HEALTHCHECK`. |
| `test/deploy-config.test.mjs` | Static regression tests for these configs, the Dockerfiles, `.dockerignore` and `docker-compose.yml`. |

## Topology

```
                 internet
                     |
             443/tcp (and 80 for ACME + redirect)
                     |
          +----------v-----------+
          |  edge: Caddy / nginx |   the ONLY host with a public address
          |  TLS, HSTS, limits   |
          +--+----------------+--+
             |                |          private network (VPC / Docker network)
     /, other paths    /api/*, /socket.io/*
             |                |
   +---------v----+   +-------v----------------+      +-------------------+
   | web          |   | API (game server)      |----->| Postgres (managed)|
   | Next.js :3000|   | Express+Socket.io :4000|      | TLS, poker_server |
   +--------------+   +-----------+------------+      +-------------------+
                                  |
                                  +------------------> Redis (rediss://, private)
```

- **One origin.** The browser loads the web app from `https://poker.example.com/`
  and calls the API at `https://poker.example.com/api/...` and Socket.io at
  `https://poker.example.com/socket.io/`. Build the web image with
  `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` both set to that origin,
  and set the API's `CLIENT_ORIGIN` to it as well.
- **WebSockets.** `/socket.io/` is proxied with the HTTP Upgrade handshake and
  long timeouts (a seated player's socket is idle between hands). Socket.io's
  own ping (every 25s) detects dead peers; the proxy timeouts only stop the
  edge from cutting healthy connections.
- **No public app ports.** The web (3000) and API (4000) listen on private
  addresses only. Do not publish them (`ports:` in Compose, a public IP, a
  security-group rule from `0.0.0.0/0`). Set the API's `HOST` to its private
  interface address so it cannot even accept a connection elsewhere. The API
  believes the forwarded headers of its trusted peers (below), so anyone who
  could reach port 4000 directly from a trusted address could claim any client
  IP.
- **Readiness stays private.** `/api/ready` reports dependency state and is
  answered 404 at the edge; probe it from the orchestrator over the private
  network. `/api/health` is harmless and left reachable for uptime monitors.

## What the edge guarantees

1. **TLS 1.2+ only, HSTS for a year** (`includeSubDomains`; add `preload` only
   deliberately). Port 80 only serves ACME challenges and redirects to the
   canonical host.
2. **Forwarded headers are OVERWRITTEN, never appended.** The edge replaces
   `X-Forwarded-For` with the TCP peer address it saw (`$remote_addr` /
   `{remote_host}`), sets `X-Forwarded-Proto: https` and `X-Forwarded-Host`
   and `Host` to the served host, and strips any client `Forwarded` header.
   Appending (nginx's `$proxy_add_x_forwarded_for`) would let a client choose
   the IP the API rate-limits, audits, and logs admin access under.
   In `nginx.conf` every `proxy_set_header` sits at `server` level, because
   nginx silently drops inherited ones in any `location` that defines its own.
3. **Request size limits.** 64 KiB for the API and Socket.io (the API itself
   accepts at most 32 KiB of JSON and 8 KiB per Socket.io message), 256 KiB for
   the web app.
4. **Edge rate limiting per client IP** with a tighter zone for `/api/auth/`.
   These shed floods before Node; the API keeps its own per-IP and per-account
   limits. Many players can share one IP (carrier NAT): watch 429s after launch.
5. **Slow-client protection**: short header/body read timeouts on ordinary
   requests.

## TRUSTED_PROXY_CIDRS: whose forwarded headers the API believes

Behind the edge, every connection to the API comes from the edge, so the API
must read the client IP and the original scheme from `X-Forwarded-For` and
`X-Forwarded-Proto`. It does so **only for connections whose TCP peer address
is inside `TRUSTED_PROXY_CIDRS`**, and only up to `TRUST_PROXY_HOPS` hops. From
any other peer those headers are ignored: the request counts as plain HTTP
(refused in production with 426, and the Socket.io handshake/upgrade is
refused) and its IP is the raw peer address.

Production proxy mode requires both (the server refuses to start otherwise):

```
TRUST_PROXY_HOPS=1                 # the edge is the one proxy in front of the API
TRUSTED_PROXY_CIDRS=10.0.1.5/32    # the edge's private address(es); comma-separated
HOST=10.0.1.10                     # the API's own private interface
```

- List the narrowest set: the edge host's private address(es), or its subnet.
  `private` (loopback, RFC 1918, `fc00::/7`) is accepted as a shorthand but
  trusts every machine on your private networks; prefer exact addresses.
- If a cloud **L7 load balancer** sits in front of the edge, the edge must take
  the client IP from it: nginx `set_real_ip_from <LB CIDR>; real_ip_header
  X-Forwarded-For;` (realip module), Caddy `trusted_proxies static <LB CIDR>` +
  `client_ip_headers X-Forwarded-For`. Only the LB's own ranges, never
  `0.0.0.0/0`. The edge then still OVERWRITES what it forwards to the API, so
  the API's `TRUST_PROXY_HOPS` stays 1. An L4 (TCP) balancer needs nothing (use
  PROXY protocol if it hides the client address).
- With direct TLS on the API instead (`TLS_CERT_FILE`/`TLS_KEY_FILE`, no edge),
  leave `TRUST_PROXY_HOPS=0`; no forwarded header is honoured at all.

## PUBLIC_API_ORIGIN, COOKIE_SITE and why the API should not live on another site

The login refresh token is an `HttpOnly; Secure; SameSite=Strict` cookie,
host-only on the API host, scoped to `/api/auth`. A browser attaches a
SameSite=Strict cookie only to requests initiated by the **same site** (same
registrable domain, e.g. `example.com`).

- **One origin (this deployment):** web and API share `https://poker.example.com`.
  The refresh request is same-origin, the cookie is always sent, no CORS
  preflight, no third-party-cookie policy applies. Leave `PUBLIC_API_ORIGIN`
  and `COOKIE_SITE` **unset**.
- **API on a sibling subdomain** (`app.example.com` + `api.example.com`): still
  same-site, so it works, but you must declare it: set
  `PUBLIC_API_ORIGIN=https://api.example.com` and `COOKIE_SITE=example.com`.
  The server checks at startup that both hosts sit under `COOKIE_SITE`. You
  also need CORS (`CLIENT_ORIGIN`) and Socket.io cross-origin, which one origin
  avoids.
- **API on another site** (`poker-api.onrender.com`, `api.other-domain.com`,
  any two `*.vercel.app` / `*.fly.dev` hosts, which the Public Suffix List makes
  separate sites): the browser treats the web app's refresh call as
  cross-site and **never sends the SameSite=Strict cookie**, and Safari/Firefox
  (and Chrome's third-party-cookie controls) block it regardless. Every player
  would be logged out at the first access-token expiry (15 minutes). The server
  refuses to start with such a `PUBLIC_API_ORIGIN`. Relaxing the cookie to
  `SameSite=None` would reopen CSRF on the refresh endpoint; do not do that.
  Put both behind one origin with this edge instead.

## Several API instances

**Run exactly one API instance (verify before changing).** Each process loads
the live tables into memory on start (`tableManager.recover()`) and drives
their turn timers; no cross-instance table ownership (lease or advisory lock)
exists yet, so two processes would both run the same tables. `REDIS_URL`
(`rediss://` in production) makes Socket.io fan events out across processes,
but it does not make table processing safe to duplicate. Deploy by stopping the
old process (it drains on SIGTERM) before starting the new one, not with an
overlapping rolling update. If multi-instance support is added later, the edge
also needs sticky sessions for Socket.io long-polling (nginx `ip_hash` or a
cookie; Caddy `lb_policy cookie`).

## Smoke tests (staging, after deploying)

```sh
H=https://poker.example.com
curl -sI $H/ | grep -i strict-transport-security          # HSTS on the web app
curl -s  $H/api/health                                     # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' $H/api/ready      # 404 (private only)
curl -s -o /dev/null -w '%{http_code}\n' http://poker.example.com/   # 301
# WebSocket upgrade passes through (expect "101 Switching Protocols"):
curl -si --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H "Origin: $H" "$H/socket.io/?EIO=4&transport=websocket" | head -1
# Spoofed client IP is NOT honoured: the API logs the edge-observed address.
curl -s -H 'X-Forwarded-For: 1.2.3.4' $H/api/health >/dev/null   # check API logs
# Body limit: expect 413.
head -c 200000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- $H/api/auth/login
# The API port is not reachable from outside (expect a timeout/refusal):
curl -m 5 http://<api-public-ip>:4000/api/health
```
