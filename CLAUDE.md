# Washa: Build Brief for Claude Code

**Washa Ltd** is its own company: Kenya’s WhatsApp-first store for car batteries, then parts and accessories. Every customer-facing name, M-Pesa Till, WhatsApp Business account and invoice is under Washa Ltd.
Tagline: *Washa. Battery, sasa hivi.*

Customers order on **WhatsApp** (the main channel) or a **mobile-first web store**. They pay with **M-Pesa STK push**. Paid orders go to a **packing screen**, the **nearest boda** is summoned, and the loop closes when the customer taps **Received** or **Call me**.

**North Star:** customer journey, prompt delivery, ease of access. Every decision is judged against these three.

---

## Pilot scope (Phase 1)
- **Batteries only.** Max 5 brands, 5–10 SKUs per brand (25–50 SKUs).
- **Capacity:** 100 orders/day without degradation. Design for 10x the volume without a rewrite.
- **Geography:** Nairobi Metro, one warehouse.
- **Lanes:** retail (B2C) and B2B (garages, dealers, fleets). Both use the same WhatsApp number, recognised by phone number.
- **Data capture is a feature.** Every chat must leave behind a complete customer, vehicle and location record.

## Build order (do not skip ahead)
| # | Module | Spec |
|---|--------|------|
| 1 | Foundations: repo, DB schema, catalogue, fitment table | `docs/01-architecture.md` |
| 2 | **WhatsApp bot**: conversation, battery matching, capture, handoff | `docs/02-whatsapp-bot.md` |
| 3 | **M-Pesa STK push**: payment, callbacks, reconciliation | `docs/03-mpesa-stk.md` |
| 4 | Packing screen | `docs/04-roadmap.md` |
| 5 | Dispatch and boda app | `docs/04-roadmap.md` |
| 6 | Delivery confirmation and call-back flow | `docs/04-roadmap.md` |
| 7 | Points, tiers and Rewards Store | `docs/04-roadmap.md` |
| 8 | Web store | `docs/04-roadmap.md` |
| 9 | Owner dashboard and daily WhatsApp report | `docs/04-roadmap.md` |

Modules 2 and 3 are the heart of the system. Ship them end to end, from a WhatsApp chat to a paid order in the DB, before touching anything else.

Delivery pricing is specced separately in `docs/06-delivery-zones.md`. Build it as part of Module 1 (config + pricing function) and wire it into the bot in Module 2.

Open decisions live in `docs/05-open-questions.md`. Never invent a business rule. If a rule is missing, read that file, use the stated default, and flag it.

---

## Stack
- **Language:** TypeScript everywhere, Node 20+.
- **Monorepo:** pnpm workspaces.
  - `apps/api`: Fastify. WhatsApp + M-Pesa webhooks, order engine, jobs.
  - `apps/web`: Next.js (App Router). Web store, admin, packing screen, boda PWA.
  - `packages/db`: Drizzle ORM schema + migrations.
  - `packages/core`: domain logic (pricing, tiers, order state machine). Pure functions, fully unit-tested.
- **Database:** Postgres (Supabase). Supabase Realtime feeds the packing screen and dispatch.
- **Jobs/queue:** pg-boss on the same Postgres. No Redis in Phase 1.
- **AI:** Claude API, used for understanding only: intent, entity extraction, reading battery label photos. Model name comes from config (`CLAUDE_MODEL`).
- **Hosting:** the API is a long-running Node service (Railway, Render or Fly). The web app runs on Vercel or the same host.

## Non-negotiable rules
1. **The state machine owns the flow. The LLM never does.** Claude classifies and extracts. Code decides what happens next.
2. **Prices, stock and totals come only from the DB.** Never from model output. Never.
3. **No dispatch without a verified M-Pesa payment** (`ResultCode 0` plus an amount match). B2B on-account credit is a later module behind a flag.
4. **Webhooks ack fast.** Return 200 within 2s and do the work in a job. Every inbound event is idempotent: dedupe on WhatsApp message ID and M-Pesa `CheckoutRequestID`.
5. **Every order status change writes a `status_events` row** with actor and timestamp. Points, KPIs and the dashboard are all computed from these rows.
6. **Phone numbers are stored in E.164** (`+2547XXXXXXXX`). M-Pesa needs `2547XXXXXXXX`, so convert at the edge only.
7. **Money is stored as integer KES.** No floats.
8. **Secrets live in env vars only.** See `.env.example`. Never log tokens, passkeys or full payment payloads at info level.
9. **Kenya Data Protection Act 2019:** capture consent on first contact, store the minimum, and support opt-out ("STOP").
10. **Copy voice:** short, warm, direct. English with natural Kenyan phrasing. Swahili only where it's set in the copy deck. No corporate filler.

## How to work
- Each module starts with its spec. Restate the acceptance criteria as tests first, then build.
- Each module needs:
  - unit tests for `packages/core`
  - integration tests against a test DB
  - a `scripts/simulate-*.ts` that replays fake webhooks, so the whole loop runs locally without Meta or Safaricom.
- Use the Daraja **sandbox** and a WhatsApp **test number** until go-live.
- Commit per working slice with clear messages. Update the module’s checklist in its spec file as items pass.
- When finished with a module, write a short `docs/changelog.md` entry: what shipped, what’s stubbed, what’s next.

## Commands
```
cp .env.example .env   # fill in; DATABASE_URL is the only one needed locally
pnpm i
pnpm db:migrate        # apply Drizzle migrations (packages/db/migrations)
pnpm db:seed           # placeholder catalogue, fitments, tiers, zones (idempotent)
pnpm dev               # api (:3001) + web (:3000)
pnpm test              # core unit tests + api integration tests (uses TEST_DATABASE_URL, wiped each run)
pnpm simulate:order    # full WhatsApp → STK → paid loop with fake webhooks (uses SIM_DATABASE_URL, default washa_sim)
pnpm db:generate       # new migration after editing packages/db/src/schema.ts
```
