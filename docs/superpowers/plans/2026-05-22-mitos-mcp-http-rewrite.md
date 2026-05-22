# MITOS MCP HTTP Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the single-file stdio MITOS MCP server into a modular, stateless Streamable-HTTP server with 5 read-only tools, bearer auth, and deployment artifacts for remote use from Claude for Word.

**Architecture:** Three focused modules — `mitos.ts` (API client + pure helpers + 1h cache), `tools.ts` (5 tool definitions, handlers, formatters), `index.ts` (Express app, fail-closed bearer auth, stateless `POST /mcp`, open `GET /health`). Each JSON-RPC request gets a fresh `StreamableHTTPServerTransport` (no session bookkeeping). Pure functions are unit-tested with `node:test` + `tsx`; the network/HTTP layer is validated by a live smoke-test script.

**Tech Stack:** TypeScript (ES2022, CommonJS), `@modelcontextprotocol/sdk` ^1.28, Express 5, `tsx` (dev, test runner loader), Node 22.

Spec: `docs/superpowers/specs/2026-05-22-mitos-mcp-fullstack-design.md`

---

## File Structure

```
src/
  mitos.ts          API client + pure helpers + cache. Exports: types, BASE_URL,
                    normalize, formatDuration, pool, fetchJson, fetchAllServices,
                    getExtended, listCategorySample.
  mitos.test.ts     Unit tests for normalize, formatDuration, pool.
  tools.ts          5 tool defs (toolDefinitions), per-tool handler functions,
                    extractLegalBasis (pure), markdown formatters, callTool dispatcher.
  tools.test.ts     Unit tests for extractLegalBasis + search filtering.
  index.ts          Express app, auth middleware, POST /mcp, GET /health, startup.
scripts/
  smoke.mjs         Live integration smoke test (health + each of 5 tools over HTTP).
Dockerfile
docker-compose.yml
nginx.conf.example
README.md
```

The old 633-line `src/index.ts` is replaced. Logic lifted verbatim (already
verified live): `fetchAllServices`, `pool`, `normalize`, `formatDuration`, the
`getProcedure` markdown formatter.

---

## Task 1: Project setup — deps, test script, tsconfig

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Add express dependency and tsx + test/smoke scripts**

Edit `package.json` so `dependencies` and `scripts` read:

```json
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "node --import tsx --test \"src/**/*.test.ts\"",
    "smoke": "node scripts/smoke.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.28.0",
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^22.19.15",
    "tsx": "^4.19.0",
    "typescript": "^5.9.3"
  }
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: installs `express`, `@types/express`, `tsx`; no errors.

- [ ] **Step 3: Exclude test files from the build**

Edit `tsconfig.json` `exclude` to:

```json
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
```

- [ ] **Step 4: Verify the test runner wiring with a trivial smoke test**

Create `src/sanity.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});
```

Run: `npm test`
Expected: PASS, 1 test passed.

- [ ] **Step 5: Remove the sanity test and commit**

```bash
rm src/sanity.test.ts
git add package.json package-lock.json tsconfig.json
git commit -m "chore: add express dep, tsx test runner, test/smoke scripts"
```

---

## Task 2: `mitos.ts` — pure helper `normalize` (TDD)

**Files:**
- Create: `src/mitos.ts`
- Test: `src/mitos.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mitos.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "./mitos.js";

test("normalize strips Greek accents and lowercases", () => {
  assert.equal(normalize("Φορολογία"), normalize("φορολογια"));
  assert.equal(normalize("ΑΔΕΙΑ"), "αδεια");
});

