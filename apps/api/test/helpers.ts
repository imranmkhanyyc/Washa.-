import { afterAll, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@washa/db/schema";
import { buildApp } from "../src/app";
import { createTestDeps, type TestDeps } from "../src/wiring";
import { Sim, SimCustomer, resetDb, idsOf } from "../src/sim";

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/washa_test";

// Warehouse placeholder: -1.2841, 36.8219. 1° lat ≈ 111.2 km.
export const north = (km: number) => ({ lat: -1.2841 + km / 111.195, lng: 36.8219 });

export function useSim() {
  const h = {} as { sim: Sim; deps: TestDeps; close: () => Promise<void> };
  beforeAll(async () => {
    const { deps, close } = await createTestDeps(TEST_URL);
    const app = await buildApp(deps);
    h.deps = deps;
    h.sim = new Sim(deps, app);
    h.close = async () => { await app.close(); await close(); };
  });
  beforeEach(async () => {
    h.deps.clock.set(new Date("2026-06-13T09:00:00Z")); // Saturday 12:00 Nairobi, off-peak
    h.deps.wa.outbox = [];
    h.deps.mpesa.pushes = [];
    h.deps.mpesa.queryResults.clear();
    h.deps.queue.pending().length = 0;
    (h.deps.queue as unknown as { jobs: unknown[] }).jobs = [];
    await resetDb(h.deps.db);
  });
  afterAll(async () => h.close());
  return h;
}

/** Existing customer with a complete profile (skips consent/profile). */
export async function knownCustomer(deps: TestDeps, waId: string, opts: { name?: string; buyerType?: "retail" | "garage" | "fleet"; tier?: string | null } = {}) {
  const bt = opts.buyerType ?? "retail";
  const [c] = await deps.db.insert(s.customers).values({
    phoneE164: `+${waId}`, name: opts.name ?? "Wanjiku", buyerType: bt, tierTrack: bt === "retail" ? "d2c" : "b2b",
    tier: opts.tier ?? null, consentAt: new Date("2026-01-01T00:00:00Z"),
  }).returning();
  await deps.db.insert(s.conversations).values({ customerId: c!.id, state: "PAID_DONE", lastInboundAt: new Date("2026-01-01T00:00:00Z") });
  return c!;
}

/** Drives a known customer from "Hi" to the summary: Toyota Fielder 2015 (NS60 L), first offer, qty 1, pin. */
export async function driveToSummary(cu: SimCustomer, opts: { km?: number; offerIndex?: number; qty?: number } = {}) {
  await cu.text("Hi");
  await cu.pick("menu_buy");
  await cu.tap("m_car");
  await cu.pick("make:Toyota");
  const offer = await cu.text("Fielder 2015");
  const rows = idsOf(offer.replies.at(-1));
  const sku = rows[opts.offerIndex ?? 0]!;
  const q = await cu.pick(sku);
  const m = q.replies.at(-1)!;
  if (m.kind === "buttons" && (opts.qty ?? 1) === 1) await cu.tap("qty_1");
  else await cu.text(String(opts.qty ?? 1));
  const loc = north(opts.km ?? 7);
  const summary = await cu.location(loc.lat, loc.lng, "Parklands");
  return { sku: sku.slice(4), summary: summary.replies.at(-1)!, offer: offer.replies.at(-1)! };
}

export async function orderFor(deps: TestDeps, customerPhone: string) {
  const [c] = await deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, customerPhone));
  const rows = await deps.db.select().from(s.orders).where(eq(s.orders.customerId, c!.id));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.number.localeCompare(b.number)).at(-1)!;
}
