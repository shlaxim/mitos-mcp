# MITOS MCP — Full-Stack Design Spec

_Date: 2026-05-22_
_Status: Approved design (brainstorming complete). Ready for implementation plan._

## 1. Purpose

An MCP server wrapping the Greek government **MITOS** registry (Εθνικό Μητρώο
Διοικητικών Διαδικασιών) — the National Registry of Administrative Procedures —
exposed by GRNET at `https://api.digigov.grnet.gr/v1`.

It lets an MCP client search and fetch Greek administrative procedures, and is
designed to be reached **remotely from Claude for Word** over HTTPS. A priority
goal is structured legal-basis output that can later be cross-checked against
sibling MCPs (`D:\kodiko-mcp`, nomos).

## 2. Constraints & Decisions

### 2.1 Transport: Stateless Streamable HTTP
- Each JSON-RPC request gets a **fresh `StreamableHTTPServerTransport`**; no
  `Mcp-Session-Id` bookkeeping. Tools are read-only lookups with no per-session
  state, so sessions would add failure modes for no benefit.
- Required because Claude for Word connects to a remote **HTTPS** URL — it will
  not accept stdio, a raw IP, or a self-signed certificate.
- Chosen over: (a) stateful HTTP sessions — unnecessary state; (b) stdio + a
  bridge process — extra moving part, and Claude for Word needs HTTPS anyway.

### 2.2 Deliberate simplifications (per "Simplicity First")
- **No zod.** JSON `inputSchema` on each tool + light runtime checks in handlers.
- **No pino.** Log to stderr.
- **No lru-cache / p-throttle.** The existing 1-hour in-memory cache + a
  concurrency-10 fetch pool are sufficient for a read-only registry mirror.

### 2.3 Auth & networking
- `MITOS_MCP_AUTH_TOKEN` env var → require `Authorization: Bearer <token>` on
  the `/mcp` route. If the env var is unset, the server refuses to start (fail
  closed — no accidental open deployment).
- `GET /health` stays **unauthenticated** (for uptime monitoring).
- Bind `0.0.0.0:8743`. Port overridable via `PORT` env var.

## 3. File Layout

Rewrite of the current single 633-line `src/index.ts` into focused modules
(target < 500 lines each):

```
src/
  index.ts   Express app, bearer-auth middleware, POST /mcp (stateless transport),
             GET /health, startup + background cache warm-up.
  mitos.ts   API client: fetchJson, concurrency pool, fetchAllServices (parallel
             paged + in-flight dedup), 1h cache, Greek accent-insensitive normalize,
             formatDuration. Lifted from current code — already verified live.
  tools.ts   The 5 tool definitions (JSON inputSchema) + handlers + markdown
             formatters.
```

Code worth lifting verbatim from the current `index.ts` (verified against the
live API): `fetchAllServices`, `pool`, `normalize`, `getProcedure` markdown
formatter, `formatDuration`.

## 4. Tools (5)

### 4.1 `search_procedures(query, language=both, category?)` — existing, keep
Client-side substring match over the cached full services index (~4305 entries,
fetched via parallel paging). Accent-insensitive Greek matching. Optional
`category` filter applies a life-event check over the title-matched subset
(capped at 200 to bound fan-out).

### 4.2 `get_procedure(id)` — existing, keep
Fetches `/services-extended/{id}` and renders a human-readable markdown summary:
description, eligibility conditions, in-person + digital process steps, timeframe,
cost, legal basis, service points, useful links.

### 4.3 `list_categories()` — existing, keep
Lists life-event categories. MITOS has **no categories endpoint**, so this
samples ~150 procedures (evenly spread across the full list) and unions their
`process.life_events`. Cached 1h. The output states it is sampled, not exhaustive.

### 4.4 `list_procedures_by_category(category, limit=50)` — NEW
Returns procedures whose `process.life_events` include the given category.
**Honest limitation, documented in the tool description and output:** MITOS has
no category endpoint, so this works over the sampled life-event set (same sample
basis as `list_categories`), **not** an exhaustive scan of all 4305 procedures.
`limit` caps returned results (default 50).

### 4.5 `get_legal_basis_articles(procedure_id)` — NEW, PRIORITY
Returns the structured per-statute legal citations from
`metadata.process_rules[]` as **machine-readable JSON** (not prose), so
kodiko/nomos MCPs can verify each citation independently.

