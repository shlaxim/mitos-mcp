import {
  normalize,
  FETCH_CONCURRENCY,
  CACHE_TTL_MS,
  fetchAllServices,
  getExtended,
  pool,
  formatDuration,
  type ExtendedResponse,
  type ServiceListItem,
  type ServiceTitle,
} from "./mitos.js";

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

// ── Task 8 Step 1: small format helpers ───────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

// ── Task 8 Step 2: searchProcedures handler ───────────────────────────────────

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

// ── Task 8 Step 3: getProcedure handler (markdown formatter) ──────────────────

export async function getProcedure(id: string): Promise<string> {
  const json = await getExtended(id);

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
  const url = str(d.url);
  if (url) lines.push(`**URL:** ${url}`);
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
      const num = step.step_digital_num_id ?? "";
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

// ── Task 8 Step 4: listCategories and listProceduresByCategory ────────────────

const SAMPLE_SIZE = 150;

/**
 * Evenly-spread sample across the full services list, keeping each source item
 * paired with its extended response (the extended body does NOT reliably include
 * the id, so we carry it from the list item).
 */
interface SampledItem {
  item: ServiceListItem;
  ext: ExtendedResponse;
}
let sampledItemsCache: { items: SampledItem[]; fetchedAt: number } | null = null;

async function sampleExtended(): Promise<SampledItem[]> {
  if (sampledItemsCache && Date.now() - sampledItemsCache.fetchedAt < CACHE_TTL_MS)
    return sampledItemsCache.items;
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
  sampledItemsCache = { items: out, fetchedAt: Date.now() };
  return out;
}

function lifeEventsOf(ext: ExtendedResponse): string[] {
  const proc = (ext.data?.metadata as Record<string, unknown>)?.process as
    | Record<string, unknown>
    | undefined;
  return (proc?.life_events as string[] | undefined) ?? [];
}

export async function listCategories(): Promise<string> {
  const samples = await sampleExtended();
  const set = new Set<string>();
  for (const s of samples) lifeEventsOf(s.ext).forEach((e) => set.add(e));
  if (set.size === 0) return "No categories found.";
  const sorted = [...set].sort((a, b) => a.localeCompare(b, "el"));
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

// ── Task 8 Step 5: tool definitions and callTool dispatcher ──────────────────

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
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) throw new Error("query must not be empty");
      const language = typeof args.language === "string" ? args.language : "both";
      const category = typeof args.category === "string" ? args.category : undefined;
      return searchProcedures(query, language, category);
    }
    case "get_procedure": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id.trim()) throw new Error("id must not be empty");
      return getProcedure(id);
    }
    case "list_categories":
      return listCategories();
    case "list_procedures_by_category": {
      const category = typeof args.category === "string" ? args.category : "";
      if (!category.trim()) throw new Error("category must not be empty");
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return listProceduresByCategory(category, limit);
    }
    case "get_legal_basis_articles": {
      const id = typeof args.procedure_id === "string" ? args.procedure_id : "";
      if (!id.trim()) throw new Error("procedure_id must not be empty");
      return getLegalBasisArticles(id);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
