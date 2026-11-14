# Washa

*Battery, sasa hivi.* A WhatsApp-first car battery store for Nairobi: chat → M-Pesa STK push → packing → boda.

Read [`CLAUDE.md`](CLAUDE.md) and [`docs/`](docs) first. Status: Modules 1–3 done; see [`docs/changelog.md`](docs/changelog.md).

```
cp .env.example .env
pnpm i
pnpm db:migrate && pnpm db:seed
pnpm test
pnpm simulate:order
pnpm dev
```

| Path | What |
|---|---|
| `packages/core` | Pure domain logic: order state machine, tiers, pricing, delivery zones |
| `packages/db` | Drizzle schema, migrations, placeholder seed |
| `apps/api` | Fastify: WhatsApp + M-Pesa webhooks, conversation engine, payments, jobs |
| `apps/web` | Next.js: packing screen stub (store, admin, rider app later) |
| `scripts/simulate-order.ts` | Full chat → STK → PAID loop with fake webhooks |
