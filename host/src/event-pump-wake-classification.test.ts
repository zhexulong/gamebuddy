import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HELD_RECEIPT_PROGRESS_STATES, HELD_SEMANTIC_PROGRESS_KINDS, HOST_MINTED_WAKE_KINDS } from "./event-pump.js";

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

test("a Host-minted kind names the Host path that turns it into a turn", () => {
  const minted = Object.entries(HOST_MINTED_WAKE_KINDS);
  assert.ok(minted.length > 0, "the table is the population this assertion reads; an empty one proves nothing");
  for (const [kind, wake] of minted) {
    assert.ok(
      wake.trim().length > 20,
      `Host-minted kind "${kind}" must name the path that delivers it, got: "${wake}"`,
    );
    assert.match(
      wake,
      /acceptHostMintedFact/u,
      `Host-minted kind "${kind}" can only be delivered by the Host itself, so its wake source must name that path`,
    );
  }
});

test("a Host-minted kind is never held, because no adapter fact would wake the model for it", () => {
  const held = [...Object.keys(HELD_SEMANTIC_PROGRESS_KINDS), ...Object.keys(HELD_RECEIPT_PROGRESS_STATES)];
  const swallowed = Object.keys(HOST_MINTED_WAKE_KINDS).filter((kind) => held.includes(kind));
  assert.deepEqual(
    swallowed,
    [],
    `these kinds are held but only the Host mints them, so nothing the Mod publishes could ever wake the model: ` +
      `${swallowed.join(", ")}`,
  );
  const heldOutcomes = held.filter((kind) => OUTCOME_WORDS.some((word) => kind.includes(word)));
  assert.deepEqual(heldOutcomes, [], "the no-outcome-in-held rule still holds for every held kind");
});

/**
 * The gate, not a test of today's one kind: the population is every semantic kind SPELLED IN THE PUMP'S OWN SOURCE, so a
 * kind added there without a wake classification fails here rather than sitting in the pump unwatched.
 */
test("every kind the pump mints itself is classified", () => {
  const own = [...spelledKinds()]
    .filter(([, where]) => where === "event-pump.ts")
    .map(([kind]) => kind)
    .sort();
  assert.ok(
    own.length > 0,
    "the scan recognised no kind in event-pump.ts, so this reading is blocked rather than green",
  );
  const unclassified = own.filter((kind) => !(kind in HOST_MINTED_WAKE_KINDS));
  assert.deepEqual(
    unclassified,
    [],
    `the pump mints these kinds and nothing says how a turn is created for them: ${unclassified.join(", ")}. ` +
      "Add each to HOST_MINTED_WAKE_KINDS with the Host path that delivers it.",
  );
  console.log(
    `event_pump_wake_classification: examined ${String(own.length)} pump-minted kinds (${own.join(", ")}), ` +
      `all classified in HOST_MINTED_WAKE_KINDS`,
  );
});
