"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Crown, Play, Shuffle, Swords, Trophy } from "lucide-react";
import { Header } from "./home-app";
import { playerStatDetails } from "@/lib/player-details";
import { formatStat, HARD_CAP_AMOUNT, SOFT_CAP_AMOUNT } from "@/lib/rules";
import { Court, MobileLineup, Opponents, Standings } from "./lobby-lineup";
import {
  POSITIONS,
  type Candidate,
  type CapType,
  type LineupSlot,
  type LobbyMode,
  type Position,
  type PublicLobbyState,
  type PublicRun,
  type SortKey,
} from "@/lib/types";

type ActionName = "settings" | "start" | "spin" | "reroll-team" | "reroll-decade" | "pick" | "move-pick" | "next-match";

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
  const [movingPosition, setMovingPosition] = useState<Position | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const stateVersionRef = useRef<number | null>(null);
  const stateTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(tokenKey(code));
    if (saved) setToken(saved);
  }, [code]);

  const fetchLobbyState = useCallback(async (sinceVersion?: number | null) => {
    const params = new URLSearchParams();
    if (token) params.set("token", token);
    if (typeof sinceVersion === "number") params.set("since", String(sinceVersion));
    const query = params.toString();
    const url = query ? `/api/lobbies/${code}?${query}` : `/api/lobbies/${code}`;
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 204) return null;
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? "Could not load lobby.");
    return data as PublicLobbyState;
  }, [code, token]);

  const rememberState = useCallback((nextState: PublicLobbyState) => {
    stateVersionRef.current = nextState.stateVersion;
    stateTokenRef.current = token ?? null;
    setState(nextState);
  }, [token]);

  const load = useCallback(async () => {
    const nextState = await fetchLobbyState();
    if (nextState) rememberState(nextState);
  }, [fetchLobbyState, rememberState]);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    async function tick() {
      if (inFlight) return;
      inFlight = true;
      try {
        const sinceVersion = stateTokenRef.current === (token ?? null) ? stateVersionRef.current : null;
        const nextState = await fetchLobbyState(sinceVersion);
        if (!stopped) {
          if (nextState) rememberState(nextState);
          setError("");
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Could not load lobby.");
      } finally {
        inFlight = false;
      }
    }
    tick();
    const interval = window.setInterval(tick, 850);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [fetchLobbyState, rememberState, token]);

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
  const showDraftLayout = Boolean(token && activeMatch && state?.status !== "lobby");
  const canPickLineup = canAct && !busy && viewerRun?.status === "active";
  const canMoveLineup = !busy && viewerRun?.status === "active";
  const capStatusPanel = <CapStatus state={state} run={visibleRun} />;
  const spinPanel = (
    <SpinPanel
      state={state}
      run={currentRun}
      viewerRun={viewerRun}
      spin={activeSpin}
      canAct={canAct}
      busy={busy}
      onAction={action}
    />
  );
  const boardPanel = (
    <BoardPanel
      state={state}
      run={currentRun}
      viewerRun={viewerRun}
      selected={selected}
      setSelected={(candidate) => {
        setSelected(candidate);
        if (candidate) setMovingPosition(null);
      }}
      canAct={canAct}
      busy={busy}
      onPick={(position) => selected && action("pick", { playerSeasonId: selected.id, position })}
    />
  );

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
      rememberState(data);
      setSelected(null);
      setMovingPosition(null);
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
              <p className="budget-number">${visibleRun?.budgetLeft ?? state?.capAmount ?? HARD_CAP_AMOUNT}</p>
            </div>
            <button className="btn icon" type="button" onClick={copyInvite} title="Copy invite link" aria-label="Copy invite link">
              {copied ? <Check size={18} /> : <Copy size={18} />}
            </button>
          </>
        }
      />

      <section className={`game-grid ${showDraftLayout ? "game-grid-draft" : ""}`}>
        {showDraftLayout ? (
          <>
            <div className="stack draft-controls">
              {error ? <div className="error">{error}</div> : null}
              {capStatusPanel}
              {spinPanel}
              {state ? <Opponents state={state} /> : null}
            </div>
            <div className="draft-board">{boardPanel}</div>
          </>
        ) : (
          <div className="stack">
            {error ? <div className="error">{error}</div> : null}
            {!token ? (
              <JoinPanel code={code} name={name} setName={setName} busy={busy} onJoin={join} />
            ) : state?.status === "lobby" ? (
              <LobbySetup state={state} busy={busy} isHost={isHost} onAction={action} />
            ) : (
              <>
                {capStatusPanel}
                {spinPanel}
                {boardPanel}
              </>
            )}
          </div>
        )}

        <aside className="side">
          {state ? (
            <>
              <Court
                lineup={viewerRun?.lineup ?? {}}
                selected={selected}
                movingPosition={movingPosition}
                canPick={canPickLineup}
                canMove={canMoveLineup}
                onPick={(position) => selected && action("pick", { playerSeasonId: selected.id, position })}
                onStartMove={(position) => {
                  setSelected(null);
                  setMovingPosition((current) => current === position ? null : position);
                }}
                onMove={(fromPosition, position) => action("move-pick", { fromPosition, position })}
              />
              {!showDraftLayout ? <Opponents state={state} /> : null}
              <Standings state={state} onNext={() => action("next-match")} isHost={isHost} busy={busy} />
            </>
          ) : null}
        </aside>
      </section>

      {state?.activeMatch ? (
        <MobileLineup
          lineup={viewerRun?.lineup ?? {}}
          selected={selected}
          movingPosition={movingPosition}
          canPick={canPickLineup}
          canMove={canMoveLineup}
          onPick={(position) => selected && action("pick", { playerSeasonId: selected.id, position })}
          onStartMove={(position) => {
            setSelected(null);
            setMovingPosition((current) => current === position ? null : position);
          }}
          onMove={(fromPosition, position) => action("move-pick", { fromPosition, position })}
        />
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
          Hard ${HARD_CAP_AMOUNT}
        </button>
        <button className={`btn ${state.capType === "soft" ? "blue" : ""}`} type="button" disabled={!isHost || busy} onClick={() => onAction("settings", { capType: "soft" })}>
          Soft ${SOFT_CAP_AMOUNT}
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
            ${run?.budgetLeft ?? state?.capAmount ?? HARD_CAP_AMOUNT} left · ${run?.capSpent ?? 0} spent · ${state?.capAmount ?? HARD_CAP_AMOUNT} {state?.capType ?? "hard"} cap
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
  const [sort, setSort] = useState<SortKey>("PPG");
  const match = state?.activeMatch;
  const ownFinal = viewerRun?.finalResult;
  const poolCount = match?.candidates.length ?? 0;
  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (match?.candidates ?? []).filter((candidate) => {
      const matchesQuery = !needle || candidate.player.toLowerCase().includes(needle) || candidate.positions.join(" ").toLowerCase().includes(needle);
      const matchesPosition = position === "All" || candidate.positions.includes(position);
      return matchesQuery && matchesPosition;
    });
    const value = (candidate: Candidate) => {
      if (sort === "APG") return candidate.perGame.apg;
      if (sort === "RPG") return candidate.perGame.rpg;
      if (sort === "Defense") return candidate.ratings.defense;
      if (sort === "Gravity") return candidate.ratings.shootingGravity;
      return candidate.perGame.ppg;
    };
    return [...filtered].sort((a, b) => value(b) - value(a) || a.player.localeCompare(b.player));
  }, [match?.candidates, position, query, sort]);

  if (ownFinal) {
    return <ResultPanel run={viewerRun} />;
  }

  if (!match) return null;

  const title = match.mode === "snake" && match.currentSpin ? `${match.currentSpin.team} ${match.currentSpin.era}` : viewerRun?.currentSpin ? `${viewerRun.currentSpin.team} ${viewerRun.currentSpin.era}` : "Spin, Pick, Place";
  const subtitle = selected ? `Placing ${selected.player}` : poolCount ? `${candidates.length} of ${poolCount} players in pool` : "Each spin reveals one team and one decade";

  return (
    <section className="panel">
      <div className="black-head">
        <p className="black-head-title">{title}</p>
        <p className="black-head-subtitle">{subtitle}</p>
      </div>
      {poolCount ? (
        <>
          <div className="filters panel-pad">
            <div className="position-filter-row" aria-label="Position filters">
              {(["All", ...POSITIONS] as const).map((slot) => (
                <button className={`btn ${position === slot ? "primary" : ""}`} type="button" key={slot} onClick={() => setPosition(slot)}>
                  {slot}
                </button>
              ))}
            </div>
            <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player" aria-label="Search players" />
            <label className="sort-filter">
              <span>Sort by category</span>
              <select className="select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort players">
                <option value="PPG">PPG</option>
                <option value="APG">APG</option>
                <option value="RPG">RPG</option>
                <option value="Defense">Defense</option>
                <option value="Gravity">Gravity</option>
              </select>
            </label>
          </div>
          {candidates.length ? (
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
          ) : (
            <div className="empty-state compact">
              <div>
                <h2>No matches.</h2>
                <p>Try another player name or position.</p>
              </div>
            </div>
          )}
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
  const details = playerStatDetails(candidate);
  return (
    <button className={`candidate-button ${active ? "active" : ""}`} type="button" disabled={disabled} onClick={onSelect} data-testid="player-card" data-player-id={candidate.id} data-tooltip={details} title={details}>
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
