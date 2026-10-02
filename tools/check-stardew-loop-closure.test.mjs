#!/usr/bin/env node
/**
 * Tests for the loop-closure feasibility gate.
 *
 * The gate answers one question per candidate primitive: CAN this action close a
 * loop? It derives candidates from the three adjudication tables and checks the
 * anchor in the target-version decompile. The properties that must hold:
 *
 *   1. every new-primitive row has a resolvable `File.cs:line` anchor
 *   2. a private entry blocks (the Agent cannot call it)
 *   3. realtime-input-only with no terminal blocks (an Agent has no 60FPS hands)
 *   4. a menu-only terminal blocks (the Agent cannot dismiss the menu)
 *   5. a public entry whose own body has no terminal falls through to the chain
 *
 * Each rule has a mutation in the sibling `.mutation.mjs`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GATE = path.join(ROOT, "tools", "check-stardew-loop-closure.mjs");
const execFileAsync = promisify(execFile);

async function run(extraArgs = [], env = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [GATE, ...extraArgs], {
      encoding: "utf8",
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("the gate passes on the shipped tables", async () => {
  const r = await run();
  assert.equal(r.code, 0, `gate must pass; stderr: ${r.stderr}`);
  assert.match(r.stdout, /^\s*closable\s+cut_grass\b/m, "cut_grass is a closable candidate");
  assert.match(r.stdout, /^\s*closable\s+enter_mine\b/m, "enter_mine is a closable candidate");
});

test("every candidate primitive is resolved against the real decompile", async () => {
  const r = await run();
  const lines = r.stdout.split("\n").filter((l) => /^\s+(closable|blocked|verify_chain)\s/.test(l));
  assert.ok(lines.length >= 15, `expected the full candidate set; got ${lines.length}`);
  // No candidate may be blocked in the shipped state.
  const blocked = lines.filter((l) => /^\s+blocked\s/.test(l));
  assert.equal(blocked.length, 0, `unexpected blocked candidates:\n${blocked.join("\n")}`);
});

test("the gate reports a count line", async () => {
  const r = await run();
  const m = r.stdout.match(/loop-closure gate: (\d+) candidates, (\d+) closable, (\d+) verify-chain, (\d+) blocked/);
  assert.ok(m, `count line present; stdout: ${r.stdout.slice(-200)}`);
  assert.equal(Number(m[4]), 0, "zero blocked");
  assert.ok(Number(m[1]) >= 15, "candidate set is the full one");
});

test("a realtime-input-only entry with no terminal blocks the candidate", async () => {
  // `Game1.pressActionButton` is the raw key/mouse dispatcher: it reads
  // `KeyboardState`/`MouseState` and writes no world terminal of its own. An Agent
  // has no 60FPS input device, so this shape must block rather than look closable.
  const f = path.join(HERE, ".tmp-realtime.json");
  await writeFile(f, JSON.stringify([{ actionId: "probe", anchor: "Game1.cs:11146" }]), "utf8");
  try {
    const r = await run(["--candidates", f]);
    assert.equal(r.code, 1, `realtime-only must block; stdout: ${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /realtime input/);
  } finally {
    await rm(f, { force: true });
  }
});

test("a private entry blocks the candidate", async () => {
  // `GameLocation.getGalaxySword` is a real `private void` that writes world state
  // (`Game1.player.Items.Add`). A private entry is NOT callable by the Mod, so the
  // candidate must be blocked -- this is the rule that keeps a plan item honest.
  const f = path.join(HERE, ".tmp-private.json");
  await writeFile(f, JSON.stringify([{ actionId: "probe", anchor: "GameLocation.cs:3548" }]), "utf8");
  try {
    const r = await run(["--candidates", f]);
    assert.equal(r.code, 1, `a private entry must block; stdout: ${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /entry is private/);
  } finally {
    await rm(f, { force: true });
  }
});

test("a menu-only terminal blocks the candidate", async () => {
  // `case "Billboard"` mounts a Billboard menu and writes nothing else. The Agent
  // cannot dismiss an arbitrary menu, so a menu-only terminal is not a closed loop.
  const f = path.join(HERE, ".tmp-menu.json");
  await writeFile(f, JSON.stringify([{ actionId: "probe", anchor: "GameLocation.cs:9787" }]), "utf8");
  try {
    const r = await run(["--candidates", f]);
    assert.equal(r.code, 1, `a menu-only terminal must block; stdout: ${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /only mounts a menu/);
  } finally {
    await rm(f, { force: true });
  }
});

test("a public entry with no terminal of its own falls through to the chain", async () => {
  // `FruitTree.performUseAction` only delegates to `shake`; the terminal (fruit[]
  // nulled + Debris) is one hop down. The gate must keep going rather than
  // declaring the entry effect-free.
  const f = path.join(HERE, ".tmp-chain.json");
  await writeFile(f, JSON.stringify([{ actionId: "probe", anchor: "FruitTree.cs:222 -> FruitTree.cs:361 shake" }]), "utf8");
  try {
    const r = await run(["--candidates", f]);
    assert.equal(r.code, 0, `the chain hop carries the terminal; stdout: ${r.stdout}`);
    assert.match(r.stdout, /FruitTree\.cs:361/);
  } finally {
    await rm(f, { force: true });
  }
});

test("an anchor with no File.cs:line hop is reported, not skipped", async () => {
  const f = path.join(HERE, ".tmp-badanchor.json");
  await writeFile(f, JSON.stringify([{ actionId: "ghost", anchor: "just some prose" }]), "utf8");
  try {
    const r = await run(["--candidates", f]);
    assert.equal(r.code, 1, "a malformed anchor must fail the gate");
    assert.match(`${r.stdout}${r.stderr}`, /anchor_unparseable|anchor has no/);
  } finally {
    await rm(f, { force: true });
  }
});