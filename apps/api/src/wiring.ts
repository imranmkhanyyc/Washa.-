/** Builds Deps for production or for tests/simulations. */
import { createDb } from "@washa/db";
import * as s from "@washa/db/schema";
import { loadConfig, type Env } from "./config";
import { FakeClock, systemClock, type Clock } from "./clock";
import { InlineQueue, createPgBossQueue } from "./jobs/queue";
import { FakeWhatsAppClient, GraphWhatsAppClient } from "./whatsapp/client";
import { ClaudeAiService, FakeAiService } from "./ai/service-exports";
import { FakeDarajaClient, HttpDarajaClient } from "./mpesa/daraja";
import { createEventBus } from "./events";
import { silentLogger, type Deps, type Logger } from "./deps";
import { registerJobs } from "./jobs/register";

export async function createProdDeps(log: Logger) {
  const config = loadConfig();
  const env = config.env;
  const { db, pool } = createDb(env.DATABASE_URL);
  const clock: Clock = systemClock;
  const queue = env.JOB_QUEUE === "inline" ? new InlineQueue(clock, { autoRun: true }) : await createPgBossQueue(env.DATABASE_URL);
  const deps: Deps = {
    db, config, clock, queue, log,
    wa: new GraphWhatsAppClient({ graphVersion: env.WA_GRAPH_VERSION, phoneNumberId: env.WA_PHONE_NUMBER_ID, accessToken: env.WA_ACCESS_TOKEN }),
    ai: new ClaudeAiService({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.CLAUDE_MODEL,
      log: async (e) => { await db.insert(s.aiLogs).values({ conversationId: e.conversationId ?? null, fn: e.fn, input: e.input as object, output: (e.output ?? null) as object, valid: e.valid }); },
    }),
    mpesa: new HttpDarajaClient({
      baseUrl: env.MPESA_BASE_URL, consumerKey: env.MPESA_CONSUMER_KEY, consumerSecret: env.MPESA_CONSUMER_SECRET,
      storeNumber: env.MPESA_STORE_NUMBER, tillNumber: env.MPESA_TILL_NUMBER, passkey: env.MPESA_PASSKEY, transactionType: env.MPESA_TRANSACTION_TYPE,
    }),
    events: createEventBus(),
  };
  await queue.start();
  await registerJobs(deps);
  return { deps, close: async () => { await queue.stop(); await pool.end(); } };
}

export interface TestDeps extends Deps {
  clock: FakeClock;
  queue: InlineQueue;
  wa: FakeWhatsAppClient;
  ai: FakeAiService;
  mpesa: FakeDarajaClient;
}

export async function createTestDeps(url: string, overrides: Partial<Env> = {}, startAt = new Date("2026-06-13T09:00:00Z")) {
  const config = loadConfig({
    WA_APP_SECRET: "test-app-secret", WA_VERIFY_TOKEN: "test-verify", MPESA_CALLBACK_SECRET: "cb-secret",
    ADMIN_TOKEN: "admin-token", PUBLIC_API_URL: "https://api.test", MPESA_TRANSACTION_TYPE: "CustomerPayBillOnline",
    STAFF_ALERT_PHONES: "+254700000009", ...overrides,
  });
  const { db, pool } = createDb(url, { max: 5 });
  const clock = new FakeClock(startAt.getTime());
  const deps: TestDeps = {
    db, config, clock, queue: new InlineQueue(clock), log: silentLogger,
    wa: new FakeWhatsAppClient(), ai: new FakeAiService(), mpesa: new FakeDarajaClient(), events: createEventBus(),
  };
  await registerJobs(deps);
  return { deps, close: () => pool.end() };
}
