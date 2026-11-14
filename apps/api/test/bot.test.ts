import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import * as s from "@washa/db/schema";
import { useSim, knownCustomer, driveToSummary, north, orderFor } from "./helpers";
import { bodyOf, idsOf } from "../src/sim";
import { sendToCustomer } from "../src/notify";

const h = useSim();

describe("WhatsApp bot · docs/02 acceptance criteria", () => {
  it("new number: consent → profile → match by car → offer → location → summary in ≤ 12 messages from us", async () => {
    const cu = h.sim.customer("254711000001");
    expect(bodyOf((await cu.text("Hi")).replies[0])).toContain("Reply STOP anytime");
    await cu.tap("consent_ok");
    await cu.text("Amina");
    await cu.tap("bt_retail");
    await cu.pick("menu_buy");
    await cu.tap("m_car");
    await cu.pick("make:Toyota");
    const offer = await cu.text("Fielder 2015");
    const list = offer.replies[0]!;
    expect(list.kind).toBe("list");
    expect(bodyOf(list)).toContain("NS60");
    await cu.pick(idsOf(list)[0]!);
    await cu.tap("qty_1");
    const p = north(7);
    const summary = (await cu.location(p.lat, p.lng, "Parklands")).replies.at(-1)!;
    expect(bodyOf(summary)).toMatch(/Total: KES/);
    expect(idsOf(summary)).toEqual(["pay", "change", "handoff"]);

    const sent = cu.allReplies().length;
    expect(sent).toBeLessThanOrEqual(12);

    // Data capture: customer, vehicle and location records exist.
    const [c] = await h.deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, "+254711000001"));
    expect(c).toMatchObject({ name: "Amina", buyerType: "retail", tierTrack: "d2c" });
    expect(c!.consentAt).not.toBeNull();
    const [v] = await h.deps.db.select().from(s.vehicles).where(eq(s.vehicles.customerId, c!.id));
    expect(v).toMatchObject({ make: "Toyota", model: "Fielder", year: 2015, batterySize: "NS60L" });
    const locs = await h.deps.db.select().from(s.locations).where(eq(s.locations.customerId, c!.id));
    expect(locs).toHaveLength(1);
    const o = await orderFor(h.deps, "+254711000001");
    expect(o.status).toBe("DRAFT");
    expect(o.totalKes).toBe(o.subtotalKes - o.discountKes + o.deliveryFeeKes);
  });

  it("business buyer is asked for the business name", async () => {
    const cu = h.sim.customer("254711000002");
    await cu.text("Hi");
    await cu.tap("consent_ok");
    await cu.text("Otieno");
    expect(bodyOf((await cu.tap("bt_garage")).replies[0])).toContain("name of your business");
    const r = await cu.text("Otieno Motors");
    expect(r.replies[0]!.kind).toBe("list");
    const [c] = await h.deps.db.select().from(s.customers).where(eq(s.customers.phoneE164, "+254711000002"));
    expect(c).toMatchObject({ buyerType: "garage", tierTrack: "b2b", businessName: "Otieno Motors" });
  });

  it("known number skips profile and sees 'Karibu back, {name}'", async () => {
    await knownCustomer(h.deps, "254711000003", { name: "Wanjiku" });
    const r = await h.sim.customer("254711000003").text("Hi");
    expect(r.replies).toHaveLength(1);
    expect(bodyOf(r.replies[0])).toContain("Karibu back, Wanjiku");
    expect(r.replies[0]!.kind).toBe("list");
  });

  it("photo of an NS70 label → correct size suggested and confirmed", async () => {
    await knownCustomer(h.deps, "254711000004");
    h.deps.wa.media.set("media-ns70", { data: Buffer.from("label:ns70"), mimeType: "image/jpeg" });
    h.deps.ai.labels.set("label:ns70", { size_family: "75D23L", polarity: "L", brand: "Amaron" });
    const cu = h.sim.customer("254711000004");
    await cu.text("Hi");
    await cu.pick("menu_unsure");
    await cu.tap("m_photo");
    const confirm = (await cu.image("media-ns70")).replies[0]!;
    expect(bodyOf(confirm)).toBe("Looks like an NS70, terminal on the left. Correct?");
    expect(idsOf(confirm)).toEqual(["yes", "no"]);
    const offer = (await cu.tap("yes")).replies[0]!;
    expect(offer.kind).toBe("list");
    expect(idsOf(offer).every((id) => id.endsWith("NS70L"))).toBe(true);
  });

  it("ambiguous fitment asks exactly one clarifying question", async () => {
    await knownCustomer(h.deps, "254711000005");
    const cu = h.sim.customer("254711000005");
    await cu.text("Hi");
    await cu.pick("menu_buy");
    await cu.tap("m_car");
    await cu.pick("make:Toyota");
    const q = (await cu.text("Hilux 2018")).replies;
    expect(q).toHaveLength(1);
    expect(bodyOf(q[0])).toContain("different batteries by engine");
    expect(idsOf(q[0])).toEqual(["eng:Petrol", "eng:Diesel"]);
    const offer = (await cu.tap("eng:Diesel", "Diesel")).replies[0]!;
    expect(offer.kind).toBe("list");
    expect(idsOf(offer).every((id) => id.endsWith("N70L"))).toBe(true);
  });

  it("an engine in the first message skips the clarifying question", async () => {
    await knownCustomer(h.deps, "254711000006");
    const cu = h.sim.customer("254711000006");
    await cu.text("Hi");
    await cu.pick("menu_buy");
    await cu.tap("m_car");
    await cu.pick("make:Toyota");
    const offer = (await cu.text("Prado 2016 diesel")).replies[0]!;
    expect(offer.kind).toBe("list");
    expect(bodyOf(offer)).toContain("N70");
  });

  it("out-of-stock size → nearest compatible size, then call-back; never an empty list", async () => {
    await knownCustomer(h.deps, "254711000007");
    await h.deps.db.update(s.stock).set({ qtyOnHand: 0 }).where(eq(s.stock.sku, "CHX-NS60L"));
    for (const b of ["AMR", "BSH", "VRT", "YSA"]) await h.deps.db.update(s.stock).set({ qtyOnHand: 0 }).where(eq(s.stock.sku, `${b}-NS60L`));
    const cu = h.sim.customer("254711000007");
    await cu.text("Hi");
    const nearest = (await cu.text("NS60")).replies[0]!;
    expect(nearest.kind).toBe("list");
    expect(bodyOf(nearest)).toContain("nearest fit is NS70");
    expect(idsOf(nearest).length).toBeGreaterThan(0);

    for (const b of ["CHX", "AMR", "BSH", "VRT", "YSA"]) await h.deps.db.update(s.stock).set({ qtyOnHand: 0 }).where(eq(s.stock.sku, `${b}-NS70L`));
    const none = (await cu.text("NS60")).replies[0]!;
    expect(none.kind).toBe("buttons");
    expect(idsOf(none)).toContain("callback");
  });

  it("Gold/Platinum B2B number sees tier prices and delivery discount in the offer and summary", async () => {
    await knownCustomer(h.deps, "254711000008", { name: "Otieno", buyerType: "garage", tier: "gold" });
    const cu = h.sim.customer("254711000008");
    const { offer, summary } = await driveToSummary(cu, { km: 7, qty: 2 });
    const [p] = await h.deps.db.select().from(s.products).where(eq(s.products.sku, idsOf(offer)[0]!.slice(4)));
    const unitAfter = p!.priceKes - Math.round((p!.priceKes * 3) / 100);
    const row = offer.kind === "list" ? offer.rows[0]! : null;
    expect(row?.description).toContain(`KES ${unitAfter.toLocaleString("en-KE")}`);
    expect(row?.description).toContain("(was");
    // Zone B, 2 units: 350 + 150 = 500 → Gold 50% → 250
    expect(bodyOf(summary)).toContain("Gold discount");
    expect(bodyOf(summary)).toContain("Delivery: KES 250 (was KES 500)");
    const o = await orderFor(h.deps, "+254711000008");
    expect(o).toMatchObject({ tierAtOrder: "gold", deliveryFeeKes: 250, discountKes: Math.round((p!.priceKes * 3) / 100) * 2 });

    await knownCustomer(h.deps, "254711000009", { name: "Fleet Co", buyerType: "fleet", tier: "platinum" });
    const plat = await driveToSummary(h.sim.customer("254711000009"), { km: 7, qty: 2 });
    expect(bodyOf(plat.summary)).toContain("Delivery: free (was KES 500)");
  });

  it("'STOP' sets opted_out_at and blocks non-transactional messages", async () => {
    const c = await knownCustomer(h.deps, "254711000010");
    const r = await h.sim.customer("254711000010").text("STOP");
    expect(bodyOf(r.replies[0])).toContain("won't get any more");
    const [after] = await h.deps.db.select().from(s.customers).where(eq(s.customers.id, c.id));
    expect(after!.optedOutAt).not.toBeNull();
    const before = h.deps.wa.outbox.length;
    expect(await sendToCustomer(h.deps, { customerId: c.id, phoneE164: c.phoneE164 }, { kind: "text", body: "Offer!" }, { category: "marketing" })).toBe("skipped");
    expect(h.deps.wa.outbox.length).toBe(before);
    // Transactional messages still go out (e.g. a payment receipt).
    expect(await sendToCustomer(h.deps, { customerId: c.id, phoneE164: c.phoneE164 }, { kind: "text", body: "Paid" }, { category: "transactional" })).toBe("sent");
  });

  it("handoff silences the bot until released", async () => {
    await knownCustomer(h.deps, "254711000011");
    const cu = h.sim.customer("254711000011");
    await cu.text("Hi");
    expect(bodyOf((await cu.pick("handoff")).replies[0])).toContain("One of our team");
    const alerts = await h.deps.db.select().from(s.staffAlerts);
    expect(alerts.some((a) => a.kind === "handoff")).toBe(true);
    expect(h.deps.wa.to("254700000009").length).toBeGreaterThan(0); // staff WhatsApp alert
    expect((await cu.text("hello?")).replies).toHaveLength(0);
    expect((await cu.text("anyone there")).replies).toHaveLength(0);

    const [conv] = await h.deps.db.select().from(s.conversations).innerJoin(s.customers, eq(s.customers.id, s.conversations.customerId)).where(eq(s.customers.phoneE164, "+254711000011"));
    const unauth = await h.sim.app.inject({ method: "POST", url: `/admin/conversations/${conv!.conversations.id}/release` });
    expect(unauth.statusCode).toBe(401);
    const rel = await h.sim.app.inject({ method: "POST", url: `/admin/conversations/${conv!.conversations.id}/release`, headers: { authorization: "Bearer admin-token" } });
    expect(rel.statusCode).toBe(200);
    const back = (await cu.text("Hi")).replies;
    expect(back).toHaveLength(1);
    expect(bodyOf(back[0])).toContain("Karibu back");
  });

  it("handoff triggers: complaint keywords, returns/warranty, two failed parses, low confidence", async () => {
    await knownCustomer(h.deps, "254711000012");
    const a = h.sim.customer("254711000012");
    await a.text("Hi");
    await a.text("I want a refund, this battery is faulty");
    let [conv] = await h.deps.db.select().from(s.conversations);
    expect(conv!.handoff).toBe(true);

    await knownCustomer(h.deps, "254711000013");
    const b = h.sim.customer("254711000013");
    await b.text("Hi");
    await b.text("asdf");
    expect(bodyOf(b.newReplies().at(-1))).toBe("");
    await b.text("qwerty");
    const [cb] = await h.deps.db.select({ handoff: s.conversations.handoff, reason: s.conversations.handoffReason }).from(s.conversations)
      .innerJoin(s.customers, eq(s.customers.id, s.conversations.customerId)).where(eq(s.customers.phoneE164, "+254711000013"));
    expect(cb).toEqual({ handoff: true, reason: "two failed parses in a row" });

    await knownCustomer(h.deps, "254711000014");
    const c = h.sim.customer("254711000014");
    await c.text("Hi");
    await c.text("what time do you close on sundays");
    const [cc] = await h.deps.db.select({ reason: s.conversations.handoffReason }).from(s.conversations)
      .innerJoin(s.customers, eq(s.customers.id, s.conversations.customerId)).where(eq(s.customers.phoneE164, "+254711000014"));
    expect(cc!.reason).toMatch(/low confidence/);
  });

  it("duplicate webhook delivery produces no duplicate messages or orders", async () => {
    await knownCustomer(h.deps, "254711000015");
    const cu = h.sim.customer("254711000015");
    const first = await cu.text("Hi", "wamid.dup.1");
    expect(first.replies).toHaveLength(1);
    const again = await cu.replay("wamid.dup.1", "Hi");
    expect(again.replies).toHaveLength(0);
    const inbound = await h.deps.db.select().from(s.messages).where(and(eq(s.messages.waMessageId, "wamid.dup.1")));
    expect(inbound).toHaveLength(1);
  });

  it("out-of-area pin → call-back/pickup offer, no price shown", async () => {
    await knownCustomer(h.deps, "254711000016");
    const cu = h.sim.customer("254711000016");
    await cu.text("Hi");
    await cu.text("NS70 L");
    const offer = cu.newReplies();
    void offer;
    const [first] = await h.deps.db.select().from(s.products).where(eq(s.products.sku, "CHX-NS70L"));
    await cu.pick(`sku:${first!.sku}`);
    await cu.tap("qty_1");
    const far = north(50);
    const r = (await cu.location(far.lat, far.lng, "Thika")).replies[0]!;
    expect(bodyOf(r)).toContain("outside our delivery area");
    expect(bodyOf(r)).not.toMatch(/KES/);
    expect(idsOf(r)).toEqual(["callback", "pickup", "handoff"]);
    const pickup = (await cu.tap("pickup")).replies[0]!;
    expect(bodyOf(pickup)).toContain("Pickup at warehouse: free");
  });

  it("saved location is offered on the next order", async () => {
    await knownCustomer(h.deps, "254711000017");
    const cu = h.sim.customer("254711000017");
    await driveToSummary(cu);
    await cu.tap("change");
    await cu.tap("m_size");
    await cu.text("NS40");
    await cu.pick("sku:CHX-NS40L");
    const loc = (await cu.tap("qty_1")).replies[0]!;
    expect(idsOf(loc)).toEqual(["loc_saved", "loc_new"]);
    const summary = (await cu.tap("loc_saved")).replies[0]!;
    expect(bodyOf(summary)).toContain("Total:");
  });

  it("changing a zone fee doesn't change the fee on already-priced orders", async () => {
    await knownCustomer(h.deps, "254711000018");
    const cu = h.sim.customer("254711000018");
    await driveToSummary(cu, { km: 7 });
    const before = await orderFor(h.deps, "+254711000018");
    expect(before.deliveryFeeKes).toBe(350);
    await h.deps.db.update(s.deliveryZones).set({ baseFeeKes: 999 }).where(eq(s.deliveryZones.code, "B"));
    await cu.tap("pay");
    await cu.tap("pay_this");
    const after = await orderFor(h.deps, "+254711000018");
    expect(after.deliveryFeeKes).toBe(350);
    expect(h.deps.mpesa.lastPush()!.amountKes).toBe(before.totalKes);
  });

  it("3 batteries → extra-unit fee and split across 2 rider trips; B2B 6 units → bulk run", async () => {
    await knownCustomer(h.deps, "254711000019");
    // Zone C (no free-delivery threshold): 550 + 2 × 200
    await driveToSummary(h.sim.customer("254711000019"), { km: 15, qty: 3 });
    const o = await orderFor(h.deps, "+254711000019");
    expect(o.deliveryFeeKes).toBe(950);
    expect((o.deliveryQuote as { trips: number }).trips).toBe(2);

    await knownCustomer(h.deps, "254711000020", { buyerType: "garage", tier: "silver" });
    const { summary } = await driveToSummary(h.sim.customer("254711000020"), { km: 2, qty: 6 });
    expect(bodyOf(summary)).toContain("bulk run");
    expect((await orderFor(h.deps, "+254711000020")).deliveryMode).toBe("bulk_run");
  });

  it("quantity is capped at stock", async () => {
    await knownCustomer(h.deps, "254711000021", { buyerType: "garage" });
    const cu = h.sim.customer("254711000021");
    await cu.text("Hi");
    await cu.text("NS40");
    await cu.pick("sku:CHX-NS40L");
    expect(bodyOf((await cu.text("50")).replies[0])).toBe("We have 10 in stock right now. Type a number up to 10.");
  });
});
