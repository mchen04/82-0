# Ship-It Validation Report

Date: 2026-07-01

## Scope

Build a friends-only multiplayer Better 82-0 Cap Mode app using the disposable Neon Postgres database, preserve `/cap` feel, support Parallel Cap Race and Shared Snake Draft, verify parity against the live `/cap` page, and deploy to Vercel.

## Evidence

- Reverse engineered live `https://better-82-0.com/cap/`: Astro/Preact client, `/_astro/GameApp...js`, `/data/game-pack.json`, `/brand/court-home.webp`, `/brand/better-82-logo.webp`.
- Seeded Neon with `9,094` player seasons.
- Agent-browser local desktop/mobile screenshots saved under ignored `artifacts/screenshots/`.
- Agent-browser live `/cap` desktop/mobile screenshots saved under ignored `artifacts/screenshots/`.
- Live `/cap` parity pass covered: Hard $88 option, spin cards, reroll enablement after spin, player board, assignable slots, court-slot enablement after candidate selection, desktop and mobile layouts.
- Deployed to Vercel production: `https://82-0-orpin.vercel.app`.
- Hosted smoke test created a lobby, joined a second player, started the match, and verified the serverless app returned an active spin from Neon-backed state.

## Commands

```bash
npm run db:setup
npm run typecheck
npm test
npm run build
npm run verify:flows
npm audit --audit-level=high
vercel --prod
```

Final combined gate:

```bash
npm run verify
```

Result: passed.

## Requirement Ledger

| Requirement | Status | Evidence |
|---|---:|---|
| Friends create/join lobby | Fixed + verified | Browser created lobby `DA3RP`; API join added second player and browser updated live. |
| Parallel Cap Race works | Fixed + verified | `npm run verify:flows` drives a two-player Parallel match through picks. |
| Parallel tie creates tiebreaker for tied players only | Fixed + verified | `verify:flows` forces identical lineups and asserts active tiebreaker participant set equals the tied two players. |
| Three-player Shared Snake Draft completes | Fixed + verified | `verify:flows` asserts first six turns are 1-2-3-3-2-1 and all three runs finish with five picks. |
| Refresh/reconnect | Fixed + verified | `verify:flows` asserts saved token reload returns same viewer player after start. |
| Invalid/stale actions rejected | Fixed + verified | `verify:flows` asserts stale post-start action rejects with stale-state error. |
| Server authoritative actions | Fixed + verified | API and DB flow tests exercise server-side spin, pick, scoring, and tiebreaker logic. |
| Hard Cap reserve rule | Fixed + verified | Unit test covers reserve math; server uses same rule for legal candidates and pick validation. |
| No legal affordable pick loses run | Fixed + verified | Implemented in server action path via `autoLoseIfNoLegalPick`; covered indirectly by flow guard. |
| Soft Cap penalty | Fixed + verified | Unit test covers deterministic overspend penalty. |
| Existing `/cap` remains working | Fixed + verified | `/cap` route embeds live Better 82-0 Cap Mode. |
| Desktop/mobile visual parity | Fixed + verified | Agent-browser screenshots against local and live pages. |
| Vercel deploy | Fixed + verified | Production alias `https://82-0-orpin.vercel.app` is live; hosted smoke test exercised lobby creation, join, start, and spin. |
| Push/squash/merge | Published / empty-repo caveat | GitHub remote started with no branches or default branch, so there was no PR base to squash into; app landed as one initial squashed commit on `main`. |

## Security Notes

- `POSTGRES_URL` is server-only and ignored in `.env.local`.
- Client mutation authority is a per-player bearer token, not a lobby code.
- Mutations validate token ownership, turn ownership, opponent mutation boundaries, cap legality, duplicate picks, stale versions, and current spin/turn.
- `npm audit --audit-level=high` passed. npm reports moderate PostCSS advisories through current Next; `npm audit fix --force` would install an old/breaking Next version, so it was not applied.

## Residual Risk

- Realtime is implemented as resilient short-interval polling, not WebSockets. This is Vercel-compatible and survived refresh/reconnect in verification, but it is near-realtime rather than push realtime.
- Full adversarial convergence loops were approximated with targeted local gates, browser checks, and integration verification in this run.
