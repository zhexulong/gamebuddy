import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";
import { GAME_SESSION_PRESET_FILE, gameSessionPreset } from "./preset-game-session.js";
import {
  COMPANION_PRESET_LINE_PREFIX,
  companionPresetPublication,
  formatCompanionPresetLine,
} from "./preset-session-publication.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { createCompanionRuntime } from "../runtime.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";

/**
 * "DID THE LIVE RUN LOAD THE PRESET?" - ASKED OF THE ARTIFACT, NOT OF THE CODE.
 *
 * The whole point of this publication is that the question becomes readable from a run's own record, so the tests are
 * about the answers it can give and the fact that they cannot be confused with one another: `generation: null` (no
 * preset file), `sampling: "not_applied"` (the preset's sampler is not in force) and `not_measured` with the field
 * named (nothing was measured). An empty sampler bag would spell the second answer the same way as "nothing to say",
 * so it is not a spelling this publication has.
 *
 * The last two tests mount a real Game runtime and read the line off stderr, because a formatter nobody calls is a
 * passing test that answers nothing.
 */

before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/** Resolved from this module, so a source run and the compiled suite read the same bytes. */
const SHIPPED_PRESET_PATH = fileURLToPath(
  new URL("../../../assets/tavern/presets/amber-deepseek-v4.1.json", import.meta.url),
);
const IDENTITY = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });
const NO_SUCH_RUNTIME_CWD = join(SHIPPED_PRESET_PATH, "..", "no-such-runtime-cwd");

test("the publication keeps `null`, `not_applied` and `not_measured` three different words", () => {
  const preset = gameSessionPreset(JSON.parse(readFileSync(SHIPPED_PRESET_PATH, "utf8")) as Record<string, unknown>, {
    source: SHIPPED_PRESET_PATH,
    profile: DEFAULT_COMPANION_PRESET.profile,
  });
  const inForce = companionPresetPublication({
    preset,
    runtimeCwd: NO_SUCH_RUNTIME_CWD,
    // The effective reading carries every key the model is willing to send, including several this preset never
    // declared - and only the preset's own are the preset's answer.
    sampling: { temperature: 1, top_p: 0.9, min_p: 0, top_a: 0 },
    contextWindow: 32_768,
  });
  assert.equal(inForce.generation, preset.source, "the file that was read is named");
  assert.equal(inForce.card, null, "this fixture cwd carries no persona files, and a path is a different fact");
  assert.equal(inForce.worldbook, null);
  assert.deepEqual(inForce.sampling, { temperature: 1, top_p: 0.9 }, "only the keys the preset declares");
  assert.deepEqual(inForce.contextBudget, { value: 32_768, source: "model" });
  assert.equal(inForce.prompts.system.delivered, true);
  assert.ok(inForce.prompts.system.chars > 0, "the system segment carries rendered text and says how much");
  assert.equal(inForce.prompts.postHistory.delivered, true);
  assert.equal(inForce.prompts.postHistory.refused, null);
  assert.equal(inForce.prompts.postHistory.disposition, "applied");

  // No preset file at all: `generation: null`, and the sampler is `not_applied` - never `{}`, which would read as a
  // preset that applied and simply had nothing to say.
  const withoutPreset = companionPresetPublication({
    preset: null,
    runtimeCwd: NO_SUCH_RUNTIME_CWD,
    sampling: null,
    contextWindow: undefined,
  });
  assert.equal(withoutPreset.generation, null);
  assert.equal(withoutPreset.sampling, "not_applied");
  assert.deepEqual(withoutPreset.contextBudget, { not_measured: true, missingField: "model.contextWindow" });
  assert.equal(withoutPreset.prompts.postHistory.delivered, false);
  assert.equal(withoutPreset.prompts.postHistory.disposition, "absent_from_preset");
  assert.deepEqual(withoutPreset.prompts.disabled, []);

  // A preset whose sampler keys reached no composed model is `not_applied` too, and the two `null`s stay apart: the
  // generation file is still named while nothing of it is in force.
  const unapplied = companionPresetPublication({
    preset,
    runtimeCwd: NO_SUCH_RUNTIME_CWD,
    sampling: null,
    contextWindow: 32_768,
  });
  assert.equal(unapplied.generation, preset.source);
  assert.equal(unapplied.sampling, "not_applied");

  // One line, prefix first, and it round-trips: the run bundle parses exactly this.
  const line = formatCompanionPresetLine(inForce);
  assert.ok(line.startsWith(`${COMPANION_PRESET_LINE_PREFIX} `));
  assert.deepEqual(
    JSON.parse(line.slice(COMPANION_PRESET_LINE_PREFIX.length + 1)),
    JSON.parse(JSON.stringify(inForce)),
  );
});

