/**
 * WhatsApp conversation engine (docs/02-whatsapp-bot.md).
 * The state machine owns the flow (CLAUDE.md rule 1): Claude only classifies and extracts.
 */
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import {
  isB2B, orderTotals, priceItems, quoteDelivery, toE164Kenya, waIdToE164, formatKes, trackForBuyerType,
  type BuyerType, type Polarity,
} from "@washa/core";
import * as s from "@washa/db/schema";
import { TOP_MAKES } from "@washa/db/seed-data";
import type { Deps } from "../deps";
import type { InMessage, OutMessage } from "../whatsapp/types";
import { alertStaff, sendToCustomer } from "../notify";
import { customerTier, loadDeliverySettings, loadTierLabel, loadZones, availableBySku, transitionOrder } from "../orders/service";
import { requestStkPush } from "../mpesa/payments";
import { BTN, MENU_ROWS, T, etaWords, statusWords } from "./copy";
import { buildOffers, distinctSizes, findFitments, normaliseSize, polaritiesFor, productsBySku } from "./matching";
import { getOrCreate, saveConv, type Conversation, type ConvContext, type ConvState, type Customer } from "./store";

const HANDOFF_KEYWORDS = /\b(refund|return|returns|warranty|guarantee|faulty|complain|complaint|angry|useless|terrible|scam|fraud|worst|nonsense|stolen)\b/i;
const STOP = /^\s*(stop|unsubscribe|stop all)\s*$/i;
const STALE_MS = 24 * 3600_000;

/** Per-customer serialisation inside this process (Phase 1 runs one API instance). */
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

type Ctx = {
  deps: Deps;
  msg: InMessage;
  customer: Customer;
  conv: Conversation;
  now: Date;
};

/** Job handler: one inbound WhatsApp message. Returns false when it was a duplicate delivery. */
export async function handleInbound(deps: Deps, msg: InMessage): Promise<boolean> {
  const phone = waIdToE164(msg.waId);
  return serial(phone, async () => {
    const now = deps.clock.now();
    const prepared = await deps.db.transaction(async (tx) => {
      const { customer, conv } = await getOrCreate(tx, phone);
      const ins = await tx.insert(s.messages).values({
        waMessageId: msg.waMessageId, conversationId: conv.id, direction: "in", type: msg.kind, payload: msg as unknown as Record<string, unknown>, status: "received",
      }).onConflictDoNothing({ target: s.messages.waMessageId }).returning({ id: s.messages.id });
      if (ins.length === 0) return null; // duplicate webhook delivery
      const prevInbound = conv.lastInboundAt;
      await saveConv(tx, conv.id, { lastInboundAt: now });
      return { customer, conv: { ...conv, lastInboundAt: now }, prevInbound };
    });
    if (!prepared) return false;
    const ctx: Ctx = { deps, msg, customer: prepared.customer, conv: prepared.conv, now };
    await route(ctx, prepared.prevInbound);
    return true;
  });
}

// ---------- helpers ----------

async function say(c: Ctx, msg: OutMessage) {
  await sendToCustomer(c.deps, { customerId: c.customer.id, phoneE164: c.customer.phoneE164 }, msg, { category: "reply" });
}

async function go(c: Ctx, state: ConvState, context: ConvContext) {
  c.conv = { ...c.conv, state, context: { ...context, failCount: 0 } };
  await saveConv(c.deps.db, c.conv.id, { state, context: c.conv.context });
}

async function patchCtx(c: Ctx, patch: Partial<ConvContext>) {
  c.conv = { ...c.conv, context: { ...c.conv.context, ...patch } };
  await saveConv(c.deps.db, c.conv.id, { context: c.conv.context });
}

async function reloadCustomer(c: Ctx) {
  const [cu] = await c.deps.db.select().from(s.customers).where(eq(s.customers.id, c.customer.id));
  c.customer = cu!;
}

const text = (m: InMessage) => (m.kind === "text" ? m.text.trim() : null);
const buttonId = (m: InMessage) => (m.kind === "button" ? m.id : null);
const profileComplete = (cu: Customer) => !!(cu.consentAt && cu.name && cu.buyerType);
const firstName = (cu: Customer) => cu.name ?? "";

async function handoff(c: Ctx, reason: string) {
  c.conv = { ...c.conv, handoff: true, handoffReason: reason, state: "HANDOFF" };
  await saveConv(c.deps.db, c.conv.id, { handoff: true, handoffReason: reason, state: "HANDOFF" });
  await alertStaff(c.deps, {
    kind: "handoff", conversationId: c.conv.id,
    message: `${c.customer.name ?? "Customer"} (${c.customer.phoneE164}) needs a person: ${reason}.`,
  });
  await say(c, { kind: "text", body: T.handoff });
}

