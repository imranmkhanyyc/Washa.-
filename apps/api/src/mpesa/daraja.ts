/**
 * Safaricom Daraja client (docs/03-mpesa-stk.md).
 * Till (Buy Goods): BusinessShortCode = store number, PartyB = till number.
 */
import { darajaTimestamp } from "@washa/core";

export interface StkPushInput {
  amountKes: number;
  /** 2547XXXXXXXX (converted at the edge from E.164). */
  msisdn: string;
  accountReference: string;
  description: string;
  callbackUrl: string;
  now: Date;
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage?: string;
}

export interface StkQueryResponse {
  ResponseCode?: string;
  ResponseDescription?: string;
  MerchantRequestID?: string;
  CheckoutRequestID?: string;
  /** "0" success; other codes final failure. Absent while still processing. */
  ResultCode?: string;
  ResultDesc?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface DarajaClient {
  stkPush(input: StkPushInput): Promise<StkPushResponse>;
  stkQuery(checkoutRequestId: string, now: Date): Promise<StkQueryResponse>;
}

export interface DarajaConfig {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  storeNumber: string;
  tillNumber: string;
  passkey: string;
  transactionType: "CustomerBuyGoodsOnline" | "CustomerPayBillOnline";
}

export function stkPassword(storeNumber: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${storeNumber}${passkey}${timestamp}`).toString("base64");
}

export function buildStkPushBody(cfg: DarajaConfig, input: StkPushInput) {
  if (!Number.isInteger(input.amountKes) || input.amountKes < 1) throw new Error("Amount must be a positive integer KES");
  const ts = darajaTimestamp(input.now);
  return {
    BusinessShortCode: cfg.storeNumber,
    Password: stkPassword(cfg.storeNumber, cfg.passkey, ts),
    Timestamp: ts,
    TransactionType: cfg.transactionType,
    Amount: input.amountKes,
    PartyA: input.msisdn,
    PartyB: cfg.transactionType === "CustomerBuyGoodsOnline" ? cfg.tillNumber : cfg.storeNumber,
    PhoneNumber: input.msisdn,
    CallBackURL: input.callbackUrl,
    AccountReference: input.accountReference.slice(0, 12),
    TransactionDesc: input.description.slice(0, 13),
  };
}

export class HttpDarajaClient implements DarajaClient {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private cfg: DarajaConfig, private fetchImpl: typeof fetch = fetch) {}

  /** OAuth token, cached until ~1 min before expiry. */
  async accessToken(now = Date.now()): Promise<string> {
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.consumerKey}:${this.cfg.consumerSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.ok) throw new Error(`Daraja OAuth failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: string | number };
    this.token = { value: json.access_token, expiresAt: now + Number(json.expires_in) * 1000 };
    return this.token.value;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T & { errorMessage?: string };
    if (!res.ok && !(json as StkQueryResponse).errorCode) throw new Error(`Daraja ${path} failed: ${res.status} ${json.errorMessage ?? ""}`);
    return json;
  }

  async stkPush(input: StkPushInput) {
    const r = await this.post<StkPushResponse>("/mpesa/stkpush/v1/processrequest", buildStkPushBody(this.cfg, input));
    if (r.ResponseCode !== "0") throw new Error(`STK push rejected: ${r.ResponseDescription ?? "unknown"}`);
    return r;
  }

  async stkQuery(checkoutRequestId: string, now: Date) {
    const ts = darajaTimestamp(now);
    return this.post<StkQueryResponse>("/mpesa/stkpushquery/v1/query", {
      BusinessShortCode: this.cfg.storeNumber,
      Password: stkPassword(this.cfg.storeNumber, this.cfg.passkey, ts),
      Timestamp: ts,
      CheckoutRequestID: checkoutRequestId,
    });
  }
}

/** Offline Daraja for tests and simulate-order. Records pushes; query answers are scripted. */
export class FakeDarajaClient implements DarajaClient {
  pushes: (StkPushInput & { CheckoutRequestID: string; MerchantRequestID: string })[] = [];
  queryResults = new Map<string, StkQueryResponse>();
  failNextPush: string | null = null;
  private n = 0;
  async stkPush(input: StkPushInput) {
    if (this.failNextPush) {
      const m = this.failNextPush;
      this.failNextPush = null;
      throw new Error(m);
    }
    const id = ++this.n;
    const r = { MerchantRequestID: `MR-${id}`, CheckoutRequestID: `ws_CO_TEST_${id}`, ResponseCode: "0", ResponseDescription: "Success. Request accepted for processing" };
    this.pushes.push({ ...input, ...r });
    return r;
  }
  async stkQuery(checkoutRequestId: string) {
    return this.queryResults.get(checkoutRequestId) ?? { errorCode: "500.001.1001", errorMessage: "The transaction is being processed" };
  }
  lastPush() {
    return this.pushes.at(-1);
  }
}
