import { loadEnvConfig } from "@next/env";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { promisify } from "node:util";
import { createLobby, joinLobby, getLobbyState, applyLobbyAction } from "../lib/multiplayer";
import { getPool, query } from "../lib/db";
import { loadGamePack } from "../lib/game-data";
import { salary } from "../lib/rules";

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

  return {
    code: host.code,
    token: host.token,
    player: pick.player,
    fromPosition,
    toPosition,
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
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("Ready")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Next dev server exited early with code ${code}`));
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
