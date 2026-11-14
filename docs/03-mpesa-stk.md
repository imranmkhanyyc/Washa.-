# 03 · M-Pesa STK push (Module 3 of 9: build with Module 2)

**Goal:** the customer taps **Pay with M-Pesa**, gets the PIN prompt within seconds, and the order becomes `PAID` only when Safaricom confirms it.

## Daraja endpoints
Base URL: `MPESA_BASE_URL` (sandbox `https://sandbox.safaricom.co.ke`, production `https://api.safaricom.co.ke`).

| Call | Method + path |
|---|---|
| OAuth token | `GET /oauth/v1/generate?grant_type=client_credentials` (Basic auth with consumer key/secret). Cache until about 1 min before expiry. |
| STK push | `POST /mpesa/stkpush/v1/processrequest` |
| STK query | `POST /mpesa/stkpushquery/v1/query` |

## STK push request
**Washa Ltd uses a Till (Buy Goods).** For STK push on a Till, `BusinessShortCode` is the **store number** (head office shortcode linked to the Till), and `PartyB` is the **Till number**. The Lipa na M-Pesa Online passkey is issued for the store number at go-live.

```json
{
  "BusinessShortCode": "<MPESA_STORE_NUMBER>",
  "Password": "base64(StoreNumber + Passkey + Timestamp)",
  "Timestamp": "YYYYMMDDHHmmss (Africa/Nairobi)",
  "TransactionType": "CustomerBuyGoodsOnline",
  "Amount": 11000,
  "PartyA": "2547XXXXXXXX",
  "PartyB": "<MPESA_TILL_NUMBER>",
  "PhoneNumber": "2547XXXXXXXX",
  "CallBackURL": "https://<api>/webhooks/mpesa/<MPESA_CALLBACK_SECRET>",
  "AccountReference": "WA10234",
  "TransactionDesc": "Washa order"
}
```
- **Amount:** integer KES, equal to `orders.total_kes`.
- **AccountReference:** the order number (≤ 12 chars).
- **TransactionType:** `CustomerBuyGoodsOnline` (Till). It stays in config so a Paybill can be added later without code changes.
- **Sandbox:** Daraja’s sandbox test shortcode behaves like a Paybill, so sandbox runs use `CustomerPayBillOnline` with the test shortcode. Production switches to Till via env only.
- **After sending:** save `MerchantRequestID` and `CheckoutRequestID` to `payments` with `status = pending`.

## Callback handling: `POST /webhooks/mpesa/:secret`
1. Reject if the secret doesn’t match. Optionally allowlist Safaricom’s published callback IPs.
2. Ack `{"ResultCode":0,"ResultDesc":"Accepted"}` immediately, then process in a job.
3. Find the payment by `Body.stkCallback.CheckoutRequestID`. If it’s already final, do nothing (idempotent).
4. **`ResultCode == 0`:**
   - Read `Amount`, `MpesaReceiptNumber`, `TransactionDate` and `PhoneNumber` from `CallbackMetadata.Item`.
   - Check that the amount equals the order total.
   - Payment becomes `success`. The order goes `AWAITING_PAYMENT → PAID` and a `status_events` row is written.
   - Decrement stock.
   - Bot sends the receipt: order number, M-Pesa code and ETA.
   - Order appears on the packing screen.
5. **Non-zero result** (cancelled, timeout, insufficient funds, wrong PIN):
   - Payment becomes `failed` with `result_desc` stored, and the order becomes `PAYMENT_FAILED`.
   - Bot replies in plain words with buttons: **Try again** · **Use another number** · **Talk to a person**.
6. **Amount mismatch:** flag to the GM, don’t mark it paid, and alert staff.

## Safety nets
- **No callback after 60 s:** run STK query. Retry at 2 min and 5 min, then mark it `unknown` and alert staff.
- **One live STK per order:** block a new push while one is pending (< 2 min old).
- **Max 3 attempts per order.** After that, hand off to a human.
- **Order expiry:** `AWAITING_PAYMENT` older than 30 min becomes `EXPIRED`, stock is released, and the customer gets a resume button.
- **Receipts:** `mpesa_receipt` is unique, so one receipt can never pay two orders.
- **Reconciliation:** a nightly job compares paid orders against the day’s M-Pesa statement export (manual upload in Phase 1) and lists mismatches on the dashboard.

## Acceptance criteria
- [ ] Sandbox STK push reaches a test phone and the callback marks the order `PAID`
- [ ] Customer cancels on the phone → `PAYMENT_FAILED` + retry buttons in chat
- [ ] Dropped callback → STK query resolves the status within 2 min
- [ ] Same callback delivered twice → one payment, one receipt message
- [ ] Amount mismatch → not paid, staff alerted
- [ ] Expired order releases its stock reservation
- [ ] Paid order appears on the packing screen in real time (stub screen OK in this module)
- [ ] `pnpm simulate:order` covers success, cancel, timeout and duplicate paths
