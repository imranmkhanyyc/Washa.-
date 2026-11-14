/**
 * Records real conversations from the engine (fake webhooks, offline M-Pesa/Claude) to JSON
 * for the shareable flow demo. Usage: tsx scripts/record-demo.ts <out.json>
 */
import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import * as s from "../packages/db/src/schema";
import { buildApp } from "../apps/api/src/app";
import { createTestDeps } from "../apps/api/src/wiring";
import { Sim, SimCustomer, ensureDatabase, idsOf, resetDb } from "../apps/api/src/sim";
import type { OutMessage } from "../apps/api/src/whatsapp/types";

const URL_ = process.env.SIM_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/washa_sim";
type Ev = { t: "in"; label: string; kind: string } | { t: "out"; msg: OutMessage } | { t: "sys"; text: string; tone?: string };
const north = (km: number) => ({ lat: -1.2841 + km / 111.195, lng: 36.8219 });

async function main() {
  await ensureDatabase(URL_);
  const { deps, close } = await createTestDeps(URL_);
  const app = await buildApp(deps);
  const sim = new Sim(deps, app);
  const scenarios: { id: string; title: string; summary: string; who: string; events: Ev[] }[] = [];

  async function scenario(id: string, title: string, summary: string, who: string, fn: (r: Rec) => Promise<void>) {
    await resetDb(deps.db);
    deps.clock.set(new Date("2026-06-13T09:00:00Z"));
    deps.wa.outbox = [];
    deps.mpesa.pushes = [];
    deps.mpesa.queryResults.clear();
    const r = new Rec();
    await fn(r);
    scenarios.push({ id, title, summary, who, events: r.events });
  }

  class Rec {
    events: Ev[] = [];
    last: Record<string, string> = {};
    cu!: SimCustomer;
    phone = "";
    sys(text: string, tone?: string) { this.events.push({ t: "sys", text, tone }); }
    async state() {
      const [c] = await deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, this.phone));
      if (!c) return;
      const os = await deps.db.select().from(s.orders).where(eq(s.orders.customerId, c.id));
      for (const o of os.sort((a, b) => a.number.localeCompare(b.number))) {
        if (this.last[o.id] !== o.status) {
          const prev = this.last[o.id];
          this.last[o.id] = o.status;
          if (o.status === "CANCELLED" && !prev) continue;
          this.sys(`Order ${o.number}: ${prev ? prev + " → " : ""}${o.status}${o.status === "DRAFT" ? ` · total KES ${o.totalKes.toLocaleString("en-KE")} locked` : ""}`, o.status === "PAID" ? "good" : ["PAYMENT_FAILED", "EXPIRED"].includes(o.status) ? "bad" : undefined);
        }
      }
      const [conv] = await deps.db.select().from(s.conversations).where(eq(s.conversations.customerId, c.id));
      if (conv?.handoff && this.last.handoff !== "1") { this.last.handoff = "1"; this.sys(`Handoff: bot silenced · staff alerted (${conv.handoffReason})`, "warn"); }
      if (conv && !conv.handoff && this.last.handoff === "1") { this.last.handoff = "0"; this.sys("Staff tapped Release to bot", "good"); }
    }
    async do(label: string, kind: string, fn: () => Promise<{ replies: OutMessage[] }>) {
      this.events.push({ t: "in", label, kind });
      const pushes = deps.mpesa.pushes.length;
      const r = await fn();
      await this.state();
      if (deps.mpesa.pushes.length > pushes) {
        const p = deps.mpesa.lastPush()!;
        this.sys(`STK push sent to ${p.msisdn} · KES ${p.amountKes.toLocaleString("en-KE")} · ref ${p.accountReference}`);
      }
      for (const m of r.replies) this.events.push({ t: "out", msg: m });
      return r.replies;
    }
    async callback(code: number, receipt?: string, desc?: string) {
      const o = await this.order();
      this.sys(code === 0 ? `Safaricom callback: ResultCode 0 · receipt ${receipt}` : `Safaricom callback: ResultCode ${code} (${desc})`, code === 0 ? undefined : "bad");
      await sim.mpesaCallback(deps.mpesa.lastPush()!.CheckoutRequestID, { code, amount: o.totalKes, receipt, desc });
      await this.state();
      for (const m of this.cu.newReplies()) this.events.push({ t: "out", msg: m });
    }
    async advance(ms: number, note: string) {
      this.sys(note, "clock");
      await sim.advance(ms);
      await this.state();
      for (const m of this.cu.newReplies()) this.events.push({ t: "out", msg: m });
    }
    async order() {
      const [c] = await deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, this.phone));
      const os = await deps.db.select().from(s.orders).where(eq(s.orders.customerId, c!.id));
      return os.sort((a, b) => a.number.localeCompare(b.number)).at(-1)!;
    }
  }

  const start = (r: Rec, waId: string, name: string) => { r.phone = `+${waId}`; r.cu = sim.customer(waId, name); return r.cu; };
  const known = async (waId: string, name: string, bt: "retail" | "garage", tier: string | null, business?: string) => {
    const [c] = await deps.db.insert(s.customers).values({ phoneE164: `+${waId}`, name, buyerType: bt, tierTrack: bt === "retail" ? "d2c" : "b2b", tier, businessName: business, consentAt: new Date("2026-01-01") }).returning();
    await deps.db.insert(s.conversations).values({ customerId: c!.id, state: "PAID_DONE", lastInboundAt: new Date("2026-01-01") });
  };
  async function signUpAndBuy(r: Rec, cu: SimCustomer, name: string, model: string, km: number, place: string) {
    await r.do("Hi", "text", () => cu.text("Hi"));
    await r.do("OK", "tap", () => cu.tap("consent_ok"));
    await r.do(name, "text", () => cu.text(name));
    await r.do("Personal car", "tap", () => cu.tap("bt_retail"));
    await r.do("Buy a battery", "tap", () => cu.pick("menu_buy"));
    await r.do("By my car", "tap", () => cu.tap("m_car"));
    await r.do("Toyota", "tap", () => cu.pick("make:Toyota"));
    const offer = (await r.do(model, "text", () => cu.text(model))).at(-1);
    const row = offer?.kind === "list" ? offer.rows[1]! : null;
    await r.do(row!.title, "tap", () => cu.pick(row!.id));
    await r.do("1", "tap", () => cu.tap("qty_1"));
    const p = north(km);
    await r.do(`📍 ${place}`, "location", () => cu.location(p.lat, p.lng, place));
  }
  const pay = async (r: Rec) => {
    await r.do("Pay with M-Pesa", "tap", () => r.cu.tap("pay"));
    await r.do("Pay from this number", "tap", () => r.cu.tap("pay_this"));
  };

  await scenario("happy", "New customer, paid", "First contact to a paid order: consent, profile, match by car, offer, pin, M-Pesa.", "Amina · new number", async (r) => {
    const cu = start(r, "254712000001", "Amina");
    await signUpAndBuy(r, cu, "Amina", "Fielder 2015", 7, "Parklands");
    r.sys(`${cu.allReplies().length} messages from Washa to reach the summary (target ≤ 12)`, "good");
    await pay(r);
    await r.callback(0, "TFA1B2C3D4");
    r.sys("Order appears on the packing screen · stock 10 → 9", "good");
  });

  await scenario("cancel", "Cancelled, then retried", "Customer cancels the PIN prompt, taps Try again, and pays on the second push.", "Brian · new number", async (r) => {
    const cu = start(r, "254712000002", "Brian");
    await signUpAndBuy(r, cu, "Brian", "Probox 2012", 3, "Upper Hill");
    await pay(r);
    await r.callback(1032, undefined, "Request cancelled by user");
    await r.do("Try again", "tap", () => cu.tap("pay_retry"));
    await r.callback(0, "TFA9X8Y7Z6");
  });

  await scenario("dropped", "Callback never arrives", "Safaricom's callback is lost. The STK query at 60 s confirms the payment.", "Chebet · new number", async (r) => {
    const cu = start(r, "254712000003", "Chebet");
    await signUpAndBuy(r, cu, "Chebet", "Harrier 2016", 15, "Roysambu");
    await pay(r);
    deps.mpesa.queryResults.set(deps.mpesa.lastPush()!.CheckoutRequestID, { ResponseCode: "0", ResultCode: "0", ResultDesc: "processed successfully" });
    await r.advance(61_000, "No callback… 61 s later the STK query runs");
  });

  await scenario("photo", "Photo of the old battery", "Known customer sends a label photo. Vision reads it, the bot confirms back, then offers.", "Wanjiku · returning", async (r) => {
    await known("254712000004", "Wanjiku", "retail", "member");
    const cu = start(r, "254712000004", "Wanjiku");
    deps.wa.media.set("m1", { data: Buffer.from("ns70"), mimeType: "image/jpeg" });
    deps.ai.labels.set("ns70", { size_family: "75D23L", polarity: "L", brand: "Amaron" });
    await r.do("Hi", "text", () => cu.text("Hi"));
    await r.do("Not sure what I need", "tap", () => cu.pick("menu_unsure"));
    await r.do("Send a photo", "tap", () => cu.tap("m_photo"));
    r.sys("Label reads 75D23L → mapped to NS70, terminal left");
    await r.do("🖼 Photo of battery label", "image", () => cu.image("m1"));
    await r.do("Yes, correct", "tap", () => cu.tap("yes"));
  });

  await scenario("gold", "Gold garage, Hilux diesel", "B2B Gold customer: one clarifying question on engine, tier prices, 50% off delivery, 4 units across 2 riders.", "Otieno Motors · Gold", async (r) => {
    await known("254712000005", "Otieno", "garage", "gold", "Otieno Motors");
    const cu = start(r, "254712000005", "Otieno");
    await r.do("Hi", "text", () => cu.text("Hi"));
    await r.do("Buy a battery", "tap", () => cu.pick("menu_buy"));
    await r.do("By my car", "tap", () => cu.tap("m_car"));
    await r.do("Toyota", "tap", () => cu.pick("make:Toyota"));
    await r.do("Hilux 2018", "text", () => cu.text("Hilux 2018"));
    const offer = (await r.do("Diesel", "tap", () => cu.tap("eng:Diesel", "Diesel"))).at(-1);
    const row = offer?.kind === "list" ? offer.rows[0]! : null;
    await r.do(row!.title, "tap", () => cu.pick(row!.id));
    await r.do("4", "text", () => cu.text("4"));
    const p = north(7);
    await r.do("📍 Industrial Area", "location", () => cu.location(p.lat, p.lng, "Industrial Area"));
  });

  await scenario("area", "Outside the delivery area", "Pin 50 km out: no price, the bot offers a call-back or pickup.", "Grace · returning", async (r) => {
    await known("254712000006", "Grace", "retail", null);
    const cu = start(r, "254712000006", "Grace");
    await r.do("Hi", "text", () => cu.text("Hi"));
    const offer = (await r.do("NS40", "text", () => cu.text("NS40"))).at(-1);
    const row = offer?.kind === "list" ? offer.rows[0]! : null;
    await r.do(row!.title, "tap", () => cu.pick(row!.id));
    await r.do("1", "tap", () => cu.tap("qty_1"));
    const p = north(50);
    await r.do("📍 Thika", "location", () => cu.location(p.lat, p.lng, "Thika"));
    await r.do("Pick up", "tap", () => cu.tap("pickup"));
  });

  await scenario("expiry", "Timed out, then resumed", "Payment fails, nobody retries, the order expires after 30 min, stock is released, and the customer resumes.", "Daudi · new number", async (r) => {
    const cu = start(r, "254712000007", "Daudi");
    await signUpAndBuy(r, cu, "Daudi", "Vitz 2014", 2, "Kilimani");
    await pay(r);
    await r.callback(1037, undefined, "phone unreachable");
    await r.advance(30 * 60_000 + 10_000, "30 minutes pass with no retry");
    r.sys("Stock reservation released", "good");
    const msg = cu.allReplies().at(-1);
    await r.do("Resume order", "tap", () => cu.tap(idsOf(msg)[0]!, "Resume order"));
  });

  await scenario("handoff", "Complaint goes to a person", "Warranty complaint hands off to staff, the bot goes silent, then staff release it.", "Peter · returning", async (r) => {
    await known("254712000008", "Peter", "retail", "member");
    const cu = start(r, "254712000008", "Peter");
    await r.do("Hi", "text", () => cu.text("Hi"));
    await r.do("The battery you sold me is faulty, I want a warranty replacement", "text", () => cu.text("The battery you sold me is faulty, I want a warranty replacement"));
    await r.do("Hello??", "text", () => cu.text("Hello??"));
    r.sys("Bot stays silent while a person handles the chat");
    const [conv] = await deps.db.select().from(s.conversations).innerJoin(s.customers, eq(s.customers.id, s.conversations.customerId)).where(eq(s.customers.phoneE164, r.phone));
    await app.inject({ method: "POST", url: `/admin/conversations/${conv!.conversations.id}/release`, headers: { authorization: "Bearer admin-token" } });
    await r.state();
    await r.do("Hi", "text", () => cu.text("Hi"));
  });

  writeFileSync(process.argv[2]!, JSON.stringify(scenarios));
  console.log(`recorded ${scenarios.length} scenarios, ${scenarios.reduce((n, x) => n + x.events.length, 0)} events`);
  await app.close();
  await close();
}
main().catch((e) => { console.error(e); process.exit(1); });