/** Two failed parses in a row → handoff. Otherwise re-prompt. */
async function failedParse(c: Ctx, reprompt: OutMessage) {
  const n = (c.conv.context.failCount ?? 0) + 1;
  if (n >= c.deps.config.bot.maxFailedParses) return handoff(c, "two failed parses in a row");
  await patchCtx(c, { failCount: n });
  await say(c, reprompt);
}

// ---------- prompts ----------

const menuMsg = (body: string): OutMessage => ({ kind: "list", body, button: "Menu", rows: MENU_ROWS });
const methodMsg = (body: string): OutMessage => ({ kind: "buttons", body, buttons: [BTN.byCar, BTN.bySize, BTN.byPhoto] });
const makeListMsg = (): OutMessage => ({
  kind: "list", body: T.askMake, button: "Choose make",
  rows: [...TOP_MAKES.map((m) => ({ id: `make:${m}`, title: m })), { id: "make:__other", title: "Other" }],
});

async function showMenu(c: Ctx, body: string) {
  await go(c, "MENU", {});
  await say(c, menuMsg(body));
}

// ---------- router ----------

async function route(c: Ctx, prevInbound: Date | null) {
  const { msg } = c;
  const t = text(msg);

  // Opt-out is honoured in every state (KDPA 2019).
  if (t && STOP.test(t)) {
    await c.deps.db.update(s.customers).set({ optedOutAt: c.now }).where(eq(s.customers.id, c.customer.id));
    await say(c, { kind: "text", body: T.stop });
    return;
  }
  // Handoff silences the bot until staff release it.
  if (c.conv.handoff) return;

  if (buttonId(msg) === "handoff") return handoff(c, "customer asked for a person");
  if (t && HANDOFF_KEYWORDS.test(t)) return handoff(c, "complaint / returns / warranty keywords");

  const bid = buttonId(msg);
  if (bid?.startsWith("resume:")) return resumeOrder(c, bid.slice(7));

  // Known numbers coming back (or a stale chat) start fresh at the menu.
  const stale = !!prevInbound && c.now.getTime() - prevInbound.getTime() > STALE_MS;
  if (profileComplete(c.customer) && (["NEW", "PAID_DONE", "TRACK_ORDER"].includes(c.conv.state) || (stale && msg.kind === "text"))) {
    if (!(t && (await tryMenuText(c, t, true)))) await showMenu(c, T.menuBack(firstName(c.customer)));
    return;
  }

  switch (c.conv.state) {
    case "NEW": return onNew(c);
    case "CONSENT": return onConsent(c);
    case "PROFILE": return onProfile(c);
    case "MENU": return onMenu(c);
    case "MATCH_VEHICLE": return onMatchVehicle(c);
    case "MATCH_SIZE": return onMatchSize(c);
    case "MATCH_PHOTO": return onMatchPhoto(c);
    case "OFFER": return onOffer(c);
    case "QTY": return onQty(c);
    case "LOCATION": return onLocation(c);
    case "SUMMARY": return onSummary(c);
    case "PAY_NUMBER": return onPayNumber(c);
    case "AWAITING_PAYMENT": return onAwaitingPayment(c);
    default: return showMenu(c, T.menu);
  }
}

// ---------- NEW / CONSENT / PROFILE ----------

async function onNew(c: Ctx) {
  await go(c, "CONSENT", {});
  await say(c, { kind: "buttons", body: T.welcome, buttons: [BTN.consentOk] });
}

async function onConsent(c: Ctx) {
  const t = text(c.msg)?.toLowerCase();
  if (buttonId(c.msg) === BTN.consentOk.id || (t && /^(ok|okay|sawa|yes|ndio)\b/.test(t))) {
    await c.deps.db.update(s.customers).set({ consentAt: c.now, optedOutAt: null }).where(eq(s.customers.id, c.customer.id));
    await go(c, "PROFILE", { step: "name" });
    return say(c, { kind: "text", body: T.askName });
  }
  return failedParse(c, { kind: "buttons", body: T.welcome, buttons: [BTN.consentOk] });
}

function cleanName(raw: string): string | null {
  const m = /([A-Za-zÀ-ÿ'-]{2,30})/.exec(raw.replace(/^(i am|i'm|my name is|naitwa|jina langu ni)\s+/i, ""));
  if (!m) return null;
  return m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
}

