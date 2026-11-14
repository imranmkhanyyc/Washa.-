/** Fitment resolution and offers. Prices and stock come only from the DB. */
import { and, asc, eq, ilike, inArray } from "drizzle-orm";
import { parseSizeCode, unitPriceAfterTier, type Polarity, type TierConfig } from "@washa/core";
import * as s from "@washa/db/schema";
import type { DBOrTx } from "@washa/db";
import { availableBySku } from "../orders/service";

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface FitCandidate {
  sizeFamily: string;
  polarity: Polarity;
  engine: string | null;
  yearFrom: number;
  yearTo: number;
  model: string;
}

/** Fitment rows for a make/model/year, preferring the most specific model name match. */
export async function findFitments(db: DBOrTx, v: { make: string; model: string; year: number | null; engine?: string | null }): Promise<FitCandidate[]> {
  const rows = await db.select().from(s.fitments).where(ilike(s.fitments.make, v.make));
  const um = norm(v.model);
  if (!um) return [];
  const scored = rows.map((r) => {
    const fm = norm(r.model);
    const score = fm === um ? 1000 : um.includes(fm) && fm.length >= 2 ? fm.length : fm.includes(um) && um.length >= 3 ? 1 : 0;
    return { r, score };
  }).filter((x) => x.score > 0);
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((x) => x.score));
  let cands = scored.filter((x) => x.score === best).map(({ r }) => ({
    sizeFamily: r.sizeFamily, polarity: r.polarity, engine: r.engine, yearFrom: r.yearFrom, yearTo: r.yearTo, model: r.model,
  }));
  if (v.year != null) {
    const inYear = cands.filter((c) => v.year! >= c.yearFrom && v.year! <= c.yearTo);
    if (inYear.length > 0) cands = inYear;
  }
  if (v.engine) {
    const byEngine = cands.filter((c) => c.engine && norm(c.engine).includes(norm(v.engine!)));
    if (byEngine.length > 0) cands = byEngine;
  }
  return cands;
}

export function distinctSizes(c: FitCandidate[]) {
  const m = new Map<string, FitCandidate>();
  for (const x of c) m.set(`${x.sizeFamily}${x.polarity}`, x);
  return [...m.values()];
}

/** Normalise a size read from a label or typed: family codes directly, JIS codes via products.model_code. */
export async function normaliseSize(db: DBOrTx, raw: string): Promise<{ sizeFamily: string; polarity: Polarity | null } | null> {
  const direct = parseSizeCode(raw);
  if (direct) return direct;
  const m = /(\d{2,3}[A-H]\d{2})\s*([LR])?/i.exec(raw.toUpperCase());
  if (!m) return null;
  const rows = await db.select({ sizeFamily: s.products.sizeFamily, modelCode: s.products.modelCode }).from(s.products);
  const hit = rows.find((r) => r.modelCode.toUpperCase().replace(/[LR]$/, "") === m[1]);
  return hit ? { sizeFamily: hit.sizeFamily, polarity: (m[2] as Polarity | undefined) ?? null } : null;
}

export async function polaritiesFor(db: DBOrTx, sizeFamily: string): Promise<Polarity[]> {
  const rows = await db.selectDistinct({ p: s.products.polarity }).from(s.products).where(and(eq(s.products.sizeFamily, sizeFamily), eq(s.products.active, true)));
  return rows.map((r) => r.p);
}

export interface Offer {
  sku: string;
  label: "Good" | "Better" | "Best";
  brand: string;
  sizeFamily: string;
  polarity: Polarity;
  unitPriceKes: number;
  unitAfterTierKes: number;
  warrantyMonths: number;
  ah: number;
  available: number;
}

async function inStock(db: DBOrTx, sizeFamily: string, polarity: Polarity, tier: TierConfig | null): Promise<Omit<Offer, "label">[]> {
  const ps = await db.select().from(s.products)
    .where(and(eq(s.products.sizeFamily, sizeFamily), eq(s.products.polarity, polarity), eq(s.products.active, true)))
    .orderBy(asc(s.products.priceKes));
  const avail = await availableBySku(db, ps.map((p) => p.sku));
  return ps
    .map((p) => ({
      sku: p.sku, brand: p.brand, sizeFamily: p.sizeFamily, polarity: p.polarity, unitPriceKes: p.priceKes,
      unitAfterTierKes: unitPriceAfterTier(p.priceKes, tier), warrantyMonths: p.warrantyMonths, ah: p.ah, available: avail.get(p.sku) ?? 0,
    }))
    .filter((p) => p.available > 0);
}

/** Up to 3 SKUs spread across the price range, labelled Good / Better / Best (cheapest → priciest). */
function pickThree<T>(xs: T[]): T[] {
  if (xs.length <= 3) return xs;
  return [xs[0]!, xs[Math.floor((xs.length - 1) / 2)]!, xs[xs.length - 1]!];
}
const LABELS = ["Good", "Better", "Best"] as const;

export async function buildOffers(
  db: DBOrTx, sizeFamily: string, polarity: Polarity, tier: TierConfig | null,
): Promise<{ offers: Offer[]; substitutedFrom: string | null; shownSize: string }> {
  let list = await inStock(db, sizeFamily, polarity, tier);
  let shown = sizeFamily;
  let substitutedFrom: string | null = null;
  if (list.length === 0) {
    const alts = await db.select().from(s.sizeCompat).where(eq(s.sizeCompat.fromSize, sizeFamily)).orderBy(asc(s.sizeCompat.rank));
    for (const a of alts) {
      const l = await inStock(db, a.toSize, polarity, tier);
      if (l.length > 0) {
        list = l;
        shown = a.toSize;
        substitutedFrom = sizeFamily;
        break;
      }
    }
  }
  const offers = pickThree(list).map((o, i) => ({ ...o, label: LABELS[i]! }));
  return { offers, substitutedFrom, shownSize: shown };
}

export async function productsBySku(db: DBOrTx, skus: string[]) {
  if (skus.length === 0) return [];
  return db.select().from(s.products).where(inArray(s.products.sku, skus));
}
