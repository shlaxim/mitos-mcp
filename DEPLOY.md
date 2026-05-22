# Deploying mitos-mcp to a Hostinger VPS (mitos.nomothiki.com)

Concrete runbook for this setup:
- **Repo:** `https://github.com/shlaxim/mitos-mcp` (private)
- **Hostname:** `mitos.nomothiki.com`
- **VPS:** Hostinger VPS (Ubuntu), root SSH
- **Endpoint exposed:** `https://mitos.nomothiki.com/mcp` (+ open `GET /health`)

Replace `<YOUR_TOKEN>` everywhere with the auth token you generated (keep it secret).
Replace `<VPS_PUBLIC_IP>` with your VPS's IPv4 address (shown in the Hostinger panel).

---

## Step 1 — DNS (Hostinger panel, ~5 min + propagation)

In Hostinger → your domain `nomothiki.com` → **DNS / Name Servers** → manage DNS records, add:

| Type | Name    | Points to        | TTL  |
|------|---------|------------------|------|
| A    | `mitos` | `<VPS_PUBLIC_IP>`| 3600 |

This creates `mitos.nomothiki.com`. Wait for propagation, then verify from your PC:

```powershell
nslookup mitos.nomothiki.com
```

It must resolve to `<VPS_PUBLIC_IP>` before doing Let's Encrypt (Step 6).

---

## Step 2 — SSH into the VPS

```powershell
ssh root@<VPS_PUBLIC_IP>
```

(Hostinger shows the root password / lets you set an SSH key in the VPS panel.)

All remaining steps run **on the VPS**.

---

## Step 3 — Install Docker + compose plugin (Ubuntu)

```bash
apt-get update && apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version && docker compose version
```

---

## Step 4 — Get the code (private repo)

The repo is **private**, so cloning needs GitHub credentials. Easiest is the GitHub CLI device login:

```bash
apt-get install -y gh
gh auth login        # choose GitHub.com → HTTPS → "Login with a web browser", enter the one-time code
gh repo clone shlaxim/mitos-mcp /opt/mitos-mcp
cd /opt/mitos-mcp
```

> Alternatives: (a) create a fine-grained Personal Access Token with read access and
> `git clone https://<TOKEN>@github.com/shlaxim/mitos-mcp.git /opt/mitos-mcp`; or
> (b) make the repo public (it contains no secrets) and `git clone` plainly.

---

## Step 5 — Run the container

Create the env file (the token is read by docker compose; `.env` is gitignored so it is never committed):

```bash
echo 'MITOS_MCP_AUTH_TOKEN=<YOUR_TOKEN>' > /opt/mitos-mcp/.env
chmod 600 /opt/mitos-mcp/.env
docker compose up -d --build
```

Verify locally on the VPS (the port is bound to 127.0.0.1 only):

```bash
curl -s http://127.0.0.1:8743/health         # -> {"status":"ok"}
curl -s -X POST http://127.0.0.1:8743/mcp \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'   # -> lists 5 tools
```

Logs / lifecycle:

```bash
docker compose logs -f          # follow logs
docker compose restart          # restart
docker compose pull && docker compose up -d --build   # after a code update (git pull first)
```

---

## Step 6 — nginx reverse proxy + HTTPS (Let's Encrypt)

```bash
apt-get install -y nginx certbot python3-certbot-nginx

# Take the example config, set the real hostname, install it
sed 's/mitos\.example\.com/mitos.nomothiki.com/g' /opt/mitos-mcp/nginx.conf.example \
  > /etc/nginx/sites-available/mitos
ln -sf /etc/nginx/sites-available/mitos /etc/nginx/sites-enabled/mitos
rm -f /etc/nginx/sites-enabled/default

# certbot needs port 80 reachable and DNS already pointing here (Step 1).
# It will obtain the cert and rewrite the config for HTTPS automatically.
certbot --nginx -d mitos.nomothiki.com --redirect --agree-tos -m you@example.com -n

nginx -t && systemctl reload nginx
systemctl enable nginx
```

> The `nginx.conf.example` already references the Let's Encrypt cert paths
> (`/etc/letsencrypt/live/mitos.nomothiki.com/...`), has `proxy_buffering off` and
> 300s timeouts for streamable HTTP, and proxies to `127.0.0.1:8743`. If certbot's
> auto-edit and the example conflict, let certbot's version win — the proxy
> `location /` block is the part that must remain.

---

## Step 7 — Firewall (if ufw is enabled)

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'      # opens 80 + 443
ufw enable
```

Do **not** open 8743 — it stays localhost-only.

---

## Step 8 — Verify from the public internet (from your PC)

```powershell
curl https://mitos.nomothiki.com/health
# {"status":"ok"}
```

Optionally run the repo's smoke test against the live host from your PC:

```powershell
# from D:\mitos-mcp
$env:MITOS_MCP_AUTH_TOKEN="<YOUR_TOKEN>"; $env:PORT="443"   # smoke.mjs targets 127.0.0.1; for remote, prefer the curl checks above
```

(The bundled `npm run smoke` targets `127.0.0.1`; for a remote check use the `curl`
commands above, or run smoke on the VPS itself.)

---

## Step 9 — Connect from Claude for Word

Add a custom connector:
- **URL:** `https://mitos.nomothiki.com/mcp`
- **Header:** `Authorization: Bearer <YOUR_TOKEN>`

The 5 tools (`search_procedures`, `get_procedure`, `list_categories`,
`list_procedures_by_category`, `get_legal_basis_articles`) then appear in Claude.

---

## Updating later

```bash
cd /opt/mitos-mcp
git pull
docker compose up -d --build
```
