# 05 · Open questions (defaults in use until answered)

## Decided
- **Entity:** Washa Ltd, a standalone company. All accounts (M-Pesa, WhatsApp, invoices) are under Washa Ltd.
- **M-Pesa:** Till (Buy Goods), `CustomerBuyGoodsOnline`.
- **Tier spend window:** rolling 12 months, for both the B2B and D2C tracks.
- **B2B tiers:** Silver / Gold KES 1M / Platinum KES 2.5M (see `01-architecture.md`).
- **Delivery:** zone-based pricing (see `06-delivery-zones.md`).
- **Scale gate:** ≥ 90% on time, < 15% call-backs.

## Still open
| # | Question | Default used |
|---|---|---|
| 1 | Till number, store number and passkey for go-live (Washa Ltd). **Not issued yet**: add to env when received | Sandbox creds. Nothing in code depends on the real values |
| 2 | Real delivery zone fees, ETAs and peak windows | Placeholders in `06-delivery-zones.md` |
| 3 | D2C tier names, thresholds and perks | Member / Plus KES 25k / Pro KES 60k (placeholders) |
| 4 | Call-back response time promised to customers | 15 min in business hours |
| 5 | Final 5 brands and SKU list with prices | Seed from the deck shortlist, prices [__] |
| 6 | Warehouse location (a few options under review) and opening hours | **Downtown Nairobi CBD placeholder** (approx. -1.2841, 36.8219). All zones are drawn from this pin, so moving it re-centres every ring automatically |
| 7 | Old-battery trade-in: offer it? Credit value? | Off in Phase 1 |
| 8 | Fitting at the customer’s location? | Off in Phase 1 |
| 9 | B2B credit terms (Net 14/30) in the pilot? | Off. M-Pesa for all, behind a flag |
| 10 | Repeat-buyer target for the scale gate | TBD |
| 11 | WhatsApp: direct with Meta or through a BSP? Business verification under Washa Ltd | Direct Cloud API |
| 12 | Points-to-reward value and Rewards Store items | TBD |