async function onProfile(c: Ctx) {
  const step = c.conv.context.step;
  if (step === "name") {
    const name = text(c.msg) ? cleanName(text(c.msg)!) : null;
    if (!name) return failedParse(c, { kind: "text", body: T.askName });
    await c.deps.db.update(s.customers).set({ name }).where(eq(s.customers.id, c.customer.id));
    await go(c, "PROFILE", { step: "type" });
    return say(c, { kind: "buttons", body: T.askBuyerType(name), buttons: [BTN.personal, BTN.garage, BTN.fleet] });
  }
  if (step === "type") {
    const map: Record<string, BuyerType> = { [BTN.personal.id]: "retail", [BTN.garage.id]: "garage", [BTN.fleet.id]: "fleet" };
    const bt = map[buttonId(c.msg) ?? ""];
    if (!bt) return failedParse(c, { kind: "buttons", body: T.askBuyerType(c.customer.name ?? ""), buttons: [BTN.personal, BTN.garage, BTN.fleet] });
    await c.deps.db.update(s.customers).set({ buyerType: bt, tierTrack: trackForBuyerType(bt) }).where(eq(s.customers.id, c.customer.id));
    await reloadCustomer(c);
    if (bt === "retail") return showMenu(c, T.menuNew(firstName(c.customer)));
    await go(c, "PROFILE", { step: "business" });
    return say(c, { kind: "text", body: T.askBusinessName });
  }
  if (step === "business") {
    const b = text(c.msg);
    if (!b || b.length < 2) return failedParse(c, { kind: "text", body: T.askBusinessName });
    await c.deps.db.update(s.customers).set({ businessName: b.slice(0, 80) }).where(eq(s.customers.id, c.customer.id));
    return showMenu(c, T.menuNew(firstName(c.customer)));
  }
  await go(c, "PROFILE", { step: "name" });
  return say(c, { kind: "text", body: T.askName });
}

// ---------- MENU ----------

async function onMenu(c: Ctx) {
  const bid = buttonId(c.msg);
  switch (bid) {
    case "menu_buy": await go(c, "MENU", { step: "method" }); return say(c, methodMsg(T.howToMatch));
    case "menu_unsure": await go(c, "MENU", { step: "method" }); return say(c, methodMsg(T.howToMatchUnsure));
    case "menu_track": return trackOrder(c);
    case BTN.byCar.id: await go(c, "MATCH_VEHICLE", { step: "make" }); return say(c, makeListMsg());
    case BTN.bySize.id: await go(c, "MATCH_SIZE", {}); return say(c, { kind: "text", body: T.askSize });
    case BTN.byPhoto.id: await go(c, "MATCH_PHOTO", {}); return say(c, { kind: "text", body: T.askPhoto });
    case BTN.callback.id: return handoff(c, "call-back requested");
  }
  if (c.msg.kind === "image") { await go(c, "MATCH_PHOTO", {}); return onMatchPhoto(c); }
  const t = text(c.msg);
  if (t && (await tryMenuText(c, t, false))) return;
  return failedParse(c, menuMsg(T.didntGetThat));
}

/** Free text at the menu: a size code goes straight to matching; otherwise Claude classifies intent. */
async function tryMenuText(c: Ctx, t: string, fromGreeting: boolean): Promise<boolean> {
  const size = await normaliseSize(c.deps.db, t);
  if (size) {
    await go(c, "MATCH_SIZE", {});
    await onSizeResolved(c, size);
    return true;
  }
  const r = await c.deps.ai.classifyIntent(t, { conversationId: c.conv.id });
  if (!r) {
    if (fromGreeting) return false;
    await failedParse(c, menuMsg(T.didntGetThat));
    return true;
  }
  if (r.confidence < c.deps.config.bot.handoffConfidence) {
    if (fromGreeting) return false;
    await handoff(c, `low confidence (${r.intent})`);
    return true;
  }
  switch (r.intent) {
    case "buy_battery": await go(c, "MENU", { step: "method" }); await say(c, methodMsg(fromGreeting ? `${T.menuBack(firstName(c.customer))}\n${T.howToMatch}` : T.howToMatch)); return true;
    case "not_sure": await go(c, "MENU", { step: "method" }); await say(c, methodMsg(T.howToMatchUnsure)); return true;
    case "track_order": await trackOrder(c); return true;
    case "talk_to_person": await handoff(c, "customer asked for a person"); return true;
    case "complaint": await handoff(c, "complaint"); return true;
    case "returns_warranty": await handoff(c, "returns / warranty"); return true;
    case "greeting":
      if (fromGreeting) return false;
      await showMenu(c, c.customer.name ? T.menuBack(firstName(c.customer)) : T.menu);
      return true;
    default: return false;
  }
}

async function trackOrder(c: Ctx) {
  const [o] = await c.deps.db.select().from(s.orders)
    .where(and(eq(s.orders.customerId, c.customer.id), notInArray(s.orders.status, ["DRAFT", "CANCELLED"])))
    .orderBy(desc(s.orders.createdAt)).limit(1);
  await go(c, "MENU", {});
  const body = o ? T.trackStatus(o.number, statusWords(o.status), o.etaAt && ["PAID", "PACKING", "READY", "RIDER_ASSIGNED", "PICKED_UP"].includes(o.status) ? etaWords(o.etaAt, c.now) : null) : T.noOrders;
  return say(c, { kind: "buttons", body, buttons: [{ id: "menu_buy", title: "Buy a battery" }, BTN.person] });
}

// ---------- MATCH ----------

