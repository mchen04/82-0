import { loadEnvConfig } from "@next/env";
import { ensureDatabaseReady, getPool } from "../lib/db";

loadEnvConfig(process.cwd());

async function main() {
  const pool = getPool();
  await pool.query(`
    DROP TABLE IF EXISTS
      game_state,
      events,
      standings,
      picks,
      runs,
      matches,
      lobby_players,
      lobbies,
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
