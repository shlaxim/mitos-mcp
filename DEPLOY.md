# Deploying mitos-mcp (as actually deployed to the Hostinger VPS)

This reflects the **real** deployment of `mitos.nomothiki.com`, not an idealized
fresh-server plan. The VPS already ran a **system nginx + Docker + certbot**
(serving `nomothiki.cloud`), so we added our app *beside* the existing setup
rather than installing anything that conflicts.

**Live setup:**
- App: container on `127.0.0.1:8743`, code at `/opt/mitos-mcp`
- Public URL: `https://mitos.nomothiki.com/mcp/<token>` (path-secret auth)
- Repo: `https://github.com/shlaxim/mitos-mcp` (public)
- VPS: Hostinger Ubuntu 24.04, real public IP **`76.13.155.182`**

Use this as the template for redeploying or for a sibling MCP on the same box.

---

## Step 0 — Get a shell on the VPS

Outbound SSH (port 22) is blocked from the user's network, so SSH from a normal
terminal times out. Use **Hostinger panel → VPS → Browser terminal** (web console,
logs in as root). All VPS commands below run there.

> **Browser-terminal paste caveat:** long single-line commands get soft-wrapped into
> broken multi-line input. Prefer **many short lines** (e.g. several `echo '...' >> file`)
> over heredocs or one long `printf`.

---

## Step 1 — Confirm the VPS's REAL public IP

Do **not** trust the IP shown in the Hostinger panel — for this box it showed a
parking IP (`2.57.91.91`) that is *not* where traffic to the VPS lands. Get the
true egress/public IP from the box itself:

```bash
curl -s https://api.ipify.org; echo
```

That printed `76.13.155.182`. Use **that** value for DNS.

---

## Step 2 — DNS (Hostinger DNS panel for the domain)

Add/point an `A` record at the **real** IP:

| Type | Name    | Points to        | TTL |
|------|---------|------------------|-----|
| A    | `mitos` | `76.13.155.182`  | 60  |

Verify the authoritative answer and a couple of public resolvers:

```bash
getent hosts mitos.nomothiki.com          # on the VPS
# from anywhere: nslookup mitos.nomothiki.com 1.1.1.1   (and 8.8.8.8)
```

**Propagation gotcha:** public resolvers cache. Google `8.8.8.8` in particular held
the old value and Claude resolves through it — if Claude says "Couldn't reach the
MCP server," it's almost always stale DNS. Force-flush at <https://dns.google/cache>
(enter the hostname, type A, Flush), then retry. Cloudflare/Quad9/OpenDNS updated
quickly; the authoritative NS (`*.dns-parking.com`) is correct immediately.

---

## Step 3 — Get the code + run the container

The repo is public, so no auth is needed to clone:

```bash
cd /opt
git clone https://github.com/shlaxim/mitos-mcp.git
cd /opt/mitos-mcp
```

Create the env file (token read by docker compose; `.env` is gitignored):

```bash
echo 'MITOS_MCP_AUTH_TOKEN=<YOUR_TOKEN>' > .env
chmod 600 .env
docker compose up -d --build
```

`docker-compose.yml` binds the port to `127.0.0.1:8743` only (nginx fronts it).
Verify on the box:

```bash
docker compose ps
curl -s http://127.0.0.1:8743/health; echo      # -> {"status":"ok"}
```

---

## Step 4 — Add an nginx server block (beside the existing sites)

Do **not** install or replace nginx — the system nginx already serves other
domains. Just add one site. `nginx.conf` includes both `conf.d/*.conf` and
`sites-enabled/*`. Build the file with short lines (paste-safe):

```bash
F=/etc/nginx/sites-available/mitos
echo 'server {' > $F
echo 'listen 80;' >> $F
echo 'server_name mitos.nomothiki.com;' >> $F
echo 'location / {' >> $F
echo 'proxy_pass http://127.0.0.1:8743;' >> $F
echo 'proxy_http_version 1.1;' >> $F
echo 'proxy_set_header Host $host;' >> $F
echo 'proxy_set_header X-Real-IP $remote_addr;' >> $F
echo 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' >> $F
echo 'proxy_set_header X-Forwarded-Proto $scheme;' >> $F
echo 'proxy_buffering off;' >> $F
echo 'proxy_read_timeout 300s;' >> $F
echo 'proxy_send_timeout 300s;' >> $F
echo '}' >> $F
echo '}' >> $F
```

Activate, test, reload:

```bash
ln -sf $F /etc/nginx/sites-enabled/mitos
nginx -t && systemctl reload nginx
```

Verify the proxy works locally for that host (bypasses any stale DNS):

```bash
curl -s -H 'Host: mitos.nomothiki.com' http://127.0.0.1/health; echo   # -> {"status":"ok"}
```

---

## Step 5 — HTTPS certificate (certbot)

This box has **apt** certbot (`/usr/bin/certbot`) but the nginx plugin wasn't
installed. Install it, then issue the cert (certbot rewrites the `mitos` block to
add HTTPS + an HTTP→HTTPS redirect):

```bash
apt-get install -y python3-certbot-nginx
certbot --nginx -d mitos.nomothiki.com --redirect --agree-tos -m <YOUR_EMAIL> -n
```

certbot validates over port 80 using public DNS, so DNS (Step 2) must point at the
real IP first. Verify (the `--resolve` avoids the VPS's own stale DNS cache):

```bash
curl -s --resolve mitos.nomothiki.com:443:127.0.0.1 https://mitos.nomothiki.com/health; echo
```

Firewall: if ufw is on, ensure `Nginx Full` (80+443) is allowed; never expose 8743.

---

## Step 6 — Auth for Claude connectors (path secret)

Claude's custom connectors (incl. Claude for Word) only offer **OAuth or no-auth** —
there is **no field for an `Authorization: Bearer` header**. The server therefore
also accepts the token as a **URL path secret**: `POST /mcp/:secret` (constant-time
checked), in addition to the header. No extra config needed — it's in the code.

**Connector setup in Claude:**
- URL: `https://mitos.nomothiki.com/mcp/<YOUR_TOKEN>`
- OAuth Client ID / Secret: **leave blank**

Treat that URL as a password. The header form (`Authorization: Bearer <token>` on
`/mcp`) still works for curl/CLI/tests.

External smoke (from any machine):

```bash
curl -s -X POST "https://mitos.nomothiki.com/mcp/<YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
# -> lists the 5 tools; a wrong secret returns HTTP 401
```

---

## Updating later

```bash
cd /opt/mitos-mcp
git pull
docker compose up -d --build
```

The Let's Encrypt cert auto-renews via certbot's systemd timer
(`systemctl list-timers | grep certbot`).
