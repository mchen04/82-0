"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Crown, Play, RotateCcw, Shuffle, Swords, Trophy } from "lucide-react";
import { Header } from "./home-app";
import { formatStat, initials } from "@/lib/rules";
import { POSITIONS, type Candidate, type CapType, type LineupSlot, type LobbyMode, type Position, type PublicLobbyState, type PublicRun } from "@/lib/types";

type ActionName = "settings" | "start" | "spin" | "reroll-team" | "reroll-decade" | "pick" | "next-match";

function tokenKey(code: string) {
  return `better82:${code.toUpperCase()}:token`;
}

function playerName(state: PublicLobbyState | null, id: string | null | undefined) {
  if (!state || !id) return "Unknown";
  return state.players.find((player) => player.id === id)?.name ?? "Unknown";
}

export function LobbyApp({ code }: { code: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState("Friend");
  const [state, setState] = useState<PublicLobbyState | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(tokenKey(code));
    if (saved) setToken(saved);
  }, [code]);

  const load = useCallback(async () => {
    const url = token ? `/api/lobbies/${code}?token=${encodeURIComponent(token)}` : `/api/lobbies/${code}`;
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "Could not load lobby.");
    setState(data);
  }, [code, token]);

  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        await load();
        if (!stopped) setError("");
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Could not load lobby.");
      }
    }
    tick();
    const interval = window.setInterval(tick, 850);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [load]);

  const viewerRun = useMemo(() => {
    const match = state?.activeMatch;
    if (!match || !state.viewerPlayerId) return null;
    return match.runs.find((run) => run.playerId === state.viewerPlayerId) ?? null;
  }, [state]);

  const currentRun = useMemo(() => {
    const match = state?.activeMatch;
    if (!match) return null;
    if (match.mode === "snake") return match.runs.find((run) => run.playerId === match.currentTurnPlayerId) ?? null;
    return viewerRun;
  }, [state, viewerRun]);

  const canAct = Boolean(
    state?.viewerPlayerId &&
      state.activeMatch &&
      (state.activeMatch.mode === "parallel" || state.activeMatch.currentTurnPlayerId === state.viewerPlayerId),
  );
  const isHost = Boolean(state?.viewerPlayerId && state.hostPlayerId === state.viewerPlayerId);
  const activeMatch = state?.activeMatch ?? null;
  const visibleRun = viewerRun ?? currentRun;
  const activeSpin = activeMatch?.mode === "snake" ? activeMatch.currentSpin : viewerRun?.currentSpin ?? null;

  async function join() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/lobbies/${code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Could not join lobby.");
      localStorage.setItem(tokenKey(data.code), data.token);
      setToken(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join lobby.");
    } finally {
      setBusy(false);
    }
  }

  async function action(actionName: ActionName, payload: Record<string, unknown> = {}) {
    if (!token || !state) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/lobbies/${code}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, expectedVersion: state.stateVersion, action: actionName, ...payload }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Action failed.");
      setState(data);
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    const href = `${window.location.origin}/lobby/${code}`;
    await navigator.clipboard?.writeText(href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  const subtitle = state
    ? `${state.status.toUpperCase()} · ${state.mode === "parallel" ? "Parallel Race" : "Snake Draft"} · ${state.capType === "hard" ? "Hard" : "Soft"} Cap`
    : `Lobby ${code}`;

  return (
    <main className="shell">
      <Header
        subtitle={subtitle}
        right={
          <>
            <div className="budget-card">
              <p className="eyebrow">Budget</p>
              <p className="budget-number">${visibleRun?.budgetLeft ?? state?.capAmount ?? 88}</p>
            </div>
            <button className="btn icon" type="button" onClick={copyInvite} title="Copy invite link" aria-label="Copy invite link">
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </>
        }
      />

      <section className="game-grid">
        <div className="stack">
          {error ? <div className="error">{error}</div> : null}
          {!token ? (
            <JoinPanel code={code} name={name} setName={setName} busy={busy} onJoin={join} />
          ) : state?.status === "lobby" ? (
            <LobbySetup state={state} busy={busy} isHost={isHost} onAction={action} />
          ) : (
            <>
              <CapStatus state={state} run={visibleRun} />
              <SpinPanel
                state={state}
                run={currentRun}
                viewerRun={viewerRun}
                spin={activeSpin}
                canAct={canAct}
                busy={busy}
                onAction={action}
              />
              <BoardPanel
                state={state}
                run={currentRun}
                viewerRun={viewerRun}
                selected={selected}
                setSelected={setSelected}
                canAct={canAct}
                busy={busy}
                onPick={(position) => selected && action("pick", { playerSeasonId: selected.id, position })}
              />
            </>
          )}
        </div>

        <aside className="side">
          {state ? (
            <>
              <Court lineup={viewerRun?.lineup ?? {}} selected={selected} canAct={canAct} onPick={(position) => selected && action("pick", { playerSeasonId: selected.id, position })} />
              <Opponents state={state} />
              <Standings state={state} onNext={() => action("next-match")} isHost={isHost} busy={busy} />
              <Events state={state} />
            </>
          ) : null}
        </aside>
      </section>

      {state?.activeMatch ? (
        <MobileLineup lineup={viewerRun?.lineup ?? {}} selected={selected} canAct={canAct} onPick={(position) => selected && action("pick", { playerSeasonId: selected.id, position })} />
      ) : null}
    </main>
  );
}

