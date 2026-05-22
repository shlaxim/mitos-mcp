#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = "https://api.digigov.grnet.gr/v1";
const PAGE_LIMIT = 100;
const FETCH_CONCURRENCY = 10; // parallel HTTP requests
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------- Types ----------

interface ServiceTitle {
  el: string;
  en?: string;
}

interface ServiceListItem {
  id: string;
  title: ServiceTitle;
  ns: string;
  last_updated: string;
}

interface ListResponse {
  data: ServiceListItem[];
  success: boolean;
  total: number;
  next_page: number | null;
  current_page: number;
  limit: number;
}

interface ExtendedResponse {
  data: Record<string, unknown>;
  success: boolean;
}

// ---------- API helpers ----------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

/** Run an array of async tasks with a maximum concurrency. */
async function pool<T>(
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

// ---------- In-memory cache ----------

interface ServicesCache {
  items: ServiceListItem[];
  fetchedAt: number;
}

interface CategoriesCache {
  categories: string[];
  fetchedAt: number;
}

let servicesCache: ServicesCache | null = null;
let categoriesCache: CategoriesCache | null = null;
// In-flight promise deduplication: prevents duplicate full fetches on concurrent cold calls
let servicesFetchInFlight: Promise<ServiceListItem[]> | null = null;

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < CACHE_TTL_MS;
}

/**
 * Normalize a string for accent-insensitive matching.
 * Strips Greek tonos/dialytika and lowercases, so "φορολογια" matches "φορολογία".
 */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase();
}

/**
 * Fetch all services using parallel page requests.
 * First fetches page 1 to learn the total, then fetches remaining pages
 * concurrently (up to FETCH_CONCURRENCY at a time).
 * Deduplicates concurrent cold-cache calls so only one fetch runs at a time.
 */