test("normalize handles dialytika", () => {
  assert.equal(normalize("προϊόν"), normalize("προιον"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./mitos.js` / `normalize` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/mitos.ts`:

```typescript
/** Strip Greek tonos/dialytika and lowercase for accent-insensitive matching. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mitos.ts src/mitos.test.ts
git commit -m "feat(mitos): accent-insensitive normalize with tests"
```

---

## Task 3: `mitos.ts` — `formatDuration` (TDD)

**Files:**
- Modify: `src/mitos.ts`
- Modify: `src/mitos.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `src/mitos.test.ts`:

```typescript
import { formatDuration } from "./mitos.js";

test("formatDuration parses ISO 8601 durations", () => {
  assert.equal(formatDuration("P3Y"), "3 years");
  assert.equal(formatDuration("P1M"), "1 month");
  assert.equal(formatDuration("P10D"), "10 days");
  assert.equal(formatDuration("PT2H30M"), "2 hours, 30 minutes");
});

test("formatDuration returns undefined for undefined input", () => {
  assert.equal(formatDuration(undefined), undefined);
});

test("formatDuration returns the raw string when unparseable", () => {
  assert.equal(formatDuration("not-a-duration"), "not-a-duration");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `formatDuration` not exported.

- [ ] **Step 3: Implement**

Append to `src/mitos.ts`:

```typescript
/** Convert an ISO 8601 duration (e.g. "P3Y", "PT2H30M") to human-readable text. */
export function formatDuration(iso?: string): string | undefined {
  if (!iso) return undefined;
  const match = iso.match(
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!match || iso === "P") return iso;
  const [, years, months, days, hours, minutes, seconds] = match;
  const parts: string[] = [];
  const add = (v: string | undefined, unit: string) => {
    if (v) parts.push(`${v} ${unit}${+v > 1 ? "s" : ""}`);
  };
  add(years, "year");
  add(months, "month");
  add(days, "day");
  add(hours, "hour");
  add(minutes, "minute");
  add(seconds, "second");
  return parts.length ? parts.join(", ") : iso;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mitos.ts src/mitos.test.ts
git commit -m "feat(mitos): ISO 8601 formatDuration with tests"
```

---

## Task 4: `mitos.ts` — `pool` concurrency helper (TDD)

**Files:**
- Modify: `src/mitos.ts`
- Modify: `src/mitos.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `src/mitos.test.ts`:

```typescript
import { pool } from "./mitos.js";

test("pool returns results in input order", async () => {
  const tasks = [10, 5, 1].map((ms, i) => () =>
    new Promise<number>((r) => setTimeout(() => r(i), ms))
  );
  const results = await pool(tasks, 2);
  assert.deepEqual(
    results.map((r) => (r.status === "fulfilled" ? r.value : null)),
    [0, 1, 2]
  );
});

test("pool isolates rejections per task", async () => {
  const tasks = [
    () => Promise.resolve("ok"),
    () => Promise.reject(new Error("boom")),
  ];
  const results = await pool(tasks, 2);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `pool` not exported.

- [ ] **Step 3: Implement**

Append to `src/mitos.ts`:

```typescript
/** Run async tasks with a maximum concurrency; results preserve input order. */
export async function pool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mitos.ts src/mitos.test.ts
git commit -m "feat(mitos): concurrency pool with tests"
```

---

## Task 5: `mitos.ts` — types, constants, API client, cache (no new unit tests; covered by smoke)

**Files:**
- Modify: `src/mitos.ts`

- [ ] **Step 1: Add types, constants, fetchJson, cache, fetchAllServices, getExtended**

Append to `src/mitos.ts`:

```typescript
export const BASE_URL = "https://api.digigov.grnet.gr/v1";
export const PAGE_LIMIT = 100;
export const FETCH_CONCURRENCY = 10;
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface ServiceTitle {
  el: string;
  en?: string;
}
export interface ServiceListItem {
  id: string;
  title: ServiceTitle;
  ns: string;
  last_updated: string;
}
export interface ListResponse {
  data: ServiceListItem[];
  success: boolean;
  total: number;
  next_page: number | null;
  current_page: number;
  limit: number;
}
export interface ExtendedResponse {
  data: Record<string, unknown>;
  success: boolean;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

export function getExtended(id: string): Promise<ExtendedResponse> {
  return fetchJson<ExtendedResponse>(`${BASE_URL}/services-extended/${id}`);
}

interface ServicesCache {
  items: ServiceListItem[];
  fetchedAt: number;
}
let servicesCache: ServicesCache | null = null;
let servicesFetchInFlight: Promise<ServiceListItem[]> | null = null;

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL_MS;
}

/** Fetch all services via parallel paged requests; cached 1h, in-flight deduped. */
export async function fetchAllServices(): Promise<ServiceListItem[]> {
  if (servicesCache && isFresh(servicesCache.fetchedAt)) return servicesCache.items;
  if (servicesFetchInFlight) return servicesFetchInFlight;

  servicesFetchInFlight = (async () => {
    try {
      const first = await fetchJson<ListResponse>(
        `${BASE_URL}/services/?page=1&limit=${PAGE_LIMIT}`
      );
      if (!first.success) throw new Error("Failed to fetch services list");
      const totalPages = Math.ceil(first.total / PAGE_LIMIT);
      const all: ServiceListItem[] = [...first.data];
      if (totalPages > 1) {
        const tasks = Array.from({ length: totalPages - 1 }, (_, i) => {
          const page = i + 2;
          return () =>
            fetchJson<ListResponse>(`${BASE_URL}/services/?page=${page}&limit=${PAGE_LIMIT}`);
        });
        const results = await pool(tasks, FETCH_CONCURRENCY);
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.success) all.push(...r.value.data);
        }
      }
      servicesCache = { items: all, fetchedAt: Date.now() };
      return all;
    } finally {
      servicesFetchInFlight = null;
    }
  })();
  return servicesFetchInFlight;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/mitos.ts
git commit -m "feat(mitos): types, API client, 1h services cache"
```

---

## Task 6: `tools.ts` — `extractLegalBasis` (PRIORITY, TDD)

**Files:**
- Create: `src/tools.ts`
- Create: `src/tools.test.ts`

- [ ] **Step 1: Write the failing test (uses verified live field shapes)**

Create `src/tools.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLegalBasis } from "./tools.js";
import type { ExtendedResponse } from "./mitos.js";

const fixture: ExtendedResponse = {
  success: true,
  data: {
    title: { el: "Αποδεικτικό φορολογικής ενημερότητας" },
    metadata: {
      process_rules: [
        {
          rule_type: "Νόμος",
          rule_decision_number: "5222",
          rule_decision_year: "2025",
          rule_article: "216",
          rule_description: "Αποδεικτικό ενημερότητας",
          rule_gazette_doc_number: 134,
          rule_gazette_doc_issue: "Α",
          rule_ada: "Ρ7ΩΗ46ΜΠ3Ζ-19Γ",
          rule_url: "https://example.gr/a.pdf",
        },
        {
          rule_type: "Νόμος",
          rule_decision_number: "5104",
          rule_decision_year: "2024",
          rule_article: "12",
          rule_description: "Αποδεικτικό ενημερότητας και βεβαίωση οφειλής",
          rule_gazette_doc_number: 58,
          rule_gazette_doc_issue: "Α",
          rule_url: "https://example.gr/b.pdf",
        },
      ],
    },
  },
};

test("extractLegalBasis returns structured rules with verified shapes", () => {
  const out = extractLegalBasis("439993", fixture);
  assert.equal(out.procedure_id, "439993");
  assert.equal(out.title, "Αποδεικτικό φορολογικής ενημερότητας");
  assert.equal(out.rules.length, 2);
  assert.equal(out.rules[0].rule_gazette_doc_number, 134); // number preserved
  assert.equal(out.rules[0].rule_ada, "Ρ7ΩΗ46ΜΠ3Ζ-19Γ");
});

test("extractLegalBasis omits absent optional rule_ada", () => {
  const out = extractLegalBasis("439993", fixture);
  assert.equal("rule_ada" in out.rules[1], false);
});

test("extractLegalBasis handles missing process_rules", () => {
  const empty: ExtendedResponse = { success: true, data: { metadata: {} } };
  const out = extractLegalBasis("1", empty);
  assert.deepEqual(out.rules, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `extractLegalBasis`.

- [ ] **Step 3: Implement**

Create `src/tools.ts`:

```typescript
import type { ExtendedResponse, ServiceTitle } from "./mitos.js";

export interface LegalRule {
  rule_type?: string;
  rule_decision_number?: string;
  rule_decision_year?: string;
  rule_article?: string;
  rule_description?: string;
  rule_gazette_doc_number?: number;
  rule_gazette_doc_issue?: string;
  rule_ada?: string;
  rule_url?: string;
}
export interface LegalBasis {
  procedure_id: string;
  title?: string;
  rules: LegalRule[];
}

const RULE_KEYS: (keyof LegalRule)[] = [
  "rule_type",
  "rule_decision_number",
  "rule_decision_year",
  "rule_article",
  "rule_description",
  "rule_gazette_doc_number",
  "rule_gazette_doc_issue",
  "rule_ada",
  "rule_url",
];

/**
 * Extract structured legal-basis citations from a services-extended response.
 * Passes through only the verified MITOS fields; omits absent ones (e.g. rule_ada).
 * Never fabricates kodiko_url / law_id — those do not exist in the API.
 */
export function extractLegalBasis(id: string, ext: ExtendedResponse): LegalBasis {
  const metadata = ext.data?.metadata as Record<string, unknown> | undefined;
  const title = (ext.data?.title as ServiceTitle | undefined)?.el;
  const raw = metadata?.process_rules;
  const rules: LegalRule[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw as Record<string, unknown>[]) {
      const rule: LegalRule = {};
      for (const k of RULE_KEYS) {
        const v = r[k];
        if (v !== undefined && v !== null && v !== "") {
          (rule as Record<string, unknown>)[k] = v;
        }
      }
      rules.push(rule);
    }
  }
  return { procedure_id: id, title, rules };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat(tools): extractLegalBasis structured citations with tests"
```

---

## Task 7: `tools.ts` — `searchProcedures` filter logic (TDD for the pure filter)

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/tools.test.ts`

- [ ] **Step 1: Add the failing test for the pure title-filter helper**

Append to `src/tools.test.ts`:

```typescript
import { filterByTitle } from "./tools.js";
import type { ServiceListItem } from "./mitos.js";

const services: ServiceListItem[] = [
  { id: "1", title: { el: "Φορολογία πολιτών", en: "Citizen taxation" }, ns: "", last_updated: "" },
  { id: "2", title: { el: "Άδεια οδήγησης", en: "Driving licence" }, ns: "", last_updated: "" },
];

test("filterByTitle matches Greek accent-insensitively", () => {
  assert.deepEqual(filterByTitle(services, "φορολογια", "el").map((s) => s.id), ["1"]);
});

test("filterByTitle matches English when language=en", () => {
  assert.deepEqual(filterByTitle(services, "driving", "en").map((s) => s.id), ["2"]);
});

test("filterByTitle searches both languages by default", () => {
  assert.deepEqual(filterByTitle(services, "licence", "both").map((s) => s.id), ["2"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `filterByTitle` not exported.

- [ ] **Step 3: Implement**

Add to `src/tools.ts` (add `normalize`, `ServiceListItem` to the imports from `./mitos.js`):

```typescript
import { normalize, type ServiceListItem } from "./mitos.js";

/** Pure title filter — accent-insensitive substring match in the chosen language(s). */
export function filterByTitle(
  services: ServiceListItem[],
  query: string,
  language: string
): ServiceListItem[] {
  const q = normalize(query.trim());
  const lang = language.toLowerCase();
  return services.filter((svc) => {
    const el = normalize(svc.title.el ?? "");
    const en = normalize(svc.title.en ?? "");
    if (lang === "en") return en.includes(q);
    if (lang === "el") return el.includes(q);
    return el.includes(q) || en.includes(q);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/tools.test.ts
git commit -m "feat(tools): pure title filter with tests"
```

---

## Task 8: `tools.ts` — formatters, all 5 handlers, tool definitions, dispatcher

**Files:**
- Modify: `src/tools.ts`

- [ ] **Step 1: Add small format helpers**

Append to `src/tools.ts` (extend the `./mitos.js` import to add
`BASE_URL, FETCH_CONCURRENCY, ExtendedResponse, getExtended, fetchAllServices, fetchJson, pool, formatDuration` as needed):

```typescript
import {
  BASE_URL,
  FETCH_CONCURRENCY,
  fetchAllServices,
  fetchJson,
  getExtended,
  pool,
  formatDuration,
  type ExtendedResponse,
  type ListResponse,
} from "./mitos.js";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}
```

(Consolidate the `./mitos.js` imports into a single import statement; do not leave duplicate import lines.)

- [ ] **Step 2: Add `searchProcedures` handler**

Append to `src/tools.ts`:

```typescript
export async function searchProcedures(
  query: string,
  language: string,
  category?: string
): Promise<string> {
  const all = await fetchAllServices();
  let matches = filterByTitle(all, query, language);
  if (matches.length === 0) return `No procedures found matching "${query}".`;

  const cat = category?.trim();
  if (cat) {
    const catLower = cat.toLowerCase();
    const subset = matches.slice(0, 200);
    const tasks = subset.map((svc) => () => getExtended(svc.id));
    const results = await pool(tasks, FETCH_CONCURRENCY);
    const filtered: ServiceListItem[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled" || !r.value.success) continue;
      const proc = (r.value.data?.metadata as Record<string, unknown>)?.process as
        | Record<string, unknown>
        | undefined;
      const events = proc?.life_events as string[] | undefined;
      if (events?.some((e) => e.toLowerCase().includes(catLower))) filtered.push(subset[i]);
    }
    matches = filtered;
    if (matches.length === 0)
      return `No procedures found matching "${query}" in category "${cat}".`;
  }

  const lines = matches.slice(0, 50).map((svc) => {
    const en = svc.title.en ? ` / ${svc.title.en}` : "";
    return `• [${svc.id}] ${svc.title.el}${en}`;
  });
  const total = matches.length;
  const note =
    total > 50
      ? `\n(Showing first 50 of ${total} matches)`
      : `\n(${total} result${total === 1 ? "" : "s"})`;
  return lines.join("\n") + note;
}
```

- [ ] **Step 3: Add `getProcedure` handler (markdown formatter lifted from old index.ts)**

Append to `src/tools.ts` the `getProcedure(id: string): Promise<string>` function,
copied verbatim from the current `src/index.ts` lines 253–472 (the body from
`const json = await fetchJson...` through `return lines.join("\n");`), with these
adjustments: call `getExtended(id)` instead of the inline `fetchJson` URL, and use
the module-level `str`, `arr`, `formatDuration`. Do not change the formatting logic.

```typescript
export async function getProcedure(id: string): Promise<string> {
  const json = await getExtended(id);
  if (!json.success || !json.data) return `Procedure ${id} not found.`;
  // ... (verbatim markdown-building body from old src/index.ts:262–471) ...
  return lines.join("\n");
}
```

- [ ] **Step 4: Add `listCategories` and `listProceduresByCategory` handlers**

Append to `src/tools.ts`:

```typescript
const SAMPLE_SIZE = 150;

interface CategoriesCache {
  categories: string[];
  fetchedAt: number;
}
let categoriesCache: CategoriesCache | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Evenly-spread sample across the full services list, keeping each source item
 * paired with its extended response (the extended body does NOT reliably include
 * the id, so we carry it from the list item).
 */
interface SampledItem {
  item: ServiceListItem;
  ext: ExtendedResponse;
}
async function sampleExtended(): Promise<SampledItem[]> {
  const all = await fetchAllServices();
  const step = Math.max(1, Math.floor(all.length / SAMPLE_SIZE));
  const sample = all.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
  const results = await pool(
    sample.map((svc) => () => getExtended(svc.id)),
    FETCH_CONCURRENCY
  );
  const out: SampledItem[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value.success) out.push({ item: sample[i], ext: r.value });
  }
  return out;
}

function lifeEventsOf(ext: ExtendedResponse): string[] {
  const proc = (ext.data?.metadata as Record<string, unknown>)?.process as
    | Record<string, unknown>
    | undefined;
  return (proc?.life_events as string[] | undefined) ?? [];
}

export async function listCategories(): Promise<string> {
  if (categoriesCache && Date.now() - categoriesCache.fetchedAt < CACHE_TTL_MS) {
    const c = categoriesCache.categories;
    return `${c.length} life event categories:\n\n` + c.map((x) => `• ${x}`).join("\n");
  }
  const samples = await sampleExtended();
  const set = new Set<string>();
  for (const s of samples) lifeEventsOf(s.ext).forEach((e) => set.add(e));
  if (set.size === 0) return "No categories found.";
  const sorted = [...set].sort((a, b) => a.localeCompare(b, "el"));
  categoriesCache = { categories: sorted, fetchedAt: Date.now() };
  return (
    `${sorted.length} life event categories (sampled from ${samples.length} procedures):\n\n` +
    sorted.map((c) => `• ${c}`).join("\n")
  );
}

export async function listProceduresByCategory(
  category: string,
  limit: number
): Promise<string> {
  const catLower = category.trim().toLowerCase();
  const samples = await sampleExtended();
  const matches: string[] = [];
  for (const s of samples) {
    if (lifeEventsOf(s.ext).some((e) => e.toLowerCase().includes(catLower))) {
      matches.push(`• [${s.item.id}] ${s.item.title.el}`);
    }
  }
  const header =
    `Procedures in category "${category}" ` +
    `(NOTE: sampled from ~${samples.length} procedures, not an exhaustive scan of all ~4305 — ` +
    `MITOS has no category endpoint):\n\n`;
  if (matches.length === 0) return header + "No matches in the sampled set.";
  return header + matches.slice(0, limit).join("\n");
}

export async function getLegalBasisArticles(id: string): Promise<string> {
  const ext = await getExtended(id);
  if (!ext.success || !ext.data) return JSON.stringify({ procedure_id: id, rules: [] }, null, 2);
  return JSON.stringify(extractLegalBasis(id, ext), null, 2);
}
```

- [ ] **Step 5: Add tool definitions and the `callTool` dispatcher**

Append to `src/tools.ts`:

```typescript
export const toolDefinitions = [
  {
    name: "search_procedures",
    description:
      "Search Greek administrative procedures (MITOS registry) by keyword. Returns matching procedure IDs and Greek/English titles. Cached after first call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search in procedure titles" },
        language: {
          type: "string",
          enum: ["el", "en", "both"],
          description: "Which title language to search; default 'both'",
          default: "both",
        },
        category: {
          type: "string",
          description: "Optional life-event category filter. Use list_categories for values.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_procedure",
    description:
      "Get full details of a MITOS procedure by ID: description, eligibility, steps (in-person + digital), timeframe, cost, legal basis, service points, links.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Numeric MITOS procedure ID, e.g. '439993'" } },
      required: ["id"],
    },
  },
  {
    name: "list_categories",
    description:
      "List life-event categories in MITOS (e.g. 'Φορολογία πολιτών'). Sampled (~150 procedures), not exhaustive — MITOS has no categories endpoint. Cached after first call.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_procedures_by_category",
    description:
      "List procedures whose life events include a category. LIMITATION: works over a ~150-procedure sample, NOT all ~4305 — MITOS has no category endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Life-event category to match" },
        limit: { type: "number", description: "Max results (default 50)", default: 50 },
      },
      required: ["category"],
    },
  },
  {
    name: "get_legal_basis_articles",
    description:
      "Get structured, machine-readable legal-basis citations (statute type, number, year, article, gazette/FEK, ΔΙΑΥΓΕΙΑ ADA, URL) for a procedure, for cross-checking against legal MCPs.",
    inputSchema: {
      type: "object",
      properties: { procedure_id: { type: "string", description: "Numeric MITOS procedure ID" } },
      required: ["procedure_id"],
    },
  },
];

/** Dispatch a tool call to its handler. Throws on unknown tool / bad args. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "search_procedures": {
      const query = (args.query as string) ?? "";
      if (!query.trim()) throw new Error("query must not be empty");
      return searchProcedures(query, (args.language as string) ?? "both", args.category as string | undefined);
    }
    case "get_procedure": {
      const id = (args.id as string) ?? "";
      if (!id.trim()) throw new Error("id must not be empty");
      return getProcedure(id);
    }
    case "list_categories":
      return listCategories();
    case "list_procedures_by_category": {
      const category = (args.category as string) ?? "";
      if (!category.trim()) throw new Error("category must not be empty");
      return listProceduresByCategory(category, (args.limit as number) ?? 50);
    }
    case "get_legal_basis_articles": {
      const id = (args.procedure_id as string) ?? "";
      if (!id.trim()) throw new Error("procedure_id must not be empty");
      return getLegalBasisArticles(id);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 6: Type-check and run unit tests**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm test`
Expected: PASS (all earlier tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts
git commit -m "feat(tools): all 5 handlers, tool defs, dispatcher"
```

---

## Task 9: `index.ts` — Express app, fail-closed auth, stateless /mcp, /health

**Files:**
- Modify: `src/index.ts` (replace entire file)

- [ ] **Step 1: Replace `src/index.ts` with the HTTP server**

```typescript
#!/usr/bin/env node
import express, { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchAllServices } from "./mitos.js";
import { toolDefinitions, callTool } from "./tools.js";

const TOKEN = process.env.MITOS_MCP_AUTH_TOKEN;
const PORT = Number(process.env.PORT ?? 8743);

// Fail closed: refuse to start without an auth token (prevents accidental open deploy).
if (!TOKEN) {
  process.stderr.write("FATAL: MITOS_MCP_AUTH_TOKEN is not set. Refusing to start.\n");
  process.exit(1);
}

function tokenValid(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOKEN as string);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Build a fresh MCP server instance (no shared per-request state). */
function buildServer(): Server {
  const server = new Server(
    { name: "mitos-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const text = await callTool(name, (args ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });
  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!tokenValid(req.headers.authorization)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }
  next();
}

// Stateless Streamable HTTP: a fresh transport + server per request.
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    process.stderr.write(`/mcp error: ${err}\n`);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`MITOS MCP server listening on 0.0.0.0:${PORT}\n`);
  fetchAllServices().catch((err) => process.stderr.write(`Cache warm-up failed: ${err}\n`));
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `dist/index.js`, `dist/mitos.js`, `dist/tools.js` produced, no errors.

- [ ] **Step 4: Verify fail-closed behavior**

Run (PowerShell): `node dist/index.js`
Expected: prints "FATAL: MITOS_MCP_AUTH_TOKEN is not set" and exits 1.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: stateless Streamable HTTP server with fail-closed bearer auth"
```

---

## Task 10: Live smoke test script

**Files:**
- Create: `scripts/smoke.mjs`

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke.mjs`:

```javascript
// Live smoke test: starts nothing — assumes the server is already running.
// Usage: MITOS_MCP_AUTH_TOKEN=<t> PORT=8743 node scripts/smoke.mjs
const PORT = process.env.PORT ?? 8743;
const TOKEN = process.env.MITOS_MCP_AUTH_TOKEN;
const BASE = `http://127.0.0.1:${PORT}`;

if (!TOKEN) {
  console.error("Set MITOS_MCP_AUTH_TOKEN to the server's token.");
  process.exit(1);
}

async function rpc(method, params, id) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
  const text = await res.text();
  // Streamable HTTP may return SSE; extract the JSON data line if so.
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text;
  const json = JSON.parse(line.replace(/^data:\s*/, ""));
  if (json.error) throw new Error(`${method} -> ${JSON.stringify(json.error)}`);
  return json.result;
}

let ok = 0, fail = 0;
function check(name, cond) {
  if (cond) { ok++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// 1. health (unauthenticated)
const health = await fetch(`${BASE}/health`).then((r) => r.json());
check("health is ok", health.status === "ok");

// 2. unauthorized /mcp is rejected
const unauth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 0 }),
});
check("unauthorized /mcp -> 401", unauth.status === 401);

