# Changelog

## Modules 1–3: foundations, WhatsApp bot, M-Pesa STK push (2026-11-14)

### What shipped
- **Monorepo** (pnpm): `packages/core`, `packages/db`, `apps/api` (Fastify), `apps/web` (Next.js).
- **`packages/core`** (pure, unit-tested, 39 tests): order state machine (`orderMachine.ts`, unknown transitions throw), tiers (`tiers.ts`, rolling 12 months, instant upgrades, downgrades at the start of next month in Nairobi time), pricing (`pricing.ts`, integer KES), zone delivery (`delivery.ts`: polygons first, then rings; extra units, peak surcharge, tier discount after surcharges, round to KES 10, free-over, trips of ≤ 2, B2B bulk run), phone E.164 ↔ M-Pesa MSISDN, size-code parsing, Daraja timestamps.
- **`packages/db`**: full Drizzle schema from `01-architecture.md` + `06-delivery-zones.md`, initial migration, idempotent seed (5 brands × 5 SKUs over 4 size families, stock, fitments for 30 common Kenyan cars, `tier_config`, `delivery_zones`, `delivery_settings`). All seed figures are flagged as placeholders (`price_placeholder`, `placeholder` columns, `notes`).
- **WhatsApp (Module 2)**: `GET/POST /webhooks/whatsapp` with `X-Hub-Signature-256` check and fast ack; jobs do the work; dedupe on `messages.wa_message_id`. Conversation engine for every state in the spec (consent, profile, menu, match by car / size / photo, offer, qty, location, summary, pay number), handoff (button, keywords, two failed parses, confidence < 0.6, returns/warranty) with staff alert and admin release, STOP opt-out, 24-hour window with template fallback. Claude functions `classifyIntent`, `extractVehicle`, `readBatteryLabel` use structured JSON output, are validated with zod and logged to `ai_logs`; Claude never sees prices.
- **M-Pesa (Module 3)**: Daraja client (cached OAuth, STK push for Till/Buy Goods with Paybill sandbox switch via env, STK query). `requestStkPush(orderId, phone)` reserves stock, moves the order to `AWAITING_PAYMENT`, blocks a second live push (< 2 min), caps attempts at 3. `POST /webhooks/mpesa/:secret` acks immediately; the job is idempotent on `CheckoutRequestID`, checks the amount, marks `PAID` with a `status_events` row, decrements stock, recomputes the tier and sends the receipt. Covered: failures with retry buttons, STK query at 60 s / 2 min / 5 min then `unknown` + staff alert, 30-min expiry with stock release and a resume button, amount mismatch, and a unique receipt so one receipt can never pay two orders.
- **Packing screen stub**: `GET /pack/queue` (priority tiers first, then oldest) and `GET /pack/stream` (SSE); `apps/web/app/pack` renders it live.
- **Tests**: 36 API integration tests against a real Postgres test DB (`test/bot.test.ts`, `test/payments.test.ts`, `test/daraja.test.ts`), plus `pnpm simulate:order` (success, cancel→retry, dropped callback→query, query never resolves→expiry, duplicate webhook + duplicate callback).

### What's stubbed / not built yet
- **Packing screen** is a stub (SSE + simple page). Module 4 builds the tablet UI and moves realtime to Supabase Realtime (currently an in-process EventEmitter).
- **Admin**: JSON endpoints only (`GET /admin/alerts`, `POST /admin/conversations/:id/reply`, `POST /admin/conversations/:id/release`, bearer `ADMIN_TOKEN`). No inbox UI, no zone map / "test a pin" screen, no tier_config editor yet.
- **Nightly reconciliation** against the M-Pesa statement export (manual upload): not built.
- **Downgrade heads-up message**: the downgrade is scheduled and applied, but the WhatsApp heads-up isn't sent yet. `battery_health_reminder`, `rider_on_the_way`, `order_delivered_confirm`, `callback_ack` and `daily_owner_report` belong to later modules.
- **Real Claude calls** are written against `@anthropic-ai/sdk` and typecheck, but have not run live (no API key here). Tests and the simulation use `FakeAiService`.
- **Daraja sandbox** has not been hit (no credentials). Everything runs through `FakeDarajaClient`.
- **Staff alerts** go to the admin inbox table and as free-form WhatsApp to `STAFF_ALERT_PHONES`/`GM_PHONE`. Free-form only reaches staff inside their 24-hour window, so an alert template, or a staff group joined via the inbox, is needed.

