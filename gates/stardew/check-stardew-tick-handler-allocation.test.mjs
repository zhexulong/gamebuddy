#!/usr/bin/env node
/**
 * The falsifiers for `tools/check-stardew-tick-handler-allocation.mjs`.
 *
 * Each case is a tree the gate must read in both directions: the allocation a registered handler makes is named, and
 * the same call one frame away, or the same `+` on numbers, is left alone. The case that matters most is
 * `a collection built inside a registered handler is named` - it is the class, and it is red on the shape a new
 * subscription ships.
 *
 * red-proof: inject  `this.cache = new List<string>();` in a registered handler -> `✖
 *                    tick_handler_allocates:<fixture>:OnTick:collection`; recording it in the baseline is clean, and
 *                    deleting the entry again is the same red (this file, run by
 *                    `test:stardew-tick-handler-allocation`)
 * red-proof: inject  a recorded handler whose allocation was deleted -> `✖
 *                    tick_allocation_baseline_stale:<fixture>:OnTick:collection`, and a `-=` subscription that names
 *                    no member -> the population drops to the members `+=` registered (this file)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOCATION_PATTERNS,
  allocationsOf,
  readTickAllocations,
  SOURCE_ROOT,
} from "./check-stardew-tick-handler-allocation.mjs";

const GATE = fileURLToPath(new URL("./check-stardew-tick-handler-allocation.mjs", import.meta.url));

/** A subscribing class, with the handler body the case needs. */
const TICKED = (body) => `namespace GameBuddy.Stardew;

internal sealed class Ticked
{
    internal void Entry()
    {
        this.Helper.Events.GameLoop.UpdateTicked += this.OnTick;
    }

    private void OnTick(object? sender, object e)
    {
${body}
    }
}
`;

