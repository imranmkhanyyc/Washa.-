/**
 * pnpm simulate:order
 * Runs the whole WhatsApp chat → STK push → PAID loop locally with fake webhooks
 * (no Meta, no Safaricom, no Claude). Covers success, cancel, timeout and duplicate paths.
 *
 * Uses SIM_DATABASE_URL (default: a separate `washa_sim` database, created and reset on every run).
 */
import { eq } from "drizzle-orm";
import * as s from "../packages/db/src/schema";
import { buildApp } from "../apps/api/src/app";
import { createTestDeps } from "../apps/api/src/wiring";
import { Sim, SimCustomer, bodyOf, ensureDatabase, idsOf, resetDb } from "../apps/api/src/sim";
import type { OutMessage } from "../apps/api/src/whatsapp/types";

const URL_ = process.env.SIM_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/washa_sim";
const quiet = process.argv.includes("--quiet");
const failures: string[] = [];

function show(who: string, line: string) {
  if (!quiet) console.log(`  ${who.padEnd(8)} ${line.replace(/\n/g, "\n           ")}`);
}
function showReplies(ms: OutMessage[]) {
  for (const m of ms) {
    const extra = m.kind === "buttons" ? `  [${m.buttons.map((b) => b.title).join("] [")}]`
      : m.kind === "list" ? `\n${m.rows.map((r) => `   ▸ ${r.title}${r.description ? ` | ${r.description}` : ""}`).join("\n")}`
      : m.kind === "location_request" ? "  [📍 Send location]" : "";
    show("Washa:", `${"body" in m ? m.body : `(template ${m.kind})`}${extra}`);
  }
}
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

async function say(cu: SimCustomer, label: string, fn: () => Promise<{ replies: OutMessage[] }>) {
  show("Customer:", label);
  const r = await fn();
  showReplies(r.replies);
  return r.replies;
}

