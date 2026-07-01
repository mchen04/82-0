import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { initials } from "@/lib/rules";
import { playerStatDetails } from "@/lib/player-details";
import {
  POSITIONS,
  type Candidate,
  type LineupSlot,
  type Position,
  type PublicLobbyState,
  type PublicRun,
} from "@/lib/types";

type LineupPickerProps = {
  lineup: Partial<Record<Position, LineupSlot>>;
  selected: Candidate | null;
  movingPosition: Position | null;
  canPick: boolean;
  canMove: boolean;
  onPick: (position: Position) => void;
  onStartMove: (position: Position) => void;
  onMove: (fromPosition: Position, position: Position) => void;
};

function playerName(state: PublicLobbyState, id: string | null | undefined) {
  if (!id) return "Unknown";
  return state.players.find((player) => player.id === id)?.name ?? "Unknown";
}

function progressSpin(state: PublicLobbyState, run: PublicRun) {
  const match = state.activeMatch;
  if (!match) return run.currentSpin;
  if (match.mode === "snake") return match.currentTurnPlayerId === run.playerId ? match.currentSpin : null;
  return run.currentSpin;
}

function rerollStatus(used: boolean, enabled: boolean) {
  if (used) return "Used";
  return enabled ? "Available" : "Off";
}

function slotDetails(slot: LineupSlot) {
  return playerStatDetails(slot);
}

function canMoveTo(lineup: Partial<Record<Position, LineupSlot>>, fromPosition: Position, position: Position) {
  if (fromPosition === position) return false;
  const slot = lineup[fromPosition];
  if (!slot?.positions.includes(position)) return false;
  const targetSlot = lineup[position];
  return !targetSlot || targetSlot.positions.includes(fromPosition);
}

function canMoveFrom(lineup: Partial<Record<Position, LineupSlot>>, position: Position) {
  return POSITIONS.some((target) => canMoveTo(lineup, position, target));
}

