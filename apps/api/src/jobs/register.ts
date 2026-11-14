import { eq, inArray, isNotNull, lte, and } from "drizzle-orm";
import * as s from "@washa/db/schema";
import type { Deps } from "../deps";
import type { InMessage } from "../whatsapp/types";
import type { WaStatus } from "../whatsapp/inbound";
import { handleInbound } from "../bot/engine";
import { JOBS, expireOrder, processCallback, runStkQuery, type StkCallbackBody } from "../mpesa/payments";
import { recomputeTier } from "../orders/service";

export const WA_JOBS = { inbound: "wa.inbound", status: "wa.status" } as const;
export const CRON_JOBS = { tiersNightly: "tiers.nightly", expirySweep: "orders.expiry_sweep" } as const;

export async function registerJobs(deps: Deps) {
  const q = deps.queue;
  await q.work<InMessage>(WA_JOBS.inbound, async (m) => { await handleInbound(deps, m); });
  await q.work<WaStatus>(WA_JOBS.status, async (st) => {
    await deps.db.update(s.messages).set({ status: st.status }).where(eq(s.messages.waMessageId, st.waMessageId));
  });
  await q.work<{ body: StkCallbackBody; attempt?: number }>(JOBS.callback, async (j) => { await processCallback(deps, j.body, j.attempt ?? 0); });
  await q.work<{ paymentId: string; n: number }>(JOBS.query, (j) => runStkQuery(deps, j.paymentId, j.n));
  await q.work<{ orderId: string }>(JOBS.expire, (j) => expireOrder(deps, j.orderId));

  // Nightly: spend ages out of the 12-month window, so tiers can drop (applied from next month).
  await q.work(CRON_JOBS.tiersNightly, async () => {
    const rows = await deps.db.select({ id: s.customers.id }).from(s.customers).where(isNotNull(s.customers.buyerType));
    for (const r of rows) await deps.db.transaction((tx) => recomputeTier(tx, r.id, deps.clock.now()));
  });
  // Backstop for the per-order expiry job.
  await q.work(CRON_JOBS.expirySweep, async () => {
    const due = await deps.db.select({ id: s.orders.id }).from(s.orders)
      .where(and(inArray(s.orders.status, ["AWAITING_PAYMENT", "PAYMENT_FAILED"]), lte(s.orders.expiresAt, deps.clock.now())));
    for (const o of due) await expireOrder(deps, o.id);
  });
  await q.schedule(CRON_JOBS.tiersNightly, "15 2 * * *");
  await q.schedule(CRON_JOBS.expirySweep, "*/5 * * * *");
}
