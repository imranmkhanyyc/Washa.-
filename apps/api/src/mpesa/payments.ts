/**
 * Module 3: STK push, callback, STK query, expiry (docs/03-mpesa-stk.md).
 * PAID is set ONLY here, by a verified callback (ResultCode 0 + amount match) or an STK query result.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { toMpesaMsisdn, type Actor } from "@washa/core";
import * as s from "@washa/db/schema";
import type { Deps } from "../deps";
import {
  OutOfStockError, commitStock, loadTierLabel, recomputeTier, releaseStock, reserveStock, transitionOrder,
} from "../orders/service";
import { alertStaff, sendToCustomer } from "../notify";
import { BTN, T, etaWords, failureReason } from "../bot/copy";
import { convByCustomer, saveConv } from "../bot/store";

export const JOBS = {
  callback: "mpesa.callback",
  query: "mpesa.query",
  expire: "order.expire",
} as const;

const FINAL = ["success", "failed", "amount_mismatch"] as const;

export type StkResult =
  | { ok: true; paymentId: string; checkoutRequestId: string }
  | { ok: false; reason: "pending" | "max_attempts" | "out_of_stock" | "bad_state" | "push_failed" };

export function callbackUrl(deps: Deps) {
  return `${deps.config.env.PUBLIC_API_URL.replace(/\/$/, "")}/webhooks/mpesa/${deps.config.env.MPESA_CALLBACK_SECRET}`;
}

/** Module 2 → Module 3 handoff. */
export async function requestStkPush(deps: Deps, orderId: string, phoneE164: string, actor: Actor = { type: "customer" }): Promise<StkResult> {
  const now = deps.clock.now();
  const { maxAttempts, pendingBlockMs, orderExpiryMs } = deps.config.payments;
  const msisdn = toMpesaMsisdn(phoneE164);

  let prep: { paymentId: string; attemptNo: number; amount: number; number: string; firstPush: boolean; expiresAt: Date } | StkResult;
  try {
    prep = await deps.db.transaction(async (tx) => {
      const [o] = await tx.select().from(s.orders).where(eq(s.orders.id, orderId)).for("update");
      if (!o || !["DRAFT", "PAYMENT_FAILED"].includes(o.status)) {
        if (o?.status === "AWAITING_PAYMENT") return { ok: false, reason: "pending" } as const;
        return { ok: false, reason: "bad_state" } as const;
      }
      const prev = await tx.select().from(s.payments).where(eq(s.payments.orderId, orderId)).orderBy(desc(s.payments.createdAt));
      const live = prev.find((p) => p.status === "pending" && now.getTime() - p.createdAt.getTime() < pendingBlockMs);
      if (live) return { ok: false, reason: "pending" } as const;
      if (prev.length >= maxAttempts) return { ok: false, reason: "max_attempts" } as const;

      await reserveStock(tx, orderId);
      await transitionOrder(tx, orderId, "AWAITING_PAYMENT", actor, now);
      const firstPush = !o.expiresAt;
      const expiresAt = o.expiresAt ?? new Date(now.getTime() + orderExpiryMs);
      if (firstPush) await tx.update(s.orders).set({ expiresAt }).where(eq(s.orders.id, orderId));
      const [p] = await tx
        .insert(s.payments)
        .values({ orderId, attemptNo: prev.length + 1, phone: phoneE164, amountKes: o.totalKes, status: "pending", createdAt: now, updatedAt: now })
        .returning();
      return { paymentId: p!.id, attemptNo: p!.attemptNo, amount: o.totalKes, number: o.number, firstPush, expiresAt };
    });
  } catch (err) {
    if (err instanceof OutOfStockError) return { ok: false, reason: "out_of_stock" };
    throw err;
  }
  if ("ok" in prep) return prep;

  if (prep.firstPush) await deps.queue.send(JOBS.expire, { orderId }, { delayMs: prep.expiresAt.getTime() - now.getTime() });

  try {
    const r = await deps.mpesa.stkPush({
      amountKes: prep.amount,
      msisdn,
      accountReference: prep.number,
      description: "Washa order",
      callbackUrl: callbackUrl(deps),
      now,
    });
    await deps.db.update(s.payments)
      .set({ merchantRequestId: r.MerchantRequestID, checkoutRequestId: r.CheckoutRequestID, updatedAt: deps.clock.now() })
      .where(eq(s.payments.id, prep.paymentId));
    deps.config.payments.queryScheduleMs.forEach((delayMs, i) =>
      void deps.queue.send(JOBS.query, { paymentId: prep.paymentId, n: i + 1 }, { delayMs }),
    );
    return { ok: true, paymentId: prep.paymentId, checkoutRequestId: r.CheckoutRequestID };
  } catch (err) {
    deps.log.error({ orderId, err: err instanceof Error ? err.message : "error" }, "stk push failed");
    await finalizeFailure(deps, prep.paymentId, null, "STK push request failed", null);
    return { ok: false, reason: "push_failed" };
  }
}

