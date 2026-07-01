# Better 82-0 Multiplayer

Friends-only multiplayer Cap Mode for Better 82-0.

## What It Does

- Creates private lobby-code games without user accounts.
- Supports two multiplayer modes:
  - Parallel Cap Race: each player builds an independent Cap Mode lineup. Opponent round, spin, reroll, lineup, budget, finish state, and projected record update live.
  - Shared Snake Draft: all players draft from the shared server-selected team/era pool in strict snake order.
- Uses Hard Cap by default at `$88`.
- Supports Soft Cap at `$100`, allowing overspend with a deterministic final win penalty.
- Persists lobbies, lobby players, matches, runs, picks, standings, event history, game state, team eras, and player seasons in Postgres.
- Keeps server authority over spins, rerolls, picks, placements, scoring, winners, and tiebreakers.

## Cap Parity Notes

The live `/cap` page is an Astro/Preact client app backed by `/data/game-pack.json`. Directly embedding it was evaluated first. It preserves the single-player UI, so this app exposes `/cap` as a live embed, but it cannot provide reliable server-authoritative multiplayer state or mutation control because the spin, reroll, pick, and placement state lives inside the embedded client.

For multiplayer, this app reuses the public game pack, court/logo assets, salary formula, scoring logic, hard-cap behavior, positions, candidate board shape, spin cards, mobile lineup strip, colors, borders, shadows, and typography in a controlled Next app.

## Setup

```bash
npm install
cp .env.example .env.local
```

Set `POSTGRES_URL` in `.env.local` or in Vercel project environment variables. The database connection is only read in server-side modules and API routes.

Seed or migrate the disposable Neon database:

```bash
npm run db:setup
```

Reset and reseed all app tables:

```bash
npm run db:reset
```

## Development

```bash
npm run dev -- --hostname 127.0.0.1 --port 3000
```

`localhost` can resolve to another local service in some browser harnesses, so `127.0.0.1` is explicitly allowed in `next.config.mjs`.

## Verification

Run the complete local gate:

```bash
npm run verify
```

This runs:

- TypeScript typecheck
- Core rule tests
- Production build
- DB-backed multiplayer flow verification against Neon

The flow verifier proves:

- stale-version actions are rejected
- refresh/reconnect returns the same player identity
- two-player Parallel Cap Race can finish in a tied first place
- tied Parallel players get a tiebreaker match containing only tied players
- three-player Shared Snake Draft completes with correct snake order
- every snake draft run finishes with five picks

Security/dependency check:

```bash
npm audit --audit-level=high
```

## Deployment

Production is live at:

```text
https://82-0-orpin.vercel.app
```

Deploy on Vercel with `POSTGRES_URL` configured as a server-side environment variable:

```bash
npm run build
vercel --prod
```

Do not expose `POSTGRES_URL` through any `NEXT_PUBLIC_` variable.

## Operational Notes

- Lobby join tokens are random bearer secrets stored in the joining browser's local storage.
- A lobby code alone can view lobby state but cannot mutate it.
- Every mutation sends the last seen `stateVersion`; stale or duplicate actions return `409`.
- Postgres row locks serialize lobby actions.
- Hard Cap enforces enough budget to leave at least `$3` for each remaining empty lineup slot.
- If a hard-cap player has no legal affordable pick for an open slot, that run is marked lost instead of getting stuck.
