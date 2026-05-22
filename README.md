# mitos-mcp

A stateless Streamable HTTP MCP server that exposes the Greek government **MITOS** administrative-procedures registry (`https://api.digigov.grnet.gr/v1`) to any MCP client that can reach an HTTPS URL — including **Claude for Word**.

---

## What it is

MITOS (Εθνικό Μητρώο Διοικητικών Διαδικασιών) is the national registry of Greek public-administration procedures: every citizen-facing service has an ID, Greek/English title, eligibility criteria, step-by-step instructions, costs, timeframes, legal-basis citations (statute type, gazette number, ΔΙΑΥΓΕΙΑ ADA), and more.

This server wraps the MITOS REST API in five read-only MCP tools and exposes them over **stateless Streamable HTTP** (Express 5). Every `POST /mcp` request gets a fresh `StreamableHTTPServerTransport` and MCP server instance — there is no session bookkeeping, which keeps the server simple and horizontally scalable. A `GET /health` endpoint is available for monitoring without authentication. All other endpoints require a bearer token.

Bearer authentication is **fail-closed**: the process refuses to start if `MITOS_MCP_AUTH_TOKEN` is not set, preventing accidental open deployment.

---

## Tools

| Tool | Description | Limitations |
|------|-------------|-------------|
| `search_procedures(query, language?, category?)` | Accent-insensitive substring search across all ~4305 MITOS procedures (full index cached 1 h). Returns up to 50 matching IDs and Greek/English titles. `language` defaults to `"both"`; accepts `"el"` or `"en"`. Optional `category` filters by life-event tag (fetches up to 200 extended records). | None for the main search. Category filter is approximate: limited to first 200 title matches. |
| `get_procedure(id)` | Full markdown-formatted details for a procedure: description, eligibility, in-person steps, digital steps, timeframe, cost, legal citations, service-point contacts, useful links. | Requires a valid numeric MITOS ID, e.g. `"439993"`. |
| `list_categories()` | Lists life-event categories found in MITOS (e.g. `"Φορολογία πολιτών"`, `"Άδεια παραμονής"`). Sorted alphabetically. Cached 1 h. | **MITOS has no categories endpoint.** Categories are extracted from the `process.life_events` field. The list is sampled from ~150 evenly-spread procedures, so niche categories may be missing. |
| `list_procedures_by_category(category, limit?)` | Lists procedures whose life events include the given category string (case-insensitive substring match). `limit` defaults to 50. | Same sampling limitation as `list_categories` — works over ~150 procedures, not all ~4305. |
| `get_legal_basis_articles(procedure_id)` | Returns structured, machine-readable JSON with all legal-basis citations for a procedure: statute type (`rule_type`), number (`rule_decision_number`), year (`rule_decision_year`), article (`rule_article`), description, FEK gazette number and issue type, optional ΔΙΑΥΓΕΙΑ ADA (`rule_ada`), and source URL. Designed for cross-checking against legal MCPs (e.g. kodiko-mcp, nomos-mcp). | `rule_ada` is absent on some rules; this tool omits it rather than fabricating a value. |

---

## Local run

**Prerequisites:** Node.js 20+ and npm.

```bash
# 1. Install dependencies
npm install

# 2. Compile TypeScript
npm run build

# 3. Start the server (PowerShell — set the token before starting)
$env:MITOS_MCP_AUTH_TOKEN="your-secret-token"; npm start
```