function JoinPanel({ code, name, setName, busy, onJoin }: { code: string; name: string; setName: (value: string) => void; busy: boolean; onJoin: () => void }) {
  return (
    <section className="panel panel-pad stack">
      <div>
        <p className="section-title">Join lobby {code}</p>
        <p className="small-copy">Pick a name to claim your player slot. Refreshes will reconnect from this browser.</p>
      </div>
      <div className="setup-row">
        <label className="field">
          <span>Your name</span>
          <input className="input" value={name} maxLength={32} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="btn primary" type="button" disabled={busy} onClick={onJoin}>
          Join
        </button>
      </div>
    </section>
  );
}

function LobbySetup({ state, busy, isHost, onAction }: { state: PublicLobbyState; busy: boolean; isHost: boolean; onAction: (action: ActionName, payload?: Record<string, unknown>) => void }) {
  return (
    <section className="panel panel-pad stack">
      <div>
        <p className="section-title">Lobby {state.code}</p>
        <p className="small-copy">{state.players.length} players joined. Hard Cap is the default, Soft Cap applies a deterministic overspend penalty.</p>
      </div>
      <div className="mode-grid">
        <button className={`mode-card ${state.mode === "parallel" ? "active" : ""}`} type="button" disabled={!isHost || busy} onClick={() => onAction("settings", { mode: "parallel" })}>
          <Trophy size={22} />
          <p className="mode-title">Parallel Cap Race</p>
          <p className="mode-copy">Independent runs, live opponent progress, winner counts, and tied-player tiebreakers.</p>
        </button>
        <button className={`mode-card ${state.mode === "snake" ? "active" : ""}`} type="button" disabled={!isHost || busy} onClick={() => onAction("settings", { mode: "snake" })}>
          <Swords size={22} />
          <p className="mode-title">Shared Snake Draft</p>
          <p className="mode-copy">Shared pool, strict snake order, current drafter authority, and live lineups.</p>
        </button>
      </div>
      <div className="segmented">
        <button className={`btn ${state.capType === "hard" ? "green" : ""}`} type="button" disabled={!isHost || busy} onClick={() => onAction("settings", { capType: "hard" })}>
          Hard $88
        </button>
        <button className={`btn ${state.capType === "soft" ? "blue" : ""}`} type="button" disabled={!isHost || busy} onClick={() => onAction("settings", { capType: "soft" })}>
          Soft $88
        </button>
      </div>
      <button className="btn" type="button" disabled={!isHost || busy} onClick={() => onAction("settings", { rerollsEnabled: !state.rerollsEnabled })}>
        <Shuffle size={17} />
        Draft rerolls {state.rerollsEnabled ? "on" : "off"}
      </button>
      <div className="stack">
        {state.players.map((player) => (
          <div className="standing-row" key={player.id}>
            <strong>{player.name}{player.id === state.hostPlayerId ? " · Host" : ""}</strong>
            <span className="eyebrow">{player.isYou ? "You" : "Ready"}</span>
          </div>
        ))}
      </div>
      <button className="btn primary" type="button" disabled={!isHost || busy || state.players.length < 2} onClick={() => onAction("start")}>
        <Play size={17} />
        Start Match
      </button>
    </section>
  );
}