**Verified live field shapes (2026-05-22, 264 rules across 58 procedures):**

| Field | Type | Notes |
|---|---|---|
| `rule_type` | string | e.g. "Νόμος" (law type) |
| `rule_decision_number` | string | |
| `rule_decision_year` | string | |
| `rule_article` | string | |
| `rule_description` | string | |
| `rule_gazette_doc_number` | **number** | FEK (gazette) number |
| `rule_gazette_doc_issue` | string | e.g. "Α" |
| `rule_ada` | string | **OPTIONAL** — ΔΙΑΥΓΕΙΑ ADA, present on some rules (e.g. 439993) |
| `rule_url` | string | source/gazette URL |

Output passes these fields through as-is per rule. **No `kodiko_url` and no
`law_id` exist in the API — the tool MUST NOT fabricate them.** If a future
cross-link to kodiko is wanted, it is a separate, explicitly-designed step.

Returns a JSON object: `{ procedure_id, title, rules: [ {…9 fields…} ] }`.
Missing optional fields (e.g. `rule_ada`) are omitted rather than nulled.

## 5. Data Flow

1. On startup, `index.ts` warms the services cache in the background
   (`fetchAllServices`) so the first `search_procedures` is fast.
2. A client POSTs JSON-RPC to `/mcp` with `Authorization: Bearer <token>`.
3. Middleware validates the token (constant-time compare); on failure → 401.
4. A fresh stateless `StreamableHTTPServerTransport` handles the request and
   dispatches to the tool handlers in `tools.ts`.
5. Handlers call `mitos.ts`, which serves from the 1h cache or fetches live
   (parallel paged, concurrency-capped, in-flight deduped).

## 6. Error Handling
- Tool handlers catch errors and return `{ isError: true, content:[text] }` —
  never crash the request.
- HTTP layer: 401 on bad/missing token at `/mcp`; 200 + JSON-RPC error body for
  protocol/tool errors; `/health` always 200 when the process is up.
- Upstream HTTP failures surface as `HTTP <status>: <url>` and, in fan-out
  (`pool`), are tolerated per-item (`PromiseSettledResult`) so one bad page or
  detail fetch doesn't fail the whole call.

## 7. Deployment Artifacts
- **Multi-stage `Dockerfile`** (`node:20-alpine`): build TypeScript, ship `dist`.
- **`docker-compose.yml`**: port 8743, `MITOS_MCP_AUTH_TOKEN` via env.
- **`nginx.conf.example`**: reverse-proxy a user subdomain → `:8743` (HTTPS
  termination via Let's Encrypt).
- **`README`**: local testing, Ubuntu/Hostinger VPS deploy + Let's Encrypt,
  and Claude-for-Word connector config (HTTPS URL + bearer token). The user has
  a domain → subdomain + LE + nginx.

## 8. Testing Path
1. Run locally; smoke-test `GET /health`.
2. Real `tools/call` over HTTP (each of the 5 tools) against the **live** MITOS
   API — confirm `get_legal_basis_articles` returns the verified field shapes.
3. Deploy to VPS; connect from Claude for Word.

## 9. API Reference (verified LIVE, still valid)
Base `https://api.digigov.grnet.gr/v1`. No auth required during beta.
- **List:** `GET /services/?page&limit` →
  `{data:[{id,title:{el,en},ns,last_updated}], success, total:4305, next_page, current_page, limit}`
- **Detail:** `GET /services-extended/{id}` (NOT `/services/{id}`); `lang=en` for English.
  Under `metadata`: `process`, `process_conditions`, `process_evidences`,
  `process_evidences_cost`, `process_steps`, `process_steps_digital`,
  `process_rules` (legal basis), `process_provision_digital_locations`,
  `process_useful_links`; plus `metadata.glance` (cost/evidences/duration/service_points).
- **No keyword-search param** (`?query=` doesn't exist; `/services/search/filter/{filter}`
  returns 400) → client-side substring match.
- **No `/categories/` endpoint** → "categories" = `process.life_events`.
- Official clients: npm `@digigov-oss/emdd-api-client`, GitLab `pyemdd-api-client`.

## 10. Out of Scope (YAGNI)
- Persistent / external cache, rate-limit middleware, metrics endpoint.
- Write operations (the registry is read-only here).
- Kodiko/nomos cross-verification logic (separate future project; this spec only
  guarantees the machine-readable output that makes it possible).
