import { and, eq, inArray, sql } from "drizzle-orm";
import {
  buildStatusEvent, computeTier, decideTierChange, findTier, rollingSpend, spendWindowStart,
  type Actor, type DeliverySettings, type DeliveryZone, type OrderStatus, type TierChange, type TierConfig, type TierTrack,
} from "@washa/core";
import * as s from "@washa/db/schema";
import type { DBOrTx } from "@washa/db";

export class OutOfStockError extends Error {
  constructor(public sku: string) {
    super(`Out of stock: ${sku}`);
  }
}

export async function loadTierConfigs(db: DBOrTx): Promise<TierConfig[]> {
  const rows = await db.select().from(s.tierConfig);
  return rows.map((r) => ({
    track: r.track,
    tier: r.tier,
    rank: r.rank,
    minSpendKes: r.minSpendKes,
    itemDiscountPct: Number(r.itemDiscountPct),
    deliveryDiscountPct: Number(r.deliveryDiscountPct),
    priorityQueue: r.priorityQueue,
    perks: r.perks as Record<string, unknown>,
    active: r.active,
  }));
}

export async function loadTierLabel(db: DBOrTx, track: TierTrack, tier: string): Promise<string> {
  const [r] = await db.select({ label: s.tierConfig.label }).from(s.tierConfig).where(and(eq(s.tierConfig.track, track), eq(s.tierConfig.tier, tier)));
  return r?.label ?? tier;
}

export async function loadZones(db: DBOrTx): Promise<DeliveryZone[]> {
  const rows = await db.select().from(s.deliveryZones);
  return rows.map((z) => ({
    id: z.id, code: z.code, name: z.name, kind: z.kind,
    minKm: z.minKm == null ? null : Number(z.minKm),
    maxKm: z.maxKm == null ? null : Number(z.maxKm),
    polygon: (z.polygon as DeliveryZone["polygon"]) ?? null,
    priority: z.priority, baseFeeKes: z.baseFeeKes, perExtraUnitKes: z.perExtraUnitKes, includedUnits: z.includedUnits,
    peakSurchargeKes: z.peakSurchargeKes, freeDeliveryOverKes: z.freeDeliveryOverKes, etaMinutes: z.etaMinutes,
    etaCutoffTime: z.etaCutoffTime, active: z.active,
  }));
}

export async function loadDeliverySettings(db: DBOrTx): Promise<DeliverySettings> {
  const [r] = await db.select().from(s.deliverySettings).where(eq(s.deliverySettings.id, 1));
  if (!r) throw new Error("delivery_settings row missing: run pnpm db:seed");
  return {
    warehouseLat: r.warehouseLat, warehouseLng: r.warehouseLng, peakWindows: r.peakWindows as DeliverySettings["peakWindows"],
    bulkThresholdUnits: r.bulkThresholdUnits, maxUnitsPerTrip: r.maxUnitsPerTrip, roundingKes: r.roundingKes, bulkRunTime: r.bulkRunTime,
  };
}

/** The customer's current tier config (null before the first paid order). */
export async function customerTier(db: DBOrTx, customer: { tierTrack: TierTrack | null; tier: string | null }): Promise<TierConfig | null> {
  if (!customer.tierTrack || !customer.tier) return null;
  return findTier(await loadTierConfigs(db), customer.tierTrack, customer.tier);
}

/**
 * Validates and applies an order status change, always writing a status_events row (CLAUDE.md rule 5).
 * The row is locked FOR UPDATE so concurrent transitions serialise.
 */
export async function transitionOrder(
  tx: DBOrTx, orderId: string, to: OrderStatus, actor: Actor, now: Date, expectedFrom?: OrderStatus[],
): Promise<{ from: OrderStatus }> {
  const [o] = await tx.select({ status: s.orders.status }).from(s.orders).where(eq(s.orders.id, orderId)).for("update");
  if (!o) throw new Error(`order ${orderId} not found`);
  if (expectedFrom && !expectedFrom.includes(o.status)) throw new Error(`order ${orderId} is ${o.status}, expected ${expectedFrom.join("/")}`);
  const ev = buildStatusEvent(orderId, o.status, to, actor, now);
  await tx.update(s.orders).set({ status: to }).where(eq(s.orders.id, orderId));
  await tx.insert(s.statusEvents).values(ev);
  return { from: o.status };
}

export async function availableBySku(db: DBOrTx, skus: string[]): Promise<Map<string, number>> {
  if (skus.length === 0) return new Map();
  const rows = await db.select().from(s.stock).where(inArray(s.stock.sku, skus));
  return new Map(rows.map((r) => [r.sku, r.qtyOnHand - r.qtyReserved]));
}