### Assumptions (defaults from `05-open-questions.md` where one exists, otherwise flagged here)
1. **Brands / SKUs / prices** (#5): the deck shortlist wasn't in the repo, so the placeholder brands are Chloride Exide, Amaron, Bosch, Varta and Yuasa. Prices come from a base-per-size × brand multiplier and are flagged `price_placeholder = true`. Stock is 10 per SKU.
2. **Size families**: NS40, NS60, NS70, N70 (NS70 in both polarities). Fitment rows (33 rows for 30 cars, with Prado, Hilux and X-Trail split by engine) are best-knowledge placeholders: **verify size and polarity against supplier/OEM data.**
3. **"Nearest compatible size"** is not defined in the spec. I added a `size_compat` table (NS40→NS60, NS60→NS70, placeholders) that ops must sign off, since tray fit matters.
4. **Good / Better / Best** = the cheapest, a middle and the priciest in-stock SKU for the size.
5. **Rounding**: tier item discount is rounded per unit to the nearest shilling, so the offer price × qty always equals the summary. The free-delivery threshold is checked against the pre-discount subtotal.
6. **Same-day zone (D)**: ETA = 18:00 Nairobi (placeholder `eta_cutoff_time`), or the next day's 18:00 if ordered after the cutoff.
7. **B2B bulk run** (≥ 6 units): the spec mentions "its own fee table" but doesn't define it, so the zone formula is used and the ETA is the next day at 10:00 (`bulk_run_time`, placeholder). Bulk applies to B2B only, so retail orders of 6+ are split into trips.
8. **Pickup** (offered when out of area): delivery fee 0, no `eta_at`.
9. **Tiers**: no tier before the first paid order (prices are the same as the base tier). Reaching the base tier doesn't send an "upgrade" message. Pending downgrades are stored in new columns `customers.pending_tier` / `pending_tier_at`.
10. **"Garage / dealer"** is one button, so it's stored as `buyer_type = garage`. Both are B2B, so tiers are unaffected.
11. **Safaricom number check**: validates the 07xx / 01xx shape only, with no operator prefix list.
12. **Payments needing a human**: on `amount_mismatch` or `unknown`, the order stays `AWAITING_PAYMENT` and is never auto-expired; staff resolve it. A success that arrives after the order is `EXPIRED`/`PAYMENT_FAILED` is recorded and alerted, not auto-marked paid (the state machine has no such transition).
13. **Resume after expiry** creates a new `DRAFT`, re-priced from the DB, because `EXPIRED` is terminal.
14. **Stale chat**: a known customer writing more than 24 h after their last message restarts at the menu.
15. **Confidence < 0.6 → handoff** applies to intent, vehicle extraction and label reads. An unreadable label (no size) counts as a failed parse instead.
16. **"Change" on the summary** cancels the draft and goes back to the match-method buttons.
17. **Concurrency**: messages from the same customer are serialised in-process (Phase 1 runs one API instance). Before running several instances, switch to a Postgres advisory lock.
18. **Callback IP allowlist** is optional (`MPESA_CALLBACK_IP_ALLOWLIST`) and off by default.
19. **Template names and parameters** assumed: `order_paid(number, receipt, eta)`, `payment_failed_retry(number)`, `tier_upgrade(label)`. Submit them to Meta with these parameter orders.
20. `CLAUDE_MODEL` defaults to `claude-opus-5-5`. Override it in env.

### What's next
Module 4: packing screen (tablet UI, PACKING/READY transitions, pack timer, Supabase Realtime).
