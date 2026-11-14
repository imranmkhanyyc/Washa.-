import Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import { IntentResult, JSON_SCHEMAS, LabelResult, VehicleResult } from "./schemas";
import type { AiContext, AiLogger, AiService, ImageInput } from "./service";

const SYSTEM_INTENT = `You classify one WhatsApp message sent to Washa, a car battery shop in Nairobi, Kenya.
Messages may be English, Swahili or Sheng. Choose the single best intent:
- buy_battery: wants to buy a battery or asks about battery options
- not_sure: unsure what battery they need
- track_order: asks where an order is or its status
- talk_to_person: asks for a human, a call, or an agent
- complaint: unhappy, angry, reporting a problem
- returns_warranty: returns, refunds, warranty claims, faulty battery after purchase
- greeting: just a greeting
- other: anything else
confidence is your probability (0-1) that the intent is correct.`;

const SYSTEM_VEHICLE = `Extract the vehicle from a Kenyan customer's WhatsApp message (English, Swahili or Sheng).
Return make, model, year (4-digit model year) and engine (e.g. "Petrol", "Diesel", or a displacement like "2.0") when stated.
Use null for anything not stated; never guess a year or engine. Use common Kenyan model names (e.g. "Fielder", "Probox", "Land Cruiser Prado").
confidence is your probability (0-1) that make and model are correct.`;

const SYSTEM_LABEL = `You read the label on a car battery in a photo.
size_family: the battery size code exactly as printed, e.g. "NS70", "N70", "NS40ZL", "DIN55" or a JIS code like "75D23L". Do not convert between code systems.
polarity: "L" or "R" if the code or label shows the terminal side, else null.
brand: the brand name if visible, else null.
Use null when unreadable. confidence is your probability (0-1) that size_family is read correctly.`;

export class ClaudeAiService implements AiService {
  private client: Anthropic;
  constructor(private opts: { apiKey: string; model: string; log?: AiLogger }) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 20_000 });
  }

  private async call<T>(
    fn: string,
    system: string,
    content: Anthropic.MessageParam["content"],
    schema: object,
    validator: ZodType<T>,
    ctx: AiContext | undefined,
    logInput: unknown,
  ): Promise<T | null> {
    let output: unknown = null;
    let valid = false;
    try {
      const res = await this.client.messages.create({
        model: this.opts.model,
        max_tokens: 1024,
        // Short classification/extraction: low effort keeps latency down for chat.
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === "refusal") return null;
      const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
      output = JSON.parse(text);
      const parsed = validator.safeParse(output);
      valid = parsed.success;
      return parsed.success ? parsed.data : null;
    } catch (err) {
      output = { error: err instanceof Error ? err.name : "error" };
      return null;
    } finally {
      await this.opts.log?.({ conversationId: ctx?.conversationId, fn, input: logInput, output, valid }).catch(() => {});
    }
  }

  classifyIntent(text: string, ctx?: AiContext) {
    return this.call("classifyIntent", SYSTEM_INTENT, text, JSON_SCHEMAS.intent, IntentResult, ctx, { text });
  }

  extractVehicle(text: string, ctx?: AiContext & { makeHint?: string }) {
    const msg = ctx?.makeHint ? `Make already chosen: ${ctx.makeHint}\nCustomer message: ${text}` : text;
    return this.call("extractVehicle", SYSTEM_VEHICLE, msg, JSON_SCHEMAS.vehicle, VehicleResult, ctx, { text, makeHint: ctx?.makeHint });
  }

  readBatteryLabel(image: ImageInput, ctx?: AiContext) {
    const mediaType = (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(image.mimeType) ? image.mimeType : "image/jpeg") as "image/jpeg";
    return this.call(
      "readBatteryLabel",
      SYSTEM_LABEL,
      [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image.data.toString("base64") } },
        { type: "text", text: "Read this battery label." },
      ],
      JSON_SCHEMAS.label,
      LabelResult,
      ctx,
      { bytes: image.data.length, mimeType: image.mimeType },
    );
  }
}
