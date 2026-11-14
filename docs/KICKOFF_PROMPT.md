# Paste this into Claude Code to start

Read CLAUDE.md and every file in docs/ before writing code.

Build Module 1 (foundations) and then Modules 2 and 3 (WhatsApp bot + M-Pesa STK push) exactly as specced:

1. Scaffold the pnpm monorepo (apps/api, apps/web, packages/db, packages/core).
2. Create the Drizzle schema and migrations from docs/01-architecture.md and docs/06-delivery-zones.md (including tier_config and delivery_zones seeded with the placeholder values). Seed it with a sample catalogue (5 brands, 4 size families) and a fitments table covering the 30 most common cars in Kenya. Mark seed prices as placeholders.
3. Write the order state machine, pricing and tiers in packages/core, with unit tests first.
4. Build the WhatsApp webhook and conversation engine per docs/02-whatsapp-bot.md.
5. Build the Daraja client, STK push, callback and STK query per docs/03-mpesa-stk.md.
6. Write scripts/simulate-order.ts so the full chat → STK → PAID loop runs locally with fake webhooks, covering success, cancel, timeout and duplicate paths.

Use the defaults in docs/05-open-questions.md and list anything you had to assume. Tick off each acceptance criterion in the spec files as it passes. Stop after Module 3 and report: what works, what’s stubbed, and what you need from us to go live.
