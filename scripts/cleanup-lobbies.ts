import { loadEnvConfig } from "@next/env";
import { cleanupExpiredLobbies } from "../lib/multiplayer";
import { getPool } from "../lib/db";

loadEnvConfig(process.cwd());

async function main() {
  const result = await cleanupExpiredLobbies();
  console.log(`Closed ${result.closed} expired lobbies; deleted ${result.deleted} retained lobbies.`);
  await getPool().end();
}

main().catch(async (error) => {
  console.error(error);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