function CapStatus({ state, run }: { state: PublicLobbyState | null; run: PublicRun | null }) {
  return (
    <section className="panel panel-pad">
      <div className="setup-row">
        <div>
          <p className="section-title">Cap Mode</p>
          <p className="eyebrow">
            ${run?.budgetLeft ?? state?.capAmount ?? 88} left · ${run?.capSpent ?? 0} spent · ${state?.capAmount ?? 88} {state?.capType ?? "hard"} cap
          </p>
        </div>
        <div className="segmented">
          <span className={`btn ${state?.capType === "hard" ? "green" : ""}`}>Hard</span>
          <span className={`btn ${state?.capType === "soft" ? "blue" : ""}`}>Soft</span>
        </div>
      </div>
    </section>
  );
}

function SpinPanel({
  state,
  run,
  viewerRun,
  spin,
  canAct,
  busy,
  onAction,
}: {
  state: PublicLobbyState | null;
  run: PublicRun | null;
  viewerRun: PublicRun | null;
  spin: { team: string; era: string } | null;
  canAct: boolean;
  busy: boolean;
  onAction: (action: ActionName, payload?: Record<string, unknown>) => void;
}) {
  const match = state?.activeMatch;
  const localRun = match?.mode === "parallel" ? viewerRun : run;
  const isSnake = match?.mode === "snake";
  const spinDisabled = busy || !canAct || Boolean(spin) || Boolean(isSnake);
  const rerollsAllowed = !isSnake || state?.rerollsEnabled;

  return (
    <section className="panel chalk panel-pad">
      <div className="spin-grid">
        <div className="spin-card">
          <p className="spin-card-label">Team</p>
          <p className="spin-value">{spin?.team ?? "???"}</p>
        </div>
        <div className="spin-card blue">
          <p className="spin-card-label">Decade</p>
          <p className="spin-value">{spin?.era ?? "???"}</p>
        </div>
      </div>
      <div className="spin-meta">
        <span>{localRun ? `${Math.max(0, 5 - localRun.picks.length)} picks left` : "Waiting"}</span>
        <span>{match?.mode === "snake" ? `Turn: ${playerName(state, match.currentTurnPlayerId)}` : "Independent run"}</span>
      </div>
      <div className="spin-actions">
        <button className="btn" type="button" disabled={busy || !canAct || !spin || !rerollsAllowed || Boolean(localRun?.teamRerollUsed)} onClick={() => onAction("reroll-team")}>
          <Shuffle size={15} />
          Team {localRun?.teamRerollUsed ? "used" : "1"}
        </button>
        <button className="btn" type="button" disabled={busy || !canAct || !spin || !rerollsAllowed || Boolean(localRun?.decadeRerollUsed)} onClick={() => onAction("reroll-decade")}>
          <Shuffle size={15} />
          Decade {localRun?.decadeRerollUsed ? "used" : "1"}
        </button>
        <button className="btn primary" type="button" disabled={spinDisabled} onClick={() => onAction("spin")}>
          <Shuffle size={15} />
          Spin
        </button>
      </div>
    </section>
  );
}

