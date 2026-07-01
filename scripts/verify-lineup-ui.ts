import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { createLobby, joinLobby, getLobbyState, applyLobbyAction } from "../lib/multiplayer";
import { getPool, query } from "../lib/db";
import { loadGamePack } from "../lib/game-data";
import { salary, toLineupSlot } from "../lib/rules";
import { type Lineup } from "../lib/types";

loadEnvConfig(process.cwd());

const execFileAsync = promisify(execFile);
const session = `lineup-ui-${process.pid}`;

async function main() {
  const seed = await seedLobby();
  const port = await freePort();
  const server = startServer(port);

  try {
    await server.ready;
    const url = `http://127.0.0.1:${port}/lobby/${seed.code}`;
    await browser("open", url);
    await browser("set", "viewport", "1280", "900");
    await evalPage(`localStorage.setItem(${JSON.stringify(`better82:${seed.code}:token`)}, ${JSON.stringify(seed.token)}); location.reload();`);
    await waitForPage(filledScript(seed.fromPosition, seed.player));

    await assertFilled(seed.fromPosition, seed.player);
    await assertDisabled(seed.toPosition);
    await assertDisabled("C");

    await browser("hover", `[data-testid="court-slot-${seed.fromPosition}"]`);
    await evalPage(`
      const tooltip = document.querySelector('[data-testid="court-slot-${seed.fromPosition}"] .initials-tooltip');
      const style = getComputedStyle(tooltip, '::after');
      if (!style.content.includes(${JSON.stringify(seed.player)})) throw new Error('tooltip details missing player name');
      if (Number(style.opacity) < 0.9) throw new Error('tooltip did not become visible on hover');
    `);

    await browser("click", `[data-testid="court-slot-${seed.fromPosition}"]`);
    await waitForPage(enabledScript(seed.toPosition));
    await assertDisabled("C");

    await browser("click", `[data-testid="court-slot-${seed.toPosition}"]`);
    await waitForPage(filledScript(seed.toPosition, seed.player));
    await assertDisabled(seed.fromPosition);

    await evalPage(`
      window.__lineupMoveDataTransfer = new DataTransfer();
      document.querySelector('[data-testid="court-slot-${seed.toPosition}"]').dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__lineupMoveDataTransfer }),
      );
    `);
    await browser("wait", "300");
    await evalPage(`
      const target = document.querySelector('[data-testid="court-slot-${seed.fromPosition}"]');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__lineupMoveDataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__lineupMoveDataTransfer }));
    `);
    await waitForPage(filledScript(seed.fromPosition, seed.player));

    await query(`UPDATE runs SET lineup = $2::jsonb, cap_spent = $3, current_spin = null, updated_at = now() WHERE id = $1`, [
      seed.runId,
      JSON.stringify(seed.swap.lineup),
      seed.swap.capSpent,
    ]);
    await waitForPage(filledScript(seed.swap.fromPosition, seed.swap.source.player));
    await assertFilled(seed.swap.position, seed.swap.target.player);
    await evalPage(`
      window.__lineupSwapDataTransfer = new DataTransfer();
      document.querySelector('[data-testid="court-slot-${seed.swap.fromPosition}"]').dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__lineupSwapDataTransfer }),
      );
    `);
    await browser("wait", "300");
    await evalPage(`
      const target = document.querySelector('[data-testid="court-slot-${seed.swap.position}"]');
      if (!target.classList.contains('available')) throw new Error('occupied swap target was not marked available');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__lineupSwapDataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__lineupSwapDataTransfer }));
    `);
    await waitForPage(filledScript(seed.swap.position, seed.swap.source.player));
    await assertFilled(seed.swap.fromPosition, seed.swap.target.player);

    await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [seed.runId, JSON.stringify(seed.searchSpin)]);
    await waitForPage(`
      if (!document.querySelector('[aria-label="Search players"]')) throw new Error('search input missing before query');
    `);
    await evalPage(`
      const input = document.querySelector('[aria-label="Search players"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!input || !setter) throw new Error('search input setter missing');
      setter.call(input, 'zzzz-no-player');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitForPage(`
      const input = document.querySelector('[aria-label="Search players"]');
      if (!input) throw new Error('search input disappeared after no-result query');
      if (input.value !== 'zzzz-no-player') throw new Error('search query did not stick');
      if (!document.body.textContent.includes('No matches.')) throw new Error('no-result search state missing');
    `);

    console.log("Lineup UI verification passed.");
  } finally {
    await browser("close").catch(() => undefined);
    server.stop();
    await getPool().end().catch(() => undefined);
  }
}

async function seedLobby() {
  const pick = loadGamePack().players
    .filter((player) => player.positions.length >= 2 && player.positions.includes("C") === false)
    .map((player) => ({ player, cost: salary(player) }))
    .sort((a, b) => a.cost - b.cost || a.player.player.localeCompare(b.player.player))[0].player;
  const [fromPosition, toPosition] = pick.positions;
  assert.ok(fromPosition && toPosition, "multi-position player has two positions");

  const host = await createLobby({ name: "UI A", mode: "parallel", capType: "hard", rerollsEnabled: true });
  await joinLobby(host.code, { name: "UI B" });
  let state = await getLobbyState(host.code, host.token);
  state = await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "start" });

  const run = state.activeMatch?.runs.find((candidate) => candidate.playerId === state.viewerPlayerId);
  assert.ok(run, "viewer run exists");
  await query(`UPDATE runs SET current_spin = $2::jsonb, updated_at = now() WHERE id = $1`, [run.id, JSON.stringify({ team: pick.team, era: pick.era })]);
  state = await getLobbyState(host.code, host.token);
  await applyLobbyAction(host.code, { token: host.token, expectedVersion: state.stateVersion, action: "pick", playerSeasonId: pick.id, position: fromPosition });

  const swap = swappablePair(new Set([pick.id]));
  const searchPlayer = loadGamePack().players.find((player) => player.id !== pick.id && player.positions.some((slot) => slot !== fromPosition));
  assert.ok(searchPlayer, "searchable player exists");

  return {
    code: host.code,
    token: host.token,
    runId: run.id,
    player: pick.player,
    fromPosition,
    toPosition,
    swap,
    searchSpin: { team: searchPlayer.team, era: searchPlayer.era },
  };
}

function swappablePair(excludedIds: Set<string>) {
  const pack = loadGamePack();
  const options = pack.players.flatMap((source) =>
    pack.players.flatMap((target) => {
      if (source.id === target.id || excludedIds.has(source.id) || excludedIds.has(target.id)) return [];
      return source.positions.flatMap((fromPosition) =>
        target.positions
          .filter((position) => position !== fromPosition && source.positions.includes(position) && target.positions.includes(fromPosition))
          .map((position) => ({ source, target, fromPosition, position, cost: salary(source) + salary(target) })),
      );
    }),
  );
  const pair = options.sort((a, b) => a.cost - b.cost || a.source.player.localeCompare(b.source.player) || a.target.player.localeCompare(b.target.player))[0];
  assert.ok(pair, "swappable player pair exists");
  const lineup: Lineup = {
    [pair.fromPosition]: toLineupSlot(pair.fromPosition, pair.source),
    [pair.position]: toLineupSlot(pair.position, pair.target),
  };
  return {
    ...pair,
    lineup,
    capSpent: salary(pair.source) + salary(pair.target),
  };
}

async function assertFilled(position: string, player: string) {
  await evalPage(filledScript(position, player));
}

function filledScript(position: string, player: string) {
  return `
    const slot = document.querySelector('[data-testid="court-slot-${position}"]');
    if (!slot) throw new Error('missing ${position} slot');
    if (!slot.getAttribute('aria-label')?.includes(${JSON.stringify(player)})) throw new Error('${position} is not filled by ${player}');
  `;
}

function enabledScript(position: string) {
  return `
    const slot = document.querySelector('[data-testid="court-slot-${position}"]');
    if (!slot) throw new Error('missing ${position} slot');
    if (slot.disabled) throw new Error('${position} should be enabled');
  `;
}

async function assertDisabled(position: string) {
  await evalPage(`
    const slot = document.querySelector('[data-testid="court-slot-${position}"]');
    if (!slot) throw new Error('missing ${position} slot');
    if (!slot.disabled) throw new Error('${position} should be disabled');
  `);
}

async function evalPage(script: string) {
  await browser("eval", `(() => { ${script} })()`);
}

async function waitForPage(script: string, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await evalPage(script);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for page condition.");
}

async function waitForServer(port: number, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for dev server.");
}

async function browser(...args: string[]) {
  return execFileAsync("agent-browser", ["--session", session, ...args], { maxBuffer: 1024 * 1024 });
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object", "free port address is available");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function startServer(port: number) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = execFile(command, ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Next dev server did not become ready in time")), 30_000);
    let settling = false;
    let settled = false;
    let output = "";
    const appendOutput = (text: string) => {
      output = `${output}${text}`.slice(-4000);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      appendOutput(text);
      if (text.includes("Ready") && !settling) {
        settling = true;
        waitForServer(port)
          .then(() => {
            settled = true;
            clearTimeout(timeout);
            resolve();
          })
          .catch((error) => fail(error));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      fail(new Error(`Next dev server exited early with code ${code}\n${output}`));
    });
  });

  return {
    ready,
    stop() {
      child.kill("SIGINT");
    },
  };
}

main().catch(async (error) => {
  console.error(error);
  await browser("close").catch(() => undefined);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
