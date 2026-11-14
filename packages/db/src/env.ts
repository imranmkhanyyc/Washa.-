/** Loads ./.env (repo root or cwd) if present. Node ≥ 20.12. Existing env vars win. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadDotEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(process.cwd(), ".env"), path.resolve(here, "../../../.env")]) {
    if (existsSync(p)) {
      (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(p);
      return;
    }
  }
}
