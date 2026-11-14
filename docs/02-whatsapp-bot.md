# 02 · WhatsApp bot (Module 2 of 9: build first)

**Goal:** a customer goes from “Hi” to a confirmed, priced order with a location pin in under 10 minutes, and we capture a full profile on the way.

## Platform
- **API:** WhatsApp Business **Cloud API** (Meta), direct or through a Meta-approved BSP.
- **Graph API version:** set by `WA_GRAPH_VERSION`.
- **Inbound:** `GET /webhooks/whatsapp` handles verification (`hub.mode`, `hub.verify_token`, `hub.challenge`). `POST /webhooks/whatsapp` takes messages and statuses.
  - Verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `WA_APP_SECRET`).
  - Dedupe on `messages[].id`.
- **Outbound:** `POST /{WA_PHONE_NUMBER_ID}/messages`. Use interactive **reply buttons** (max 3) and **list messages** (max 10 rows) wherever a choice exists. Typing is the fallback, not the default.
- **24-hour window:** free-form replies only inside 24h of the customer’s last message. Anything outside the window (payment receipts sent late, delivery updates, reminders, tier upgrades) uses **pre-approved templates**.
- **Cost:** Meta bills per delivered message. Batch updates and never send two messages where one will do.

## Conversation states (`conversations.state`)
```
NEW → CONSENT → PROFILE → MENU
MENU → MATCH_VEHICLE | MATCH_SIZE | MATCH_PHOTO → OFFER → QTY → LOCATION
     → SUMMARY → PAY_NUMBER → AWAITING_PAYMENT → PAID_DONE
MENU → TRACK_ORDER | HANDOFF
```

## Flow, step by step
1. **NEW / CONSENT.** First contact from a new number: a short welcome plus a one-line consent and privacy note (“We save your details to serve you faster. Reply STOP anytime.”), with an **OK** button.
2. **PROFILE.**
   - Ask for a first name (free text).
   - Ask the buyer type with buttons: **Personal car** · **Garage / dealer** · **Fleet**. A business type also asks for the business name.
   - Known numbers skip straight to MENU with “Karibu back, {name}”.
3. **MENU** (list): **Buy a battery** · **Not sure what I need** · **Track my order** · **Talk to a person**.
4. **MATCH.** Three ways in, all ending in a `size_family` + polarity:
   - **By car:** make (list of the top 9 makes + Other), then model and year as free text. Claude extracts `{make, model, year, engine?}` as strict JSON, and `fitments` resolves the size. If more than one size fits, ask one clarifying question (engine or petrol/diesel).
   - **By size:** the customer types a size like “NS70”. Normalise and confirm.
   - **By photo:** the customer sends a picture of the old battery’s label. Claude vision reads the size code and polarity, and we **always confirm back** (“Looks like an NS70, terminal on the left. Correct?”).
   - Save the vehicle to `vehicles` either way.
5. **OFFER.**
   - Up to 3 in-stock SKUs for that size, labelled **Good / Better / Best**, each with price after tier, warranty and brand.
   - Shown as a list message. Prices come from `pricing.ts`, never from Claude.
6. **QTY.** Retail defaults to 1 (button: **1** · **More**). B2B asks the quantity. Cap at stock and show what’s available if short.
7. **LOCATION.**
   - Ask for a WhatsApp **location pin**. Offer **Use saved location** if one exists.
   - Calculate the delivery fee and ETA from zones.
   - Outside the zone: offer a pickup or call-back, never a silent fail.
8. **SUMMARY.** Item, qty, discount, delivery fee, total, and ETA in plain words. Buttons: **Pay with M-Pesa** · **Change** · **Talk to a person**.
9. **PAY_NUMBER.** Buttons: **Pay from this number** · **Use another number** (validate a Safaricom 07xx/01xx number). Then hand off to Module 3 (`requestStkPush(orderId, phone)`).
10. **AWAITING_PAYMENT.** “Check your phone and enter your M-Pesa PIN.” Module 3 sends the result back to the bot.

## Handoff to a human
- **Triggers:**
  - “Talk to a person”
  - two failed parses in a row
  - complaint or anger keywords
  - Claude returns `confidence < 0.6`
  - any request about returns or warranty claims
- **Effect:** `handoff = true`, the bot goes silent, and staff get a WhatsApp alert plus an admin inbox item. Staff reply from the admin inbox, and **Release to bot** resumes the flow.

## Claude usage (`apps/api/src/ai/`)
- **One function per job:**
  - `classifyIntent(text)` returns `{intent, confidence}`
  - `extractVehicle(text)` returns `{make, model, year, engine, confidence}`
  - `readBatteryLabel(imageUrl)` returns `{size_family, polarity, brand?, confidence}`
- **Output:** strict JSON schema, validated with zod. Anything invalid counts as a failed parse.
- **Guardrails:** Claude never sees prices or decides flow, and never writes customer-facing text that contains numbers.
- **Logging:** inputs/outputs are logged with the conversation ID for tuning the fitment table.

## Templates to submit to Meta (utility category)
`order_paid` · `rider_on_the_way` · `order_delivered_confirm` · `callback_ack` · `payment_failed_retry` · `tier_upgrade` · `battery_health_reminder` (marketing) · `daily_owner_report`

## Acceptance criteria
- [ ] A new number completes consent → profile → match by car → offer → location → summary in ≤ 12 messages from us
- [ ] A known number skips profile and sees “Karibu back, {name}”
- [ ] Photo of an NS70 label → correct size suggested and confirmed
- [ ] Ambiguous fitment asks exactly one clarifying question
- [ ] Out-of-stock size → offers nearest compatible size or a call-back, never an empty list
- [ ] Gold/Platinum B2B number sees tier prices and delivery discount in the offer and summary
- [ ] “STOP” sets `opted_out_at`, and no further non-transactional messages go out
- [ ] Handoff silences the bot until released
- [ ] Duplicate webhook delivery produces no duplicate messages or orders
- [ ] `pnpm simulate:order` runs the whole chat with fake webhooks and passes