export function Court({ lineup, selected, movingPosition, canPick, canMove, onPick, onStartMove, onMove }: LineupPickerProps) {
  return (
    <section className="court">
      {POSITIONS.map((position) => {
        const slot = lineup[position];
        const pickTarget = Boolean(canPick && selected?.openPositions.includes(position) && !slot);
        const moveTarget = Boolean(canMove && movingPosition && canMoveTo(lineup, movingPosition, position));
        const moveSource = Boolean(canMove && slot && canMoveFrom(lineup, position));
        const available = pickTarget || moveTarget;
        const details = slot ? slotDetails(slot) : undefined;
        return (
          <button
            className={`court-slot ${position} ${slot ? "filled" : ""} ${available ? "available" : ""} ${moveSource ? "move-source" : ""} ${movingPosition === position ? "moving" : ""}`}
            type="button"
            key={position}
            disabled={!available && !slot}
            aria-disabled={!available && !moveSource}
            aria-label={details ?? `${position} slot`}
            title={details}
            draggable={moveSource}
            onClick={moveTarget && movingPosition ? () => onMove(movingPosition, position) : pickTarget ? () => onPick(position) : moveSource ? () => onStartMove(position) : undefined}
            onDragStart={
              moveSource
                ? (event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", position);
                    if (movingPosition !== position) onStartMove(position);
                  }
                : undefined
            }
            onDragOver={
              moveTarget
                ? (event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                : undefined
            }
            onDrop={
              moveTarget
                ? (event) => {
                    event.preventDefault();
                    const fromPosition = event.dataTransfer.getData("text/plain");
                    if (POSITIONS.includes(fromPosition as Position)) onMove(fromPosition as Position, position);
                    else if (movingPosition) onMove(movingPosition, position);
                  }
                : undefined
            }
            data-tooltip={details}
            data-testid={`court-slot-${position}`}
          >
            <span className="court-ring" aria-hidden="true" />
            <span className="court-core" aria-hidden="true" />
            {slot ? (
              <PlayerInitials slot={slot} className="court-initials">
                {initials(slot.player)}
                <small>{position}</small>
              </PlayerInitials>
            ) : (
              <span className="court-label">{position}</span>
            )}
          </button>
        );
      })}
    </section>
  );
}

function PlayerInitials({ slot, className, children }: { slot: LineupSlot; className: string; children: ReactNode }) {
  const details = slotDetails(slot);
  return (
    <span className={`${className} initials-tooltip`} aria-label={details} data-tooltip={details}>
      {children}
    </span>
  );
}

export function MobileLineup({ lineup, selected, movingPosition, canPick, canMove, onPick, onStartMove, onMove }: LineupPickerProps) {
  return (
    <section className="mobile-lineup" data-testid="mobile-lineup-strip">
      <div className="mobile-slots">
        {POSITIONS.map((position) => {
          const slot = lineup[position];
          const pickTarget = Boolean(canPick && selected?.openPositions.includes(position) && !slot);
          const moveTarget = Boolean(canMove && movingPosition && canMoveTo(lineup, movingPosition, position));
          const moveSource = Boolean(canMove && slot && canMoveFrom(lineup, position));
          const available = pickTarget || moveTarget;
          const details = slot ? slotDetails(slot) : undefined;
          return (
            <button
              className={`mobile-slot ${slot ? "filled" : ""} ${available ? "available" : ""} ${moveSource ? "move-source" : ""} ${movingPosition === position ? "moving" : ""}`}
              type="button"
              key={position}
              disabled={!available && !slot}
              aria-disabled={!available && !moveSource}
              aria-label={details ?? `${position} slot`}
              title={details}
              onClick={moveTarget && movingPosition ? () => onMove(movingPosition, position) : pickTarget ? () => onPick(position) : moveSource ? () => onStartMove(position) : undefined}
              data-testid={`mobile-slot-${position}`}
            >
              {slot ? (
                <PlayerInitials slot={slot} className="mobile-initials">
                  <strong>{initials(slot.player)}</strong>
                </PlayerInitials>
              ) : (
                <strong>{position}</strong>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function Opponents({ state }: { state: PublicLobbyState }) {
  const match = state.activeMatch;
  if (!match) return null;
  return (
    <section className="panel panel-pad stack">
      <p className="section-title">Lobby Progress</p>
      {match.tiebreakerOf ? <div className="notice">Tiebreaker match: only tied players are drafting this round.</div> : null}
      {match.runs.map((run) => {
        const result = run.finalResult;
        const progress = Math.round((run.picks.length / 5) * 100);
        const spin = progressSpin(state, run);
        const rerollsEnabled = state.rerollsEnabled;
        const spinLabel = spin ? `${spin.team} ${spin.era}` : result ? "Complete" : "No spin";
        return (
          <div
            className={`opponent-card ${match.mode === "snake" && match.currentTurnPlayerId === run.playerId ? "current-turn" : ""}`}
            key={run.id}
            aria-current={match.mode === "snake" && match.currentTurnPlayerId === run.playerId ? "true" : undefined}
            data-testid={`progress-card-${run.playerId}`}
          >
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
                <span className="eyebrow progress-spin-label">{spinLabel}</span>
              )}
            </div>
            <div className="progress-details">
              <ProgressDetail label="Team reroll" value={rerollStatus(run.teamRerollUsed, rerollsEnabled)} used={run.teamRerollUsed} testId={`progress-team-reroll-${run.playerId}`} />
              <ProgressDetail label="Decade reroll" value={rerollStatus(run.decadeRerollUsed, rerollsEnabled)} used={run.decadeRerollUsed} testId={`progress-decade-reroll-${run.playerId}`} />
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

function ProgressDetail({ label, value, used = false, testId }: { label: string; value: string; used?: boolean; testId: string }) {
  return (
    <div className={`progress-detail ${used ? "used" : ""}`} data-testid={testId}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MiniLineup({ run }: { run: PublicRun }) {
  return (
    <div className="lineup-mini">
      {POSITIONS.map((position) => {
        const slot = run.lineup[position];
        return (
          slot ? (
            <PlayerInitials slot={slot} className="mini-slot filled" key={position}>
              {initials(slot.player)}
            </PlayerInitials>
          ) : (
            <div className="mini-slot" key={position}>
              {position}
            </div>
          )
        );
      })}
    </div>
  );
}

export function Standings({ state, onNext, isHost, busy }: { state: PublicLobbyState; onNext: () => void; isHost: boolean; busy: boolean }) {
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
