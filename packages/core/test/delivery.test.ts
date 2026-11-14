import { describe, it, expect } from "vitest";
import { quoteDelivery, findZone, isPeak, type DeliveryZone } from "../src/delivery";
import { SETTINGS, ZONES, north } from "./zones.fixture";

// Saturday 12:00 Nairobi (off-peak) and Monday 08:00 Nairobi (peak).
const OFFPEAK = new Date("2026-06-13T09:00:00Z");
const PEAK = new Date("2026-06-15T05:00:00Z");
const base = { units: 1, subtotalKes: 5_000, isB2B: false, tierDeliveryDiscountPct: 0, now: OFFPEAK };

describe("delivery zones", () => {
  it("a pin in each ring returns the right zone, fee and ETA", () => {
    const cases = [
      { km: 2, code: "A", fee: 200, etaMin: 45 },
      { km: 7, code: "B", fee: 350, etaMin: 75 },
      { km: 15, code: "C", fee: 550, etaMin: 120 },
    ];
    for (const c of cases) {
      const q = quoteDelivery({ ...base, point: north(c.km) }, ZONES, SETTINGS);
      expect(q.inArea).toBe(true);
      if (!q.inArea) continue;
      expect(q.zoneCode).toBe(c.code);
      expect(q.feeKes).toBe(c.fee);
      expect(q.etaAt.getTime() - OFFPEAK.getTime()).toBe(c.etaMin * 60_000);
    }
    const d = quoteDelivery({ ...base, point: north(30) }, ZONES, SETTINGS);
    expect(d.inArea && d.zoneCode).toBe("D");
    expect(d.inArea && d.feeKes).toBe(800);
    // Same day: 18:00 Nairobi = 15:00Z
    expect(d.inArea && d.etaAt.toISOString()).toBe("2026-06-13T15:00:00.000Z");
  });

  it("same-day zone after the cutoff rolls to the next day", () => {
    const late = new Date("2026-06-13T16:00:00Z"); // 19:00 Nairobi
    const d = quoteDelivery({ ...base, now: late, point: north(30) }, ZONES, SETTINGS);
    expect(d.inArea && d.etaAt.toISOString()).toBe("2026-06-14T15:00:00.000Z");
  });

  it("a polygon drawn over part of ring B overrides it", () => {
    const p = north(7);
    const poly: DeliveryZone = {
      ...ZONES[1]!, id: "P1", code: "P1", name: "Hard area", kind: "polygon", minKm: null, maxKm: null, priority: 10,
      baseFeeKes: 600, etaMinutes: 100, freeDeliveryOverKes: null,
      polygon: { type: "Polygon", coordinates: [[
        [p.lng - 0.01, p.lat - 0.01], [p.lng + 0.01, p.lat - 0.01], [p.lng + 0.01, p.lat + 0.01], [p.lng - 0.01, p.lat + 0.01], [p.lng - 0.01, p.lat - 0.01],
      ]] },
    };
    const zones = [...ZONES, poly];
    const q = quoteDelivery({ ...base, point: p }, zones, SETTINGS);
    expect(q.inArea && q.zoneCode).toBe("P1");
    expect(q.inArea && q.feeKes).toBe(600);
    // Outside the polygon but still in ring B → ring B.
    expect(findZone(north(9), zones, SETTINGS)?.zone.code).toBe("B");
  });

  it("3 batteries → extra-unit fee and 2 rider trips", () => {
    const q = quoteDelivery({ ...base, units: 3, point: north(2) }, ZONES, SETTINGS);
    expect(q.inArea && q.feeKes).toBe(200 + 2 * 100);
    expect(q.inArea && q.trips).toBe(2);
    expect(q.inArea && q.mode).toBe("on_demand");
  });

  it("B2B order of ≥ 6 units goes to a scheduled bulk run", () => {
    const q = quoteDelivery({ ...base, units: 6, isB2B: true, point: north(2) }, ZONES, SETTINGS);
    expect(q.inArea && q.mode).toBe("bulk_run");
    // Retail with 6 units is not bulk.
    const r = quoteDelivery({ ...base, units: 6, isB2B: false, point: north(2) }, ZONES, SETTINGS);
    expect(r.inArea && r.mode).toBe("on_demand");
    expect(r.inArea && r.trips).toBe(3);
  });

  it("peak surcharge on weekdays only", () => {
    expect(isPeak(PEAK, SETTINGS.peakWindows)).toBe(true);
    expect(isPeak(OFFPEAK, SETTINGS.peakWindows)).toBe(false);
    const q = quoteDelivery({ ...base, now: PEAK, point: north(7) }, ZONES, SETTINGS);
    expect(q.inArea && q.feeKes).toBe(450);
  });

  it("Gold (50%) and Platinum (free) discounts apply after surcharges", () => {
    // Zone B peak, 2 units: 350 + 150 + 100 = 600
    const gold = quoteDelivery({ ...base, now: PEAK, units: 2, tierDeliveryDiscountPct: 50, point: north(7) }, ZONES, SETTINGS);
    expect(gold.inArea && gold.rawFeeKes).toBe(600);
    expect(gold.inArea && gold.feeKes).toBe(300);
    const plat = quoteDelivery({ ...base, now: PEAK, units: 2, tierDeliveryDiscountPct: 100, point: north(7) }, ZONES, SETTINGS);
    expect(plat.inArea && plat.feeKes).toBe(0);
    // D2C Plus 25% off 450 = 337.5 → rounds to 340
    const plus = quoteDelivery({ ...base, now: PEAK, tierDeliveryDiscountPct: 25, point: north(7) }, ZONES, SETTINGS);
    expect(plus.inArea && plus.feeKes).toBe(340);
  });

  it("free delivery over the zone threshold", () => {
    const q = quoteDelivery({ ...base, subtotalKes: 15_000, point: north(2) }, ZONES, SETTINGS);
    expect(q.inArea && q.feeKes).toBe(0);
  });

  it("out-of-area pin → no zone, no price", () => {
    const q = quoteDelivery({ ...base, point: north(50) }, ZONES, SETTINGS);
    expect(q.inArea).toBe(false);
    expect("feeKes" in q).toBe(false);
  });

  it("inactive zones are skipped", () => {
    const zones = ZONES.map((z) => (z.code === "A" ? { ...z, active: false } : z));
    expect(findZone(north(2), zones, SETTINGS)).toBeNull();
  });

  it("re-centres when the warehouse moves", () => {
    const moved = { ...SETTINGS, warehouseLat: north(30).lat };
    expect(findZone(north(30), ZONES, moved)?.zone.code).toBe("A");
  });
});