// 3. tools/list returns all 5
const list = await rpc("tools/list", {}, 1);
check("tools/list returns 5 tools", list.tools.length === 5);

// 4. search_procedures
const search = await rpc("tools/call", { name: "search_procedures", arguments: { query: "φορολογ" } }, 2);
check("search_procedures returns text", typeof search.content?.[0]?.text === "string" && search.content[0].text.length > 0);

// 5. get_legal_basis_articles returns valid JSON with rules
const legal = await rpc("tools/call", { name: "get_legal_basis_articles", arguments: { procedure_id: "439993" } }, 3);
const parsed = JSON.parse(legal.content[0].text);
check("get_legal_basis_articles returns rules array", Array.isArray(parsed.rules) && parsed.rules.length > 0);
check("legal rule has rule_type", typeof parsed.rules[0].rule_type === "string");

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the live smoke test**

In terminal A (PowerShell): `$env:MITOS_MCP_AUTH_TOKEN="testtoken"; npm run build; node dist/index.js`
In terminal B (PowerShell): `$env:MITOS_MCP_AUTH_TOKEN="testtoken"; npm run smoke`
Expected: all checks PASS, "6 passed, 0 failed". Stop terminal A afterward.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.mjs
git commit -m "test: live HTTP smoke script for health + 5 tools"
```

---

## Task 11: Deployment artifacts

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `nginx.conf.example`, `.dockerignore`
- Create/replace: `README.md`

- [ ] **Step 1: `.dockerignore`**

Create `.dockerignore`:

```
node_modules
dist
.git
docs
*.log
```

- [ ] **Step 2: Multi-stage `Dockerfile`**

Create `Dockerfile`:

```dockerfile
# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8743
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: `docker-compose.yml`**

