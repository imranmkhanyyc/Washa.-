/**
 * Fake-webhook driver shared by integration tests and scripts/simulate-order.ts.
 * Posts signed WhatsApp webhooks and Daraja callbacks through the real HTTP routes, then drains jobs.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { DB } from "@washa/db";
import { seed } from "@washa/db/seed";
import { signWaBody } from "./whatsapp/signature";
import type { OutMessage } from "./whatsapp/types";
import type { TestDeps } from "./wiring";

let seq = 0;

export class SimCustomer {
  private seen = 0;
  constructor(private sim: Sim, public waId: string, public profileName = "Test") {}

  private async post(message: Record<string, unknown>, id = `wamid.in.${this.waId}.${++seq}`) {
    const body = {
      object: "whatsapp_business_account",
      entry: [{ id: "WABA", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "254700000000", phone_number_id: "PNID" },
        contacts: [{ wa_id: this.waId, profile: { name: this.profileName } }],
        messages: [{ from: this.waId, id, timestamp: String(Math.floor(this.sim.deps.clock.now().getTime() / 1000)), ...message }],
      } }] }],
    };
    await this.sim.postWa(body);
    return { id, replies: this.newReplies() };
  }

  /** Outbound messages to this customer since the last call. */
  newReplies(): OutMessage[] {
    const all = this.sim.deps.wa.to(this.waId);
    const out = all.slice(this.seen);
    this.seen = all.length;
    return out;
  }
  allReplies() {
    return this.sim.deps.wa.to(this.waId);
  }

  text(body: string, id?: string) {
    return this.post({ type: "text", text: { body } }, id);
  }
  tap(id: string, title = id) {
    return this.post({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });
  }
  pick(id: string, title = id) {
    return this.post({ type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } } });
  }
  location(lat: number, lng: number, name = "Home") {
    return this.post({ type: "location", location: { latitude: lat, longitude: lng, name } });
  }
  image(mediaId: string) {
    return this.post({ type: "image", image: { id: mediaId, mime_type: "image/jpeg" } });
  }
  /** Replays an exact webhook delivery (duplicate). */
  replay(id: string, body: string) {
    return this.post({ type: "text", text: { body } }, id);
  }
}

export class Sim {
  constructor(public deps: TestDeps, public app: FastifyInstance) {}

  customer(waId: string, name?: string) {
    return new SimCustomer(this, waId, name);
  }

  async postWa(body: unknown) {
    const raw = JSON.stringify(body);
    const res = await this.app.inject({
      method: "POST", url: "/webhooks/whatsapp", payload: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": signWaBody(raw, this.deps.config.env.WA_APP_SECRET) },
    });
    if (res.statusCode !== 200) throw new Error(`webhook ${res.statusCode}`);
    await this.drain();
  }

  /** Delivers a Daraja STK callback through POST /webhooks/mpesa/:secret. */
  async mpesaCallback(checkoutRequestId: string, r: { code: number; desc?: string; amount?: number; receipt?: string; phone?: string }) {
    const cb: Record<string, unknown> = {
      MerchantRequestID: "MR", CheckoutRequestID: checkoutRequestId, ResultCode: r.code,
      ResultDesc: r.desc ?? (r.code === 0 ? "The service request is processed successfully." : "Request cancelled by user"),
    };
    if (r.code === 0) {
      cb.CallbackMetadata = { Item: [
        { Name: "Amount", Value: r.amount },
        { Name: "MpesaReceiptNumber", Value: r.receipt },
        { Name: "TransactionDate", Value: 20260613120000 },
        { Name: "PhoneNumber", Value: Number(r.phone ?? "254712345678") },
      ] };
    }
    const res = await this.app.inject({
      method: "POST", url: `/webhooks/mpesa/${this.deps.config.env.MPESA_CALLBACK_SECRET}`,
      payload: { Body: { stkCallback: cb } },
    });
    if (res.statusCode !== 200) throw new Error(`mpesa callback ${res.statusCode}`);
    await this.drain();
    return res.json() as { ResultCode: number };
  }

  async drain() {
    await this.deps.queue.drain();
    if (this.deps.queue.errors.length) {
      const e = this.deps.queue.errors.splice(0);
      throw e[0]!.error;
    }
  }

  async advance(ms: number) {
    // Step in 10 s increments so delayed jobs run in time order.
    const step = 10_000;
    for (let t = 0; t < ms; t += step) {
      this.deps.clock.advance(Math.min(step, ms - t));
      await this.drain();
    }
  }
}

/** Wipes transactional data and re-seeds reference data (stock back to seed levels). */
export async function resetDb(db: DB) {
  await db.execute(sql`truncate table ai_logs, staff_alerts, points_ledger, status_events, payments, order_items, orders, messages, conversations, locations, vehicles, customers, stock, size_compat restart identity cascade`);
  await db.execute(sql`alter sequence order_number_seq restart with 10001`);
  await seed(db);
}

export const bodyOf = (m: OutMessage | undefined) => (m && "body" in m ? m.body : "");
export const idsOf = (m: OutMessage | undefined) =>
  !m ? [] : m.kind === "buttons" ? m.buttons.map((b) => b.id) : m.kind === "list" ? m.rows.map((r) => r.id) : [];
