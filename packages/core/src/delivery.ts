/**
 * Zone-based delivery pricing (docs/06-delivery-zones.md).
 * Polygons first (priority order), then distance rings from the warehouse.
 */
import { haversineKm, pointInPolygon, type GeoJsonPolygon, type LatLng } from "./geo";
import { nairobiParts, nairobiDateAt } from "./time";

export interface DeliveryZone {
  id: string;
  code: string;
  name: string;
  kind: "ring" | "polygon";
  minKm: number | null;
  maxKm: number | null;
  polygon: GeoJsonPolygon | null;
  priority: number;
  baseFeeKes: number;
  perExtraUnitKes: number;
  includedUnits: number;
  peakSurchargeKes: number;
  freeDeliveryOverKes: number | null;
  /** null for "same day" zones, which use etaCutoffTime. */
  etaMinutes: number | null;
  /** "HH:MM" Nairobi time, used when etaMinutes is null. */
  etaCutoffTime: string | null;
  active: boolean;
}

export interface PeakWindow {
  /** ISO weekday numbers, 1 = Monday … 7 = Sunday. */
  days: number[];
  start: string; // "HH:MM" Nairobi
  end: string; // "HH:MM" Nairobi
}

export interface DeliverySettings {
  warehouseLat: number;
  warehouseLng: number;
  peakWindows: PeakWindow[];
  bulkThresholdUnits: number;
  maxUnitsPerTrip: number;
  roundingKes: number;
  /** "HH:MM" Nairobi time for the scheduled B2B bulk run (placeholder). */
  bulkRunTime: string;
}

export function roundTo(n: number, step: number): number {
  if (step <= 1) return Math.round(n);
  return Math.round(n / step) * step;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function isPeak(now: Date, windows: PeakWindow[]): boolean {
  const { isoWeekday, minutes } = nairobiParts(now);
  return windows.some((w) => w.days.includes(isoWeekday) && minutes >= toMin(w.start) && minutes < toMin(w.end));
}

export function findZone(
  point: LatLng,
  zones: DeliveryZone[],
  settings: DeliverySettings,
): { zone: DeliveryZone; distanceKm: number } | null {
  const distanceKm = haversineKm({ lat: settings.warehouseLat, lng: settings.warehouseLng }, point);
  const active = zones.filter((z) => z.active).sort((a, b) => a.priority - b.priority);
  for (const z of active) {
    if (z.kind === "polygon" && z.polygon && pointInPolygon(point, z.polygon)) return { zone: z, distanceKm };
  }
  for (const z of active) {
    if (z.kind !== "ring" || z.maxKm == null) continue;
    const min = z.minKm ?? 0;
    // Inner edge exclusive (except 0), outer edge inclusive: 5.0 km is zone A.
    if ((distanceKm > min || (min === 0 && distanceKm >= 0)) && distanceKm <= z.maxKm) return { zone: z, distanceKm };
  }
  return null;
}

export interface DeliveryQuoteInput {
  point: LatLng;
  units: number;
  subtotalKes: number;
  isB2B: boolean;
  /** Percent off delivery from the customer's tier (0–100). */
  tierDeliveryDiscountPct: number;
  now: Date;
}

export type DeliveryQuote =
  | { inArea: false; distanceKm: number }
  | {
      inArea: true;
      zoneId: string;
      zoneCode: string;
      zoneName: string;
      distanceKm: number;
      mode: "on_demand" | "bulk_run";
      peak: boolean;
      rawFeeKes: number;
      feeKes: number;
      trips: number;
      etaAt: Date;
    };

export function etaFor(zone: DeliveryZone, now: Date): Date {
  if (zone.etaMinutes != null) return new Date(now.getTime() + zone.etaMinutes * 60_000);
  const cutoff = zone.etaCutoffTime ?? "18:00";
  const today = nairobiDateAt(now, cutoff, 0);
  // Same day if ordered before the cutoff, else next day's cutoff (assumption, flagged).
  return now.getTime() < today.getTime() ? today : nairobiDateAt(now, cutoff, 1);
}

export function quoteDelivery(
  input: DeliveryQuoteInput,
  zones: DeliveryZone[],
  settings: DeliverySettings,
): DeliveryQuote {
  const hit = findZone(input.point, zones, settings);
  if (!hit) {
    const distanceKm = haversineKm({ lat: settings.warehouseLat, lng: settings.warehouseLng }, input.point);
    return { inArea: false, distanceKm };
  }
  const { zone, distanceKm } = hit;
  const units = Math.max(1, Math.floor(input.units));
  const bulk = input.isB2B && units >= settings.bulkThresholdUnits;
  const peak = isPeak(input.now, settings.peakWindows);

  const extra = Math.max(0, units - zone.includedUnits) * zone.perExtraUnitKes;
  const surcharge = peak ? zone.peakSurchargeKes : 0;
  const raw = zone.baseFeeKes + extra + surcharge;
  let fee = roundTo((raw * (100 - input.tierDeliveryDiscountPct)) / 100, settings.roundingKes);
  if (zone.freeDeliveryOverKes != null && input.subtotalKes >= zone.freeDeliveryOverKes) fee = 0;
  fee = Math.max(0, fee);

  const trips = bulk ? 1 : Math.ceil(units / settings.maxUnitsPerTrip);
  const etaAt = bulk ? nairobiDateAt(input.now, settings.bulkRunTime, 1) : etaFor(zone, input.now);

  return {
    inArea: true,
    zoneId: zone.id,
    zoneCode: zone.code,
    zoneName: zone.name,
    distanceKm,
    mode: bulk ? "bulk_run" : "on_demand",
    peak,
    rawFeeKes: raw,
    feeKes: fee,
    trips,
    etaAt,
  };
}
