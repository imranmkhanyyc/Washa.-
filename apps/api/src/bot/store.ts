import { eq, sql } from "drizzle-orm";
import * as s from "@washa/db/schema";
import type { DBOrTx } from "@washa/db";

export type ConvState =
  | "NEW" | "CONSENT" | "PROFILE" | "MENU"
  | "MATCH_VEHICLE" | "MATCH_SIZE" | "MATCH_PHOTO"
  | "OFFER" | "QTY" | "LOCATION" | "SUMMARY" | "PAY_NUMBER" | "AWAITING_PAYMENT" | "PAID_DONE"
  | "TRACK_ORDER" | "HANDOFF";

/** Working memory for the flow. Prices are never stored here; they are re-read from the DB. */
export interface ConvContext {
  step?: string;
  failCount?: number;
  make?: string;
  vehicle?: { make: string | null; model: string | null; year: number | null; engine: string | null };
  vehicleId?: string;
  candidates?: { sizeFamily: string; polarity: "L" | "R"; engine: string | null; yearFrom: number; yearTo: number }[];
  size?: { sizeFamily: string; polarity: "L" | "R" | null };
  offerSkus?: string[];
  sku?: string;
  qty?: number;
  locationId?: string;
  orderId?: string;
  pickup?: boolean;
}

export type Customer = typeof s.customers.$inferSelect;
export type Conversation = Omit<typeof s.conversations.$inferSelect, "state" | "context"> & { state: ConvState; context: ConvContext };

export async function getOrCreate(tx: DBOrTx, phoneE164: string): Promise<{ customer: Customer; conv: Conversation; isNew: boolean }> {
  const inserted = await tx.insert(s.customers).values({ phoneE164 }).onConflictDoNothing().returning();
  const isNew = inserted.length > 0;
  const [customer] = isNew ? inserted : await tx.select().from(s.customers).where(eq(s.customers.phoneE164, phoneE164));
  await tx.insert(s.conversations).values({ customerId: customer!.id }).onConflictDoNothing();
  const [conv] = await tx.select().from(s.conversations).where(eq(s.conversations.customerId, customer!.id)).for("update");
  return { customer: customer!, conv: conv as Conversation, isNew };
}

export async function saveConv(tx: DBOrTx, id: string, patch: Partial<Pick<Conversation, "state" | "context" | "handoff" | "handoffReason" | "lastInboundAt">>) {
  await tx.update(s.conversations).set({ ...(patch as Record<string, unknown>), updatedAt: sql`now()` }).where(eq(s.conversations.id, id));
}

export async function convByCustomer(tx: DBOrTx, customerId: string): Promise<Conversation | undefined> {
  const [c] = await tx.select().from(s.conversations).where(eq(s.conversations.customerId, customerId));
  return c as Conversation | undefined;
}