async function fetchAllServices(): Promise<ServiceListItem[]> {
  if (servicesCache && isFresh(servicesCache.fetchedAt)) {
    return servicesCache.items;
  }

  // If a fetch is already in flight, share its promise
  if (servicesFetchInFlight) return servicesFetchInFlight;

  servicesFetchInFlight = (async () => {
    try {
      // Fetch page 1 to get total count
      const first = await fetchJson<ListResponse>(
        `${BASE_URL}/services/?page=1&limit=${PAGE_LIMIT}`
      );
      if (!first.success) throw new Error("Failed to fetch services list");

      const totalPages = Math.ceil(first.total / PAGE_LIMIT);
      const all: ServiceListItem[] = [...first.data];

      if (totalPages > 1) {
        const remainingTasks = Array.from({ length: totalPages - 1 }, (_, i) => {
          const page = i + 2;
          return () =>
            fetchJson<ListResponse>(
              `${BASE_URL}/services/?page=${page}&limit=${PAGE_LIMIT}`
            );
        });

        const results = await pool(remainingTasks, FETCH_CONCURRENCY);
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.success) {
            all.push(...r.value.data);
          }
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

// ---------- Tool: search_procedures ----------

async function searchProcedures(
  query: string,
  language: string,
  category?: string
): Promise<string> {
  const allServices = await fetchAllServices();
  const q = normalize(query.trim());
  const lang = language.toLowerCase();
  const cat = category?.trim();

  // If a category filter is requested we need to match against life_events,
  // which requires extended data. To keep this fast we filter by title first,
  // then apply the category filter only on the title-matched subset (max 200).
  let titleMatches = allServices.filter((svc) => {
    const elTitle = normalize(svc.title.el ?? "");
    const enTitle = normalize(svc.title.en ?? "");
    if (lang === "en") return enTitle.includes(q);
    if (lang === "el") return elTitle.includes(q);
    return elTitle.includes(q) || enTitle.includes(q);
  });

  if (titleMatches.length === 0) {
    return `No procedures found matching "${query}".`;
  }

  // Category filter: fetch extended for up to 200 title-matched services
  if (cat) {
    const catLower = cat.toLowerCase();
    const subset = titleMatches.slice(0, 200);
    const tasks = subset.map(
      (svc) => () =>
        fetchJson<ExtendedResponse>(`${BASE_URL}/services-extended/${svc.id}`)
    );
    const results = await pool(tasks, FETCH_CONCURRENCY);
    const filtered: ServiceListItem[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status !== "fulfilled" || !r.value.success) continue;
      const proc = (r.value.data?.metadata as Record<string, unknown>)
        ?.process as Record<string, unknown> | undefined;
      const events = proc?.life_events as string[] | undefined;
      if (events?.some((e) => e.toLowerCase().includes(catLower))) {
        filtered.push(subset[i]);
      }
    }
    titleMatches = filtered;
    if (titleMatches.length === 0) {
      return `No procedures found matching "${query}" in category "${cat}".`;
    }
  }

  const lines = titleMatches.slice(0, 50).map((svc) => {
    const en = svc.title.en ? ` / ${svc.title.en}` : "";
    return `• [${svc.id}] ${svc.title.el}${en}`;
  });

  const total = titleMatches.length;
  const note =
    total > 50
      ? `\n(Showing first 50 of ${total} matches)`
      : `\n(${total} result${total === 1 ? "" : "s"})`;

  return lines.join("\n") + note;
}

// ---------- Tool: get_procedure ----------

function formatDuration(iso?: string): string | undefined {
  if (!iso) return undefined;
  const match = iso.match(
    /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/
  );
  if (!match) return iso;
  const [, years, months, days, hours, minutes, seconds] = match;
  const parts: string[] = [];
  if (years) parts.push(`${years} year${+years > 1 ? "s" : ""}`);
  if (months) parts.push(`${months} month${+months > 1 ? "s" : ""}`);
  if (days) parts.push(`${days} day${+days > 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hour${+hours > 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${+minutes > 1 ? "s" : ""}`);
  if (seconds) parts.push(`${seconds} second${+seconds > 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : iso;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

async function getProcedure(id: string): Promise<string> {
  const json = await fetchJson<ExtendedResponse>(
    `${BASE_URL}/services-extended/${id}`
  );

  if (!json.success || !json.data) {
    return `Procedure ${id} not found.`;
  }

  const d = json.data;
  const title = d.title as ServiceTitle | undefined;
  const metadata = d.metadata as Record<string, unknown> | undefined;
  const proc = metadata?.process as Record<string, unknown> | undefined;
  // glance is a sibling of process inside metadata, not nested inside process
  const glance = metadata?.glance as Record<string, unknown> | undefined;

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`# ${title?.el ?? id}`);
  if (title?.en) lines.push(`**English:** ${title.en}`);
  const altTitles = arr(proc?.alternative_titles) as string[] | undefined;
  if (altTitles) lines.push(`**Also known as:** ${altTitles.join(", ")}`);
  lines.push(`**ID:** ${id}`);
  lines.push(`**URL:** ${str(d.url) ?? `https://id.mitos.gov.gr/${id}`}`);
  lines.push(`**Last updated:** ${str(d.last_updated) ?? "N/A"}`);

  // Responsible organisation
  const orgOwner = proc?.org_owner as Record<string, unknown> | undefined;
  const orgTitle = (orgOwner?.title as ServiceTitle | undefined)?.el;
  if (orgTitle) lines.push(`**Responsible authority:** ${orgTitle}`);
  lines.push("");

  // ── Description ───────────────────────────────────────────────────────────
  const desc = str(proc?.description);
  if (desc) {
    lines.push("## Description");
    lines.push(desc);
    lines.push("");
  }

  // ── Remarks ───────────────────────────────────────────────────────────────
  const remarks = str(proc?.remarks);
  if (remarks) {
    lines.push("> **Note:** " + remarks);
    lines.push("");
  }

  // ── At a Glance ───────────────────────────────────────────────────────────
  if (glance) {
    const glanceLines: string[] = [];

    const cost = str((glance.cost as Record<string, unknown>)?.value);
    if (cost) glanceLines.push(`**Cost:** ${cost}`);

    const evidences = str((glance.evidences as Record<string, unknown>)?.value);
    if (evidences) glanceLines.push(`**Required documents:** ${evidences}`);

    const digDuration = str(
      (glance.duration_steps_digital as Record<string, unknown>)?.value
    );
    if (digDuration) glanceLines.push(`**Digital processing time:** ${digDuration}`);

    // Validity of the issued document
    const validityDuration = str(proc?.validity_duration);
    if (validityDuration) {
      glanceLines.push(
        `**Document validity:** ${formatDuration(validityDuration) ?? validityDuration}`
      );
    }

    // How the output is delivered
    const deliveryType = arr(proc?.delivery_type) as string[] | undefined;
    if (deliveryType) glanceLines.push(`**Delivery:** ${deliveryType.join(", ")}`);

    if (glanceLines.length > 0) {
      lines.push("## At a Glance");
      lines.push(...glanceLines);
      lines.push("");
    }
  }

  // ── Timeframe ─────────────────────────────────────────────────────────────
  const deadline = str(proc?.deadline_duration);
  if (deadline) {
    lines.push("## Timeframe");
    lines.push(`**Statutory deadline:** ${formatDuration(deadline) ?? deadline}`);
    lines.push("");
  }

  // ── Categories & audience ─────────────────────────────────────────────────
  const lifeEvents = arr(proc?.life_events) as string[] | undefined;
  if (lifeEvents) {
    lines.push(`**Categories:** ${lifeEvents.join(", ")}`);
  }

  const providedTo = arr(proc?.provided_to) as string[] | undefined;
  if (providedTo) {
    lines.push(`**Provided to:** ${providedTo.join(", ")}`);
  }

  if (lifeEvents || providedTo) lines.push("");

  // ── Eligibility conditions ────────────────────────────────────────────────
  const conditions = arr(metadata?.process_conditions) as
    | Array<Record<string, unknown>>
    | undefined;
  if (conditions) {
    lines.push("## Eligibility Conditions");
    for (const c of conditions) {
      const name = str(c.conditions_name) ?? "";
      const type = str(c.conditions_type) ?? "";
      const alt = c.conditions_alternative ? " (alternative)" : "";
      lines.push(`- **${type}${alt}:** ${name}`);
    }
    lines.push("");
  }

  // ── How to apply ─────────────────────────────────────────────────────────
  const appNote = str(proc?.application_note);
  if (appNote) {
    lines.push("## How to Apply");
    lines.push(appNote);
    lines.push("");
  }

  // ── Digital process steps ─────────────────────────────────────────────────
  const digitalSteps = arr(metadata?.process_steps_digital) as
    | Array<Record<string, unknown>>
    | undefined;
  if (digitalSteps) {
    lines.push("## Digital Process Steps");
    for (const step of digitalSteps) {
      const num = step.step_digital_num_id;
      const t = str(step.step_digital_title) ?? "";
      const d2 = str(step.step_digital_description);
      const exit = step.step_digital_exit ? " [EXIT]" : "";
      lines.push(`${num}. **${t}**${exit}`);
      if (d2) lines.push(`   ${d2}`);
    }
    lines.push("");
  }

  // ── Legal basis ───────────────────────────────────────────────────────────
  const rules = arr(metadata?.process_rules) as
    | Array<Record<string, unknown>>
    | undefined;
  if (rules) {
    lines.push("## Legal Basis");
    for (const r of rules) {
      const type = str(r.rule_type) ?? "";
      const num = str(r.rule_decision_number);
      const year = str(r.rule_decision_year);
      const rDesc = str(r.rule_description) ?? "";
      const rUrl = str(r.rule_url);
      const ref = num && year ? ` ${num}/${year}` : num ? ` ${num}` : "";
      const link = rUrl ? ` — ${rUrl}` : "";
      lines.push(`- **${type}${ref}:** ${rDesc}${link}`);
    }
    lines.push("");
  }

  // ── Service points (physical) ─────────────────────────────────────────────
  if (glance) {
    const svcPoints = (glance.service_points as Record<string, unknown>)?.value;
    const svcArr = arr(svcPoints) as Array<Record<string, unknown>> | undefined;
    if (svcArr) {
      lines.push("## Where to Apply (In Person)");
      for (const sp of svcArr) {
        const spTitle = str(sp.title) ?? "";
        const spUrl = str(sp.url);
        lines.push(spUrl ? `- [${spTitle}](${spUrl})` : `- ${spTitle}`);
      }
      lines.push("");
    }
  }

  // ── Digital service locations ─────────────────────────────────────────────
  const digitalLocations = arr(
    metadata?.process_provision_digital_locations
  ) as Array<Record<string, unknown>> | undefined;
  if (digitalLocations) {
    lines.push("## Where to Apply (Digital)");
    for (const l of digitalLocations) {
      const lt = str(l.provision_digital_location_title) ?? "";
      const lu = str(l.provision_digital_location_url);
      lines.push(lu ? `- [${lt}](${lu})` : `- ${lt}`);
    }
    lines.push("");
  }

  // ── gov.gr portal links ───────────────────────────────────────────────────
  const govgrCodes = arr(proc?.govgr_codes) as
    | Array<Record<string, unknown>>
    | undefined;
  if (govgrCodes) {
    lines.push("## Apply on gov.gr");
    for (const g of govgrCodes) {
      const gt = (g.title as ServiceTitle | undefined)?.el ?? str(g.title) ?? "";
      const gu = str(g.url);
      lines.push(gu ? `- [${gt}](${gu})` : `- ${gt}`);
    }
    lines.push("");
  }

  // ── Useful links ──────────────────────────────────────────────────────────
  const usefulLinks = arr(metadata?.process_useful_links) as
    | Array<Record<string, unknown>>
    | undefined;
  if (usefulLinks) {
    lines.push("## Useful Links");
    for (const l of usefulLinks) {
      const lt = str(l.useful_link_title) ?? "";
      const lu = str(l.useful_link_url);
      lines.push(lu ? `- [${lt}](${lu})` : `- ${lt}`);
    }
  }

  return lines.join("\n");
}

// ---------- Tool: list_categories ----------

async function listCategories(): Promise<string> {
  if (categoriesCache && isFresh(categoriesCache.fetchedAt)) {
    const sorted = categoriesCache.categories;
    return (
      `${sorted.length} life event categories:\n\n` +
      sorted.map((c) => `• ${c}`).join("\n")
    );
  }

  // Use the cached services list to sample evenly across the full dataset
  const allServices = await fetchAllServices();

  // Sample up to 150 IDs evenly spread across the full list
  const SAMPLE_SIZE = 150;
  const step = Math.max(1, Math.floor(allServices.length / SAMPLE_SIZE));
  const sample = allServices.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

  const tasks = sample.map(
    (svc) => () =>
      fetchJson<ExtendedResponse>(`${BASE_URL}/services-extended/${svc.id}`)
  );

  const results = await pool(tasks, FETCH_CONCURRENCY);
  const categorySet = new Set<string>();

  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value.success) continue;
    const proc = (r.value.data?.metadata as Record<string, unknown>)
      ?.process as Record<string, unknown> | undefined;
    const events = proc?.life_events as string[] | undefined;
    if (events) events.forEach((e) => categorySet.add(e));
  }

  if (categorySet.size === 0) return "No categories found.";

  const sorted = [...categorySet].sort((a, b) => a.localeCompare(b, "el"));
  categoriesCache = { categories: sorted, fetchedAt: Date.now() };

  return (
    `${sorted.length} life event categories (sampled from ${sample.length} procedures across ${allServices.length} total):\n\n` +
    sorted.map((c) => `• ${c}`).join("\n")
  );
}

// ---------- MCP Server ----------

const server = new Server(
  { name: "mitos-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_procedures",
      description:
        "Search Greek administrative procedures (MITOS registry) by keyword. Returns matching procedure IDs, Greek titles, and English titles where available. Results are cached after the first call.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword to search for in procedure titles",
          },
          language: {
            type: "string",
            enum: ["el", "en", "both"],
            description:
              "Which language title to search: 'el' for Greek, 'en' for English, 'both' (default)",
            default: "both",
          },
          category: {
            type: "string",
            description:
              "Optional life-event category filter (e.g. 'Φορολογία πολιτών'). Use list_categories to see available values.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_procedure",
      description:
        "Get full details of a MITOS administrative procedure by its ID. Returns description, eligibility conditions, process steps (in-person and digital), timeframe, cost, legal basis, service points, and useful links.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The numeric MITOS procedure ID (e.g. '439993')",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "list_categories",
      description:
        "List all available life-event categories in the MITOS registry (e.g. 'Φορολογία πολιτών', 'Υγεία', 'Εκπαίδευση'). Results are cached after the first call.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    if (name === "search_procedures") {
      const query = (args?.query as string) ?? "";
      const language = (args?.language as string) ?? "both";
      const category = args?.category as string | undefined;
      if (!query.trim()) throw new Error("query must not be empty");
      result = await searchProcedures(query, language, category);
    } else if (name === "get_procedure") {
      const id = (args?.id as string) ?? "";
      if (!id.trim()) throw new Error("id must not be empty");
      result = await getProcedure(id);
    } else if (name === "list_categories") {
      result = await listCategories();
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

// ---------- Start ----------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("MITOS MCP server running on stdio\n");

  // Warm the services cache in the background so the first search is instant
  fetchAllServices().catch((err) =>
    process.stderr.write(`Cache warm-up failed: ${err}\n`)
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