async function onMatchVehicle(c: Ctx) {
  const ctx = c.conv.context;
  const bid = buttonId(c.msg);
  const t = text(c.msg);
  if (ctx.step === "make") {
    let make: string | null = null;
    if (bid === "make:__other") {
      await go(c, "MATCH_VEHICLE", { step: "make_text" });
      return say(c, { kind: "text", body: T.askMakeOther });
    }
    if (bid?.startsWith("make:")) make = bid.slice(5);
    else if (t) make = TOP_MAKES.find((m) => m.toLowerCase() === t.toLowerCase()) ?? null;
    if (!make) return failedParse(c, makeListMsg());
    await go(c, "MATCH_VEHICLE", { step: "model", make });
    return say(c, { kind: "text", body: T.askModelYear(make) });
  }
  if (ctx.step === "make_text") {
    if (!t || !/[a-z]/i.test(t)) return failedParse(c, { kind: "text", body: T.askMakeOther });
    const make = t.slice(0, 40);
    await go(c, "MATCH_VEHICLE", { step: "model", make });
    return say(c, { kind: "text", body: T.askModelYear(make) });
  }
  if (ctx.step === "model") {
    if (!t) return failedParse(c, { kind: "text", body: T.askModelYear(ctx.make ?? "car") });
    const v = await c.deps.ai.extractVehicle(t, { conversationId: c.conv.id, makeHint: ctx.make });
    if (!v || !v.model) return failedParse(c, { kind: "text", body: T.askModelYear(ctx.make ?? "car") });
    if (v.confidence < c.deps.config.bot.handoffConfidence) return handoff(c, "low confidence vehicle extraction");
    const vehicle = { make: ctx.make ?? v.make, model: v.model, year: v.year, engine: v.engine };
    const [row] = await c.deps.db.insert(s.vehicles).values({ customerId: c.customer.id, make: vehicle.make, model: vehicle.model, year: vehicle.year, engine: vehicle.engine }).returning({ id: s.vehicles.id });
    return resolveVehicle(c, vehicle, row!.id, false);
  }
  if (ctx.step === "clarify_engine" || ctx.step === "clarify_year") {
    const v = ctx.vehicle!;
    let refined = { ...v };
    if (ctx.step === "clarify_engine") {
      const eng = bid?.startsWith("eng:") ? bid.slice(4) : t;
      if (!eng) return failedParse(c, { kind: "text", body: T.clarifyEngine(carName(v)) });
      refined.engine = eng;
    } else {
      const y = t ? /\b(19[5-9]\d|20\d{2})\b/.exec(t) : null;
      if (!y) return failedParse(c, { kind: "text", body: T.clarifyYear(carName(v)) });
      refined.year = Number(y[1]);
    }
    await c.deps.db.update(s.vehicles).set({ engine: refined.engine, year: refined.year }).where(eq(s.vehicles.id, ctx.vehicleId!));
    return resolveVehicle(c, refined, ctx.vehicleId!, true);
  }
  await go(c, "MATCH_VEHICLE", { step: "make" });
  return say(c, makeListMsg());
}

const carName = (v: { make: string | null; model: string | null; year: number | null }) =>
  [v.make, v.model, v.year].filter(Boolean).join(" ");

async function resolveVehicle(c: Ctx, v: NonNullable<ConvContext["vehicle"]>, vehicleId: string, clarified: boolean) {
  const cands = v.make && v.model ? await findFitments(c.deps.db, { make: v.make, model: v.model, year: v.year, engine: v.engine }) : [];
  const sizes = distinctSizes(cands);
  if (sizes.length === 0) {
    await go(c, "MENU", { step: "method", vehicleId });
    return say(c, { kind: "buttons", body: T.noFitment, buttons: [BTN.bySize, BTN.byPhoto, BTN.person] });
  }
  if (sizes.length === 1 || clarified) {
    if (sizes.length > 1) return handoff(c, "fitment still ambiguous after clarifying question");
    const sz = sizes[0]!;
    await c.deps.db.update(s.vehicles).set({ batterySize: `${sz.sizeFamily}${sz.polarity}` }).where(eq(s.vehicles.id, vehicleId));
    return showOffer(c, { sizeFamily: sz.sizeFamily, polarity: sz.polarity }, { vehicle: v, vehicleId });
  }
  // More than one size fits: ask exactly one clarifying question.
  const engines = [...new Set(cands.map((x) => x.engine).filter((e): e is string => !!e))];
  await go(c, "MATCH_VEHICLE", { step: engines.length > 1 ? "clarify_engine" : "clarify_year", vehicle: v, vehicleId, make: v.make ?? undefined });
  if (engines.length > 1) {
    const body = T.clarifyEngine(carName(v));
    if (engines.length <= 3) return say(c, { kind: "buttons", body, buttons: engines.map((e) => ({ id: `eng:${e}`, title: e.slice(0, 20) })) });
    return say(c, { kind: "list", body, button: "Choose engine", rows: engines.slice(0, 10).map((e) => ({ id: `eng:${e}`, title: e.slice(0, 24) })) });
  }
  return say(c, { kind: "text", body: T.clarifyYear(carName(v)) });
}

