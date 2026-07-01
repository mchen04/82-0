import { loadEnvConfig } from "@next/env";
import { ensureDatabaseReady, getPool } from "../lib/db";

loadEnvConfig(process.cwd());

async function main() {
  if (process.env.RESET_DATABASE !== "1") {
    throw new Error("Refusing to drop database tables without RESET_DATABASE=1.");
  }

  const pool = getPool();
  await pool.query(`
    DROP TABLE IF EXISTS
      events,
      standings,
      picks,
      runs,
      matches,
      lobby_players,
      lobbies,
      game_pack_versions,
      player_seasons,
      team_eras
    CASCADE;
  `);
  await ensureDatabaseReady();
  console.log("Database reset and reseeded.");
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
