import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { loadGamePack, playerCostRows } from "./game-data";

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
    await client.query("SELECT pg_advisory_lock(820820)");
    await createSchema(client);
    await seedGameData(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock(820820)").catch(() => undefined);
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
      status text NOT NULL CHECK (status IN ('lobby', 'active', 'results')),
      rerolls_enabled boolean NOT NULL DEFAULT true,
      host_player_id uuid,
      active_match_id uuid,
      state_version integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

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

    CREATE TABLE IF NOT EXISTS game_state (
      lobby_id uuid PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
      state_version integer NOT NULL DEFAULT 0,
      snapshot jsonb NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function seedGameData(client: PoolClient) {
  const expected = loadGamePack().meta.players;
  const existing = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM player_seasons");
  if (Number(existing.rows[0]?.count ?? 0) >= expected) return;

  await client.query("TRUNCATE player_seasons, team_eras CASCADE");

  const pack = loadGamePack();
  for (const teamEra of pack.teamEras) {
    await client.query(
      `INSERT INTO team_eras(team, era, count) VALUES ($1, $2, $3)
       ON CONFLICT (team, era) DO UPDATE SET count = excluded.count`,
      [teamEra.team, teamEra.era, teamEra.count],
    );
  }

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
}
