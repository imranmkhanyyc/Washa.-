import { describe, it, expect } from "vitest";
import {
  trackForBuyerType, computeTier, rollingSpend, decideTierChange, startOfNextMonthNairobi,
} from "../src/tiers";
import { TIERS, tier } from "./fixtures";

describe("tiers", () => {
  it("maps buyer type to track", () => {
    expect(trackForBuyerType("retail")).toBe("d2c");
    expect(trackForBuyerType("garage")).toBe("b2b");
    expect(trackForBuyerType("dealer")).toBe("b2b");
    expect(trackForBuyerType("fleet")).toBe("b2b");
  });

  it("no paid order → no tier yet", () => {
    expect(computeTier("b2b", 0, 0, TIERS)).toBeNull();
  });

  it("first paid order → base tier", () => {
    expect(computeTier("b2b", 5_000, 1, TIERS)?.tier).toBe("silver");
    expect(computeTier("d2c", 5_000, 1, TIERS)?.tier).toBe("member");
  });

  it("B2B thresholds", () => {
    expect(computeTier("b2b", 999_999, 5, TIERS)?.tier).toBe("silver");
    expect(computeTier("b2b", 1_000_000, 5, TIERS)?.tier).toBe("gold");
    expect(computeTier("b2b", 2_500_000, 5, TIERS)?.tier).toBe("platinum");
  });

  it("D2C placeholder thresholds", () => {
    expect(computeTier("d2c", 25_000, 2, TIERS)?.tier).toBe("plus");
    expect(computeTier("d2c", 60_000, 2, TIERS)?.tier).toBe("pro");
  });

  it("ignores inactive tiers", () => {
    const cfg = TIERS.map((c) => (c.tier === "platinum" ? { ...c, active: false } : c));
    expect(computeTier("b2b", 3_000_000, 5, cfg)?.tier).toBe("gold");
  });

  it("rolling 12-month spend drops aged orders", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const orders = [
      { totalKes: 600_000, paidAt: new Date("2025-06-01T00:00:00Z") }, // aged out
      { totalKes: 500_000, paidAt: new Date("2025-07-01T00:00:00Z") },
      { totalKes: 500_000, paidAt: new Date("2026-06-14T00:00:00Z") },
    ];
    expect(rollingSpend(orders, now)).toBe(1_000_000);
  });

  it("upgrades are instant", () => {
    const now = new Date("2026-06-15T10:00:00Z");
    expect(decideTierChange(tier("silver"), tier("gold"), now)).toEqual({ kind: "upgrade", to: "gold", effectiveAt: now });
    expect(decideTierChange(null, tier("silver"), now).kind).toBe("upgrade");
  });

  it("downgrades wait for the next calendar month (Nairobi)", () => {
    const now = new Date("2026-06-15T10:00:00Z");
    const ch = decideTierChange(tier("platinum"), tier("gold"), now);
    expect(ch).toEqual({ kind: "downgrade", to: "gold", effectiveAt: new Date("2026-06-30T21:00:00Z") });
  });

  it("next month boundary respects Nairobi time near midnight", () => {
    // 2026-06-30T22:00Z is already 1 July 01:00 in Nairobi → next month is August.
    expect(startOfNextMonthNairobi(new Date("2026-06-30T22:00:00Z")).toISOString()).toBe("2026-07-31T21:00:00.000Z");
    expect(startOfNextMonthNairobi(new Date("2026-12-10T00:00:00Z")).toISOString()).toBe("2026-12-31T21:00:00.000Z");
  });

  it("same tier → no change", () => {
    expect(decideTierChange(tier("gold"), tier("gold"), new Date()).kind).toBe("none");
  });
});