async function onMatchSize(c: Ctx) {
  const ctx = c.conv.context;
  if (ctx.step === "polarity") {
    const bid = buttonId(c.msg);
    const t = text(c.msg)?.toLowerCase();
    const pol: Polarity | null = bid === BTN.left.id || t === "left" || t === "l" ? "L" : bid === BTN.right.id || t === "right" || t === "r" ? "R" : null;
    if (!pol) return failedParse(c, { kind: "buttons", body: T.askPolarity(ctx.size!.sizeFamily), buttons: [BTN.left, BTN.right] });
    return onSizeResolved(c, { sizeFamily: ctx.size!.sizeFamily, polarity: pol });
  }
  const t = text(c.msg);
  const size = t ? await normaliseSize(c.deps.db, t) : null;
  if (!size) return failedParse(c, { kind: "text", body: T.askSize });
  return onSizeResolved(c, size);
}

/** Size known (typed, confirmed from a photo): settle polarity, save the vehicle, show the offer. */
async function onSizeResolved(c: Ctx, size: { sizeFamily: string; polarity: Polarity | null }) {
  let pol = size.polarity;
  if (!pol) {
    const pols = await polaritiesFor(c.deps.db, size.sizeFamily);
    if (pols.length === 1) pol = pols[0]!;
    else if (pols.length > 1) {
      await go(c, "MATCH_SIZE", { ...c.conv.context, step: "polarity", size });
      return say(c, { kind: "buttons", body: T.askPolarity(size.sizeFamily), buttons: [BTN.left, BTN.right] });
    } else pol = "L"; // unknown family: offer path will fall through to the no-stock call-back
  }
  let vehicleId = c.conv.context.vehicleId;
  if (vehicleId) await c.deps.db.update(s.vehicles).set({ batterySize: `${size.sizeFamily}${pol}` }).where(eq(s.vehicles.id, vehicleId));
  else {
    const [row] = await c.deps.db.insert(s.vehicles).values({ customerId: c.customer.id, batterySize: `${size.sizeFamily}${pol}` }).returning({ id: s.vehicles.id });
    vehicleId = row!.id;
  }
  return showOffer(c, { sizeFamily: size.sizeFamily, polarity: pol }, { vehicleId, vehicle: c.conv.context.vehicle });
}

async function onMatchPhoto(c: Ctx) {
  const ctx = c.conv.context;
  if (ctx.step === "confirm") {
    const bid = buttonId(c.msg);
    const t = text(c.msg)?.toLowerCase();
    if (bid === BTN.yes.id || (t && /^(yes|ndio|correct|sawa)/.test(t))) return onSizeResolved(c, ctx.size!);
    if (bid === BTN.no.id || (t && /^(no|hapana)/.test(t))) {
      await go(c, "MATCH_SIZE", {});
      return say(c, { kind: "text", body: T.askSize });
    }
    return failedParse(c, { kind: "buttons", body: T.confirmLabel(ctx.size!.sizeFamily, ctx.size!.polarity), buttons: [BTN.yes, BTN.no] });
  }
  if (c.msg.kind === "text") {
    const size = await normaliseSize(c.deps.db, c.msg.text);
    if (size) return onSizeResolved(c, size);
  }
  if (c.msg.kind !== "image") return failedParse(c, { kind: "text", body: T.askPhoto });
  const img = await c.deps.wa.getMedia(c.msg.mediaId);
  const r = await c.deps.ai.readBatteryLabel(img, { conversationId: c.conv.id });
  const size = r?.size_family ? await normaliseSize(c.deps.db, `${r.size_family}${r.polarity ?? ""}`) : null;
  if (!r || !size) return failedParse(c, { kind: "buttons", body: T.photoUnreadable, buttons: [BTN.bySize, BTN.person] });
  if (r.confidence < c.deps.config.bot.handoffConfidence) return handoff(c, "low confidence label read");
  const pol = size.polarity ?? r.polarity ?? null;
  await go(c, "MATCH_PHOTO", { step: "confirm", size: { sizeFamily: size.sizeFamily, polarity: pol } });
  // Always confirm back what vision read.
  return say(c, { kind: "buttons", body: T.confirmLabel(size.sizeFamily, pol), buttons: [BTN.yes, BTN.no] });
}

// ---------- OFFER / QTY ----------

