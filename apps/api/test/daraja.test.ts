import { describe, it, expect } from "vitest";
import { HttpDarajaClient, buildStkPushBody, stkPassword } from "../src/mpesa/daraja";

const cfg = {
  baseUrl: "https://sandbox.safaricom.co.ke", consumerKey: "ck", consumerSecret: "cs",
  storeNumber: "123456", tillNumber: "987654", passkey: "pk", transactionType: "CustomerBuyGoodsOnline" as const,
};
const input = { amountKes: 11000, msisdn: "254712345678", accountReference: "WA10234", description: "Washa order", callbackUrl: "https://api/webhooks/mpesa/x", now: new Date("2026-01-31T22:05:09Z") };

describe("Daraja client", () => {
  it("Till: BusinessShortCode = store number, PartyB = till, Buy Goods", () => {
    const b = buildStkPushBody(cfg, input);
    expect(b).toMatchObject({
      BusinessShortCode: "123456", PartyB: "987654", TransactionType: "CustomerBuyGoodsOnline", Amount: 11000,
      PartyA: "254712345678", PhoneNumber: "254712345678", AccountReference: "WA10234", Timestamp: "20260201010509",
    });
    expect(b.Password).toBe(Buffer.from("123456pk20260201010509").toString("base64"));
    expect(stkPassword("1", "2", "3")).toBe(Buffer.from("123").toString("base64"));
  });

  it("sandbox Paybill: PartyB = shortcode", () => {
    const b = buildStkPushBody({ ...cfg, storeNumber: "174379", transactionType: "CustomerPayBillOnline" }, input);
    expect(b).toMatchObject({ BusinessShortCode: "174379", PartyB: "174379", TransactionType: "CustomerPayBillOnline" });
  });

  it("rejects non-integer amounts", () => {
    expect(() => buildStkPushBody(cfg, { ...input, amountKes: 10.5 })).toThrow();
  });

  it("caches the OAuth token until ~1 min before expiry", async () => {
    let tokenCalls = 0;
    const fake = (async (url: string) => {
      if (url.includes("/oauth/")) { tokenCalls++; return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: "3599" })); }
      return new Response(JSON.stringify({ MerchantRequestID: "m", CheckoutRequestID: "c", ResponseCode: "0", ResponseDescription: "ok" }));
    }) as unknown as typeof fetch;
    const c = new HttpDarajaClient(cfg, fake);
    const t0 = Date.now();
    expect(await c.accessToken(t0)).toBe("t1");
    expect(await c.accessToken(t0 + 3_000_000)).toBe("t1");
    expect(await c.accessToken(t0 + 3_560_000)).toBe("t2");
    await c.stkPush(input);
    expect(tokenCalls).toBe(2);
  });
});
