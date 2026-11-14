CREATE TYPE "public"."actor_type" AS ENUM('system', 'customer', 'staff', 'rider');--> statement-breakpoint
CREATE TYPE "public"."buyer_type" AS ENUM('retail', 'garage', 'dealer', 'fleet');--> statement-breakpoint
CREATE TYPE "public"."msg_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."order_channel" AS ENUM('whatsapp', 'web');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'AWAITING_PAYMENT', 'PAID', 'PACKING', 'READY', 'RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CONFIRMED', 'CALLBACK_REQUESTED', 'RESOLVED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('customer', 'staff', 'rider');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'success', 'failed', 'unknown', 'amount_mismatch');--> statement-breakpoint
CREATE TYPE "public"."polarity" AS ENUM('L', 'R');--> statement-breakpoint
CREATE TYPE "public"."rider_status" AS ENUM('offline', 'available', 'busy');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('packer', 'gm', 'agent');--> statement-breakpoint
CREATE TYPE "public"."tier_track" AS ENUM('b2b', 'd2c');--> statement-breakpoint
CREATE TYPE "public"."zone_kind" AS ENUM('ring', 'polygon');--> statement-breakpoint
CREATE SEQUENCE "public"."order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 10001 CACHE 1;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"fn" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"valid" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"state" text DEFAULT 'NEW' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"handoff" boolean DEFAULT false NOT NULL,
	"handoff_reason" text,
	"assigned_staff_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"name" text,
	"buyer_type" "buyer_type",
	"business_name" text,
	"tier_track" "tier_track",
	"tier" text,
	"pending_tier" text,
	"pending_tier_at" timestamp with time zone,
	"spend_kes_12m" integer DEFAULT 0 NOT NULL,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"consent_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"warehouse_lat" double precision NOT NULL,
	"warehouse_lng" double precision NOT NULL,
	"peak_windows" jsonb NOT NULL,
	"bulk_threshold_units" integer DEFAULT 6 NOT NULL,
	"max_units_per_trip" integer DEFAULT 2 NOT NULL,
	"rounding_kes" integer DEFAULT 10 NOT NULL,
	"bulk_run_time" text DEFAULT '10:00' NOT NULL,
	"placeholder" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "zone_kind" NOT NULL,
	"min_km" numeric(6, 2),
	"max_km" numeric(6, 2),
	"polygon" jsonb,
	"priority" integer DEFAULT 100 NOT NULL,
	"base_fee_kes" integer NOT NULL,
	"per_extra_unit_kes" integer DEFAULT 0 NOT NULL,
	"included_units" integer DEFAULT 1 NOT NULL,
	"peak_surcharge_kes" integer DEFAULT 0 NOT NULL,
	"free_delivery_over_kes" integer,
	"eta_minutes" integer,
	"eta_cutoff_time" text,
	"placeholder" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "delivery_zones_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"year_from" integer NOT NULL,
	"year_to" integer NOT NULL,
	"engine" text,
	"size_family" text NOT NULL,
	"polarity" "polarity" NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"label" text,
	"landmark" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wa_message_id" text,
	"conversation_id" uuid,
	"direction" "msg_direction" NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_kes" integer NOT NULL,
	"unit_discount_kes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text DEFAULT 'WA' || nextval('order_number_seq') NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" "order_channel" DEFAULT 'whatsapp' NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"subtotal_kes" integer DEFAULT 0 NOT NULL,
	"discount_kes" integer DEFAULT 0 NOT NULL,
	"delivery_fee_kes" integer DEFAULT 0 NOT NULL,
	"total_kes" integer DEFAULT 0 NOT NULL,
	"tier_at_order" text,
	"location_id" uuid,
	"eta_at" timestamp with time zone,
	"delivery_quote" jsonb,
	"delivery_mode" text,
	"stock_reserved" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"merchant_request_id" text,
	"checkout_request_id" text,
	"phone" text NOT NULL,
	"amount_kes" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"result_code" integer,
	"result_desc" text,
	"mpesa_receipt" text,
	"raw" jsonb,
	"query_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_checkout_request_id_unique" UNIQUE("checkout_request_id"),
	CONSTRAINT "payments_mpesa_receipt_unique" UNIQUE("mpesa_receipt")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "points_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_type" "party_type" NOT NULL,
	"party_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"order_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"sku" text PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"size_family" text NOT NULL,
	"model_code" text NOT NULL,
	"ah" integer NOT NULL,
	"cca" integer NOT NULL,
	"polarity" "polarity" NOT NULL,
	"terminal" text NOT NULL,
	"warranty_months" integer NOT NULL,
	"price_kes" integer NOT NULL,
	"price_placeholder" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "riders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"status" "rider_status" DEFAULT 'offline' NOT NULL,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_seen_at" timestamp with time zone,
	"points_balance" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "size_compat" (
	"from_size" text NOT NULL,
	"to_size" text NOT NULL,
	"rank" integer DEFAULT 1 NOT NULL,
	"notes" text,
	CONSTRAINT "size_compat_from_size_to_size_pk" PRIMARY KEY("from_size","to_size")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"phone" text NOT NULL,
	"points_balance" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid,
	"order_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock" (
	"sku" text PRIMARY KEY NOT NULL,
	"qty_on_hand" integer DEFAULT 0 NOT NULL,
	"qty_reserved" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"bin_location" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tier_config" (
	"track" "tier_track" NOT NULL,
	"tier" text NOT NULL,
	"label" text NOT NULL,
	"rank" integer NOT NULL,
	"min_spend_kes" integer NOT NULL,
	"item_discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"delivery_discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"priority_queue" boolean DEFAULT false NOT NULL,
	"perks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"placeholder" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "tier_config_track_tier_pk" PRIMARY KEY("track","tier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"make" text,
	"model" text,
	"year" integer,
	"engine" text,
	"battery_size" text,
	"battery_sku" text,
	"fitted_at" timestamp with time zone,
	"source_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locations" ADD CONSTRAINT "locations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_alerts" ADD CONSTRAINT "staff_alerts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_alerts" ADD CONSTRAINT "staff_alerts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_events" ADD CONSTRAINT "status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock" ADD CONSTRAINT "stock_sku_products_sku_fk" FOREIGN KEY ("sku") REFERENCES "public"."products"("sku") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitments_make_model_idx" ON "fitments" USING btree ("make","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_customer_idx" ON "locations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conv_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_size_idx" ON "products" USING btree ("size_family","polarity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_events_order_idx" ON "status_events" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_events_to_idx" ON "status_events" USING btree ("to_status","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vehicles_customer_idx" ON "vehicles" USING btree ("customer_id");