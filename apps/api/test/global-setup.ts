import pg from "pg";
import { runMigrations } from "@washa/db/migrate";

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/washa_test";

export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await c.end();
  await runMigrations(TEST_URL);
}
