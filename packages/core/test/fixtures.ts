import type { TierConfig } from "../src/tiers";

const t = (
  track: "b2b" | "d2c", tier: string, rank: number, minSpendKes: number,
  itemDiscountPct: number, deliveryDiscountPct: number, priorityQueue = false,
): TierConfig => ({ track, tier, rank, minSpendKes, itemDiscountPct, deliveryDiscountPct, priorityQueue, perks: {}, active: true });

/** Mirrors the seed values in docs/01-architecture.md. */
export const TIERS: TierConfig[] = [
  t("b2b", "silver", 1, 0, 0, 0),
  t("b2b", "gold", 2, 1_000_000, 3, 50),
  t("b2b", "platinum", 3, 2_500_000, 5, 100, true),
  t("d2c", "member", 1, 0, 0, 0),
  t("d2c", "plus", 2, 25_000, 2, 25),
  t("d2c", "pro", 3, 60_000, 3, 50, true),
];
export const tier = (name: string) => TIERS.find((x) => x.tier === name)!;
