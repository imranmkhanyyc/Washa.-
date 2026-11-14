import { createDb } from "./index";
import { loadDotEnv } from "./env";
import { seed } from "./seed";

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, pool } = createDb(url);
seed(db).then(async () => {
  console.log("seeded (all catalogue prices, fitments and zones are PLACEHOLDERS)");
  await pool.end();
});
