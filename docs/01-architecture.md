# 01 · Architecture and data model

## System map
```
Customer ──WhatsApp──▶ Meta Cloud API ──webhook──▶ apps/api ──▶ Postgres
   ▲                                                  │  ▲          │
   │◀───────────── outbound messages ◀────────────────┘  │          │ realtime
   │                                                     │          ▼
   └──M-Pesa PIN◀── Safaricom Daraja ◀── STK push ───────┘   apps/web
                         │                                (packing · admin ·
                         └── callback ──▶ apps/api         boda PWA · store)
```

## Order state machine
```
DRAFT → AWAITING_PAYMENT → PAID → PACKING → READY → RIDER_ASSIGNED
      → PICKED_UP → DELIVERED → CONFIRMED
                              ↘ CALLBACK_REQUESTED → RESOLVED
Side exits: PAYMENT_FAILED (retryable) · EXPIRED (no pay in 30 min) · CANCELLED
```
- `DRAFT`: the cart being built in chat. Items, location and price are locked at summary.
- `AWAITING_PAYMENT`: an STK push has been sent. Only one live STK per order.
- `PAID`: set **only** by a verified callback or STK query result.
- `READY`: packer tapped Ready, which triggers dispatch.
- Transitions live in `packages/core/orderMachine.ts`. Any transition not in the table throws.

## Tables (Drizzle, `packages/db`)
| Table | Key fields |
|---|---|
| `customers` | id, phone_e164 (unique), name, buyer_type (`retail`/`garage`/`dealer`/`fleet`), business_name, tier_track (`b2b`/`d2c`), tier (key into `tier_config`), spend_kes_12m, points_balance, consent_at, opted_out_at, created_at |
| `vehicles` | id, customer_id, make, model, year, engine, battery_size, battery_sku, fitted_at, source_order_id |
| `locations` | id, customer_id, lat, lng, label, landmark, is_default |
| `products` | sku, brand, size_family (`NS40`, `NS60`, `NS70`, `N70`, `DIN55`…), model_code, ah, cca, polarity (`L`/`R`), terminal, warranty_months, price_kes, active |
| `stock` | sku, qty_on_hand, qty_reserved, reorder_level |
| `fitments` | make, model, year_from, year_to, engine, size_family, polarity, notes. **The matching brain. Seed and own this table.** |
| `conversations` | id, customer_id, state, context (jsonb), last_inbound_at, handoff (bool), handoff_reason, assigned_staff_id |
| `messages` | id, wa_message_id (unique), conversation_id, direction, type, payload (jsonb), status, created_at |
| `orders` | id, number (`WA10001`…), customer_id, channel (`whatsapp`/`web`), status, subtotal_kes, discount_kes, delivery_fee_kes, total_kes, tier_at_order, location_id, eta_at, created_at |
| `order_items` | order_id, sku, qty, unit_price_kes |
| `payments` | id, order_id, merchant_request_id, checkout_request_id (unique), phone, amount_kes, status, result_code, result_desc, mpesa_receipt (unique), raw (jsonb), created_at |
| `status_events` | order_id, from_status, to_status, actor_type (`system`/`customer`/`staff`/`rider`), actor_id, at |
| `staff` | id, name, role (`packer`/`gm`/`agent`), phone, points_balance |
| `riders` | id, name, phone, status (`offline`/`available`/`busy`), last_lat, last_lng, last_seen_at, points_balance |
| `tier_config` | track, tier, rank, min_spend_kes, item_discount_pct, delivery_discount_pct, priority_queue, perks (jsonb), active |
| `delivery_zones` | see `docs/06-delivery-zones.md` |
| `points_ledger` | party_type, party_id, delta, reason, order_id, at |

**Stock reservation:** reserve at `AWAITING_PAYMENT`, release on `EXPIRED`/`CANCELLED`/`PAYMENT_FAILED` (after the final retry), and decrement on `PAID`.

## Pricing (`packages/core/pricing.ts`)
`total = subtotal − tier_item_discount + delivery_fee_after_tier`
- **Delivery fee:** calculated by `packages/core/delivery.ts` (see `docs/06-delivery-zones.md`).
- **Tier:** applied after the base fee, using the customer’s track and tier at the moment of checkout.

## Tiers (`packages/core/tiers.ts`)
Two tracks, one engine. The track comes from `customers.buyer_type`: `garage`/`dealer`/`fleet` → **B2B**, `retail` → **D2C**.

- **Spend window:** **rolling 12 months** of `PAID` order totals, for both tracks.
- **Recompute:** on every `PAID` and by a nightly job, since spend can age out and drop a tier.
- **Downgrades:** take effect at the start of the next calendar month with a WhatsApp heads-up. Upgrades are instant, with a WhatsApp message.
- **Config:** thresholds, discounts and perks live in a `tier_config` table (track, tier, min_spend_kes, item_discount_pct, delivery_discount_pct, priority_queue, perks jsonb). Not in code. All values can be edited from the admin screen.

### B2B track (confirmed)
| Tier | Rolling 12-mo spend | Item discount | Delivery | Queue |
|---|---|---|---|---|
| Silver | first paid order | 0% | full fee | normal |
| Gold | ≥ KES 1,000,000 | 3% | 50% off | normal |
| Platinum | ≥ KES 2,500,000 | 5% | free | priority |

### D2C track (PLACEHOLDER values — design TBD)
| Tier | Rolling 12-mo spend | Item discount | Delivery | Perks |
|---|---|---|---|---|
| Member | first paid order | 0% | full fee | Battery-health reminders |
| Plus | ≥ KES 25,000 [placeholder] | 2% [placeholder] | 25% off [placeholder] | Free battery health check |
| Pro | ≥ KES 60,000 [placeholder] | 3% [placeholder] | 50% off [placeholder] | Priority queue, free check |

The D2C names and numbers are stand-ins so the engine can be built and tested. Final figures replace them in `tier_config` with no code change.

## KPIs (computed from `status_events`)
| KPI | Measured from | Target |
|---|---|---|
| Inquiry → paid | — | < 10 min |
| Paid → delivered | — | < 90 min, Nairobi |
| On-time % | delivered ≤ eta_at | **≥ 90%** |
| Call-back rate | CALLBACK_REQUESTED / DELIVERED | **< 15%** |
| Repeat rate | — | target TBD |
