import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HELD_RECEIPT_PROGRESS_STATES, HELD_SEMANTIC_PROGRESS_KINDS } from "./event-pump.js";

/**
 * A gate, not a test of today's two tables.
 *
 * The defect it exists for: `program_settled` was added to the held set and nothing ever woke the model for it, so a
 * submitted plan settled into silence (816.5 s, measured 2026-11-07). A held fact is never delivered, so it leaves no
 * trace in any bundle, so no run audit can see it - the only place this class is catchable is at the classification.
 *
 * Two assertions carry the weight and both read the tables, which are the authority:
 *   1. a held kind must name the fact that will wake the model for it;
 *   2. a held kind may not be an OUTCOME.
 *
 * The third part reports its population from source instead of asserting a number it cannot reach: a scan that
 * recognises only some spellings must say how many it examined, not pretend the rest do not exist.
 */

const HOST_SRC = join(import.meta.dirname, "..", "src");
const MOD_SRC = join(import.meta.dirname, "..", "..", "integrations", "stardew");

function filesUnder(dir: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-test") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (accept(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Every semantic-kind spelling the scan recognises, with the file it came from. */
function spelledKinds(): Map<string, string> {
  const kinds = new Map<string, string>();
  const remember = (kind: string | undefined, where: string) => {
    if (kind !== undefined && /^[a-z][a-z0-9_]+$/u.test(kind)) kinds.set(kind, where);
  };

  for (const path of filesUnder(HOST_SRC, (name) => name.endsWith(".ts") && !name.includes(".test."))) {
    const text = readFileSync(path, "utf8");
    const short = path.split(/[\\/]/u).slice(-1)[0] ?? path;
    for (const match of text.matchAll(/[A-Z0-9_]+_SEMANTIC_KIND\s*=\s*"([a-z0-9_]+)"/gu)) remember(match[1], short);
    for (const match of text.matchAll(/semanticKind:\s*"([a-z0-9_]+)"/gu)) remember(match[1], short);
  }

  for (const path of filesUnder(MOD_SRC, (name) => name.endsWith(".cs"))) {
    const text = readFileSync(path, "utf8");
    const short = path.split(/[\\/]/u).slice(-1)[0] ?? path;
    for (const match of text.matchAll(/SemanticKind\s*=\s*"([a-z0-9_]+)"/gu)) remember(match[1], short);
    for (const match of text.matchAll(/\bkind:\s*"([a-z][a-z0-9_]+)"/gu)) remember(match[1], short);
  }

  return kinds;
}

const OUTCOME_WORDS = ["settled", "terminal", "succeeded", "failed", "rejected", "cancelled", "invalidated", "ended"];

test("a held fact names the fact that will wake the model for it", () => {
  for (const [kind, reason] of Object.entries(HELD_SEMANTIC_PROGRESS_KINDS)) {
    assert.ok(
      reason.trim().length > 20,
      `held semantic kind "${kind}" must state which later fact wakes the model, got: "${reason}"`,
    );
  }
  for (const [state, reason] of Object.entries(HELD_RECEIPT_PROGRESS_STATES)) {
    assert.ok(
      reason.trim().length > 20,
      `held receipt state "${state}" must state which later fact wakes the model, got: "${reason}"`,
    );
  }
});

test("an outcome is never held, because the model is never told it happened", () => {
  const held = [...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS), ...Object.keys(HELD_RECEIPT_PROGRESS_STATES)];
  const heldOutcomes = held.filter((kind) => OUTCOME_WORDS.some((word) => kind.includes(word)));
  assert.deepEqual(
    heldOutcomes,
    [],
    `these kinds are outcomes but are held, so nobody wakes the model for them: ${heldOutcomes.join(", ")}. ` +
      "A settlement, a terminal receipt, a rejection - each is news the model acts on. Hold PROGRESS only.",
  );
});

test("the held tables are reported beside every kind the scan can read", () => {
  const kinds = spelledKinds();
  const population = [...kinds.keys()].sort();
  const held = [...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS), ...Object.keys(HELD_RECEIPT_PROGRESS_STATES)];
  assert.ok(
    population.length > 0,
    "the scan recognised no semantic kind at all, so this reading is blocked rather than green",
  );
  console.log(
    `event_pump_wake_classification: examined ${String(population.length)} spelled kinds ` +
      `(${population.slice(0, 8).join(", ")}${population.length > 8 ? ", ..." : ""}); held ${String(held.length)} ` +
      `(${held.join(", ")})`,
  );
});
