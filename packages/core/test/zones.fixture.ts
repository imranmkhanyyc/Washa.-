import type { DeliverySettings, DeliveryZone } from "../src/delivery";

export const SETTINGS: DeliverySettings = {
  warehouseLat: -1.2841,
  warehouseLng: 36.8219,
  peakWindows: [
    { days: [1, 2, 3, 4, 5], start: "07:00", end: "09:30" },
    { days: [1, 2, 3, 4, 5], start: "16:30", end: "19:00" },
  ],
  bulkThresholdUnits: 6,
  maxUnitsPerTrip: 2,
  roundingKes: 10,
  bulkRunTime: "10:00",
};

const ring = (code: string, name: string, minKm: number, maxKm: number, base: number, extra: number, eta: number | null, freeOver: number | null): DeliveryZone => ({
  id: code, code, name, kind: "ring", minKm, maxKm, polygon: null, priority: 100,
  baseFeeKes: base, perExtraUnitKes: extra, includedUnits: 1, peakSurchargeKes: 100,
  freeDeliveryOverKes: freeOver, etaMinutes: eta, etaCutoffTime: eta == null ? "18:00" : null, active: true,
});

export const ZONES: DeliveryZone[] = [
  ring("A", "Core", 0, 5, 200, 100, 45, 15_000),
  ring("B", "Inner", 5, 10, 350, 150, 75, 25_000),
  ring("C", "Outer", 10, 20, 550, 200, 120, null),
  ring("D", "Metro edge", 20, 35, 800, 250, null, null),
];

/** Move `km` due north of the warehouse (1° lat ≈ 111.2 km). */
export const north = (km: number) => ({ lat: SETTINGS.warehouseLat + km / 111.195, lng: SETTINGS.warehouseLng });