interface CallbackItem { Name: string; Value?: string | number }
export interface StkCallbackBody {
  Body?: { stkCallback?: { MerchantRequestID?: string; CheckoutRequestID?: string; ResultCode?: number | string; ResultDesc?: string; CallbackMetadata?: { Item?: CallbackItem[] } } };
}

/** Job handler for POST /webhooks/mpesa/:secret. Idempotent on CheckoutRequestID. */
export async function processCallback(deps: Deps, body: StkCallbackBody, attempt = 0): Promise<"processed" | "duplicate" | "unknown_checkout"> {
  const cb = body?.Body?.stkCallback;
  const checkoutId = cb?.CheckoutRequestID;
  if (!cb || !checkoutId) return "unknown_checkout";
  const [p] = await deps.db.select().from(s.payments).where(eq(s.payments.checkoutRequestId, checkoutId));
  if (!p) {
    // The push response may not be saved yet (race). Retry briefly.
    if (attempt < 5) await deps.queue.send(JOBS.callback, { body, attempt: attempt + 1 }, { delayMs: 5_000 });
    return "unknown_checkout";
  }
  const code = Number(cb.ResultCode);
  if (code === 0) {
    const item = (n: string) => cb.CallbackMetadata?.Item?.find((i) => i.Name === n)?.Value;
    const amount = Number(item("Amount"));
    const receipt = item("MpesaReceiptNumber") != null ? String(item("MpesaReceiptNumber")) : null;
    return finalizeSuccess(deps, p.id, { amountKes: amount, receipt, resultDesc: cb.ResultDesc ?? null, raw: body });
  }
  return finalizeFailure(deps, p.id, code, cb.ResultDesc ?? null, body);
}

/** STK query safety net: 60 s, 2 min, 5 min after the push; then `unknown` + staff alert. */
export async function runStkQuery(deps: Deps, paymentId: string, n: number) {
  const [p] = await deps.db.select().from(s.payments).where(eq(s.payments.id, paymentId));
  if (!p || (FINAL as readonly string[]).includes(p.status) || !p.checkoutRequestId) return;
  const last = n >= deps.config.payments.queryScheduleMs.length;
  let r;
  try {
    r = await deps.mpesa.stkQuery(p.checkoutRequestId, deps.clock.now());
  } catch (err) {
    r = { errorMessage: err instanceof Error ? err.message : "error" };
  }
  await deps.db.update(s.payments).set({ queryAttempts: p.queryAttempts + 1, updatedAt: deps.clock.now() }).where(eq(s.payments.id, paymentId));
  if (r.ResultCode != null && r.ResultCode !== "") {
    const code = Number(r.ResultCode);
    if (code === 0) {
      // Query returns no amount/receipt; the amount is what we pushed (= order total at push time).
      await finalizeSuccess(deps, paymentId, { amountKes: p.amountKes, receipt: null, resultDesc: r.ResultDesc ?? null, raw: { query: r } });
    } else {
      await finalizeFailure(deps, paymentId, code, r.ResultDesc ?? null, { query: r });
    }
    return;
  }
  if (last) {
    await deps.db.update(s.payments).set({ status: "unknown", updatedAt: deps.clock.now() }).where(and(eq(s.payments.id, paymentId), eq(s.payments.status, "pending")));
    await alertStaff(deps, { kind: "payment_unknown", orderId: p.orderId, message: `No M-Pesa result for payment attempt ${p.attemptNo} after 5 min. Check the M-Pesa statement.` });
  }
}

