import { sql } from "drizzle-orm";
import type { DB } from "./index";
import * as s from "./schema";
import * as d from "./seed-data";

/** Idempotent seed: reference data is upserted; stock is only inserted if missing. */
export async function seed(db: DB) {
  await db.transaction(async (tx) => {
    for (const p of d.PRODUCTS) {
      await tx.insert(s.products).values(p).onConflictDoUpdate({ target: s.products.sku, set: p });
    }
    await tx.insert(s.stock).values(d.STOCK).onConflictDoNothing();
    await tx.delete(s.fitments);
    await tx.insert(s.fitments).values(d.FITMENTS);
    await tx.insert(s.sizeCompat).values(d.SIZE_COMPAT).onConflictDoNothing();
    for (const t of d.TIER_CONFIG) {
      await tx.insert(s.tierConfig).values(t).onConflictDoUpdate({ target: [s.tierConfig.track, s.tierConfig.tier], set: t });
    }
    await tx.insert(s.deliverySettings).values(d.DELIVERY_SETTINGS).onConflictDoUpdate({ target: s.deliverySettings.id, set: d.DELIVERY_SETTINGS });
    for (const z of d.DELIVERY_ZONES) {
      await tx.insert(s.deliveryZones).values(z).onConflictDoUpdate({ target: s.deliveryZones.code, set: z });
    }
    const [{ n }] = (await tx.execute(sql`select count(*)::int as n from staff`)).rows as [{ n: number }];
    if (n === 0) await tx.insert(s.staff).values(d.STAFF);
  });
}
