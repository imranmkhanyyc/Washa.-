import Fastify from "fastify";
import type { Deps } from "./deps";
import { webhookRoutes } from "./routes/webhooks";
import { packRoutes } from "./routes/pack";
import { adminRoutes } from "./routes/admin";

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ? { level: deps.config.env.LOG_LEVEL } : false, trustProxy: true, bodyLimit: 1_000_000 });

  // Keep the raw body: WhatsApp signatures are an HMAC of the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/health", async () => ({ ok: true }));
  await webhookRoutes(app, deps);
  await packRoutes(app, deps);
  await adminRoutes(app, deps);
  return app;
}
