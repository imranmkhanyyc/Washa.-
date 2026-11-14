import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies X-Hub-Signature-256: "sha256=" + HMAC-SHA256(rawBody, WA_APP_SECRET). */
export function verifyWaSignature(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
}

export function signWaBody(rawBody: string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}