async function finalizeSuccess(
  deps: Deps, paymentId: string, r: { amountKes: number; receipt: string | null; resultDesc: string | null; raw: unknown },
): Promise<"processed" | "duplicate"> {
  const now = deps.clock.now();
  type Outcome =
    | { kind: "duplicate" }
    | { kind: "paid"; orderId: string; customerId: string; upgradedTo: string | null; track: "b2b" | "d2c" | null }
    | { kind: "mismatch" | "late"; orderId: string; customerId: string; msg: string };

  let out: Outcome;
  try {
    out = await deps.db.transaction(async (tx): Promise<Outcome> => {
      const [p] = await tx.select().from(s.payments).where(eq(s.payments.id, paymentId)).for("update");
      if (!p || (FINAL as readonly string[]).includes(p.status)) return { kind: "duplicate" };
      const [o] = await tx.select().from(s.orders).where(eq(s.orders.id, p.orderId)).for("update");
      if (!o) return { kind: "duplicate" };
      const base = { resultCode: 0, resultDesc: r.resultDesc, mpesaReceipt: r.receipt, raw: r.raw as object, updatedAt: now };

      if (r.amountKes !== o.totalKes || r.amountKes !== p.amountKes) {
        await tx.update(s.payments).set({ ...base, status: "amount_mismatch" }).where(eq(s.payments.id, p.id));
        return { kind: "mismatch", orderId: o.id, customerId: o.customerId, msg: `Order ${o.number}: M-Pesa paid KES ${r.amountKes}, order total KES ${o.totalKes}. NOT marked paid.` };
      }
      await tx.update(s.payments).set({ ...base, status: "success" }).where(eq(s.payments.id, p.id));
      if (o.status !== "AWAITING_PAYMENT") {
        return { kind: "late", orderId: o.id, customerId: o.customerId, msg: `Order ${o.number} is ${o.status} but M-Pesa confirmed payment ${r.receipt ?? "(via query)"}. Needs manual action.` };
      }
      await transitionOrder(tx, o.id, "PAID", { type: "system", id: "mpesa" }, now);
      await commitStock(tx, o.id);
      const change = await recomputeTier(tx, o.customerId, now);
      const [c] = await tx.select({ track: s.customers.tierTrack }).from(s.customers).where(eq(s.customers.id, o.customerId));
      return { kind: "paid", orderId: o.id, customerId: o.customerId, upgradedTo: change.kind === "upgrade" ? change.to : null, track: c?.track ?? null };
    });
  } catch (err: any) {
    if (err?.code === "23505" && String(err?.constraint ?? "").includes("receipt")) {
      // Receipt already used on another payment: one receipt can never pay two orders.
      const [p] = await deps.db.select().from(s.payments).where(eq(s.payments.id, paymentId));
      await deps.db.update(s.payments).set({ status: "amount_mismatch", resultCode: 0, resultDesc: "duplicate receipt", updatedAt: now }).where(eq(s.payments.id, paymentId));
      await alertStaff(deps, { kind: "duplicate_receipt", orderId: p?.orderId, gm: true, message: `M-Pesa receipt ${r.receipt} was already used on another payment.` });
      return "processed";
    }
    throw err;
  }

  if (out.kind === "duplicate") return "duplicate";
  const [order] = await deps.db.select().from(s.orders).where(eq(s.orders.id, out.orderId));
  const [cust] = await deps.db.select().from(s.customers).where(eq(s.customers.id, out.customerId));
  const conv = await convByCustomer(deps.db, out.customerId);
  const to = { customerId: cust!.id, phoneE164: cust!.phoneE164 };

  if (out.kind !== "paid") {
    if (conv) await saveConv(deps.db, conv.id, { handoff: true, handoffReason: out.kind === "mismatch" ? "amount_mismatch" : "late_payment" });
    await alertStaff(deps, { kind: out.kind === "mismatch" ? "amount_mismatch" : "late_payment", orderId: out.orderId, conversationId: conv?.id, gm: true, message: out.msg });
    await sendToCustomer(deps, to, { kind: "text", body: T.handoff }, { category: "transactional" });
    return "processed";
  }

  const pickup = order!.deliveryMode === "pickup";
  const eta = order!.etaAt ? etaWords(order!.etaAt, now) : "";
  const [pay] = await deps.db.select().from(s.payments).where(eq(s.payments.id, paymentId));
  await sendToCustomer(deps, to, { kind: "text", body: T.paid(order!.number, pay?.mpesaReceipt ?? null, eta, pickup) }, {
    category: "transactional",
    template: { name: "order_paid", params: [order!.number, pay?.mpesaReceipt ?? "-", eta || "-"] },
  });
  if (conv) await saveConv(deps.db, conv.id, { state: "PAID_DONE", context: {} });
  if (out.upgradedTo && out.track) {
    const label = await loadTierLabel(deps.db, out.track, out.upgradedTo);
    await sendToCustomer(deps, to, { kind: "text", body: T.tierUpgrade(label) }, { category: "marketing", template: { name: "tier_upgrade", params: [label] } });
  }
  deps.events.emit("order.paid", { orderId: order!.id, number: order!.number });
  return "processed";
}

