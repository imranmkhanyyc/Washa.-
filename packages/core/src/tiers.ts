/**
 * Tier engine (docs/01-architecture.md §Tiers). Two tracks, one engine.
 * All thresholds/discounts come from tier_config rows, never from code.
 */
export type BuyerType = "retail" | "garage" | "dealer" | "fleet";
export type TierTrack = "b2b" | "d2c";

export interface TierConfig {
  track: TierTrack;
  tier: string;
  rank: number;
  minSpendKes: number;
  /** Percent, e.g. 3 for 3%. */
  itemDiscountPct: number;
  /** Percent, e.g. 50 for 50% off, 100 for free. */
  deliveryDiscountPct: number;
  priorityQueue: boolean;
  perks: Record<string, unknown>;
  active: boolean;
}

export function trackForBuyerType(buyerType: BuyerType): TierTrack {
  return buyerType === "retail" ? "d2c" : "b2b";
}

export function isB2B(buyerType: BuyerType): boolean {
  return trackForBuyerType(buyerType) === "b2b";
}


/** Start of the rolling 12-month spend window. */
export function spendWindowStart(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}

export interface PaidOrderLite {
  totalKes: number;
  paidAt: Date;
}

/** Rolling 12-month sum of PAID order totals. */
export function rollingSpend(orders: PaidOrderLite[], now: Date): number {
  const start = spendWindowStart(now).getTime();
  return orders
    .filter((o) => o.paidAt.getTime() > start)
    .reduce((s, o) => s + o.totalKes, 0);
}

/**
 * Highest active tier on the track whose threshold is met.
 * The base tier (lowest rank) needs a first paid order; with none, returns null.
 */
export function computeTier(
  track: TierTrack,
  spend12mKes: number,
  paidOrderCount: number,
  configs: TierConfig[],
): TierConfig | null {
  if (paidOrderCount <= 0) return null;
  const eligible = configs
    .filter((c) => c.track === track && c.active && spend12mKes >= c.minSpendKes)
    .sort((a, b) => b.rank - a.rank);
  if (eligible.length > 0) return eligible[0]!;
  // Fallback: lowest active tier on the track.
  const base = configs.filter((c) => c.track === track && c.active).sort((a, b) => a.rank - b.rank);
  return base[0] ?? null;
}

export function findTier(configs: TierConfig[], track: TierTrack, tier: string | null): TierConfig | null {
  if (!tier) return null;
  return configs.find((c) => c.track === track && c.tier === tier && c.active) ?? null;
}

const NAIROBI_OFFSET_MS = 3 * 3600_000; // Africa/Nairobi is UTC+3, no DST.

/** First instant of the next calendar month in Africa/Nairobi, as a UTC Date. */
export function startOfNextMonthNairobi(now: Date): Date {
  const local = new Date(now.getTime() + NAIROBI_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, 1) - NAIROBI_OFFSET_MS);
}

export type TierChange =
  | { kind: "none" }
  | { kind: "upgrade"; to: string; effectiveAt: Date }
  | { kind: "downgrade"; to: string | null; effectiveAt: Date };

/**
 * Upgrades are instant. Downgrades take effect at the start of the next calendar month.
 */
export function decideTierChange(
  current: TierConfig | null,
  computed: TierConfig | null,
  now: Date,
): TierChange {
  const curRank = current?.rank ?? -1;
  const newRank = computed?.rank ?? -1;
  if (newRank === curRank) return { kind: "none" };
  if (newRank > curRank) return { kind: "upgrade", to: computed!.tier, effectiveAt: now };
  return { kind: "downgrade", to: computed?.tier ?? null, effectiveAt: startOfNextMonthNairobi(now) };
}
