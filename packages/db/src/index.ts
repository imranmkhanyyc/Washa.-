import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export * as schema from "./schema";
export * from "./schema";
export type DB = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DBOrTx = DB | Tx;

export function createDb(url: string, opts: { max?: number } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
