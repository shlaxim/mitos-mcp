/** Strip Greek tonos/dialytika and lowercase for accent-insensitive matching. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

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