async function showOffer(c: Ctx, size: { sizeFamily: string; polarity: Polarity }, keep: Pick<ConvContext, "vehicle" | "vehicleId">) {
  const tier = await customerTier(c.deps.db, c.customer);
  const { offers, substitutedFrom, shownSize } = await buildOffers(c.deps.db, size.sizeFamily, size.polarity, tier);
  await go(c, "OFFER", { ...keep, size, offerSkus: offers.map((o) => o.sku) });
  if (offers.length === 0) {
    // Never an empty list: offer a call-back or another size.
    return say(c, { kind: "buttons", body: T.noStock(size.sizeFamily), buttons: [BTN.callback, BTN.otherSize, BTN.person] });
  }
  const car = keep.vehicle ? carName(keep.vehicle) : null;
  const note = substitutedFrom ? T.nearestNote(substitutedFrom, shownSize) : null;
  return say(c, {
    kind: "list",
    body: T.offerBody(car, substitutedFrom ?? shownSize, size.polarity, note),
    button: T.offerButton,
    rows: offers.map((o) => ({
      id: `sku:${o.sku}`,
      title: `${o.label} · ${o.brand}`.slice(0, 24),
      description: `${formatKes(o.unitAfterTierKes)}${o.unitAfterTierKes < o.unitPriceKes ? ` (was ${formatKes(o.unitPriceKes)})` : ""} · ${o.warrantyMonths}-mo warranty · ${o.sizeFamily}${o.polarity}`.slice(0, 72),
    })),
  });
}

async function onOffer(c: Ctx) {
  const bid = buttonId(c.msg);
  if (bid === BTN.callback.id) return handoff(c, "call-back requested (no stock)");
  if (bid === BTN.otherSize.id) { await go(c, "MATCH_SIZE", {}); return say(c, { kind: "text", body: T.askSize }); }
  const sku = bid?.startsWith("sku:") ? bid.slice(4) : null;
  if (!sku || !c.conv.context.offerSkus?.includes(sku)) {
    const t = text(c.msg);
    const size = t ? await normaliseSize(c.deps.db, t) : null;
    if (size) return onSizeResolved(c, size);
    return failedParse(c, { kind: "text", body: T.didntGetThat });
  }
  await go(c, "QTY", { ...c.conv.context, sku });
  if (isB2B(c.customer.buyerType ?? "retail")) return say(c, { kind: "text", body: T.askQtyB2B });
  return say(c, { kind: "buttons", body: T.askQtyRetail, buttons: [BTN.qty1, BTN.qtyMore] });
}

async function onQty(c: Ctx) {
  const ctx = c.conv.context;
  const bid = buttonId(c.msg);
  if (bid === BTN.qtyMore.id) return say(c, { kind: "text", body: T.askQtyNumber });
  let qty: number | null = bid === BTN.qty1.id ? 1 : null;
  const t = text(c.msg);
  if (qty == null && t && /^\d{1,4}$/.test(t)) qty = Number(t);
  if (!qty || qty < 1) return failedParse(c, { kind: "text", body: T.askQtyNumber });
  const avail = (await availableBySku(c.deps.db, [ctx.sku!])).get(ctx.sku!) ?? 0;
  if (qty > avail) return say(c, { kind: "text", body: T.qtyShort(avail) });
  await go(c, "LOCATION", { ...ctx, qty });
  return askLocation(c);
}

// ---------- LOCATION ----------

async function savedLocation(c: Ctx) {
  const [l] = await c.deps.db.select().from(s.locations)
    .where(and(eq(s.locations.customerId, c.customer.id), eq(s.locations.isDefault, true))).limit(1);
  return l ?? null;
}

async function askLocation(c: Ctx) {
  const saved = await savedLocation(c);
  if (saved) return say(c, { kind: "buttons", body: T.askLocationSaved(saved.label ?? "pinned"), buttons: [BTN.savedLoc, BTN.newLoc] });
  return say(c, { kind: "location_request", body: T.askLocation });
}

async function onLocation(c: Ctx) {
  const bid = buttonId(c.msg);
  const ctx = c.conv.context;
  if (ctx.step === "out_of_area") {
    if (bid === BTN.pickup.id) return toSummary(c, { ...ctx, pickup: true });
    if (bid === BTN.callback.id) return handoff(c, "out of area: call-back for a quote");
  }
  if (bid === BTN.newLoc.id) return say(c, { kind: "location_request", body: T.askLocation });
  if (bid === BTN.savedLoc.id) {
    const saved = await savedLocation(c);
    if (saved) return quoteAndSummarise(c, saved.id);
  }
  if (c.msg.kind === "location") {
    await c.deps.db.update(s.locations).set({ isDefault: false }).where(eq(s.locations.customerId, c.customer.id));
    const [loc] = await c.deps.db.insert(s.locations).values({
      customerId: c.customer.id, lat: c.msg.lat, lng: c.msg.lng, label: (c.msg.name || c.msg.address || "Pinned location").slice(0, 60), isDefault: true,
    }).returning({ id: s.locations.id });
    return quoteAndSummarise(c, loc!.id);
  }
  return failedParse(c, { kind: "location_request", body: T.askLocation });
}

