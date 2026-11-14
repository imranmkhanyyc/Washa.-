# 04 · Remaining modules (build after 2 + 3 pass)

Each module gets its own detailed spec file before build. This is the scope and the bar.

## 4 · Packing screen (`apps/web/pack`)
- Tablet view. Live queue of `PAID` orders, oldest first. Platinum orders jump the queue.
- Tap an order to start packing → `PACKING` (pack timer starts). Show items, bin location and customer note.
- Scan or confirm each SKU, then tap the big **Ready** button → `READY` and dispatch fires.
- **Done when:** a paid order appears within 3 s with no refresh, and the timer and packer ID are saved.

## 5 · Dispatch and boda app (`apps/web/rider`, PWA)
- Riders log in by phone + OTP and toggle **Available**. GPS pings every 30 s while available or busy.
- On `READY`, offer the job to the nearest available rider (straight-line distance first, road ETA later).
  - 45 s to accept, then move to the next rider. After 3 declines, alert the GM.
- On accept: `RIDER_ASSIGNED`. The rider sees the pickup and a **target delivery time** (`eta_at`).
- **Pickup:** rider scans the order QR at the warehouse → `PICKED_UP`. The customer gets the rider’s name, phone and ETA.
- **Delivery:** rider taps **Delivered** at the pin (must be within 200 m, or give a reason) → `DELIVERED`.
- Batteries weigh 9–25 kg, so allow up to 2 per trip in Phase 1.
- **Done when:** an end-to-end dispatch with 3 test riders picks the nearest one, and accept timeouts roll over correctly.

## 6 · Close the loop
- On `DELIVERED`, the customer gets buttons: **Received ✅** · **Call me**.
- **Received** → `CONFIRMED`, and points are awarded to the customer, packer and rider.
- **Call me** → `CALLBACK_REQUESTED`. The GM is alerted with the order context and must call back within the set time, then mark it `RESOLVED` with a reason.
- No answer in 24 h → auto-confirm.

## 7 · Points, tiers and Rewards Store
- **Customer points:** 1 point per KES 100 paid (default, configurable).
- **Tiers:** B2B and D2C tracks from `tier_config` (`01-architecture.md`), rolling 12 months. Recompute on every `PAID` and nightly.
- **Packer points:** on-time pack (under target) and zero errors. Deduct for a wrong item.
- **Rider points:** on-time pickup, on-time delivery (`DELIVERED ≤ eta_at`), and no call-back on the order.
- **Rewards Store:** catalogue of redeemable items, a balance check and a redeem request, with GM approval in Phase 1.
- Everything goes through `points_ledger` and is never edited, only appended.

## 8 · Web store (`apps/web`)
- Mobile-first. Two ways to search: **Find by car** (same `fitments` logic) and **Shop by size**.
- Same pricing, same STK checkout and same order engine as WhatsApp. Sign-in is by phone OTP, so it’s the same customer record as WhatsApp.
- After checkout, all order updates go to WhatsApp.
- Visual direction: near-black, electric lime accent, real Kenyan cars, direct copy.

## 9 · Owner dashboard and reports
- **Live:** orders by status, today’s revenue, on-time %, call-back rate, stock alerts, riders online.
- **Daily WhatsApp report to the owner at 8 pm:** orders, revenue, average delivery time, on-time %, call-backs, low stock, retail vs B2B split.
- **CSV export** for orders and payments.

## Scale gate (before wider launch)
100 orders/day held for 2 straight weeks with:
- **≥ 90%** on time
- **< 15%** call-backs
- repeat-buyer target TBD