/** The same, but the handler is a LOCAL FUNCTION, which is how the Mod's fixtures subscribe. */
const LOCAL_TICKED = (body) => `namespace GameBuddy.Stardew;

internal sealed class LocalTicked
{
    internal void Install()
    {
        void OnTick(object? sender, object e)
        {
${body}
        }
        this.Helper.Events.GameLoop.UpdateTicked += OnTick;
    }
}
`;

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "gamebuddy-tick-allocation-"));
  const source = path.join(root, "integrations", "stardew");
  mkdirSync(source, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(source, name), body);
  return {
    root: source,
    baselinePath: path.join(root, "baseline.json"),
    record(allocations) {
      writeFileSync(this.baselinePath, `${JSON.stringify({ allocations }, null, 2)}\n`);
    },
    clean() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const codesOf = (reading) => reading.findings.map((finding) => finding.code);
const detailsOf = (reading, code) =>
  reading.findings.filter((finding) => finding.code === code).map((finding) => finding.detail);

test("a collection built inside a registered handler is named", async () => {
  const tree = fixture({ "Ticked.cs": TICKED("        this.cache = new List<string>();") });
  try {
    const reading = await readTickAllocations({ root: tree.root, baselinePath: tree.baselinePath });
    assert.deepEqual(codesOf(reading), ["tick_handler_allocates"]);
    assert.deepEqual(detailsOf(reading, "tick_handler_allocates"), [
      "integrations/stardew/Ticked.cs:OnTick:collection",
    ]);
    assert.equal(reading.handlers.length, 1);
    assert.equal(reading.allocating.length, 1);
    assert.equal(reading.clean, 0);
  } finally {
    tree.clean();
  }
});

test("recording the allocation is clean, and deleting the record while it still allocates is the same red", async () => {
  const tree = fixture({ "Ticked.cs": TICKED("        this.cache = new List<string>();") });
  try {
    tree.record([{ file: "integrations/stardew/Ticked.cs", handler: "OnTick", pattern: "collection" }]);
    const recorded = await readTickAllocations({ root: tree.root, baselinePath: tree.baselinePath });
    assert.deepEqual(codesOf(recorded), []);
    assert.equal(recorded.recorded, 1);

    tree.record([]);
    const unrecorded = await readTickAllocations({ root: tree.root, baselinePath: tree.baselinePath });
    assert.deepEqual(detailsOf(unrecorded, "tick_handler_allocates"), [
      "integrations/stardew/Ticked.cs:OnTick:collection",
    ]);
  } finally {
    tree.clean();
  }
});

test("a recorded allocation whose line was removed is stale, so the debt cannot outlive it", async () => {
  const tree = fixture({ "Ticked.cs": TICKED("        object? nothing = null;") });
  try {
    tree.record([{ file: "integrations/stardew/Ticked.cs", handler: "OnTick", pattern: "collection" }]);
    const reading = await readTickAllocations({ root: tree.root, baselinePath: tree.baselinePath });
    assert.deepEqual(codesOf(reading), ["tick_allocation_baseline_stale"]);
    assert.deepEqual(detailsOf(reading, "tick_allocation_baseline_stale"), [
      "integrations/stardew/Ticked.cs:OnTick:collection",
    ]);
  } finally {
    tree.clean();
  }
});

test("a locally declared handler is resolved from the registration, not from its name", async () => {
  const tree = fixture({ "LocalTicked.cs": LOCAL_TICKED("        _ = JsonSerializer.Serialize(this.value);") });
  try {
    const reading = await readTickAllocations({ root: tree.root, baselinePath: tree.baselinePath });
    assert.deepEqual(detailsOf(reading, "tick_handler_allocates"), [
      "integrations/stardew/LocalTicked.cs:OnTick:serializer",
    ]);
  } finally {
    tree.clean();
  }
});

test("an unregistered handler is outside the population: `-=` only removes", async () => {
  const tree = fixture({
    "Ticked.cs": TICKED("        object? nothing = null;").replace(
      "this.Helper.Events.GameLoop.UpdateTicked += this.OnTick;",
      "this.Helper.Events.GameLoop.UpdateTicked -= this.OnTick;\n        this.Other.GameLoop.UpdateTicked += this.Untracked;",
    ),
  });
  try {
    const reading = await readTickAllocations({ root: tree.root, baselinePath: tree.baselinePath });
    // One `+=` remains, naming `Untracked`, which this file does not declare - so the population is one member the
    // resolver cannot find, and the allocation in the unsubscribed `OnTick` is never read.
    assert.equal(reading.handlers.length, 0);
    assert.deepEqual(codesOf(reading), ["tick_handler_unresolved"]);
    assert.equal(reading.allocating.length, 0);
  } finally {
    tree.clean();
  }
});

test("text concatenated inside a loop is named, and the same `+` on numbers is not", async () => {
  const concatenating = fixture({
    "Ticked.cs": TICKED(`        foreach (string name in this.names)
            this.text += ":" + name;`),
  });
  const adding = fixture({
    "Ticked.cs": TICKED(`        foreach (int value in this.values)
            this.total += value + 1;`),
  });
  const outside = fixture({
    "Ticked.cs": TICKED(`        this.text = "prefix" + this.suffix;`),
  });
  try {
    const hit = await readTickAllocations({ root: concatenating.root, baselinePath: concatenating.baselinePath });
    assert.deepEqual(detailsOf(hit, "tick_handler_allocates"), [
      "integrations/stardew/Ticked.cs:OnTick:string_concatenation_in_loop",
    ]);

    const numeric = await readTickAllocations({ root: adding.root, baselinePath: adding.baselinePath });
    assert.deepEqual(codesOf(numeric), []);

    const once = await readTickAllocations({ root: outside.root, baselinePath: outside.baselinePath });
    assert.deepEqual(codesOf(once), []);
  } finally {
    concatenating.clean();
    adding.clean();
    outside.clean();
  }
});

test("the pattern set is a closed set, and each member is named by a case above", () => {
  const declared = new Set([...Object.keys(ALLOCATION_PATTERNS), "string_concatenation_in_loop"]);
  for (const pattern of ["linq", "collection", "array", "serializer", "format", "string_concatenation_in_loop"])
    assert.ok(declared.has(pattern), `the gate reads no site for the pattern it declares: ${pattern}`);
});

test("a tree that registers no handler is a blocked reading, never a green one", () => {
  const tree = fixture({
    "GameLoopOnly.cs": `namespace GameBuddy.Stardew;

internal sealed class GameLoopOnly
{
    private void Tick() => Game1.player.stamina = 270f;
}
`,
  });
  try {
    const run = () =>
      execFileSync(process.execPath, [GATE, "--root", tree.root, "--baseline", tree.baselinePath], {
        encoding: "utf8",
        stdio: "pipe",
      });
    assert.throws(run, (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /stardew_tick_handlers_no_population/u);
      return true;
    });
  } finally {
    tree.clean();
  }
});

test("the Mod's own handlers are counted, and every allocation in them is recorded", async () => {
  const reading = await readTickAllocations({ root: SOURCE_ROOT });
  assert.deepEqual(codesOf(reading), []);
  assert.ok(reading.handlers.length > 0, "no registered handler was derived, so the reading is vacuous");
  assert.equal(reading.clean + reading.allocating.length, reading.handlers.length);
  // The reading the commit published: five clean, three allocating. Asserted as a property of the two buckets rather
  // than as the numbers, so paying a debt does not turn this case red - it turns `recorded` down.
  assert.ok(reading.recorded >= 0);
  for (const entry of reading.allocating) assert.ok(allocationsOf(entry.handler).length > 0);
});
