/**
 * db-push.ts — Apply SQL migrations in db/migrations/ to Supabase
 * via the Management API. Idempotent: every migration file is
 * authored to be safe to re-run.
 *
 * Required env:
 *   SUPABASE_MANAGEMENT_PAT  — Personal access token
 *   SUPABASE_PROJECT_REF     — Project ref (e.g. abcdefghijkl)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: resolve(process.cwd(), ".env") });

async function main() {
  const PAT = process.env.SUPABASE_MANAGEMENT_PAT;
  const REF = process.env.SUPABASE_PROJECT_REF;

  if (!PAT || !REF) {
    console.error(
      "Missing SUPABASE_MANAGEMENT_PAT or SUPABASE_PROJECT_REF in .env",
    );
    process.exit(1);
  }

  const migrationsDir = resolve(process.cwd(), "db/migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("No migrations found.");
    return;
  }

  const endpoint = `https://api.supabase.com/v1/projects/${REF}/database/query`;

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    process.stdout.write(`▸ ${file} ... `);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`FAIL\n${text}`);
      process.exit(1);
    }
    console.log("ok");
  }

  console.log("\nAll migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
