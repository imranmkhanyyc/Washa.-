/**
 * All outbound WhatsApp goes through here:
 * - 24-hour window: free-form inside it, pre-approved template outside it.
 * - Opt-out (STOP): no non-transactional messages.
 * - Every message sent is recorded in `messages`.
 */
import { eq } from "drizzle-orm";
import { e164ToWaId } from "@washa/core";
import * as s from "@washa/db/schema";
import type { Deps } from "./deps";
import type { OutMessage } from "./whatsapp/types";

export type MessageCategory = "reply" | "transactional" | "marketing";
const WINDOW_MS = 24 * 3600_000;

export interface Recipient {
  customerId: string;
  phoneE164: string;
}

export async function sendToCustomer(
  deps: Deps,
  to: Recipient,
  msg: OutMessage,
  opts: { category: MessageCategory; template?: { name: string; params: string[] } } = { category: "reply" },
): Promise<"sent" | "template" | "skipped"> {
  const [c] = await deps.db.select().from(s.customers).where(eq(s.customers.id, to.customerId));
  const [conv] = await deps.db.select().from(s.conversations).where(eq(s.conversations.customerId, to.customerId));
  if (!c) return "skipped";
  if (opts.category === "marketing" && c.optedOutAt) return "skipped";

  const inWindow = !!conv?.lastInboundAt && deps.clock.now().getTime() - conv.lastInboundAt.getTime() < WINDOW_MS;
  let out: OutMessage | null = msg;
  let result: "sent" | "template" = "sent";
  if (!inWindow) {
    if (!opts.template) {
      deps.log.warn({ customerId: c.id }, "outside 24h window and no template: message not sent");
      return "skipped";
    }
    out = { kind: "template", name: opts.template.name, params: opts.template.params };
    result = "template";
  }
  const { waMessageId } = await deps.wa.send(e164ToWaId(to.phoneE164), out);
  await deps.db.insert(s.messages).values({
    waMessageId: waMessageId || null,
    conversationId: conv?.id ?? null,
    direction: "out",
    type: out.kind,
    payload: out as unknown as Record<string, unknown>,
    status: "sent",
  });
  return result;
}

/** Staff alert: admin inbox row + WhatsApp to staff numbers (template-free: staff numbers are expected inside the window via the ops group; falls back to log). */
export async function alertStaff(
  deps: Deps,
  alert: { kind: string; message: string; conversationId?: string | null; orderId?: string | null; gm?: boolean },
) {
  await deps.db.insert(s.staffAlerts).values({ kind: alert.kind, message: alert.message, conversationId: alert.conversationId ?? null, orderId: alert.orderId ?? null });
  const phones = new Set(deps.config.staffAlertPhones);
  if (alert.gm && deps.config.env.GM_PHONE) phones.add(deps.config.env.GM_PHONE);
  for (const p of phones) {
    try {
      await deps.wa.send(e164ToWaId(p), { kind: "text", body: `[Washa alert: ${alert.kind}] ${alert.message}` });
    } catch (err) {
      deps.log.error({ err: String(err), kind: alert.kind }, "staff alert send failed");
    }
  }
  deps.log.warn({ kind: alert.kind, orderId: alert.orderId }, "staff alert");
}
