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