async function quoteAndSummarise(c: Ctx, locationId: string) {
  const ctx = { ...c.conv.context, locationId, pickup: false };
  const q = await quoteFor(c, ctx);
  if (q && !q.inArea) {
    await go(c, "LOCATION", { ...ctx, step: "out_of_area" });
    // Out of area: no price shown, offer call-back or pickup.
    return say(c, { kind: "buttons", body: T.outOfArea, buttons: [BTN.callback, BTN.pickup, BTN.person] });
  }
  return toSummary(c, ctx);
}

async function quoteFor(c: Ctx, ctx: ConvContext) {
  if (ctx.pickup || !ctx.locationId) return null;
  const [loc] = await c.deps.db.select().from(s.locations).where(eq(s.locations.id, ctx.locationId));
  const [p] = await productsBySku(c.deps.db, [ctx.sku!]);
  const tier = await customerTier(c.deps.db, c.customer);
  const items = priceItems([{ sku: p!.sku, qty: ctx.qty!, unitPriceKes: p!.priceKes }], tier);
  return quoteDelivery(
    { point: { lat: loc!.lat, lng: loc!.lng }, units: items.units, subtotalKes: items.subtotalKes, isB2B: isB2B(c.customer.buyerType ?? "retail"), tierDeliveryDiscountPct: tier?.deliveryDiscountPct ?? 0, now: c.now },
    await loadZones(c.deps.db), await loadDeliverySettings(c.deps.db),
  );
}

// ---------- SUMMARY ----------

/** Locks items, location and price into a DRAFT order and shows the summary. */
async function toSummary(c: Ctx, ctx: ConvContext) {
  const [p] = await productsBySku(c.deps.db, [ctx.sku!]);
  if (!p) return showMenu(c, T.menu);
  const tier = await customerTier(c.deps.db, c.customer);
  const items = priceItems([{ sku: p.sku, qty: ctx.qty!, unitPriceKes: p.priceKes }], tier);
  const q = await quoteFor(c, ctx);
  const inArea = q && q.inArea ? q : null;
  const totals = orderTotals(items, inArea ? inArea.feeKes : 0);
  const tierLabel = tier ? await loadTierLabel(c.deps.db, tier.track, tier.tier) : null;

  const orderId = await c.deps.db.transaction(async (tx) => {
    // Replace a previous draft from this chat, if any.
    if (ctx.orderId) {
      const [old] = await tx.select({ status: s.orders.status }).from(s.orders).where(eq(s.orders.id, ctx.orderId));
      if (old?.status === "DRAFT") await transitionOrder(tx, ctx.orderId, "CANCELLED", { type: "system", id: "bot" }, c.now);
    }
    const [o] = await tx.insert(s.orders).values({
      customerId: c.customer.id, channel: "whatsapp", status: "DRAFT",
      subtotalKes: totals.subtotalKes, discountKes: totals.discountKes, deliveryFeeKes: totals.deliveryFeeKes, totalKes: totals.totalKes,
      tierAtOrder: tier?.tier ?? null, locationId: ctx.pickup ? null : ctx.locationId ?? null,
      etaAt: inArea?.etaAt ?? null,
      deliveryMode: ctx.pickup ? "pickup" : inArea?.mode ?? null,
      deliveryQuote: inArea ? { zoneId: inArea.zoneId, zoneCode: inArea.zoneCode, distanceKm: Math.round(inArea.distanceKm * 100) / 100, trips: inArea.trips, rawFeeKes: inArea.rawFeeKes, peak: inArea.peak, mode: inArea.mode } : null,
      createdAt: c.now,
    }).returning();
    await tx.insert(s.orderItems).values(items.lines.map((l) => ({ orderId: o!.id, sku: l.sku, qty: l.qty, unitPriceKes: l.unitPriceKes, unitDiscountKes: l.unitDiscountKes })));
    await tx.insert(s.statusEvents).values({ orderId: o!.id, fromStatus: null, toStatus: "DRAFT", actorType: "customer", actorId: c.customer.id, at: c.now });
    if (ctx.vehicleId) await tx.update(s.vehicles).set({ batterySku: p.sku, sourceOrderId: o!.id }).where(eq(s.vehicles.id, ctx.vehicleId));
    return o!.id;
  });

  await go(c, "SUMMARY", { ...ctx, orderId, step: undefined });
  const body = T.summary({
    lines: [{ label: `${p.brand} ${p.sizeFamily}${p.polarity}`, qty: ctx.qty!, lineKes: items.subtotalKes }],
    discountKes: totals.discountKes,
    tierLabel,
    deliveryFeeKes: totals.deliveryFeeKes,
    rawDeliveryKes: inArea && inArea.rawFeeKes !== inArea.feeKes ? inArea.rawFeeKes : null,
    totalKes: totals.totalKes,
    eta: inArea ? etaWords(inArea.etaAt, c.now) : "",
    pickup: !!ctx.pickup,
    trips: inArea?.trips ?? 1,
    bulk: inArea?.mode === "bulk_run",
  });
  return say(c, { kind: "buttons", body, buttons: [BTN.pay, BTN.change, BTN.person] });
}

