/** Battery size codes. Normalises free text like "ns 70", "NS-70", "ns70l" → { sizeFamily, polarity? }. */
export type Polarity = "L" | "R";

const PATTERN = /\b(NS|N|DIN)\s*[-_ ]?\s*(\d{2,3})\s*(Z)?\s*([LR])?\b/i;

export function parseSizeCode(text: string): { sizeFamily: string; polarity: Polarity | null } | null {
  const m = PATTERN.exec(text.toUpperCase());
  if (!m) return null;
  const family = `${m[1]}${m[2]}`;
  const pol = (m[4] as Polarity | undefined) ?? null;
  return { sizeFamily: family, polarity: pol };
}

export function polarityLabel(p: Polarity): string {
  return p === "L" ? "terminal on the left" : "terminal on the right";
}
