import { describe, it, expect } from "vitest";
import { toE164Kenya, toMpesaMsisdn, isValidMpesaNumber, waIdToE164 } from "../src/phone";
import { parseSizeCode } from "../src/sizes";
import { darajaTimestamp } from "../src/time";

describe("phone", () => {
  it("normalises Kenyan numbers to E.164", () => {
    for (const s of ["0712345678", "712345678", "254712345678", "+254712345678", "0712 345 678"]) {
      expect(toE164Kenya(s)).toBe("+254712345678");
    }
    expect(toE164Kenya("0112345678")).toBe("+254112345678");
    expect(toE164Kenya("0212345678")).toBeNull();
    expect(toE164Kenya("12345")).toBeNull();
    expect(isValidMpesaNumber("0812345678")).toBe(false);
  });
  it("converts to M-Pesa MSISDN at the edge", () => {
    expect(toMpesaMsisdn("+254712345678")).toBe("254712345678");
    expect(waIdToE164("254712345678")).toBe("+254712345678");
  });
});

describe("sizes", () => {
  it("parses size codes", () => {
    expect(parseSizeCode("ns70")).toEqual({ sizeFamily: "NS70", polarity: null });
    expect(parseSizeCode("I need NS-70 L please")).toEqual({ sizeFamily: "NS70", polarity: "L" });
    expect(parseSizeCode("NS40ZL")).toEqual({ sizeFamily: "NS40", polarity: "L" });
    expect(parseSizeCode("n70")).toEqual({ sizeFamily: "N70", polarity: null });
    expect(parseSizeCode("din 55")).toEqual({ sizeFamily: "DIN55", polarity: null });
    expect(parseSizeCode("hello")).toBeNull();
  });
});

describe("time", () => {
  it("Daraja timestamp in Nairobi time", () => {
    expect(darajaTimestamp(new Date("2026-01-31T22:05:09Z"))).toBe("20260201010509");
  });
});