async function onSummary(c: Ctx) {
  const bid = buttonId(c.msg);
  if (bid === BTN.pay.id) {
    await go(c, "PAY_NUMBER", c.conv.context);
    return say(c, { kind: "buttons", body: T.payNumber, buttons: [BTN.payThis, BTN.payOther] });
  }
  if (bid === BTN.change.id) {
    const id = c.conv.context.orderId;
    if (id) await c.deps.db.transaction((tx) => transitionOrder(tx, id, "CANCELLED", { type: "customer", id: c.customer.id }, c.now, ["DRAFT"]));
    await go(c, "MENU", { step: "method" });
    return say(c, methodMsg(T.howToMatch));
  }
  return failedParse(c, { kind: "text", body: T.didntGetThat });
}

// ---------- PAY ----------

async function onPayNumber(c: Ctx) {
  const ctx = c.conv.context;
  const bid = buttonId(c.msg);
  if (bid === BTN.payThis.id) {
    if (!toE164Kenya(c.customer.phoneE164)) {
      await go(c, "PAY_NUMBER", { ...ctx, step: "other_number" });
      return say(c, { kind: "text", body: T.askOtherNumber });
    }
    return pay(c, c.customer.phoneE164);
  }
  if (bid === BTN.payOther.id) {
    await go(c, "PAY_NUMBER", { ...ctx, step: "other_number" });
    return say(c, { kind: "text", body: T.askOtherNumber });
  }
  const t = text(c.msg);
  if (ctx.step === "other_number" && t) {
    const n = toE164Kenya(t);
    if (!n) return failedParse(c, { kind: "text", body: T.badNumber });
    return pay(c, n);
  }
  return failedParse(c, { kind: "buttons", body: T.payNumber, buttons: [BTN.payThis, BTN.payOther] });
}

type PayCtx = ConvContext & { payPhone?: string };

async function pay(c: Ctx, phoneE164: string) {
  const ctx = c.conv.context as PayCtx;
  await go(c, "AWAITING_PAYMENT", { ...ctx, step: undefined, payPhone: phoneE164 } as PayCtx);
  const r = await requestStkPush(c.deps, ctx.orderId!, phoneE164, { type: "customer", id: c.customer.id });
  if (r.ok) return say(c, { kind: "text", body: T.checkPhone });
  switch (r.reason) {
    case "pending": return say(c, { kind: "text", body: T.stkPending });
    case "max_attempts": return handoff(c, "max payment attempts");
    case "out_of_stock": {
      if (ctx.size) return showOffer(c, { sizeFamily: ctx.size.sizeFamily, polarity: ctx.size.polarity ?? "L" }, { vehicle: ctx.vehicle, vehicleId: ctx.vehicleId });
      return showMenu(c, T.outOfStockAtPay);
    }
    case "push_failed": return; // payment flow already sent retry buttons
    default: return showMenu(c, T.menu);
  }
}

async function onAwaitingPayment(c: Ctx) {
  const ctx = c.conv.context as PayCtx;
  const bid = buttonId(c.msg);
  if (bid === BTN.retry.id) return pay(c, ctx.payPhone ?? c.customer.phoneE164);
  if (bid === BTN.payOther.id) {
    await go(c, "PAY_NUMBER", { ...ctx, step: "other_number" });
    return say(c, { kind: "text", body: T.askOtherNumber });
  }
  const [o] = ctx.orderId ? await c.deps.db.select({ status: s.orders.status }).from(s.orders).where(eq(s.orders.id, ctx.orderId)) : [];
  if (o?.status === "PAYMENT_FAILED") return say(c, { kind: "buttons", body: T.payFailed("M-Pesa declined it"), buttons: [BTN.retry, BTN.payOther, BTN.person] });
  return say(c, { kind: "text", body: T.stkPending });
}

// ---------- RESUME ----------

/** Resume an EXPIRED order: same item, qty and location, re-priced from the DB now. */
async function resumeOrder(c: Ctx, orderId: string) {
  const [o] = await c.deps.db.select().from(s.orders).where(and(eq(s.orders.id, orderId), eq(s.orders.customerId, c.customer.id), ne(s.orders.status, "PAID")));
  const [it] = o ? await c.deps.db.select().from(s.orderItems).where(eq(s.orderItems.orderId, o.id)) : [];
  if (!o || !it || o.status !== "EXPIRED") return showMenu(c, T.menu);
  const avail = (await availableBySku(c.deps.db, [it.sku])).get(it.sku) ?? 0;
  const [p] = await productsBySku(c.deps.db, [it.sku]);
  if (avail < it.qty) return showOffer(c, { sizeFamily: p!.sizeFamily, polarity: p!.polarity }, {});
  return toSummary(c, { sku: it.sku, qty: it.qty, locationId: o.locationId ?? undefined, pickup: o.deliveryMode === "pickup", size: { sizeFamily: p!.sizeFamily, polarity: p!.polarity } });
}
