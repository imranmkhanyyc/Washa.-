/**
 * Pricing (docs/01-architecture.md §Pricing).
 * total = subtotal − tier_item_discount + delivery_fee_after_tier
 * All money is integer KES. Prices only ever come from the DB.
 */
export interface TierDiscounts {
  itemDiscountPct: number;
  deliveryDiscountPct: number;
}

export const NO_TIER: TierDiscounts = { itemDiscountPct: 0, deliveryDiscountPct: 0 };

function assertKes(n: number, label: string) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer KES, got ${n}`);
}

/** Per-unit tier discount, rounded to the nearest shilling. */
export function unitDiscountKes(unitPriceKes: number, pct: number): number {
  assertKes(unitPriceKes, "unitPriceKes");
  return Math.round((unitPriceKes * pct) / 100);
}

export function unitPriceAfterTier(unitPriceKes: number, tier: TierDiscounts | null): number {
  return unitPriceKes - unitDiscountKes(unitPriceKes, (tier ?? NO_TIER).itemDiscountPct);
}

export interface PriceLineInput {
  sku: string;
  qty: number;
  unitPriceKes: number;
}

export interface PricedLine extends PriceLineInput {
  unitDiscountKes: number;
  lineSubtotalKes: number;
  lineDiscountKes: number;
}

export interface ItemsPrice {
  lines: PricedLine[];
  units: number;
  subtotalKes: number;
  discountKes: number;
}

export function priceItems(lines: PriceLineInput[], tier: TierDiscounts | null): ItemsPrice {
  const pct = (tier ?? NO_TIER).itemDiscountPct;
  const priced = lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error(`qty must be a positive integer, got ${l.qty}`);
    const ud = unitDiscountKes(l.unitPriceKes, pct);
    return { ...l, unitDiscountKes: ud, lineSubtotalKes: l.unitPriceKes * l.qty, lineDiscountKes: ud * l.qty };
  });
  return {
    lines: priced,
    units: priced.reduce((s, l) => s + l.qty, 0),
    subtotalKes: priced.reduce((s, l) => s + l.lineSubtotalKes, 0),
    discountKes: priced.reduce((s, l) => s + l.lineDiscountKes, 0),
  };
}

export interface OrderTotals {
  subtotalKes: number;
  discountKes: number;
  deliveryFeeKes: number;
  totalKes: number;
}

/** deliveryFeeAfterTierKes comes from delivery.quoteDelivery (tier already applied there). */
export function orderTotals(items: ItemsPrice, deliveryFeeAfterTierKes: number): OrderTotals {
  assertKes(deliveryFeeAfterTierKes, "deliveryFeeKes");
  const totalKes = items.subtotalKes - items.discountKes + deliveryFeeAfterTierKes;
  return { subtotalKes: items.subtotalKes, discountKes: items.discountKes, deliveryFeeKes: deliveryFeeAfterTierKes, totalKes };
}

/** "KES 11,000" */
export function formatKes(n: number): string {
  return `KES ${n.toLocaleString("en-KE")}`;
}