Create `docker-compose.yml`:

```yaml
services:
  mitos-mcp:
    build: .
    restart: unless-stopped
    ports:
      - "8743:8743"
    environment:
      MITOS_MCP_AUTH_TOKEN: ${MITOS_MCP_AUTH_TOKEN:?set MITOS_MCP_AUTH_TOKEN}
      PORT: "8743"
```

- [ ] **Step 4: `nginx.conf.example`**

Create `nginx.conf.example`:

```nginx
# Reverse proxy mitos.<your-domain> -> 127.0.0.1:8743 (HTTPS via Let's Encrypt/certbot).
server {
    listen 80;
    server_name mitos.example.com;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name mitos.example.com;

    ssl_certificate     /etc/letsencrypt/live/mitos.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mitos.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8743;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Streamable HTTP may stream responses; disable buffering.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

- [ ] **Step 5: `README.md`**

Create `README.md` with these sections (write full prose, no placeholders):
1. **What it is** — MCP server over MITOS, 5 tools, stateless HTTP.
2. **Tools** — table of the 5 tools + the sampling/legal-basis limitations.
3. **Local run** — `npm install`, `npm run build`, `$env:MITOS_MCP_AUTH_TOKEN=...; npm start`, then `npm run smoke`.
4. **Docker** — `MITOS_MCP_AUTH_TOKEN=... docker compose up --build`.
5. **VPS deploy (Ubuntu/Hostinger)** — clone, `docker compose up -d`, install nginx + certbot, copy `nginx.conf.example` to `/etc/nginx/sites-available/mitos`, `certbot --nginx -d mitos.<domain>`, reload nginx.
6. **Claude for Word connector** — add a custom connector with URL `https://mitos.<domain>/mcp` and header `Authorization: Bearer <token>`.
7. **Environment** — `MITOS_MCP_AUTH_TOKEN` (required, server refuses to start without it), `PORT` (default 8743).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml nginx.conf.example .dockerignore README.md
git commit -m "docs: deployment artifacts (Docker, compose, nginx, README)"
```

---

## Task 12: Final verification + progress update

**Files:**
- Modify: `progress.md`

- [ ] **Step 1: Full type-check, build, unit tests**

Run: `npx tsc --noEmit` → no errors.
Run: `npm run build` → dist produced.
Run: `npm test` → all unit tests PASS.

- [ ] **Step 2: Full live smoke (per Task 10 Step 2)**

Expected: "6 passed, 0 failed".

- [ ] **Step 3: Update `progress.md`**

Mark steps 5–6 of NEXT STEPS done; note the rewrite is complete and smoke-tested locally; remaining open item: VPS deploy + Claude-for-Word connection.

- [ ] **Step 4: Commit**

```bash
git add progress.md
git commit -m "docs: mark HTTP rewrite complete; VPS deploy remains"
```

---

## Self-Review Notes

- **Spec coverage:** transport (Task 9), file layout (Tasks 2–9), all 5 tools
  (Tasks 6–8), auth fail-closed (Task 9), deployment artifacts (Task 11), testing
  path (Tasks 10, 12), verified `process_rules` shape (Task 6). All covered.
- **Type consistency:** `extractLegalBasis(id, ext)`, `filterByTitle(services, query, language)`,
  `callTool(name, args)`, `toolDefinitions`, `buildServer()` are used consistently
  across tasks.
- **Known soft spot:** Task 8 Step 3 references the verbatim markdown body from the
  old `src/index.ts:262–471` rather than re-printing ~210 lines. The source is in
  git history (commit 9f6af7d) and unchanged in the working tree at plan time — the
  implementer copies it directly.
```
