# 06 · Zone-based delivery pricing

**Goal:** a fair, predictable delivery fee and a promised ETA for any pin in Nairobi Metro, set by the ops team without a developer. Every number below is a **placeholder** until ops sets real figures.

## Warehouse
The site isn't chosen yet. The placeholder is **downtown Nairobi CBD** (approx. -1.2841, 36.8219), set in `delivery_settings` / env, not hard-coded. Rings re-centre automatically when it moves. Polygons are absolute, so review them after a move.

## How it works
1. The customer drops a WhatsApp location pin (or picks a saved one).
2. `delivery.ts` finds the zone. **Polygon zones are checked first**, in priority order. If none matches, **distance rings** from the warehouse are used as the fallback.
3. The fee is built from the zone’s rules (below), then the customer’s tier delivery discount is applied.
4. The zone’s ETA target is stamped onto the order as `eta_at` and drives rider points and the on-time KPI.
5. No zone: out of area. The bot offers a **call-back for a quote** or **pickup at the warehouse**, and never fails silently.

## Why polygons and rings
- **Rings** (straight-line km from the warehouse) are simple and work on day one.
- **Polygons** fix what rings get wrong: Nairobi traffic and geography mean 8 km to Westlands is not 8 km to Rongai. Ops can draw a polygon over a hard area and give it its own price and ETA.
- Phase 1 ships with rings plus an admin map to add polygons. Polygons override rings.

## Fee formula
```
base_fee        = zone.base_fee_kes
extra_units     = max(0, battery_count − zone.included_units) × zone.per_extra_unit_kes
peak_surcharge  = zone.peak_surcharge_kes  if order time is in a peak window, else 0
raw_fee         = base_fee + extra_units + peak_surcharge
fee_after_tier  = round_to_10(raw_fee × (1 − tier.delivery_discount_pct))
free_if_over    = 0 if subtotal ≥ zone.free_delivery_over_kes (when set)
```
- **Batteries are heavy** (9–25 kg), so **one rider trip carries at most 2 units**. Orders above that are split across riders, or moved to a scheduled bulk run (B2B), automatically.
- **B2B bulk orders** (≥ `bulk_threshold_units`, default 6) skip on-demand dispatch and are booked into a **scheduled bulk run** with its own fee table.

## Starter zones (PLACEHOLDER figures)
| Zone | Rule | Base fee | Per extra unit | ETA target | Free over |
|---|---|---|---|---|---|
| A · Core | ≤ 5 km ring | KES 200 | KES 100 | 45 min | KES 15,000 |
| B · Inner | 5–10 km ring | KES 350 | KES 150 | 75 min | KES 25,000 |
| C · Outer | 10–20 km ring | KES 550 | KES 200 | 120 min | — |
| D · Metro edge | 20–35 km ring | KES 800 | KES 250 | same day | — |
| Out of area | > 35 km | quote / pickup | — | — | — |

- **Peak windows (placeholder):** 07:00–09:30 and 16:30–19:00 weekdays, +KES 100.
- **Rounding:** fees round to the nearest KES 10.

## Table: `delivery_zones`
| Field | Notes |
|---|---|
| id, name, code | e.g. `A`, “Core” |
| kind | `ring` or `polygon` |
| min_km, max_km | rings only |
| polygon | GeoJSON, polygons only |
| priority | lower checks first; polygons default above rings |
| base_fee_kes, per_extra_unit_kes, included_units | included_units default 1 |
| peak_surcharge_kes | |
| free_delivery_over_kes | nullable |
| eta_minutes | null for “same day” zones, which use `eta_cutoff_time` |
| active | soft-disable a zone without deleting it |

Plus `delivery_settings` (single row): warehouse lat/lng, peak windows, bulk_threshold_units, max_units_per_trip (2), rounding (10).

## Admin (Module 9 dashboard, early version in Module 1)
- A map with the warehouse pin, rings drawn and polygons editable.
- Edit any zone’s fees and ETA and save. Changes apply to new quotes only, never to orders already priced.
- “Test a pin”: drop a pin and see the zone, fee per tier, and ETA.

## Data we collect to tune it
For every delivery, store the zone, quoted ETA, actual ride time, distance and rider. After two weeks of pilot data the dashboard shows **actual vs promised time per zone**, so the real fees and ETAs get set from evidence, not guesses.

## Acceptance criteria
- [ ] A pin in each ring returns the right zone, fee and ETA
- [ ] A polygon drawn over part of ring B overrides it
- [ ] 3 batteries → extra-unit fee applied and the order is split into 2 rider trips
- [ ] A B2B order of ≥ 6 units is routed to a scheduled bulk run
- [ ] Gold (50% off) and Platinum (free) delivery discounts apply correctly after surcharges
- [ ] Out-of-area pin → call-back/pickup offer, no price shown
- [ ] Changing a zone fee doesn’t change the fee on already-priced orders
