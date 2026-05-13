import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(process.cwd(), ".env") });

async function main() {
  const PAT = process.env.SUPABASE_MANAGEMENT_PAT!;
  const REF = process.env.SUPABASE_PROJECT_REF!;
  const sql = process.argv.slice(2).join(" ");
  if (!sql) {
    console.error("usage: pnpm tsx scripts/db-query.ts \"<sql>\"");
    process.exit(1);
  }
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const txt = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(txt);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
