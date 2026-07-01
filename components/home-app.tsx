"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, LogIn, Plus, Shuffle, Trophy } from "lucide-react";
import { HARD_CAP_AMOUNT, SOFT_CAP_AMOUNT } from "@/lib/rules";
import type { CapType, LobbyMode } from "@/lib/types";

function tokenKey(code: string) {
  return `better82:${code.toUpperCase()}:token`;
}

export function HomeApp() {
  const router = useRouter();
  const [name, setName] = useState("Player 1");
  const [joinName, setJoinName] = useState("Friend");
  const [joinCode, setJoinCode] = useState("");
  const [mode, setMode] = useState<LobbyMode>("parallel");
  const [capType, setCapType] = useState<CapType>("hard");
  const [rerollsEnabled, setRerollsEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/lobbies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mode, capType, rerollsEnabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Could not create lobby.");
      localStorage.setItem(tokenKey(data.code), data.token);
      router.push(`/lobby/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create lobby.");
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/lobbies/${code}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: joinName }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "Could not join lobby.");
      localStorage.setItem(tokenKey(data.code), data.token);
      router.push(`/lobby/${data.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join lobby.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <Header subtitle="Friends-only multiplayer Cap Mode" />
      <section className="page-grid">
        <div className="panel chalk panel-pad">
          <p className="section-title">Create or join a lobby</p>
          <p className="small-copy">
            Hard Cap starts at ${HARD_CAP_AMOUNT}; Soft Cap uses ${SOFT_CAP_AMOUNT} with deterministic overspend penalties.
          </p>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="mode-grid">
          <button className={`mode-card ${mode === "parallel" ? "active" : ""}`} type="button" onClick={() => setMode("parallel")}>
            <Trophy size={22} />
            <p className="mode-title">Parallel Cap Race</p>
            <p className="mode-copy">Everyone builds an independent Cap Mode lineup. Best projected record wins, ties trigger tiebreakers.</p>
          </button>
          <button className={`mode-card ${mode === "snake" ? "active" : ""}`} type="button" onClick={() => setMode("snake")}>
            <Shuffle size={22} />
            <p className="mode-title">Shared Snake Draft</p>
            <p className="mode-copy">One shared draft board, snake order, one current drafter, and live lineups for everyone.</p>
          </button>
        </div>

        <section className="panel panel-pad stack">
          <div className="setup-row">
            <label className="field">
              <span>Your name</span>
              <input className="input" value={name} maxLength={32} onChange={(event) => setName(event.target.value)} />
            </label>
            <button className="btn primary" type="button" disabled={busy} onClick={create}>
              <Plus size={17} />
              Create Lobby
            </button>
          </div>

          <div className="segmented">
            <button className={`btn ${capType === "hard" ? "green" : ""}`} type="button" onClick={() => setCapType("hard")}>
              Hard ${HARD_CAP_AMOUNT}
            </button>
            <button className={`btn ${capType === "soft" ? "blue" : ""}`} type="button" onClick={() => setCapType("soft")}>
              Soft ${SOFT_CAP_AMOUNT}
            </button>
          </div>

          <label className="field">
            <span>Draft rerolls</span>
            <select className="select" value={rerollsEnabled ? "on" : "off"} onChange={(event) => setRerollsEnabled(event.target.value === "on")}>
              <option value="on">Enabled before start</option>
              <option value="off">Disabled before start</option>
            </select>
          </label>
        </section>

        <section className="panel panel-pad stack">
          <div className="setup-row">
            <label className="field">
              <span>Lobby code</span>
              <input className="input" value={joinCode} maxLength={8} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="ABCDE" />
            </label>
            <label className="field">
              <span>Your name</span>
              <input className="input" value={joinName} maxLength={32} onChange={(event) => setJoinName(event.target.value)} />
            </label>
            <button className="btn" type="button" disabled={busy || !joinCode.trim()} onClick={join}>
              <LogIn size={17} />
              Join
            </button>
          </div>
        </section>

        <a className="btn" href="/cap">
          <Copy size={17} />
          Open single-player /cap
        </a>
      </section>
    </main>
  );
}

export function Header({ subtitle, right }: { subtitle: string; right?: React.ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="/">
          <img src="/brand/better-82-logo.webp" className="brand-logo" alt="" aria-hidden="true" />
          <div>
            <p className="brand-title">Better 82-0</p>
            <p className="brand-subtitle">{subtitle}</p>
          </div>
        </a>
        {right ? <div className="top-actions">{right}</div> : null}
      </div>
    </header>
  );
}