/** Reserve at AWAITING_PAYMENT. Atomic per SKU: fails if not enough unreserved stock. */
export async function reserveStock(tx: DBOrTx, orderId: string) {
  const [o] = await tx.select({ reserved: s.orders.stockReserved }).from(s.orders).where(eq(s.orders.id, orderId));
  if (o?.reserved) return;
  const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId));
  for (const it of items) {
    const res = await tx
      .update(s.stock)
      .set({ qtyReserved: sql`${s.stock.qtyReserved} + ${it.qty}` })
      .where(and(eq(s.stock.sku, it.sku), sql`${s.stock.qtyOnHand} - ${s.stock.qtyReserved} >= ${it.qty}`))
      .returning({ sku: s.stock.sku });
    if (res.length === 0) throw new OutOfStockError(it.sku);
  }
  await tx.update(s.orders).set({ stockReserved: true }).where(eq(s.orders.id, orderId));
}

/** Release on EXPIRED / CANCELLED / final PAYMENT_FAILED. Idempotent. */
export async function releaseStock(tx: DBOrTx, orderId: string) {
  const [o] = await tx.select({ reserved: s.orders.stockReserved }).from(s.orders).where(eq(s.orders.id, orderId));
  if (!o?.reserved) return;
  const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId));
  for (const it of items) {
    await tx.update(s.stock).set({ qtyReserved: sql`greatest(0, ${s.stock.qtyReserved} - ${it.qty})` }).where(eq(s.stock.sku, it.sku));
  }
  await tx.update(s.orders).set({ stockReserved: false }).where(eq(s.orders.id, orderId));
}

/** Decrement on PAID: on_hand and reserved both drop. */
export async function commitStock(tx: DBOrTx, orderId: string) {
  const [o] = await tx.select({ reserved: s.orders.stockReserved }).from(s.orders).where(eq(s.orders.id, orderId));
  const items = await tx.select().from(s.orderItems).where(eq(s.orderItems.orderId, orderId));
  for (const it of items) {
    await tx
      .update(s.stock)
      .set({
        qtyOnHand: sql`${s.stock.qtyOnHand} - ${it.qty}`,
        qtyReserved: o?.reserved ? sql`greatest(0, ${s.stock.qtyReserved} - ${it.qty})` : s.stock.qtyReserved,
      })
      .where(eq(s.stock.sku, it.sku));
  }
  await tx.update(s.orders).set({ stockReserved: false }).where(eq(s.orders.id, orderId));
}

/**
 * Recompute a customer's tier from rolling 12-month PAID spend (status_events).
 * Upgrades apply now; downgrades are scheduled for the start of next month.
 */
export async function recomputeTier(tx: DBOrTx, customerId: string, now: Date): Promise<TierChange> {
  const [c] = await tx.select().from(s.customers).where(eq(s.customers.id, customerId)).for("update");
  if (!c || !c.buyerType) return { kind: "none" };
  const track: TierTrack = c.buyerType === "retail" ? "d2c" : "b2b";
  const paid = await tx
    .select({ totalKes: s.orders.totalKes, paidAt: s.statusEvents.at })
    .from(s.statusEvents)
    .innerJoin(s.orders, eq(s.orders.id, s.statusEvents.orderId))
    .where(and(eq(s.orders.customerId, customerId), eq(s.statusEvents.toStatus, "PAID")));
  const spend = rollingSpend(paid, now);
  const recentPaid = paid.filter((p) => p.paidAt > spendWindowStart(now)).length;
  const configs = await loadTierConfigs(tx);
  // A customer with any paid order ever keeps at least the base tier.
  const computed = computeTier(track, spend, paid.length > 0 ? Math.max(1, recentPaid) : 0, configs);
  const current = findTier(configs, track, c.tier);
  const change = decideTierChange(current, computed, now);

  if (change.kind === "upgrade") {
    await tx.update(s.customers).set({ tierTrack: track, tier: change.to, spendKes12m: spend, pendingTier: null, pendingTierAt: null }).where(eq(s.customers.id, customerId));
  } else if (change.kind === "downgrade") {
    // Apply a downgrade whose effective date has arrived; otherwise schedule it.
    if (c.pendingTierAt && c.pendingTierAt <= now) {
      await tx.update(s.customers).set({ tier: change.to, spendKes12m: spend, pendingTier: null, pendingTierAt: null }).where(eq(s.customers.id, customerId));
    } else {
      await tx.update(s.customers).set({ tierTrack: track, spendKes12m: spend, pendingTier: change.to, pendingTierAt: change.effectiveAt }).where(eq(s.customers.id, customerId));
    }
  } else {
    await tx.update(s.customers).set({ tierTrack: track, spendKes12m: spend, pendingTier: null, pendingTierAt: null }).where(eq(s.customers.id, customerId));
  }
  return change;
}
