/**
 * Claude is used for understanding only (CLAUDE.md rule 1). It never sees prices, never decides flow,
 * and never writes customer-facing text. Every output is validated with zod; invalid = failed parse (null).
 */
import { IntentResult, LabelResult, VehicleResult } from "./schemas";

export interface AiContext {
  conversationId?: string;
}
export interface ImageInput {
  data: Buffer;
  mimeType: string;
}

export interface AiService {
  classifyIntent(text: string, ctx?: AiContext): Promise<IntentResult | null>;
  extractVehicle(text: string, ctx?: AiContext & { makeHint?: string }): Promise<VehicleResult | null>;
  readBatteryLabel(image: ImageInput, ctx?: AiContext): Promise<LabelResult | null>;
}

export type AiLogger = (entry: { conversationId?: string; fn: string; input: unknown; output: unknown; valid: boolean }) => Promise<void>;

/**
 * Deterministic stand-in for Claude, used by tests and `pnpm simulate:order`.
 * Recognises a handful of phrases so the whole loop runs offline.
 */
export class FakeAiService implements AiService {
  /** Map from media id / image bytes (utf8) to the label the "vision model" reads. */
  labels = new Map<string, Omit<LabelResult, "confidence"> & { confidence?: number }>();
  calls: { fn: string; input: unknown }[] = [];

  async classifyIntent(text: string) {
    this.calls.push({ fn: "classifyIntent", input: text });
    const t = text.toLowerCase();
    const pick = (intent: IntentResult["intent"], confidence = 0.9) => IntentResult.parse({ intent, confidence });
    if (/(refund|return|warranty)/.test(t)) return pick("returns_warranty");
    if (/(angry|useless|terrible|complain|scam)/.test(t)) return pick("complaint");
    if (/(person|human|agent|call me)/.test(t)) return pick("talk_to_person");
    if (/(track|where is my|status)/.test(t)) return pick("track_order");
    if (/(battery|betri|buy)/.test(t)) return pick("buy_battery");
    if (/(not sure|don't know|dont know)/.test(t)) return pick("not_sure");
    if (/^(hi|hello|habari|niaje|hey|mambo)\b/.test(t)) return pick("greeting");
    if (/(asdf|qwerty|\?\?\?)/.test(t)) return null; // simulates invalid model output
    return pick("other", 0.4);
  }

  async extractVehicle(text: string, ctx?: { makeHint?: string }) {
    this.calls.push({ fn: "extractVehicle", input: text });
    if (/(asdf|qwerty|\?\?\?)/i.test(text)) return null;
    const year = /\b(19[5-9]\d|20\d{2})\b/.exec(text);
    const engine = /\b(diesel|petrol)\b/i.exec(text);
    const model = text
      .replace(/\b(19[5-9]\d|20\d{2})\b/, "")
      .replace(/\b(diesel|petrol)\b/i, "")
      .replace(new RegExp(`\\b${ctx?.makeHint ?? "^$"}\\b`, "i"), "")
      .replace(/[^\w\s-]/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    return VehicleResult.parse({
      make: ctx?.makeHint ?? null,
      model: model || null,
      year: year ? Number(year[1]) : null,
      engine: engine ? engine[1]![0]!.toUpperCase() + engine[1]!.slice(1).toLowerCase() : null,
      confidence: model ? 0.9 : 0.3,
    });
  }

  async readBatteryLabel(image: ImageInput) {
    this.calls.push({ fn: "readBatteryLabel", input: `${image.data.length} bytes` });
    const l = this.labels.get(image.data.toString("utf8"));
    if (!l) return LabelResult.parse({ size_family: null, polarity: null, brand: null, confidence: 0.2 });
    return LabelResult.parse({ confidence: 0.92, ...l });
  }
}