/** The block one line carries, as the run bundle parses it. */
type PublishedBlock = {
  card: string | null;
  worldbook: string | null;
  generation: string | null;
  sampling: unknown;
  contextBudget: unknown;
  prompts: {
    system: { chars: number; delivered: boolean; disposition: string; refused: string | null };
    postHistory: { chars: number; delivered: boolean; disposition: string; refused: string | null };
    disabled: readonly string[];
  };
};

/** Mount a real Game runtime on a fresh root, optionally mounting the shipped preset, and read back its line. */
async function mountedPublication(mountPreset: boolean): Promise<PublishedBlock> {
  const root = await canonicalTestRoot(`gamebuddy-companion-preset-publication-${mountPreset ? "mounted" : "empty"}-`);
  const { runtimeCwd } = resolveRuntimePaths(IDENTITY as never, root);
  await mkdir(runtimeCwd, { recursive: true });
  if (mountPreset)
    await writeFile(join(runtimeCwd, GAME_SESSION_PRESET_FILE), readFileSync(SHIPPED_PRESET_PATH, "utf8"), "utf8");

  const captured: string[] = [];
  const stderr = process.stderr as unknown as { write: (...args: unknown[]) => boolean };
  const original = stderr.write.bind(process.stderr);
  stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  try {
    const runtime = await createCompanionRuntime(
      IDENTITY,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      "game_surface_preset_publication",
      undefined,
      "game",
    );
    runtime.session.dispose();
  } finally {
    stderr.write = original;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  const lines = captured
    .join("")
    .split("\n")
    .map((line) => line.replace(/\r+$/u, ""))
    .filter((line) => line.startsWith(`${COMPANION_PRESET_LINE_PREFIX} `));
  assert.equal(lines.length, 1, "one line per Game runtime, so a reader cannot see two answers");
  return JSON.parse((lines[0] ?? "").slice(COMPANION_PRESET_LINE_PREFIX.length + 1)) as PublishedBlock;
}

test("a mounted Game runtime prints the publication once, naming the preset it read", async () => {
  const block = await mountedPublication(true);
  // The three paths, each separately answerable: the generation file this cwd was provisioned with is named, and the
  // persona files this fixture does not mount stay `null` rather than becoming a path nobody wrote.
  assert.ok(
    typeof block.generation === "string" && block.generation.endsWith(GAME_SESSION_PRESET_FILE),
    `the generation file this runtime read must be named, got ${String(block.generation)}`,
  );
  assert.equal(block.card, null, "this fixture mounts no card, and a path is a different fact from a null");
  assert.equal(block.worldbook, null);
  // This fixture configures no model, so the preset's sampler keys reached nothing: `not_applied`, not an empty bag.
  assert.equal(block.sampling, "not_applied");
  assert.deepEqual(block.contextBudget, { not_measured: true, missingField: "model.contextWindow" });
  assert.deepEqual(block.prompts.system, {
    chars: block.prompts.system.chars,
    delivered: true,
    disposition: "applied",
    refused: null,
  });
  assert.ok(block.prompts.system.chars > 0, "the system segment carries text and says how much");
  assert.deepEqual(block.prompts.postHistory, {
    chars: block.prompts.postHistory.chars,
    delivered: true,
    disposition: "applied",
    refused: null,
  });
  assert.ok(block.prompts.postHistory.chars > 0);
});

test("a Game runtime provisioned with no preset publishes `generation: null` rather than nothing at all", async () => {
  const block = await mountedPublication(false);
  assert.equal("generation" in block, true, "the key is present: 'no preset' and 'we forgot to say' differ");
  assert.equal(block.generation, null);
  assert.equal(block.sampling, "not_applied", "a run with no preset has no sampler values in force, not an empty bag");
  assert.deepEqual(block.contextBudget, { not_measured: true, missingField: "model.contextWindow" });
  assert.equal(block.prompts.system.delivered, false);
  assert.equal(block.prompts.postHistory.delivered, false);
});
