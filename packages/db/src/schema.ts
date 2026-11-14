/**
 * Drizzle schema (docs/01-architecture.md §Tables, docs/06-delivery-zones.md).
 * Money is integer KES. Phones are E.164.
 */
import {
  pgTable, pgEnum, pgSequence, uuid, text, integer, boolean, timestamp, jsonb, numeric,
  doublePrecision, index, primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ORDER_STATUSES } from "@washa/core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const buyerType = pgEnum("buyer_type", ["retail", "garage", "dealer", "fleet"]);
export const tierTrack = pgEnum("tier_track", ["b2b", "d2c"]);
export const orderStatus = pgEnum("order_status", ORDER_STATUSES);
export const actorType = pgEnum("actor_type", ["system", "customer", "staff", "rider"]);
export const orderChannel = pgEnum("order_channel", ["whatsapp", "web"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "success", "failed", "unknown", "amount_mismatch"]);
export const msgDirection = pgEnum("msg_direction", ["in", "out"]);
export const polarity = pgEnum("polarity", ["L", "R"]);
export const staffRole = pgEnum("staff_role", ["packer", "gm", "agent"]);
export const riderStatus = pgEnum("rider_status", ["offline", "available", "busy"]);
export const zoneKind = pgEnum("zone_kind", ["ring", "polygon"]);
export const partyType = pgEnum("party_type", ["customer", "staff", "rider"]);

export const orderNumberSeq = pgSequence("order_number_seq", { startWith: 10001, increment: 1 });

export const customers = pgTable("customers", {
  id: id(),
  phoneE164: text("phone_e164").notNull().unique(),
  name: text("name"),
  buyerType: buyerType("buyer_type"),
  businessName: text("business_name"),
  tierTrack: tierTrack("tier_track"),
  tier: text("tier"),
  /** Downgrade scheduled for the start of next month (docs/01 §Tiers). */
  pendingTier: text("pending_tier"),
  pendingTierAt: ts("pending_tier_at"),
  spendKes12m: integer("spend_kes_12m").notNull().default(0),
  pointsBalance: integer("points_balance").notNull().default(0),
  consentAt: ts("consent_at"),
  optedOutAt: ts("opted_out_at"),
  createdAt: createdAt(),
});

