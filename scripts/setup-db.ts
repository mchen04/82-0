import { loadEnvConfig } from "@next/env";
import { ensureDatabaseReady, getPool } from "../lib/db";

loadEnvConfig(process.cwd());

async function main() {
  await ensureDatabaseReady();
  const count = await getPool().query<{ count: string }>("SELECT count(*)::text AS count FROM player_seasons");
  console.log(`Database ready with ${count.rows[0]?.count ?? "0"} player seasons.`);
  await getPool().end();
}

main().catch(async (error) => {
  console.error(error);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
