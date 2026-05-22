# mitos-mcp — Progress

_Last updated: 2026-05-22 (rewrite complete)_

## Goal

MCP server wrapping the Greek government MITOS API
(Εθνικό Μητρώο Διοικητικών Διαδικασιών) at `https://api.digigov.grnet.gr/v1`,
so administrative procedures can be searched and fetched — and ultimately reached
**remotely from Claude for Word** over HTTPS.

Project location: `D:\mitos-mcp` (moved from `C:\Users\m_pal\mitos mcp` on 2026-05-22).
Sibling MCPs on D: include `D:\kodiko-mcp` (legal-basis output is meant to be
cross-checked/verified against kodiko/nomos MCPs later).

## APPROVED DESIGN (2026-05-22) — ready to spec + implement

### Transport
- **Stateless Streamable HTTP** (chosen over stateful sessions and stdio+bridge).
  Each JSON-RPC request gets a fresh `StreamableHTTPServerTransport`; no
  `Mcp-Session-Id` bookkeeping. Tools are read-only lookups with no per-session
  state, so sessions add failure modes for no benefit. Required because Claude for
  Word connects to a remote **HTTPS** URL (won't accept stdio, raw IP, or self-signed).

### File layout (rewrite from current single 633-line `src/index.ts`; keep files < 500 lines)
```
src/
  index.ts      Express app, bearer-auth middleware, POST /mcp, GET /health, startup + cache warm-up
  mitos.ts      fetchJson, concurrency pool, fetchAllServices, 1h cache, Greek accent-insensitive normalize
                (lifted from current code — already verified against live API)
  tools.ts      5 tool definitions (JSON inputSchema) + handlers + markdown formatters
```

### Tools (all 5)
1. `search_procedures(query, language=both, category?)` — exists, keep. Client-side
   substring match over cached full services index (~4305, paged fetch).
2. `get_procedure(id)` — exists, keep. Uses `/services-extended/{id}`.
3. `list_categories()` — exists, keep. Life-event sampling (~150 procedures).
4. `list_procedures_by_category(category, limit)` — **NEW.** Honest limitation: MITOS
   has no category endpoint, so this works over the cached/sampled life-event set,
   NOT an exhaustive scan of all 4305. Document the limitation.
5. `get_legal_basis_articles(procedure_id)` — **NEW, PRIORITY.** Structured per-statute
   citations from `process_rules[]` (`rule_type`, `rule_decision_number`,
   `rule_decision_year`, `rule_article`, `rule_description`, `rule_gazette_doc_number`,
   `rule_gazette_doc_issue`, `rule_ada`, `rule_url`). Machine-readable so kodiko/nomos
   MCPs can verify each. **MUST verify exact field shapes against LIVE API**
   (Chrome DevTools + live fetch) before finalizing. Do NOT fabricate a `kodiko_url`
   from an unconfirmed `law_id`.

### Auth & networking
- `MITOS_MCP_AUTH_TOKEN` env → `Authorization: Bearer <token>` check on `/mcp`.
- `/health` stays open (for monitoring).
- Bind `0.0.0.0:8743`.

### Deployment artifacts
- Multi-stage `Dockerfile` (node:20-alpine).
- `docker-compose.yml` (port 8743, token via env).
- `nginx.conf.example` (reverse proxy user's subdomain → :8743).
- `README` — local testing, Ubuntu/Hostinger VPS + Let's Encrypt, Claude-for-Word
  connector config (HTTPS URL + bearer token). User HAS a domain → subdomain + LE + nginx.

### Deliberate simplifications (diverge from old spec below, per user's "simplicity first" rule)
- **No zod** (JSON inputSchema + light handler checks).
- **No pino** (stderr logging).
- **No lru-cache / p-throttle** — existing 1h in-memory cache + concurrency-10 pool suffice.
- Flag these in the spec.

### Testing path
Run locally → smoke-test `/health` + a real `tools/call` over HTTP against live MITOS
API → deploy to VPS → connect from Claude for Word.

## NEXT STEPS (resume here)
1. ~~Relaunch Claude Code from `D:\mitos-mcp`.~~ ✓ done — cwd is `D:\mitos-mcp`.
2. ~~Verify `get_legal_basis_articles` field shapes against live API.~~ ✓ done 2026-05-22 (see below).
3. ~~Write spec~~ ✓ done → `docs/superpowers/specs/2026-05-22-mitos-mcp-fullstack-design.md`.
4. ~~Write implementation plan~~ ✓ done → `docs/superpowers/plans/2026-05-22-mitos-mcp-http-rewrite.md`.
5. ~~Implement rewrite (index.ts / mitos.ts / tools.ts) + deployment artifacts.~~ ✓ done 2026-05-22.
   - 3 source modules (src/mitos.ts, src/tools.ts, src/index.ts) + 2 test files.
   - 5 tools: search_procedures, get_procedure, list_categories, list_procedures_by_category, get_legal_basis_articles.
   - Stateless Streamable HTTP on port 8743, fail-closed bearer auth.
   - Deployment artifacts: Dockerfile (multi-stage node:20-alpine), docker-compose.yml, nginx.conf.example, README.md.
6. ~~Build + local smoke test.~~ ✓ done 2026-05-22.
   - `npx tsc --noEmit` → clean (no errors).
   - `npm run build` → dist/ compiled successfully.
   - `npm test` → **13/13 unit tests pass** (normalize, formatDuration, pool, extractLegalBasis, filterByTitle).
   - `npm run smoke` → **6/6 live smoke checks pass** (health, 401 rejection, tools/list, search_procedures, get_legal_basis_articles ×2).
   - Merged to `master` 2026-05-22 as commit `341be7a` (`feat/http-rewrite`, 16 commits, branch deleted). Re-verified on merged master: 13/13 tests + 6/6 smoke.

**Remaining open item:** VPS deploy + connect from Claude for Word.
- Clone repo on Ubuntu/Hostinger VPS, `docker compose up -d --build`.
- Install nginx + certbot, copy nginx.conf.example, run `certbot --nginx -d mitos.<domain>`.
- Add custom connector in Claude for Word: URL `https://mitos.<domain>/mcp`, header `Authorization: Bearer <token>`.

## VERIFIED `process_rules` shape (LIVE 2026-05-22, 264 rules across 58 procedures)
Each rule in `metadata.process_rules[]` is flat with these keys:
- `rule_type` (string, e.g. "Νόμος")
- `rule_decision_number` (string)
- `rule_decision_year` (string)
- `rule_article` (string)
- `rule_description` (string)
- `rule_gazette_doc_number` (**number** — FEK number)
- `rule_gazette_doc_issue` (string, e.g. "Α")
- `rule_ada` (string, **OPTIONAL** — ΔΙΑΥΓΕΙΑ ADA, present on some rules e.g. 439993)
- `rule_url` (string)

No `kodiko_url`, no `law_id` — confirms the "don't fabricate kodiko_url" rule.
`get_legal_basis_articles` returns these fields as machine-readable JSON per rule.

## Current code state (before rewrite)
- `src/index.ts` (633 lines): **stdio** transport, 3 tools
  (search_procedures, get_procedure, list_categories). Type-checks clean.
  Good logic to lift: `fetchAllServices` (parallel paged + in-flight dedup),
  `normalize` (Greek accent strip), `pool` (concurrency cap), `getProcedure`
  markdown formatter, `formatDuration` (ISO 8601 duration → human).

## API findings (verified LIVE 2026-05-21) — still valid
Real base `https://api.digigov.grnet.gr/v1`. No auth required during beta.
- **List:** `GET /v1/services/?page&limit` → `{data:[{id,title:{el,en},ns,last_updated}],success,total:4305,next_page,current_page,limit}`
- **Detail:** `GET /v1/services-extended/{id}` (NOT `/services/{id}`). `lang=en` for English.
  Field groups under `metadata`: `process`, `process_conditions`, `process_evidences`,
  `process_evidences_cost`, `process_steps`, `process_steps_digital`, `process_rules`
  (legal basis), `process_provision_digital_locations`, `process_useful_links`; plus
  `metadata.glance` (cost/evidences/duration/service_points).
- **No keyword-search param** (spec's `?query=` doesn't exist; undocumented
  `/services/search/filter/{filter}` returns 400). → client-side substring match.
- **No `/categories/` endpoint.** "Categories" = life events (`process.life_events`),
  SDG registry (`/v1/registries/sdg`), NACE (`/v1/registries/nace`), or `org_owner`.
- Official clients: npm `@digigov-oss/emdd-api-client`, GitLab `pyemdd-api-client`.