async function main() {
  await ensureDatabase(URL_);
  const { deps, close } = await createTestDeps(URL_);
  const app = await buildApp(deps);
  const sim = new Sim(deps, app);
  await resetDb(deps.db);
  const orderOf = async (phone: string) => {
    const [c] = await deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, phone));
    const os = await deps.db.select().from(s.orders).where(eq(s.orders.customerId, c!.id));
    return os.sort((a, b) => a.number.localeCompare(b.number)).at(-1)!;
  };

  /** New customer: Hi → consent → profile → car → offer → qty → pin → summary → pay. */
  async function chatToPay(waId: string, name: string, car: string, km: number) {
    const cu = sim.customer(waId, name);
    await say(cu, "Hi", () => cu.text("Hi"));
    await say(cu, "[OK]", () => cu.tap("consent_ok"));
    await say(cu, name, () => cu.text(name));
    await say(cu, "[Personal car]", () => cu.tap("bt_retail"));
    await say(cu, "[Buy a battery]", () => cu.pick("menu_buy"));
    await say(cu, "[By my car]", () => cu.tap("m_car"));
    await say(cu, "[Toyota]", () => cu.pick("make:Toyota"));
    const offer = (await say(cu, car, () => cu.text(car))).at(-1);
    const sku = idsOf(offer)[1] ?? idsOf(offer)[0]!;
    await say(cu, `[${sku.slice(4)}]`, () => cu.pick(sku));
    await say(cu, "[1]", () => cu.tap("qty_1"));
    const p = { lat: -1.2841 + km / 111.195, lng: 36.8219 };
    await say(cu, `📍 (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`, () => cu.location(p.lat, p.lng, "Kilimani"));
    const ours = cu.allReplies().length;
    await say(cu, "[Pay with M-Pesa]", () => cu.tap("pay"));
    await say(cu, "[Pay from this number]", () => cu.tap("pay_this"));
    return { cu, sku: sku.slice(4), messagesToSummary: ours };
  }

  // ---------- 1. Success ----------
  console.log("\n▶ Scenario 1: success (new customer, Toyota Fielder, zone B)");
  {
    const { cu, sku, messagesToSummary } = await chatToPay("254712000001", "Amina", "Fielder 2015", 7);
    const order = await orderOf("+254712000001");
    const push = deps.mpesa.lastPush()!;
    show("Daraja:", `STK push ${push.CheckoutRequestID} · KES ${push.amountKes} · ref ${push.accountReference}`);
    show("Daraja:", "callback ResultCode 0, receipt TFA1SIM001");
    await sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA1SIM001" });
    showReplies(cu.newReplies());
    const after = await orderOf("+254712000001");
    const [st] = await deps.db.select().from(s.stock).where(eq(s.stock.sku, sku));
    check("order is PAID", after.status === "PAID", after.status);
    check("≤ 12 messages from us to reach the summary", messagesToSummary <= 12, String(messagesToSummary));
    check("stock decremented (10 → 9, nothing reserved)", st!.qtyOnHand === 9 && st!.qtyReserved === 0);
    check("receipt sent with order number and M-Pesa code", bodyOf(deps.wa.last("254712000001")).includes(after.number) && bodyOf(deps.wa.last("254712000001")).includes("TFA1SIM001"));
  }

  // ---------- 2. Cancel → retry → success ----------
  console.log("\n▶ Scenario 2: customer cancels on the phone, then retries");
  {
    const { cu } = await chatToPay("254712000002", "Brian", "Probox 2012", 3);
    const order = await orderOf("+254712000002");
    show("Daraja:", "callback ResultCode 1032 (cancelled by user)");
    await sim.mpesaCallback(deps.mpesa.lastPush()!.CheckoutRequestID, { code: 1032, desc: "Request cancelled by user" });
    const failMsg = cu.newReplies();
    showReplies(failMsg);
    check("order is PAYMENT_FAILED", (await orderOf("+254712000002")).status === "PAYMENT_FAILED");
    check("retry buttons shown", JSON.stringify(idsOf(failMsg.at(-1))) === JSON.stringify(["pay_retry", "pay_other", "handoff"]));
    await say(cu, "[Try again]", () => cu.tap("pay_retry"));
    show("Daraja:", "callback ResultCode 0, receipt TFA1SIM002");
    await sim.mpesaCallback(deps.mpesa.lastPush()!.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA1SIM002" });
    showReplies(cu.newReplies());
    check("order is PAID after retry", (await orderOf("+254712000002")).status === "PAID");
  }

  // ---------- 3. Timeout: callback never arrives ----------
  console.log("\n▶ Scenario 3: callback dropped → STK query at 60 s resolves it");
  {
    const { cu } = await chatToPay("254712000003", "Chebet", "Harrier 2016", 15);
    const push = deps.mpesa.lastPush()!;
    deps.mpesa.queryResults.set(push.CheckoutRequestID, { ResponseCode: "0", ResultCode: "0", ResultDesc: "The service request is processed successfully." });
    show("(clock)", "no callback… advancing 61 s");
    await sim.advance(61_000);
    showReplies(cu.newReplies());
    check("STK query marked the order PAID within 2 min", (await orderOf("+254712000003")).status === "PAID");
  }
  console.log("\n▶ Scenario 3b: no callback and the query never resolves → expiry");
  {
    const { cu, sku } = await chatToPay("254712000004", "Daudi", "Vitz 2014", 2);
    show("(clock)", "no callback, query keeps saying 'processing'… advancing 5 min");
    await sim.advance(5 * 60_000 + 1_000);
    const [p] = await deps.db.select().from(s.payments).where(eq(s.payments.orderId, (await orderOf("+254712000004")).id));
    check("payment marked unknown and staff alerted after 5 min", p!.status === "unknown");
    // Staff check the statement and find the customer never paid: they mark it failed, expiry then runs.
    await deps.db.update(s.payments).set({ status: "failed" }).where(eq(s.payments.id, p!.id));
    show("(staff)", "statement checked: not paid → payment set failed");
    show("(clock)", "advancing to 30 min");
    await sim.advance(26 * 60_000);
    showReplies(cu.newReplies());
    const [st] = await deps.db.select().from(s.stock).where(eq(s.stock.sku, sku));
    check("order EXPIRED", (await orderOf("+254712000004")).status === "EXPIRED");
    check("stock reservation released", st!.qtyReserved === 0);
  }

  // ---------- 4. Duplicates ----------
  console.log("\n▶ Scenario 4: duplicate WhatsApp webhook + duplicate M-Pesa callback");
  {
    const cu = sim.customer("254712000005", "Esther");
    await say(cu, "Hi (wamid.DUP)", () => cu.text("Hi", "wamid.DUP"));
    const dup = await say(cu, "Hi (same wamid.DUP, redelivered by Meta)", () => cu.replay("wamid.DUP", "Hi"));
    check("redelivered WhatsApp message gets no reply", dup.length === 0);
    await cu.tap("consent_ok"); await cu.text("Esther"); await cu.tap("bt_retail");
    const offer = (await cu.text("NS70 L")).replies.at(-1);
    await cu.pick(idsOf(offer)[0]!); await cu.tap("qty_1");
    await cu.location(-1.29, 36.80, "Westlands"); await cu.tap("pay"); await cu.tap("pay_this");
    cu.newReplies();
    const order = await orderOf("+254712000005");
    const push = deps.mpesa.lastPush()!;
    show("Daraja:", "callback ResultCode 0 (×2, same CheckoutRequestID)");
    await sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA1SIM005" });
    await sim.mpesaCallback(push.CheckoutRequestID, { code: 0, amount: order.totalKes, receipt: "TFA1SIM005" });
    const replies = cu.newReplies();
    showReplies(replies);
    const pays = await deps.db.select().from(s.payments).where(eq(s.payments.orderId, order.id));
    const orders = await deps.db.select().from(s.orders).innerJoin(s.customers, eq(s.customers.id, s.orders.customerId)).where(eq(s.customers.phoneE164, "+254712000005"));
    check("one payment row", pays.length === 1);
    check("one receipt message", replies.filter((m) => bodyOf(m).startsWith("Paid ✅")).length === 1);
    check("one order", orders.length === 1);
  }

  await app.close();
  await close();
  console.log(failures.length ? `\n✘ ${failures.length} check(s) failed: ${failures.join("; ")}` : "\n✔ All simulation checks passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
