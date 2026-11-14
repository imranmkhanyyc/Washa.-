import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@washa/db/schema";
import { useSim, knownCustomer, driveToSummary, orderFor } from "./helpers";
import { bodyOf, idsOf } from "../src/sim";
import { packQueue } from "../src/routes/pack";

const h = useSim();

async function toAwaiting(waId: string, opts: Parameters<typeof knownCustomer>[2] = {}) {
  await knownCustomer(h.deps, waId, opts);
  const cu = h.sim.customer(waId);
  const { sku } = await driveToSummary(cu, { km: 7 });
  await cu.tap("pay");
  const r = await cu.tap("pay_this");
  const order = await orderFor(h.deps, `+${waId}`);
  return { cu, sku, order, reply: r.replies.at(-1)!, push: h.deps.mpesa.lastPush()! };
}

const stockOf = async (sku: string) => (await h.deps.db.select().from(s.stock).where(eq(s.stock.sku, sku)))[0]!;
const paymentsOf = (orderId: string) => h.deps.db.select().from(s.payments).where(eq(s.payments.orderId, orderId));
const eventsOf = (orderId: string) => h.deps.db.select().from(s.statusEvents).where(eq(s.statusEvents.orderId, orderId));

describe("M-Pesa STK push · docs/03 acceptance criteria", () => {
  it("STK push → callback marks the order PAID (stock decremented, receipt sent, status_events written)", async () => {
    const paid: string[] = [];
    h.deps.events.on("order.paid", (e: { number: string }) => paid.push(e.number));
    const { cu, sku, order, reply, push } = await toAwaiting("254722000001");
    expect(bodyOf(reply)).toBe("Check your phone and enter your M-Pesa PIN.");
    expect(push).toMatchObject({ amountKes: order.totalKes, msisdn: "254722000001", accountReference: order.number, callbackUrl: "https://api.test/webhooks/mpesa/cb-secret" });
    expect(order.status).toBe("AWAITING_PAYMENT");
    expect((await stockOf(sku)).qtyReserved).toBe(1);

    const ack = await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA1B2C3D4" });
    expect(ack).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    const after = await orderFor(h.deps, "+254722000001");
    expect(after.status).toBe("PAID");
    const st = await stockOf(sku);
    expect(st).toMatchObject({ qtyOnHand: 9, qtyReserved: 0 });
    const [p] = await paymentsOf(order.id);
    expect(p).toMatchObject({ status: "success", mpesaReceipt: "TFA1B2C3D4", resultCode: 0 });
    const evs = (await eventsOf(order.id)).map((e) => `${e.fromStatus}>${e.toStatus}:${e.actorType}`);
    expect(evs).toEqual(["null>DRAFT:customer", "DRAFT>AWAITING_PAYMENT:customer", "AWAITING_PAYMENT>PAID:system"]);
    const receipt = cu.newReplies().find((m) => bodyOf(m).startsWith("Paid ✅"));
    expect(bodyOf(receipt)).toContain(order.number);
    expect(bodyOf(receipt)).toContain("TFA1B2C3D4");
    expect(bodyOf(receipt)).toMatch(/Arriving in about 75 min/);
    // Paid order appears on the packing screen feed, in real time.
    expect(paid).toEqual([order.number]);
    expect((await packQueue(h.deps)).map((o) => o.number)).toEqual([order.number]);
    // Tier: first paid order → base tier (Member)
    const [c] = await h.deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, "+254722000001"));
    expect(c!.tier).toBe("member");
  });

  it("customer cancels on the phone → PAYMENT_FAILED + retry buttons; retry sends a new STK", async () => {
    const { cu, order, push, sku } = await toAwaiting("254722000002");
    cu.newReplies();
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 1032, desc: "Request cancelled by user" });
    expect((await orderFor(h.deps, "+254722000002")).status).toBe("PAYMENT_FAILED");
    const msg = cu.newReplies()[0]!;
    expect(bodyOf(msg)).toContain("cancelled on the phone");
    expect(idsOf(msg)).toEqual(["pay_retry", "pay_other", "handoff"]);
    expect((await stockOf(sku)).qtyReserved).toBe(1); // held until the final retry

    const retry = await cu.tap("pay_retry");
    expect(bodyOf(retry.replies[0])).toBe("Check your phone and enter your M-Pesa PIN.");
    expect(h.deps.mpesa.pushes).toHaveLength(2);
    expect((await orderFor(h.deps, "+254722000002")).status).toBe("AWAITING_PAYMENT");
    expect(await paymentsOf(order.id)).toHaveLength(2);
  });

  it("use another number validates a Safaricom number and pushes to it", async () => {
    const { cu, push } = await toAwaiting("254722000003");
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 2001, desc: "The initiator information is invalid." });
    await cu.tap("pay_other");
    expect(bodyOf((await cu.text("12345")).replies[0])).toContain("doesn't look like a Safaricom number");
    await cu.text("0799 111 222");
    expect(h.deps.mpesa.lastPush()!.msisdn).toBe("254799111222");
  });

  it("dropped callback → STK query resolves the status within 2 min", async () => {
    const { cu, order, push } = await toAwaiting("254722000004");
    h.deps.mpesa.queryResults.set(push.CheckoutRequestID, { ResponseCode: "0", ResultCode: "0", ResultDesc: "The service request is processed successfully." });
    await h.sim.advance(59_000);
    expect((await orderFor(h.deps, "+254722000004")).status).toBe("AWAITING_PAYMENT");
    await h.sim.advance(2_000); // t = 61 s: first query
    expect((await orderFor(h.deps, "+254722000004")).status).toBe("PAID");
    expect(cu.newReplies().some((m) => bodyOf(m).startsWith("Paid ✅"))).toBe(true);
    const [p] = await paymentsOf(order.id);
    expect(p!.status).toBe("success");
    // A late callback afterwards changes nothing.
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "LATE123" });
    expect(cu.newReplies()).toHaveLength(0);
  });

  it("query still processing at 5 min → payment `unknown` and staff alerted", async () => {
    const { order } = await toAwaiting("254722000005");
    await h.sim.advance(301_000);
    const [p] = await paymentsOf(order.id);
    expect(p).toMatchObject({ status: "unknown", queryAttempts: 3 });
    const alerts = await h.deps.db.select().from(s.staffAlerts).where(eq(s.staffAlerts.orderId, order.id));
    expect(alerts.map((a) => a.kind)).toContain("payment_unknown");
    // Never expire an order while money may be in flight.
    await h.sim.advance(31 * 60_000);
    expect((await orderFor(h.deps, "+254722000005")).status).toBe("AWAITING_PAYMENT");
  });

  it("same callback delivered twice → one payment, one receipt message", async () => {
    const { cu, order, push } = await toAwaiting("254722000006");
    cu.newReplies();
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA0000001" });
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA0000001" });
    expect(await paymentsOf(order.id)).toHaveLength(1);
    expect(cu.newReplies().filter((m) => bodyOf(m).startsWith("Paid ✅"))).toHaveLength(1);
    expect((await eventsOf(order.id)).filter((e) => e.toStatus === "PAID")).toHaveLength(1);
  });

  it("amount mismatch → not paid, staff alerted", async () => {
    const { order, push } = await toAwaiting("254722000007");
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes - 100, receipt: "TFAMISMATCH" });
    expect((await orderFor(h.deps, "+254722000007")).status).toBe("AWAITING_PAYMENT");
    const [p] = await paymentsOf(order.id);
    expect(p!.status).toBe("amount_mismatch");
    const alerts = await h.deps.db.select().from(s.staffAlerts).where(eq(s.staffAlerts.orderId, order.id));
    expect(alerts.map((a) => a.kind)).toContain("amount_mismatch");
    expect(await packQueue(h.deps)).toHaveLength(0); // no dispatch without verified payment
  });

  it("one receipt can never pay two orders", async () => {
    const a = await toAwaiting("254722000008");
    const b = await toAwaiting("254722000009");
    await h.sim.mpesaCallback(a.push.CheckoutRequestID, { code: 0, amount: a.order.totalKes, receipt: "TFASAME" });
    await h.sim.mpesaCallback(b.push.CheckoutRequestID, { code: 0, amount: b.order.totalKes, receipt: "TFASAME" });
    expect((await orderFor(h.deps, "+254722000008")).status).toBe("PAID");
    expect((await orderFor(h.deps, "+254722000009")).status).toBe("AWAITING_PAYMENT");
    const alerts = await h.deps.db.select().from(s.staffAlerts);
    expect(alerts.map((x) => x.kind)).toContain("duplicate_receipt");
  });

  it("expired order releases its stock reservation and offers a resume button", async () => {
    const { cu, sku, push } = await toAwaiting("254722000010");
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 1037, desc: "DS timeout user cannot be reached" });
    cu.newReplies();
    expect((await stockOf(sku)).qtyReserved).toBe(1);
    await h.sim.advance(30 * 60_000 + 10_000);
    expect((await orderFor(h.deps, "+254722000010")).status).toBe("EXPIRED");
    expect((await stockOf(sku)).qtyReserved).toBe(0);
    const msg = cu.newReplies().at(-1)!;
    expect(bodyOf(msg)).toContain("timed out");
    const resumeId = idsOf(msg)[0]!;
    expect(resumeId).toMatch(/^resume:/);
    const summary = (await cu.tap(resumeId, "Resume order")).replies[0]!;
    expect(bodyOf(summary)).toContain("Total:");
    const fresh = await orderFor(h.deps, "+254722000010");
    expect(fresh.status).toBe("DRAFT");
  });

  it("one live STK per order; max 3 attempts, then handoff and stock released", async () => {
    const { cu, order, push, sku } = await toAwaiting("254722000011");
    // A second tap while the first push is pending is blocked.
    expect(bodyOf((await cu.tap("pay_retry")).replies[0])).toContain("already sent a request");
    expect(h.deps.mpesa.pushes).toHaveLength(1);
    await h.sim.mpesaCallback(push.CheckoutRequestID, { code: 1, desc: "insufficient balance" });
    await cu.tap("pay_retry");
    await h.sim.mpesaCallback(h.deps.mpesa.lastPush()!.CheckoutRequestID, { code: 1032 });
    await cu.tap("pay_retry");
    cu.newReplies();
    await h.sim.mpesaCallback(h.deps.mpesa.lastPush()!.CheckoutRequestID, { code: 1032 });
    expect(await paymentsOf(order.id)).toHaveLength(3);
    expect(bodyOf(cu.newReplies().at(-1))).toContain("after 3 tries");
    const [conv] = await h.deps.db.select().from(s.conversations).innerJoin(s.customers, eq(s.customers.id, s.conversations.customerId)).where(eq(s.customers.phoneE164, "+254722000011"));
    expect(conv!.conversations.handoff).toBe(true);
    expect((await stockOf(sku)).qtyReserved).toBe(0);
  });

  it("Daraja push failure → PAYMENT_FAILED with retry buttons", async () => {
    await knownCustomer(h.deps, "254722000012");
    const cu = h.sim.customer("254722000012");
    await driveToSummary(cu);
    await cu.tap("pay");
    h.deps.mpesa.failNextPush = "network down";
    const r = await cu.tap("pay_this");
    expect(idsOf(r.replies.at(-1))).toEqual(["pay_retry", "pay_other", "handoff"]);
    expect((await orderFor(h.deps, "+254722000012")).status).toBe("PAYMENT_FAILED");
  });

  it("B2B spend crossing KES 1M upgrades to Gold instantly with a WhatsApp message", async () => {
    const c = await knownCustomer(h.deps, "254722000013", { buyerType: "garage", tier: "silver" });
    // Seed prior PAID history of KES 995,000 within the last 12 months.
    const [prior] = await h.deps.db.insert(s.orders).values({ customerId: c.id, status: "PAID", totalKes: 995_000, subtotalKes: 995_000, createdAt: new Date("2026-03-01T00:00:00Z") }).returning();
    await h.deps.db.insert(s.statusEvents).values({ orderId: prior!.id, fromStatus: "AWAITING_PAYMENT", toStatus: "PAID", actorType: "system", at: new Date("2026-03-01T00:00:00Z") });
    const cu = h.sim.customer("254722000013");
    await driveToSummary(cu, { km: 7 });
    await cu.tap("pay");
    await cu.tap("pay_this");
    const o = await orderFor(h.deps, "+254722000013");
    cu.newReplies();
    await h.sim.mpesaCallback(h.deps.mpesa.lastPush()!.CheckoutRequestID, { code: 0, amount: o.totalKes, receipt: "TFAGOLD" });
    const [after] = await h.deps.db.select().from(s.customers).where(eq(s.customers.id, c.id));
    expect(after!.tier).toBe("gold");
    expect(cu.newReplies().some((m) => bodyOf(m).includes("You're now Gold"))).toBe(true);
  });
});

describe("webhook security", () => {
  it("WhatsApp verification handshake", async () => {
    const ok = await h.sim.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("12345");
    const bad = await h.sim.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1" });
    expect(bad.statusCode).toBe(403);
  });

  it("rejects a bad X-Hub-Signature-256", async () => {
    const r = await h.sim.app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: { entry: [] }, headers: { "x-hub-signature-256": "sha256=deadbeef" } });
    expect(r.statusCode).toBe(401);
  });

  it("rejects an M-Pesa callback with the wrong secret", async () => {
    const r = await h.sim.app.inject({ method: "POST", url: "/webhooks/mpesa/wrong", payload: {} });
    expect(r.statusCode).toBe(404);
  });
});
