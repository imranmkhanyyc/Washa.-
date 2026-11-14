/** Admin inbox (early version): alerts, staff reply, Release to bot. Bearer ADMIN_TOKEN. */
import { desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as s from "@washa/db/schema";
import type { Deps } from "../deps";
import { sendToCustomer } from "../notify";

export async function adminRoutes(app: FastifyInstance, deps: Deps) {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin")) return;
    const token = deps.config.env.ADMIN_TOKEN;
    if (!token || req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send({ error: "unauthorised" });
  });

  app.get("/admin/alerts", async () => ({
    alerts: await deps.db.select().from(s.staffAlerts).where(isNull(s.staffAlerts.resolvedAt)).orderBy(desc(s.staffAlerts.createdAt)).limit(100),
  }));

  app.post("/admin/conversations/:id/reply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text?: string };
    const [conv] = await deps.db.select().from(s.conversations).where(eq(s.conversations.id, id));
    if (!conv || !text) return reply.code(400).send({ error: "conversation and text required" });
    const [c] = await deps.db.select().from(s.customers).where(eq(s.customers.id, conv.customerId));
    const r = await sendToCustomer(deps, { customerId: c!.id, phoneE164: c!.phoneE164 }, { kind: "text", body: text }, { category: "reply" });
    return { result: r };
  });

  app.post("/admin/conversations/:id/release", async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await deps.db.update(s.conversations)
      .set({ handoff: false, handoffReason: null, state: "MENU", context: {} })
      .where(eq(s.conversations.id, id)).returning({ id: s.conversations.id });
    if (res.length === 0) return reply.code(404).send();
    await deps.db.update(s.staffAlerts).set({ resolvedAt: deps.clock.now() }).where(eq(s.staffAlerts.conversationId, id));
    return { released: true };
  });
}