export const vehicles = pgTable("vehicles", {
  id: id(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  make: text("make"),
  model: text("model"),
  year: integer("year"),
  engine: text("engine"),
  batterySize: text("battery_size"),
  batterySku: text("battery_sku"),
  fittedAt: ts("fitted_at"),
  sourceOrderId: uuid("source_order_id"),
  createdAt: createdAt(),
}, (t) => [index("vehicles_customer_idx").on(t.customerId)]);

export const locations = pgTable("locations", {
  id: id(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  label: text("label"),
  landmark: text("landmark"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index("locations_customer_idx").on(t.customerId)]);

export const products = pgTable("products", {
  sku: text("sku").primaryKey(),
  brand: text("brand").notNull(),
  sizeFamily: text("size_family").notNull(),
  modelCode: text("model_code").notNull(),
  ah: integer("ah").notNull(),
  cca: integer("cca").notNull(),
  polarity: polarity("polarity").notNull(),
  terminal: text("terminal").notNull(),
  warrantyMonths: integer("warranty_months").notNull(),
  priceKes: integer("price_kes").notNull(),
  /** Seed prices are placeholders until ops confirm (docs/05 #5). */
  pricePlaceholder: boolean("price_placeholder").notNull().default(false),
  active: boolean("active").notNull().default(true),
}, (t) => [index("products_size_idx").on(t.sizeFamily, t.polarity)]);

export const stock = pgTable("stock", {
  sku: text("sku").primaryKey().references(() => products.sku),
  qtyOnHand: integer("qty_on_hand").notNull().default(0),
  qtyReserved: integer("qty_reserved").notNull().default(0),
  reorderLevel: integer("reorder_level").notNull().default(0),
  binLocation: text("bin_location"),
});

export const fitments = pgTable("fitments", {
  id: id(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  yearFrom: integer("year_from").notNull(),
  yearTo: integer("year_to").notNull(),
  engine: text("engine"),
  sizeFamily: text("size_family").notNull(),
  polarity: polarity("polarity").notNull(),
  notes: text("notes"),
}, (t) => [index("fitments_make_model_idx").on(t.make, t.model)]);

/**
 * Nearest compatible sizes when the matched size is out of stock.
 * Not in the spec table list; added to satisfy "offer nearest compatible size". PLACEHOLDER rows.
 */
export const sizeCompat = pgTable("size_compat", {
  fromSize: text("from_size").notNull(),
  toSize: text("to_size").notNull(),
  rank: integer("rank").notNull().default(1),
  notes: text("notes"),
}, (t) => [primaryKey({ columns: [t.fromSize, t.toSize] })]);

export const staff = pgTable("staff", {
  id: id(),
  name: text("name").notNull(),
  role: staffRole("role").notNull(),
  phone: text("phone").notNull(),
  pointsBalance: integer("points_balance").notNull().default(0),
});

export const conversations = pgTable("conversations", {
  id: id(),
  customerId: uuid("customer_id").notNull().references(() => customers.id).unique(),
  state: text("state").notNull().default("NEW"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  lastInboundAt: ts("last_inbound_at"),
  handoff: boolean("handoff").notNull().default(false),
  handoffReason: text("handoff_reason"),
  assignedStaffId: uuid("assigned_staff_id").references(() => staff.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: id(),
  waMessageId: text("wa_message_id").unique(),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  direction: msgDirection("direction").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status"),
  createdAt: createdAt(),
}, (t) => [index("messages_conv_idx").on(t.conversationId, t.createdAt)]);

export const deliveryZones = pgTable("delivery_zones", {
  id: id(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  kind: zoneKind("kind").notNull(),
  minKm: numeric("min_km", { precision: 6, scale: 2 }),
  maxKm: numeric("max_km", { precision: 6, scale: 2 }),
  polygon: jsonb("polygon"),
  priority: integer("priority").notNull().default(100),
  baseFeeKes: integer("base_fee_kes").notNull(),
  perExtraUnitKes: integer("per_extra_unit_kes").notNull().default(0),
  includedUnits: integer("included_units").notNull().default(1),
  peakSurchargeKes: integer("peak_surcharge_kes").notNull().default(0),
  freeDeliveryOverKes: integer("free_delivery_over_kes"),
  etaMinutes: integer("eta_minutes"),
  etaCutoffTime: text("eta_cutoff_time"),
  placeholder: boolean("placeholder").notNull().default(true),
  active: boolean("active").notNull().default(true),
});

/** Single row (id = 1). */
export const deliverySettings = pgTable("delivery_settings", {
  id: integer("id").primaryKey().default(1),
  warehouseLat: doublePrecision("warehouse_lat").notNull(),
  warehouseLng: doublePrecision("warehouse_lng").notNull(),
  peakWindows: jsonb("peak_windows").notNull(),
  bulkThresholdUnits: integer("bulk_threshold_units").notNull().default(6),
  maxUnitsPerTrip: integer("max_units_per_trip").notNull().default(2),
  roundingKes: integer("rounding_kes").notNull().default(10),
  bulkRunTime: text("bulk_run_time").notNull().default("10:00"),
  placeholder: boolean("placeholder").notNull().default(true),
});

export const tierConfig = pgTable("tier_config", {
  track: tierTrack("track").notNull(),
  tier: text("tier").notNull(),
  label: text("label").notNull(),
  rank: integer("rank").notNull(),
  minSpendKes: integer("min_spend_kes").notNull(),
  itemDiscountPct: numeric("item_discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  deliveryDiscountPct: numeric("delivery_discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  priorityQueue: boolean("priority_queue").notNull().default(false),
  perks: jsonb("perks").notNull().default({}),
  placeholder: boolean("placeholder").notNull().default(false),
  active: boolean("active").notNull().default(true),
}, (t) => [primaryKey({ columns: [t.track, t.tier] })]);

export const orders = pgTable("orders", {
  id: id(),
  number: text("number").notNull().unique().default(sql`'WA' || nextval('order_number_seq')`),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  channel: orderChannel("channel").notNull().default("whatsapp"),
  status: orderStatus("status").notNull().default("DRAFT"),
  subtotalKes: integer("subtotal_kes").notNull().default(0),
  discountKes: integer("discount_kes").notNull().default(0),
  deliveryFeeKes: integer("delivery_fee_kes").notNull().default(0),
  totalKes: integer("total_kes").notNull().default(0),
  tierAtOrder: text("tier_at_order"),
  locationId: uuid("location_id").references(() => locations.id),
  etaAt: ts("eta_at"),
  /** Frozen delivery quote: zone, distance, trips, mode. Zone edits never touch priced orders. */
  deliveryQuote: jsonb("delivery_quote"),
  deliveryMode: text("delivery_mode"),
  stockReserved: boolean("stock_reserved").notNull().default(false),
  /** AWAITING_PAYMENT older than this becomes EXPIRED (30 min from first STK). */
  expiresAt: ts("expires_at"),
  createdAt: createdAt(),
}, (t) => [index("orders_status_idx").on(t.status, t.createdAt), index("orders_customer_idx").on(t.customerId)]);

export const orderItems = pgTable("order_items", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  sku: text("sku").notNull().references(() => products.sku),
  qty: integer("qty").notNull(),
  unitPriceKes: integer("unit_price_kes").notNull(),
  unitDiscountKes: integer("unit_discount_kes").notNull().default(0),
}, (t) => [index("order_items_order_idx").on(t.orderId)]);

export const payments = pgTable("payments", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  attemptNo: integer("attempt_no").notNull(),
  merchantRequestId: text("merchant_request_id"),
  checkoutRequestId: text("checkout_request_id").unique(),
  phone: text("phone").notNull(),
  amountKes: integer("amount_kes").notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  resultCode: integer("result_code"),
  resultDesc: text("result_desc"),
  mpesaReceipt: text("mpesa_receipt").unique(),
  raw: jsonb("raw"),
  queryAttempts: integer("query_attempts").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("payments_order_idx").on(t.orderId)]);

export const statusEvents = pgTable("status_events", {
  id: id(),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  fromStatus: orderStatus("from_status"),
  toStatus: orderStatus("to_status").notNull(),
  actorType: actorType("actor_type").notNull(),
  actorId: text("actor_id"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("status_events_order_idx").on(t.orderId, t.at), index("status_events_to_idx").on(t.toStatus, t.at)]);

export const riders = pgTable("riders", {
  id: id(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  status: riderStatus("status").notNull().default("offline"),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastSeenAt: ts("last_seen_at"),
  pointsBalance: integer("points_balance").notNull().default(0),
});

export const pointsLedger = pgTable("points_ledger", {
  id: id(),
  partyType: partyType("party_type").notNull(),
  partyId: uuid("party_id").notNull(),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  orderId: uuid("order_id").references(() => orders.id),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/** Admin inbox items / staff alerts (handoff, amount mismatch, unknown payment). */
export const staffAlerts = pgTable("staff_alerts", {
  id: id(),
  kind: text("kind").notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id),
  orderId: uuid("order_id").references(() => orders.id),
  message: text("message").notNull(),
  createdAt: createdAt(),
  resolvedAt: ts("resolved_at"),
});

/** Claude input/output log for tuning the fitment table (docs/02 §Claude usage). */
export const aiLogs = pgTable("ai_logs", {
  id: id(),
  conversationId: uuid("conversation_id"),
  fn: text("fn").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  valid: boolean("valid").notNull(),
  createdAt: createdAt(),
});

