import { z } from "zod";

export const INTENTS = [
  "buy_battery", "not_sure", "track_order", "talk_to_person", "complaint", "returns_warranty", "greeting", "other",
] as const;

export const IntentResult = z.object({
  intent: z.enum(INTENTS),
  confidence: z.number().min(0).max(1),
}).strict();
export type IntentResult = z.infer<typeof IntentResult>;

export const VehicleResult = z.object({
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().int().min(1950).max(2100).nullable(),
  engine: z.string().nullable(),
  confidence: z.number().min(0).max(1),
}).strict();
export type VehicleResult = z.infer<typeof VehicleResult>;

export const LabelResult = z.object({
  size_family: z.string().nullable(),
  polarity: z.enum(["L", "R"]).nullable(),
  brand: z.string().nullable(),
  confidence: z.number().min(0).max(1),
}).strict();
export type LabelResult = z.infer<typeof LabelResult>;

/** JSON Schemas sent to Claude as output_config.format (mirrors the zod schemas). */
const nullable = (t: string) => ({ type: [t, "null"] });
export const JSON_SCHEMAS = {
  intent: {
    type: "object",
    additionalProperties: false,
    required: ["intent", "confidence"],
    properties: { intent: { type: "string", enum: [...INTENTS] }, confidence: { type: "number" } },
  },
  vehicle: {
    type: "object",
    additionalProperties: false,
    required: ["make", "model", "year", "engine", "confidence"],
    properties: { make: nullable("string"), model: nullable("string"), year: nullable("integer"), engine: nullable("string"), confidence: { type: "number" } },
  },
  label: {
    type: "object",
    additionalProperties: false,
    required: ["size_family", "polarity", "brand", "confidence"],
    properties: {
      size_family: nullable("string"),
      polarity: { type: ["string", "null"], enum: ["L", "R", null] },
      brand: nullable("string"),
      confidence: { type: "number" },
    },
  },
} as const;