function BoardPanel({
  state,
  run,
  viewerRun,
  selected,
  setSelected,
  canAct,
  busy,
  onPick,
}: {
  state: PublicLobbyState | null;
  run: PublicRun | null;
  viewerRun: PublicRun | null;
  selected: Candidate | null;
  setSelected: (candidate: Candidate | null) => void;
  canAct: boolean;
  busy: boolean;
  onPick: (position: Position) => void;
}) {
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<Position | "All">("All");
  const [sort, setSort] = useState("PPG");
  const match = state?.activeMatch;
  const ownFinal = viewerRun?.finalResult;
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (match?.candidates ?? []).filter((candidate) => {
      const matchesQuery = !needle || candidate.player.toLowerCase().includes(needle) || candidate.positions.join(" ").toLowerCase().includes(needle);
      const matchesPosition = position === "All" || candidate.positions.includes(position);
      return matchesQuery && matchesPosition;
    });
    const value = (candidate: Candidate) =>
      sort === "APG" ? candidate.perGame.apg : sort === "RPG" ? candidate.perGame.rpg : sort === "Gravity" ? candidate.ratings.shootingGravity : candidate.perGame.ppg;
    return [...filtered].sort((a, b) => value(b) - value(a) || a.player.localeCompare(b.player));
  }, [match?.candidates, position, query, sort]);

  if (ownFinal) {
    return <ResultPanel run={viewerRun} />;
  }

  if (!match) return null;

  const title = match.mode === "snake" && match.currentSpin ? `${match.currentSpin.team} ${match.currentSpin.era}` : viewerRun?.currentSpin ? `${viewerRun.currentSpin.team} ${viewerRun.currentSpin.era}` : "Spin, Pick, Place";
  const subtitle = selected ? `Placing ${selected.player}` : candidates.length ? `${candidates.length} players in pool` : "Each spin reveals one team and one decade";

  return (
    <section className="panel">
      <div className="black-head">
        <p className="black-head-title">{title}</p>
        <p className="black-head-subtitle">{subtitle}</p>
      </div>
      {candidates.length ? (
        <>
          <div className="filters panel-pad">
            <div className="segmented">
              {(["All", ...POSITIONS] as const).map((slot) => (
                <button className={`btn ${position === slot ? "primary" : ""}`} type="button" key={slot} onClick={() => setPosition(slot)}>
                  {slot}
                </button>
              ))}
            </div>
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player" aria-label="Search players" />
            <select className="select" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort players">
              <option value="PPG">PPG</option>
              <option value="APG">APG</option>
              <option value="RPG">RPG</option>
              <option value="Gravity">Gravity</option>
            </select>
          </div>
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                active={selected?.id === candidate.id}
                disabled={busy || !canAct || !candidate.assignable}
                onSelect={() => setSelected(selected?.id === candidate.id ? null : candidate)}
              />
            ))}
          </div>
          {selected ? (
            <div className="notice">
              Choose {selected.openPositions.join(" / ")} on the court or mobile lineup strip to draft {selected.player}.
              {selected.openPositions.map((slot) => (
                <button className="btn primary" type="button" key={slot} disabled={busy || !canAct} onClick={() => onPick(slot)}>
                  {slot}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-state">
          <div>
            <h2>{run?.status === "lost" ? "Cap busted." : "No board yet."}</h2>
            <p>{run?.lostReason ?? "Spin to reveal one team and one decade. Pick a player from that pool, then place him into one open eligible position."}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function CandidateCard({ candidate, active, disabled, onSelect }: { candidate: Candidate; active: boolean; disabled: boolean; onSelect: () => void }) {
  return (
    <button className={`candidate-button ${active ? "active" : ""}`} type="button" disabled={disabled} onClick={onSelect} data-testid="player-card" data-player-id={candidate.id}>
      <div>
        <div className="candidate-top">
          <p className="candidate-name">{candidate.player}</p>
          <span className={`salary ${candidate.affordable ? "" : "bad"}`}>${candidate.cost}</span>
        </div>
        <p className="eyebrow">
          {candidate.positions.join(" / ")} · {candidate.team} · {candidate.era}
        </p>
        <p className="small-copy">
          {candidate.assignable ? `Open: ${candidate.openPositions.join(" / ")}` : candidate.affordable ? "No open eligible slot" : "Too expensive for the hard-cap reserve"}
        </p>
      </div>
      <Stats player={candidate} />
    </button>
  );
}

function Stats({ player }: { player: Candidate | LineupSlot }) {
  return (
    <div className="stats-row">
      <Stat label="PPG" value={player.perGame.ppg} />
      <Stat label="RPG" value={player.perGame.rpg} />
      <Stat label="APG" value={player.perGame.apg} />
      <Stat label="DEF" value={player.ratings.defense} />
      <Stat label="SG" value={player.ratings.shootingGravity} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{formatStat(value)}</strong>
      <span>{label}</span>
    </div>
  );
}

function ResultPanel({ run }: { run: PublicRun | null }) {
  const result = run?.finalResult;
  if (!run || !result) return null;
  return (
    <section className="panel result-card">
      <Crown size={30} />
      <p className="eyebrow">Projected record</p>
      <p className="record">
        {result.wins}-{result.losses}
      </p>
      <p className="grade">
        {result.grade} · {result.label} · {result.team_ovr.toFixed(1)} OVR
      </p>
      <p className="eyebrow">
        ${run.capSpent} / ${run.capSpent + run.budgetLeft} used · ${run.budgetLeft} left
      </p>
      {result.softPenaltyWins ? <p className="error">Soft cap overspend ${result.softOverspend}: -{result.softPenaltyWins} wins</p> : null}
      <div className="stack">
        {run.picks.map((slot) => (
          <div className="candidate-button" key={slot.position}>
            <div>
              <p className="candidate-name">{slot.player}</p>
              <p className="eyebrow">
                {slot.position} · {slot.team} · {slot.era} · ${slot.cost}
              </p>
            </div>
            <Stats player={slot} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Court({ lineup, selected, canAct, onPick }: { lineup: Partial<Record<Position, LineupSlot>>; selected: Candidate | null; canAct: boolean; onPick: (position: Position) => void }) {
  return (
    <section className="court">
      {POSITIONS.map((position) => {
        const slot = lineup[position];
        const available = Boolean(canAct && selected?.openPositions.includes(position) && !slot);
        return (
          <button className={`court-slot ${position} ${slot ? "filled" : ""} ${available ? "available" : ""}`} type="button" key={position} disabled={!available} onClick={() => onPick(position)} data-testid={`court-slot-${position}`}>
            <span className="court-ring" aria-hidden="true" />
            <span className="court-core" aria-hidden="true" />
            {slot ? (
              <span className="court-initials">
                {initials(slot.player)}
                <small>{position}</small>
              </span>
            ) : (
              <span className="court-label">{position}</span>
            )}
          </button>
        );
      })}
    </section>
  );
}

function MobileLineup({ lineup, selected, canAct, onPick }: { lineup: Partial<Record<Position, LineupSlot>>; selected: Candidate | null; canAct: boolean; onPick: (position: Position) => void }) {
  return (
    <section className="mobile-lineup" data-testid="mobile-lineup-strip">
      <div className="mobile-slots">
        {POSITIONS.map((position) => {
          const slot = lineup[position];
          const available = Boolean(canAct && selected?.openPositions.includes(position) && !slot);
          return (
            <button className={`mobile-slot ${slot ? "filled" : ""} ${available ? "available" : ""}`} type="button" key={position} disabled={!available} onClick={() => onPick(position)} data-testid={`mobile-slot-${position}`}>
              <strong>{slot ? initials(slot.player) : position}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Opponents({ state }: { state: PublicLobbyState }) {
  const match = state.activeMatch;
  if (!match) return null;
  return (
    <section className="panel panel-pad stack">
      <p className="section-title">Lobby Progress</p>
      {match.tiebreakerOf ? <div className="notice">Tiebreaker match: only tied players are drafting this round.</div> : null}
      {match.runs.map((run) => {
        const result = run.finalResult;
        const progress = Math.round((run.picks.length / 5) * 100);
        return (
          <div className="opponent-card" key={run.id}>
            <div className="opponent-top">
              <div>
                <p className="player-name">{playerName(state, run.playerId)}</p>
                <p className="eyebrow">
                  Round {run.round}/5 · ${run.budgetLeft} left · {run.status}
                </p>
              </div>
              {result ? (
                <strong className="grade">
                  {result.wins}-{result.losses}
                </strong>
              ) : (
                <span className="eyebrow">{run.currentSpin ? `${run.currentSpin.team} ${run.currentSpin.era}` : "No spin"}</span>
              )}
            </div>
            <div className="progress-bar" aria-hidden="true">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <MiniLineup run={run} />
          </div>
        );
      })}
    </section>
  );
}

function MiniLineup({ run }: { run: PublicRun }) {
  return (
    <div className="lineup-mini">
      {POSITIONS.map((position) => {
        const slot = run.lineup[position];
        return (
          <div className={`mini-slot ${slot ? "filled" : ""}`} key={position}>
            {slot ? initials(slot.player) : position}
          </div>
        );
      })}
    </div>
  );
}

function Standings({ state, onNext, isHost, busy }: { state: PublicLobbyState; onNext: () => void; isHost: boolean; busy: boolean }) {
  return (
    <section className="panel panel-pad stack">
      <p className="section-title">Standings</p>
      {state.standings.map((standing) => (
        <div className="standing-row" key={standing.playerId}>
          <strong>{playerName(state, standing.playerId)}</strong>
          <span className="eyebrow">
            {standing.wins}W · {standing.losses}L · {standing.ties}T
          </span>
        </div>
      ))}
      {state.status === "results" ? (
        <button className="btn primary" type="button" disabled={!isHost || busy} onClick={onNext}>
          <RotateCcw size={17} />
          Play Again
        </button>
      ) : null}
    </section>
  );
}

function Events({ state }: { state: PublicLobbyState }) {
  return (
    <section className="panel panel-pad stack">
      <p className="section-title">Event History</p>
      {state.events.slice(0, 8).map((event) => (
        <div className="event-row" key={event.id}>
          <p className="eyebrow">
            {new Date(event.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {event.type}
          </p>
        </div>
      ))}
    </section>
  );
}
