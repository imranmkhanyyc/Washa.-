import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps";
import { verifyWaSignature } from "../whatsapp/signature";
import { parseWebhook } from "../whatsapp/inbound";
import { WA_JOBS } from "../jobs/register";
import { JOBS } from "../mpesa/payments";

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Webhooks ack fast (< 2 s) and do the work in a job (CLAUDE.md rule 4). */
export async function webhookRoutes(app: FastifyInstance, deps: Deps) {
  const env = deps.config.env;

  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && env.WA_VERIFY_TOKEN && q["hub.verify_token"] === env.WA_VERIFY_TOKEN) {
      return reply.type("text/plain").send(q["hub.challenge"] ?? "");
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? "";
    if (!verifyWaSignature(raw, req.headers["x-hub-signature-256"] as string | undefined, env.WA_APP_SECRET)) {
      return reply.code(401).send({ error: "bad signature" });
    }
    const { messages, statuses } = parseWebhook(req.body);
    // singletonKey dedupes retried deliveries at the queue; the messages table dedupes for good.
    for (const m of messages) await deps.queue.send(WA_JOBS.inbound, m, { singletonKey: m.waMessageId });
    for (const st of statuses) await deps.queue.send(WA_JOBS.status, st);
    return reply.code(200).send({ ok: true });
  });

  app.post("/webhooks/mpesa/:secret", async (req, reply) => {
    const { secret } = req.params as { secret: string };
    if (!env.MPESA_CALLBACK_SECRET || !safeEq(secret, env.MPESA_CALLBACK_SECRET)) return reply.code(404).send();
    const allow = deps.config.callbackIpAllowlist;
    if (allow.length > 0 && !allow.includes(req.ip)) return reply.code(403).send();
    const body = req.body as { Body?: { stkCallback?: { CheckoutRequestID?: string } } };
    const checkout = body?.Body?.stkCallback?.CheckoutRequestID;
    deps.log.info({ checkoutRequestId: checkout }, "mpesa callback received"); // never log the full payload
    await deps.queue.send(JOBS.callback, { body }, { singletonKey: checkout ? `cb:${checkout}` : undefined });
    return reply.send({ ResultCode: 0, ResultDesc: "Accepted" });
  });
}