async function finalizeFailure(deps: Deps, paymentId: string, code: number | null, desc: string | null, raw: unknown): Promise<"processed" | "duplicate"> {
  const now = deps.clock.now();
  const res = await deps.db.transaction(async (tx) => {
    const [p] = await tx.select().from(s.payments).where(eq(s.payments.id, paymentId)).for("update");
    if (!p || (FINAL as readonly string[]).includes(p.status)) return null;
    await tx.update(s.payments).set({ status: "failed", resultCode: code, resultDesc: desc, raw: raw as object, updatedAt: now }).where(eq(s.payments.id, p.id));
    const [o] = await tx.select().from(s.orders).where(eq(s.orders.id, p.orderId)).for("update");
    if (!o) return null;
    const attempts = (await tx.select({ id: s.payments.id }).from(s.payments).where(eq(s.payments.orderId, o.id))).length;
    const final = attempts >= deps.config.payments.maxAttempts;
    if (o.status === "AWAITING_PAYMENT") {
      await transitionOrder(tx, o.id, "PAYMENT_FAILED", { type: "system", id: "mpesa" }, now);
      if (final) await releaseStock(tx, o.id);
    }
    return { orderId: o.id, customerId: o.customerId, final, number: o.number, wasAwaiting: o.status === "AWAITING_PAYMENT" };
  });
  if (!res) return "duplicate";
  if (!res.wasAwaiting) return "processed";

  const [cust] = await deps.db.select().from(s.customers).where(eq(s.customers.id, res.customerId));
  const conv = await convByCustomer(deps.db, res.customerId);
  const to = { customerId: cust!.id, phoneE164: cust!.phoneE164 };
  if (res.final) {
    if (conv) await saveConv(deps.db, conv.id, { handoff: true, handoffReason: "max_payment_attempts" });
    await alertStaff(deps, { kind: "handoff", orderId: res.orderId, conversationId: conv?.id, message: `Order ${res.number}: 3 failed M-Pesa attempts.` });
    await sendToCustomer(deps, to, { kind: "text", body: T.payFailedFinal }, { category: "transactional" });
  } else {
    await sendToCustomer(
      deps, to,
      { kind: "buttons", body: T.payFailed(failureReason(code, desc)), buttons: [BTN.retry, BTN.payOther, BTN.person] },
      { category: "transactional", template: { name: "payment_failed_retry", params: [res.number] } },
    );
  }
  return "processed";
}

/** AWAITING_PAYMENT (or PAYMENT_FAILED) older than 30 min → EXPIRED, stock released, resume button. */
export async function expireOrder(deps: Deps, orderId: string) {
  const now = deps.clock.now();
  const res = await deps.db.transaction(async (tx) => {
    const [o] = await tx.select().from(s.orders).where(eq(s.orders.id, orderId)).for("update");
    if (!o || !["AWAITING_PAYMENT", "PAYMENT_FAILED"].includes(o.status)) return null;
    if (o.expiresAt && o.expiresAt > now) return { retryInMs: o.expiresAt.getTime() - now.getTime() };
    const ps = await tx.select().from(s.payments).where(and(eq(s.payments.orderId, orderId), inArray(s.payments.status, ["pending", "unknown", "amount_mismatch"])));
    // Money may be in flight or under staff review: never expire under it.
    if (ps.some((p) => p.status !== "pending")) return null;
    if (ps.some((p) => p.status === "pending")) return { retryInMs: 60_000 };
    await transitionOrder(tx, orderId, "EXPIRED", { type: "system", id: "expiry" }, now);
    await releaseStock(tx, orderId);
    return { expired: o };
  });
  if (!res) return;
  if ("retryInMs" in res) {
    await deps.queue.send(JOBS.expire, { orderId }, { delayMs: res.retryInMs });
    return;
  }
  const o = res.expired;
  const [cust] = await deps.db.select().from(s.customers).where(eq(s.customers.id, o.customerId));
  const conv = await convByCustomer(deps.db, o.customerId);
  if (conv && !conv.handoff) await saveConv(deps.db, conv.id, { state: "MENU", context: { orderId: o.id, step: "expired" } });
  await sendToCustomer(
    deps, { customerId: cust!.id, phoneE164: cust!.phoneE164 },
    { kind: "buttons", body: T.expired(o.number), buttons: [{ id: `resume:${o.id}`, title: T.resume.title }, BTN.person] },
    { category: "transactional" },
  );
}
