import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { loadGamePack, playerCostRows } from "./game-data";
import { expirationSql } from "./lobby-policy";

let pool: Pool | null = null;
let readyPromise: Promise<void> | null = null;

export type DbClient = Pool | PoolClient;

function connectionString() {
  const value = process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL;
  if (!value) {
    throw new Error("POSTGRES_URL, DATABASE_URL, or NEON_DATABASE_URL must be set server-side.");
  }
  return value;
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
  await ensureDatabaseReady();
  return getPool().query<T>(text, values);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  await ensureDatabaseReady();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withReadTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  await ensureDatabaseReady();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureDatabaseReady() {
  if (!readyPromise) {
    readyPromise = prepareDatabase().catch((error) => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

async function prepareDatabase() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(820820)");
    await createSchema(client);
    await seedGameData(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function createSchema(client: PoolClient) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS team_eras (
      team text NOT NULL,
      era text NOT NULL,
      count integer NOT NULL,
      PRIMARY KEY (team, era)
    );

    CREATE TABLE IF NOT EXISTS player_seasons (
      player_id text PRIMARY KEY,
      player_name text NOT NULL,
      team text NOT NULL,
      era text NOT NULL,
      positions text[] NOT NULL,
      cost integer NOT NULL,
      overall numeric NOT NULL,
      search text NOT NULL,
      data jsonb NOT NULL
    );

    CREATE INDEX IF NOT EXISTS player_seasons_team_era_idx ON player_seasons(team, era);
    CREATE INDEX IF NOT EXISTS player_seasons_positions_idx ON player_seasons USING gin(positions);
    CREATE INDEX IF NOT EXISTS player_seasons_search_idx ON player_seasons USING gin(to_tsvector('simple', search));

    CREATE TABLE IF NOT EXISTS lobbies (
      id uuid PRIMARY KEY,
      code text UNIQUE NOT NULL,
      mode text NOT NULL CHECK (mode IN ('parallel', 'snake')),
      cap_type text NOT NULL CHECK (cap_type IN ('hard', 'soft')),
      cap_amount integer NOT NULL,
      status text NOT NULL CHECK (status IN ('lobby', 'active', 'results', 'closed')),
      rerolls_enabled boolean NOT NULL DEFAULT true,
      host_player_id uuid,
      active_match_id uuid,
      state_version integer NOT NULL DEFAULT 0,
      last_activity_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
      closed_at timestamptz,
      close_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE lobbies DROP CONSTRAINT IF EXISTS lobbies_status_check;
    ALTER TABLE lobbies ADD CONSTRAINT lobbies_status_check CHECK (status IN ('lobby', 'active', 'results', 'closed'));
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS expires_at timestamptz;
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS closed_at timestamptz;
    ALTER TABLE lobbies ADD COLUMN IF NOT EXISTS close_reason text;
    ALTER TABLE lobbies DROP CONSTRAINT IF EXISTS lobbies_close_reason_check;
    ALTER TABLE lobbies ADD CONSTRAINT lobbies_close_reason_check CHECK (close_reason IS NULL OR close_reason IN ('expired', 'manual'));
    UPDATE lobbies
    SET last_activity_at = coalesce(last_activity_at, updated_at, created_at, now());
    UPDATE lobbies
    SET expires_at = coalesce(expires_at, ${expirationSql("last_activity_at")});
    ALTER TABLE lobbies ALTER COLUMN last_activity_at SET DEFAULT now();
    ALTER TABLE lobbies ALTER COLUMN last_activity_at SET NOT NULL;
    ALTER TABLE lobbies ALTER COLUMN expires_at SET DEFAULT now() + interval '24 hours';
    ALTER TABLE lobbies ALTER COLUMN expires_at SET NOT NULL;
    CREATE INDEX IF NOT EXISTS lobbies_status_expires_idx ON lobbies(status, expires_at);
    CREATE INDEX IF NOT EXISTS lobbies_closed_at_idx ON lobbies(status, closed_at);

    CREATE TABLE IF NOT EXISTS lobby_players (
      id uuid PRIMARY KEY,
      lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      name text NOT NULL,
      token text UNIQUE NOT NULL,
      active boolean NOT NULL DEFAULT true,
      joined_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS lobby_players_lobby_idx ON lobby_players(lobby_id, joined_at);

    CREATE TABLE IF NOT EXISTS matches (
      id uuid PRIMARY KEY,
      lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      mode text NOT NULL CHECK (mode IN ('parallel', 'snake')),
      round_no integer NOT NULL,
      status text NOT NULL CHECK (status IN ('active', 'complete')),
      participant_ids uuid[] NOT NULL,
      current_turn_player_id uuid,
      current_pick_index integer NOT NULL DEFAULT 0,
      current_spin jsonb,
      winner_ids uuid[] NOT NULL DEFAULT '{}',
      tiebreaker_of uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );

    CREATE INDEX IF NOT EXISTS matches_lobby_idx ON matches(lobby_id, created_at);

    CREATE TABLE IF NOT EXISTS runs (
      id uuid PRIMARY KEY,
      lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES lobby_players(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('active', 'finished', 'lost')),
      round integer NOT NULL DEFAULT 1,
      cap_spent integer NOT NULL DEFAULT 0,
      team_reroll_used boolean NOT NULL DEFAULT false,
      decade_reroll_used boolean NOT NULL DEFAULT false,
      current_spin jsonb,
      lineup jsonb NOT NULL DEFAULT '{}',
      final_result jsonb,
      lost_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (match_id, player_id)
    );

    ALTER TABLE runs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

    CREATE INDEX IF NOT EXISTS runs_match_idx ON runs(match_id);

    CREATE TABLE IF NOT EXISTS picks (
      id uuid PRIMARY KEY,
      lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES lobby_players(id) ON DELETE CASCADE,
      player_season_id text NOT NULL REFERENCES player_seasons(player_id),
      position text NOT NULL,
      team text NOT NULL,
      era text NOT NULL,
      cost integer NOT NULL,
      pick_number integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS picks_match_idx ON picks(match_id, pick_number);
    CREATE INDEX IF NOT EXISTS picks_run_idx ON picks(run_id);

    CREATE TABLE IF NOT EXISTS standings (
      lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      player_id uuid NOT NULL REFERENCES lobby_players(id) ON DELETE CASCADE,
      wins integer NOT NULL DEFAULT 0,
      losses integer NOT NULL DEFAULT 0,
      ties integer NOT NULL DEFAULT 0,
      total_matches integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (lobby_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id uuid PRIMARY KEY,
      lobby_id uuid NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
      match_id uuid,
      player_id uuid,
      type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS events_lobby_idx ON events(lobby_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS game_pack_versions (
      id text PRIMARY KEY,
      version text NOT NULL,
      generated_from text NOT NULL,
      player_count integer NOT NULL,
      team_era_count integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    DROP TABLE IF EXISTS game_state;
  `);
}

async function seedGameData(client: PoolClient) {
  const pack = loadGamePack();
  const version = await client.query<{
    version: string;
    generated_from: string;
    player_count: number;
    team_era_count: number;
  }>(`SELECT version, generated_from, player_count, team_era_count FROM game_pack_versions WHERE id = 'default'`);
  const currentVersion = version.rows[0];
  if (
    currentVersion?.version === pack.version &&
    currentVersion.generated_from === pack.generatedFrom &&
    Number(currentVersion.player_count) === pack.players.length &&
    Number(currentVersion.team_era_count) === pack.teamEras.length
  ) {
    return;
  }

  const teamEraKeys = pack.teamEras.map((teamEra) => `${teamEra.team}\t${teamEra.era}`);
  const teamEraValues: unknown[] = [];
  const teamEraPlaceholders = pack.teamEras.map((teamEra, rowIndex) => {
    const offset = rowIndex * 3;
    teamEraValues.push(teamEra.team, teamEra.era, teamEra.count);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
  });
  if (teamEraPlaceholders.length) {
    await client.query(
      `INSERT INTO team_eras(team, era, count)
       VALUES ${teamEraPlaceholders.join(", ")}
       ON CONFLICT (team, era) DO UPDATE SET count = excluded.count`,
      teamEraValues,
    );
  }
  await client.query(`DELETE FROM team_eras WHERE NOT ((team || E'\t' || era) = ANY($1::text[]))`, [teamEraKeys]);

  const players = playerCostRows();
  const chunkSize = 250;
  for (let index = 0; index < players.length; index += chunkSize) {
    const chunk = players.slice(index, index + chunkSize);
    const values: unknown[] = [];
    const placeholders = chunk.map((player, rowIndex) => {
      const offset = rowIndex * 9;
      values.push(
        player.id,
        player.player,
        player.team,
        player.era,
        player.positions,
        player.cost,
        player.overall,
        `${player.player} ${player.team} ${player.era} ${player.positions.join(" ")}`.toLowerCase(),
        JSON.stringify(player),
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::text[], $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::jsonb)`;
    });

    await client.query(
      `INSERT INTO player_seasons(player_id, player_name, team, era, positions, cost, overall, search, data)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (player_id) DO UPDATE SET
        player_name = excluded.player_name,
        team = excluded.team,
        era = excluded.era,
        positions = excluded.positions,
        cost = excluded.cost,
        overall = excluded.overall,
        search = excluded.search,
        data = excluded.data`,
      values,
    );
  }

  await client.query(
    `DELETE FROM player_seasons ps
     WHERE NOT (ps.player_id = ANY($1::text[]))
       AND NOT EXISTS (
         SELECT 1 FROM picks p WHERE p.player_season_id = ps.player_id
       )`,
    [players.map((player) => player.id)],
  );
  await client.query(
    `INSERT INTO game_pack_versions(id, version, generated_from, player_count, team_era_count, updated_at)
     VALUES ('default', $1, $2, $3, $4, now())
     ON CONFLICT (id) DO UPDATE SET
       version = excluded.version,
       generated_from = excluded.generated_from,
       player_count = excluded.player_count,
       team_era_count = excluded.team_era_count,
       updated_at = now()`,
    [pack.version, pack.generatedFrom, pack.players.length, pack.teamEras.length],
  );
}
