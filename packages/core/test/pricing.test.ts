import { describe, it, expect } from "vitest";
import { priceItems, orderTotals, unitPriceAfterTier, formatKes } from "../src/pricing";
import { tier } from "./fixtures";

describe("pricing", () => {
  it("no tier → full price", () => {
    const items = priceItems([{ sku: "A", qty: 1, unitPriceKes: 11_000 }], null);
    expect(orderTotals(items, 200)).toEqual({ subtotalKes: 11_000, discountKes: 0, deliveryFeeKes: 200, totalKes: 11_200 });
  });

  it("Gold B2B: 3% item discount", () => {
    const items = priceItems([{ sku: "A", qty: 10, unitPriceKes: 9_999 }], tier("gold"));
    // per unit: round(299.97) = 300
    expect(items.discountKes).toBe(3_000);
    expect(orderTotals(items, 300).totalKes).toBe(99_990 - 3_000 + 300);
  });

  it("offer unit price × qty always equals the summary", () => {
    const unit = unitPriceAfterTier(12_345, tier("platinum"));
    const items = priceItems([{ sku: "A", qty: 3, unitPriceKes: 12_345 }], tier("platinum"));
    expect(items.subtotalKes - items.discountKes).toBe(unit * 3);
  });

  it("rejects floats and bad qty", () => {
    expect(() => priceItems([{ sku: "A", qty: 1, unitPriceKes: 10.5 }], null)).toThrow();
    expect(() => priceItems([{ sku: "A", qty: 0, unitPriceKes: 10 }], null)).toThrow();
    expect(() => orderTotals(priceItems([], null), 10.2)).toThrow();
  });

  it("formats KES", () => {
    expect(formatKes(11000)).toBe("KES 11,000");
  });
});
