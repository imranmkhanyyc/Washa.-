/**
 * Phones are stored as E.164 (+2547XXXXXXXX). M-Pesa needs 2547XXXXXXXX: convert at the edge only.
 */
const KE_MOBILE = /^\+254(7\d{8}|1\d{8})$/;

/** Normalises 07xx…, 01xx…, 2547…, +2547…, 7xx… into E.164. Returns null if not a Kenyan mobile. */
export function toE164Kenya(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  let n = digits;
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("254")) n = n.slice(3);
  else if (n.startsWith("0")) n = n.slice(1);
  if (!/^[71]\d{8}$/.test(n)) return null;
  const e164 = `+254${n}`;
  return KE_MOBILE.test(e164) ? e164 : null;
}

/**
 * Spec: "validate a Safaricom 07xx/01xx number". We validate the 07xx/01xx shape only;
 * we do not maintain an operator prefix list (assumption, see docs/changelog.md).
 */
export function isValidMpesaNumber(input: string): boolean {
  return toE164Kenya(input) !== null;
}

/** +2547XXXXXXXX → 2547XXXXXXXX (Daraja format). */
export function toMpesaMsisdn(e164: string): string {
  const n = toE164Kenya(e164);
  if (!n) throw new Error("Not a Kenyan mobile number");
  return n.slice(1);
}

/** WhatsApp sends wa_id without "+": 2547XXXXXXXX → +2547XXXXXXXX. */
export function waIdToE164(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

export function e164ToWaId(e164: string): string {
  return e164.replace(/^\+/, "");
}