The server binds on `0.0.0.0:8743` and logs to stderr. On startup it immediately warms the services cache in the background (fetches ~4305 procedures in parallel pages; first real `search_procedures` call may take a few seconds if the warm-up hasn't finished).

**Verify with the live smoke test** (run in a second terminal while the server is running):

```powershell
$env:MITOS_MCP_AUTH_TOKEN="your-secret-token"; npm run smoke
```

The smoke script sends six checks: health endpoint, unauthenticated rejection (expects 401), `tools/list` (expects 5 tools), `search_procedures`, and two `get_legal_basis_articles` assertions. Expected output: `6 passed, 0 failed`.

**Run unit tests** (no server needed):

```bash
npm test
```

Expected: 13 tests pass (pure helpers: `normalize`, `formatDuration`, `pool`, `extractLegalBasis`, `filterByTitle`).

---

## Docker

Build and start with Docker Compose. The `MITOS_MCP_AUTH_TOKEN` variable is required — Compose will refuse to start if it is not set in the environment or in a `.env` file.

```bash
# With the token exported in your shell
MITOS_MCP_AUTH_TOKEN=your-secret-token docker compose up --build
```

Or create a `.env` file in the project root:

```
MITOS_MCP_AUTH_TOKEN=your-secret-token
```

Then run:

```bash
docker compose up --build
```

The container exposes port `8743`. Use `docker compose up -d` to run in the background. Logs (to stderr) are visible via `docker compose logs -f mitos-mcp`.

The multi-stage Dockerfile compiles TypeScript in a `node:20-alpine` build stage and copies only the compiled `dist/` and production `node_modules` into the runtime image, keeping the final image lean.

---

## VPS deploy (Ubuntu / Hostinger)

These steps assume a fresh Ubuntu 22.04 VPS with Docker and Docker Compose already installed, and a domain or subdomain you control (e.g. `mitos.yourdomain.com`) whose DNS A record points to the VPS IP.

**1. Clone the repository and configure the token:**

```bash
git clone https://github.com/your-org/mitos-mcp.git
cd mitos-mcp
echo "MITOS_MCP_AUTH_TOKEN=your-secret-token" > .env
```

Choose a long random token (e.g. `openssl rand -hex 32`). Keep it secret.

**2. Start the container:**

```bash
docker compose up -d --build
```

Confirm the container is healthy:

```bash
curl http://127.0.0.1:8743/health
# {"status":"ok"}
```

**3. Install nginx and certbot:**

```bash
sudo apt update
sudo apt install -y nginx python3-certbot-nginx
```

**4. Configure nginx as a reverse proxy:**

Copy the example config and replace `mitos.example.com` with your actual subdomain:

```bash
sudo cp nginx.conf.example /etc/nginx/sites-available/mitos
sudo sed -i 's/mitos.example.com/mitos.yourdomain.com/g' /etc/nginx/sites-available/mitos
sudo ln -s /etc/nginx/sites-available/mitos /etc/nginx/sites-enabled/mitos
sudo nginx -t
sudo systemctl reload nginx
```

**5. Obtain a TLS certificate with Let's Encrypt:**

```bash
sudo certbot --nginx -d mitos.yourdomain.com
```

Certbot will automatically update the nginx config with the certificate paths and set up automatic renewal. After it completes, confirm HTTPS works:

```bash
curl https://mitos.yourdomain.com/health
# {"status":"ok"}
```

The nginx config already includes `proxy_buffering off` and a 300-second read timeout, which are needed for Streamable HTTP responses that may stream data before closing.

---

## Claude for Word connector

Claude for Word supports custom MCP connectors via an HTTPS URL and an authorization header.

In the Claude for Word add-in settings, add a new custom connector with:

- **Endpoint URL:** `https://mitos.yourdomain.com/mcp`
- **Header name:** `Authorization`
- **Header value:** `Bearer your-secret-token`

Use the same token you set in `MITOS_MCP_AUTH_TOKEN`. Once connected, all five MITOS tools appear in the Claude for Word tool panel and can be called from within Word documents.

The server is stateless, so multiple Word clients can connect simultaneously without coordination.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MITOS_MCP_AUTH_TOKEN` | **Yes** | — | Bearer token for `POST /mcp`. The server exits immediately with a fatal error if this is not set. There is no default — an open server is not an option. |
| `PORT` | No | `8743` | TCP port the server binds on (`0.0.0.0:PORT`). Must be an integer between 1 and 65535. |
