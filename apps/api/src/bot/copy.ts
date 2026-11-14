/**
 * Copy deck (CLAUDE.md rule 10): short, warm, direct; English with natural Kenyan phrasing.
 * Every number shown to a customer is formatted here from DB values, never written by Claude.
 */
import { formatKes, nairobiParts, polarityLabel, type Polarity } from "@washa/core";

export const BTN = {
  consentOk: { id: "consent_ok", title: "OK" },
  personal: { id: "bt_retail", title: "Personal car" },
  garage: { id: "bt_garage", title: "Garage / dealer" },
  fleet: { id: "bt_fleet", title: "Fleet" },
  byCar: { id: "m_car", title: "By my car" },
  bySize: { id: "m_size", title: "I know the size" },
  byPhoto: { id: "m_photo", title: "Send a photo" },
  yes: { id: "yes", title: "Yes, correct" },
  no: { id: "no", title: "No" },
  left: { id: "pol_L", title: "Left" },
  right: { id: "pol_R", title: "Right" },
  qty1: { id: "qty_1", title: "1" },
  qtyMore: { id: "qty_more", title: "More" },
  savedLoc: { id: "loc_saved", title: "Use saved location" },
  newLoc: { id: "loc_new", title: "Send a new pin" },
  callback: { id: "callback", title: "Call me back" },
  pickup: { id: "pickup", title: "Pick up" },
  pay: { id: "pay", title: "Pay with M-Pesa" },
  change: { id: "change", title: "Change" },
  person: { id: "handoff", title: "Talk to a person" },
  payThis: { id: "pay_this", title: "Pay from this number" },
  payOther: { id: "pay_other", title: "Use another number" },
  retry: { id: "pay_retry", title: "Try again" },
  otherSize: { id: "m_size", title: "Try another size" },
} as const;

export const MENU_ROWS = [
  { id: "menu_buy", title: "Buy a battery" },
  { id: "menu_unsure", title: "Not sure what I need" },
  { id: "menu_track", title: "Track my order" },
  { id: "handoff", title: "Talk to a person" },
];

export const T = {
  welcome: "Karibu Washa ⚡ Battery, sasa hivi.\nWe save your details to serve you faster. Reply STOP anytime.",
  askName: "Great. What's your first name?",
  askBuyerType: (name: string) => `Nice to meet you, ${name}. What's the battery for?`,
  askBusinessName: "What's the name of your business?",
  menuNew: (name: string) => `Asante, ${name}. What do you need today?`,
  menuBack: (name: string) => `Karibu back, ${name}. What do you need today?`,
  menu: "What do you need today?",
  howToMatch: "Let's find the right battery. How should we match it?",
  howToMatchUnsure: "No problem, we'll figure it out. Easiest is your car, or a photo of the old battery's label.",
  askMake: "Which make is your car?",
  askMakeOther: "Type the make of your car (e.g. Volkswagen).",
  askModelYear: (make: string) => `Which ${make} model and year? e.g. "Fielder 2015"`,
  askSize: 'Type the battery size, e.g. "NS70".',
  askPhoto: "Send a clear photo of the label on your old battery.",
  confirmLabel: (size: string, pol: Polarity | null) =>
    `Looks like an ${size}${pol ? `, ${polarityLabel(pol)}` : ""}. Correct?`,
  photoUnreadable: "We couldn't read that label. Type the size instead, or talk to us.",
  askPolarity: (size: string) => `${size}: is the positive (+) terminal on the left or right?`,
  clarifyEngine: (car: string) => `${car} takes different batteries by engine. Which one is yours?`,
  clarifyYear: (car: string) => `Which year is your ${car}? e.g. "2015"`,
  noFitment: "We don't have that car on file yet. Do you know the battery size, or can you send a photo?",
  offerBody: (car: string | null, size: string, pol: Polarity, note: string | null) =>
    `${car ? `${car} takes ${size}. ` : `${size}, ${polarityLabel(pol)}. `}${note ? note + " " : ""}Pick one:`,
  nearestNote: (orig: string, alt: string) => `${orig} is out of stock right now; nearest fit is ${alt}.`,
  offerButton: "See options",
  noStock: (size: string) => `Sorry, ${size} is out of stock right now. We can call you back with options, or try another size.`,
  askQtyRetail: "How many?",
  askQtyB2B: "How many units do you need? Type a number.",
  askQtyNumber: "Type the number of units you need.",
  qtyShort: (n: number) => `We have ${n} in stock right now. Type a number up to ${n}.`,
  askLocation: "Drop your location pin so we can price delivery and send a rider.",
  askLocationSaved: (label: string) => `Deliver to your saved location (${label})?`,
  outOfArea: "That pin is outside our delivery area for now. We can call you with a quote, or you can pick up at our warehouse.",
  summary: (p: {
    lines: { label: string; qty: number; lineKes: number }[];
    discountKes: number;
    tierLabel: string | null;
    deliveryFeeKes: number;
    rawDeliveryKes: number | null;
    totalKes: number;
    eta: string;
    pickup: boolean;
    trips: number;
    bulk: boolean;
  }) => {
    const out = ["Your order:"];
    for (const l of p.lines) out.push(`• ${l.label} × ${l.qty}: ${formatKes(l.lineKes)}`);
    if (p.discountKes > 0) out.push(`• ${p.tierLabel ?? "Tier"} discount: −${formatKes(p.discountKes)}`);
    if (p.pickup) out.push("• Pickup at warehouse: free");
    else if (p.deliveryFeeKes === 0) out.push(`• Delivery: free${p.rawDeliveryKes ? ` (was ${formatKes(p.rawDeliveryKes)})` : ""}`);
    else if (p.rawDeliveryKes && p.rawDeliveryKes > p.deliveryFeeKes)
      out.push(`• Delivery: ${formatKes(p.deliveryFeeKes)} (was ${formatKes(p.rawDeliveryKes)})`);
    else out.push(`• Delivery: ${formatKes(p.deliveryFeeKes)}`);
    out.push(`Total: ${formatKes(p.totalKes)}`);
    if (p.bulk) out.push(`Booked on our bulk run: ${p.eta}.`);
    else if (!p.pickup) out.push(`Arrives ${p.eta}${p.trips > 1 ? ` (${p.trips} riders, batteries are heavy)` : ""}.`);
    return out.join("\n");
  },
  payNumber: "Which M-Pesa number should we send the payment request to?",
  askOtherNumber: "Type the M-Pesa number, e.g. 0712 345 678.",
  badNumber: "That doesn't look like a Safaricom number. Try 07xx xxx xxx or 01xx xxx xxx.",
  checkPhone: "Check your phone and enter your M-Pesa PIN.",
  stkPending: "We've already sent a request to your phone. Check for it and enter your PIN.",
  stkPushFailed: "We couldn't reach M-Pesa just now. Try again in a moment.",
  outOfStockAtPay: "Sorry, that battery just sold out. Let's pick another one.",
  paid: (number: string, receipt: string | null, eta: string, pickup: boolean) =>
    `Paid ✅ Order ${number}.${receipt ? ` M-Pesa code ${receipt}.` : ""} ${pickup ? "We'll message you when it's ready for pickup." : `Arriving ${eta}.`}`,
  payFailed: (reason: string) => `Payment didn't go through: ${reason}. What would you like to do?`,
  payFailedFinal: "Payment didn't go through after 3 tries. One of our team will help you finish the order.",
  expired: (number: string) => `Order ${number} timed out before payment, so we've released the battery. Want to pick up where you left off?`,
  resume: { id: "resume", title: "Resume order" },
  handoff: "Sawa. One of our team will reply here shortly.",
  stop: "Done. You won't get any more updates or offers from us. Message anytime if you need a battery.",
  noOrders: "You don't have any orders yet.",
  trackStatus: (number: string, status: string, eta: string | null) =>
    `Order ${number}: ${status}${eta ? `. Expected ${eta}` : ""}.`,
  didntGetThat: "Sorry, I didn't get that. Please tap one of the options.",
  callbackAck: "Sawa. We'll call you back shortly.",
  pickupInfo: "Pickup at our warehouse (CBD). We'll share directions once your order is packed.",
  tierUpgrade: (label: string) => `Hongera! You're now ${label} with Washa. Your new prices apply from your next order.`,
};

