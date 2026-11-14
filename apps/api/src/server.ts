import { loadDotEnv } from "@washa/db/env";
loadDotEnv();
const { buildApp } = await import("./app");
const { createProdDeps } = await import("./wiring");

const consoleLog = {
  info: (o: object | string, m?: string) => console.log(m ?? "", typeof o === "string" ? o : JSON.stringify(o)),
  warn: (o: object | string, m?: string) => console.warn(m ?? "", typeof o === "string" ? o : JSON.stringify(o)),
  error: (o: object | string, m?: string) => console.error(m ?? "", typeof o === "string" ? o : JSON.stringify(o)),
};

const { deps, close } = await createProdDeps(consoleLog);
const app = await buildApp(deps, { logger: true });
await app.listen({ port: deps.config.env.PORT, host: "0.0.0.0" });
const shutdown = async () => { await app.close(); await close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
