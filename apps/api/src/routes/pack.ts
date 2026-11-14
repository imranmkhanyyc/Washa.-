/**
 * Packing screen feed (stub for Module 3; Module 4 builds the tablet UI and moves to Supabase Realtime).
 * GET /pack/queue: PAID orders oldest first, priority-queue tiers first.
 * GET /pack/stream: Server-Sent Events, one event per newly paid order.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as s from "@washa/db/schema";
import type { Deps } from "../deps";
import type { OrderPaidEvent } from "../events";

export async function packQueue(deps: Deps) {
  const rows = await deps.db
    .select({
      id: s.orders.id, number: s.orders.number, status: s.orders.status, totalKes: s.orders.totalKes, etaAt: s.orders.etaAt,
      tier: s.orders.tierAtOrder, createdAt: s.orders.createdAt, customerName: s.customers.name, priority: s.tierConfig.priorityQueue,
    })
    .from(s.orders)
    .innerJoin(s.customers, eq(s.customers.id, s.orders.customerId))
    .leftJoin(s.tierConfig, and(eq(s.tierConfig.track, s.customers.tierTrack), eq(s.tierConfig.tier, s.orders.tierAtOrder)))
    .where(inArray(s.orders.status, ["PAID", "PACKING"]))
    .orderBy(asc(s.orders.createdAt));
  const ids = rows.map((r) => r.id);
  const items = ids.length
    ? await deps.db.select({ orderId: s.orderItems.orderId, sku: s.orderItems.sku, qty: s.orderItems.qty, bin: s.stock.binLocation })
        .from(s.orderItems).leftJoin(s.stock, eq(s.stock.sku, s.orderItems.sku)).where(inArray(s.orderItems.orderId, ids))
    : [];
  return rows
    .map((r) => ({ ...r, priority: !!r.priority, items: items.filter((i) => i.orderId === r.id) }))
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.createdAt.getTime() - b.createdAt.getTime());
}

export async function packRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/pack/queue", async (_req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    return { orders: await packQueue(deps) };
  });

  app.get("/pack/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    reply.raw.write(": connected\n\n");
    const onPaid = (e: OrderPaidEvent) => reply.raw.write(`event: order.paid\ndata: ${JSON.stringify(e)}\n\n`);
    deps.events.on("order.paid", onPaid);
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      deps.events.off("order.paid", onPaid);
    });
  });
}
