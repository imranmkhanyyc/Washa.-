/** Africa/Nairobi is UTC+3 all year (no DST). */
export const NAIROBI_OFFSET_MS = 3 * 3600_000;

export function nairobiParts(d: Date) {
  const l = new Date(d.getTime() + NAIROBI_OFFSET_MS);
  const dow = l.getUTCDay(); // 0 = Sunday
  return {
    year: l.getUTCFullYear(),
    month: l.getUTCMonth() + 1,
    day: l.getUTCDate(),
    hour: l.getUTCHours(),
    minute: l.getUTCMinutes(),
    second: l.getUTCSeconds(),
    isoWeekday: dow === 0 ? 7 : dow,
    minutes: l.getUTCHours() * 60 + l.getUTCMinutes(),
  };
}

/** The instant of "HH:MM" Nairobi time on the Nairobi day of `d` plus `addDays`. */
export function nairobiDateAt(d: Date, hhmm: string, addDays = 0): Date {
  const p = nairobiParts(d);
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + addDays, h ?? 0, m ?? 0) - NAIROBI_OFFSET_MS);
}

/** Daraja timestamp: YYYYMMDDHHmmss in Africa/Nairobi. */
export function darajaTimestamp(d: Date): string {
  const p = nairobiParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}${pad(p.month)}${pad(p.day)}${pad(p.hour)}${pad(p.minute)}${pad(p.second)}`;
}
