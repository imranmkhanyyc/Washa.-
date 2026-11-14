import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/washa"),
  PORT: z.coerce.number().default(3001),
  PUBLIC_API_URL: z.string().default("http://localhost:3001"),
  LOG_LEVEL: z.string().default("info"),
  /** Bearer token for /admin routes (admin inbox, release to bot). */
  ADMIN_TOKEN: z.string().default(""),
  JOB_QUEUE: z.enum(["inline", "pgboss"]).default("pgboss"),

  WA_GRAPH_VERSION: z.string().default("v21.0"),
  WA_PHONE_NUMBER_ID: z.string().default(""),
  WA_ACCESS_TOKEN: z.string().default(""),
  WA_APP_SECRET: z.string().default(""),
  WA_VERIFY_TOKEN: z.string().default(""),
  STAFF_ALERT_PHONES: z.string().default(""),
  GM_PHONE: z.string().default(""),

  ANTHROPIC_API_KEY: z.string().default(""),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),

  MPESA_BASE_URL: z.string().default("https://sandbox.safaricom.co.ke"),
  MPESA_CONSUMER_KEY: z.string().default(""),
  MPESA_CONSUMER_SECRET: z.string().default(""),
  MPESA_STORE_NUMBER: z.string().default("174379"),
  MPESA_TILL_NUMBER: z.string().default("174379"),
  MPESA_PASSKEY: z.string().default(""),
  MPESA_TRANSACTION_TYPE: z.enum(["CustomerBuyGoodsOnline", "CustomerPayBillOnline"]).default("CustomerBuyGoodsOnline"),
  MPESA_CALLBACK_SECRET: z.string().default(""),
  MPESA_CALLBACK_IP_ALLOWLIST: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

export interface Config {
  env: Env;
  staffAlertPhones: string[];
  callbackIpAllowlist: string[];
  /** Business rules from docs/03 (kept in config, not scattered in code). */
  payments: {
    maxAttempts: number;
    pendingBlockMs: number;
    orderExpiryMs: number;
    /** STK query schedule, ms after the push: 60 s, then 2 min and 5 min. */
    queryScheduleMs: number[];
  };
  bot: { handoffConfidence: number; maxFailedParses: number };
}

export function loadConfig(overrides: Partial<Env> = {}): Config {
  const env = schema.parse({ ...process.env, ...overrides });
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  return {
    env,
    staffAlertPhones: list(env.STAFF_ALERT_PHONES),
    callbackIpAllowlist: list(env.MPESA_CALLBACK_IP_ALLOWLIST),
    payments: { maxAttempts: 3, pendingBlockMs: 2 * 60_000, orderExpiryMs: 30 * 60_000, queryScheduleMs: [60_000, 120_000, 300_000] },
    bot: { handoffConfidence: 0.6, maxFailedParses: 2 },
  };
}