/** Plain-words payment failure reasons from Daraja result codes. */
export function failureReason(code: number | null, desc: string | null): string {
  switch (code) {
    case 1032: return "the request was cancelled on the phone";
    case 1037: return "the phone didn't respond in time";
    case 1: return "there wasn't enough balance";
    case 2001: return "the PIN was wrong";
    case 1019: return "the request expired";
    default: return desc ? "M-Pesa declined it" : "M-Pesa declined it";
  }
}

const STATUS_WORDS: Record<string, string> = {
  DRAFT: "not paid yet", AWAITING_PAYMENT: "waiting for payment", PAYMENT_FAILED: "payment didn't go through",
  PAID: "paid, getting packed", PACKING: "being packed", READY: "packed, finding a rider", RIDER_ASSIGNED: "rider on the way to pick up",
  PICKED_UP: "on the way to you", DELIVERED: "delivered", CONFIRMED: "delivered and confirmed", CALLBACK_REQUESTED: "we'll call you back",
  RESOLVED: "resolved", EXPIRED: "timed out before payment", CANCELLED: "cancelled",
};
export const statusWords = (s: string) => STATUS_WORDS[s] ?? s.toLowerCase();

/** "by about 3:45 pm", "today by 6:00 pm", "tomorrow by 10:00 am" (Nairobi time). */
export function etaWords(eta: Date, now: Date): string {
  const e = nairobiParts(eta);
  const n = nairobiParts(now);
  const h12 = ((e.hour + 11) % 12) + 1;
  const time = `${h12}:${String(e.minute).padStart(2, "0")} ${e.hour < 12 ? "am" : "pm"}`;
  const sameDay = e.year === n.year && e.month === n.month && e.day === n.day;
  const tomorrow = new Date(Date.UTC(n.year, n.month - 1, n.day + 1));
  const isTomorrow = e.year === tomorrow.getUTCFullYear() && e.month === tomorrow.getUTCMonth() + 1 && e.day === tomorrow.getUTCDate();
  const mins = Math.round((eta.getTime() - now.getTime()) / 60_000);
  if (sameDay && mins <= 120) return `in about ${mins} min (by ${time})`;
  if (sameDay) return `today by ${time}`;
  if (isTomorrow) return `tomorrow by ${time}`;
  return `on ${e.day}/${e.month} by ${time}`;
}
