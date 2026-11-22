#!/usr/bin/env node
/**
 * The falsifiers for `tools/check-stardew-game-thread-affinity.mjs`.
 *
 * Each case is a tree the gate must read in BOTH directions: the entity read a hop can reach is named, and the same
 * read on the game loop is left alone. The one that matters most is `a read the pipe worker can reach is named` - it
 * is the class the gate exists for, and it is red on the shape that would ship a data race into the player's save.
 *
 * The fixtures are synthetic trees, not edits of the Mod: `integrations/**` belongs to the lanes that are working in
 * it, and a gate whose only proof is an edit it may not keep is a story rather than a falsifier.
 *
 * red-proof: inject  `Game1.player` added to a helper the pipe worker calls -> `✖
 *                    game_entity_touched_off_the_game_thread:<fixture>:<line>:Observe`; the same fixture with that line
 *                    removed is clean, and a `new Timer` hop reaches it through the timer path too (this file, run by
 *                    `test:stardew-game-thread-affinity`)
 * red-proof: inject  an entity-touching `Read` call the resolver cannot decide, undeclared -> `✖
 *                    game_thread_unresolved_call:<fixture>:<line>:Read`; declared -> clean; declared with no live site
 *                    -> `✖ game_thread_declaration_stale:<fixture>:Read` (this file)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readAffinity, SOURCE_ROOT } from "./check-stardew-game-thread-affinity.mjs";

const GATE = fileURLToPath(new URL("./check-stardew-game-thread-affinity.mjs", import.meta.url));

/** The Mod shape a fixture imitates: a constructor that starts the worker, and helpers it can reach. */
const PIPE_WORKER = (tail) => `namespace GameBuddy.Stardew;

internal sealed class PipeWorker
{
    internal PipeWorker()
    {
        this.worker = Task.Run(this.RunAsync);
    }

    private Task RunAsync() => this.Handle();

    private void Handle()
    {
        this.Observe();
    }

    private void Observe()
    {
${tail}
    }
}
`;

const TIMER_OWNER = (tail) => `namespace GameBuddy.Stardew;

internal sealed class Watchdog
{
    private readonly Timer timer = new Timer(_ => this.Report(), null, 1000, 1000);

    private void Report()
    {
${tail}
    }
}
`;

/** A fixture tree: `<dir>/integrations/stardew/<name>.cs`, so paths read like the Mod's own. */
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "gamebuddy-thread-affinity-"));
  const source = path.join(root, "integrations", "stardew");
  mkdirSync(source, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(source, name), body);
  return {
    root: source,
    declarationsPath: path.join(root, "declarations.json"),
    declare(contents) {
      writeFileSync(this.declarationsPath, `${JSON.stringify(contents, null, 2)}\n`);
    },
    clean() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const codesOf = (reading) => reading.findings.map((finding) => finding.code);
const detailsOf = (reading, code) =>
  reading.findings.filter((finding) => finding.code === code).map((finding) => finding.detail);

test("a read the pipe worker can reach is named", async () => {
  const tree = fixture({ "PipeWorker.cs": PIPE_WORKER("        object? player = Game1.player;") });
  try {
    const reading = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.deepEqual(codesOf(reading), ["game_entity_touched_off_the_game_thread"]);
    assert.match(
      detailsOf(reading, "game_entity_touched_off_the_game_thread")[0],
      /^integrations\/stardew\/PipeWorker\.cs:\d+:Observe$/u,
    );
    // The populations are counted, not asserted on a constant: the same tree measured a hop, a closure and the one
    // entity-touching member that the hop reached.
    assert.equal(reading.hops.length, 1);
    assert.equal(reading.touching, 1);
    assert.equal(reading.onLoop, 0);
    assert.equal(reading.undeclared, 1);
  } finally {
    tree.clean();
  }
});

test("the same tree without that read is clean, so the finding follows the content", async () => {
  const tree = fixture({ "PipeWorker.cs": PIPE_WORKER("        object? nothing = null;") });
  try {
    const reading = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.hops.length, 1);
    assert.equal(reading.closure.length, 3);
    assert.equal(reading.touching, 0);
  } finally {
    tree.clean();
  }
});

test("an entity named only in a comment is not an access", async () => {
  const tree = fixture({
    "PipeWorker.cs": PIPE_WORKER(
      "        // reads Game1.player on the game loop, never here\n        object? nothing = null;",
    ),
    "Documented.cs": `namespace GameBuddy.Stardew;

internal sealed class Documented
{
    /// <summary>Copies Game1.currentLocation on the game loop.</summary>
    private void Copy() { }
}
`,
  });
  try {
    const reading = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.deepEqual(codesOf(reading), []);
    assert.equal(reading.touching, 0);
  } finally {
    tree.clean();
  }
});

test("a timer hop reaches its callback, so the class is not just Task.Run", async () => {
  const tree = fixture({ "Watchdog.cs": TIMER_OWNER("        Game1.player.stamina = -20f;") });
  try {
    const reading = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.deepEqual(codesOf(reading), ["game_entity_touched_off_the_game_thread"]);
    assert.match(
      detailsOf(reading, "game_entity_touched_off_the_game_thread")[0],
      /^integrations\/stardew\/Watchdog\.cs:\d+:Report$/u,
    );
  } finally {
    tree.clean();
  }
});

test("an ambiguity the resolver cannot decide is named, declared away, and stale when its site is gone", async () => {
  const files = {
    "PipeWorker.cs": PIPE_WORKER("        this.held.Twiddle();"),
    "First.cs": `namespace GameBuddy.Stardew;

internal sealed class First
{
    internal void Twiddle() => Game1.player.stamina = 0f;
}
`,
    "Second.cs": `namespace GameBuddy.Stardew;

internal sealed class Second
{
    internal void Twiddle() { }
}
`,
  };
  const tree = fixture(files);
  try {
    const undeclared = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.ok(codesOf(undeclared).includes("game_thread_unresolved_call"));
    assert.match(
      detailsOf(undeclared, "game_thread_unresolved_call")[0],
      /^integrations\/stardew\/PipeWorker\.cs:\d+:Twiddle$/u,
    );

    tree.declare({
      unresolved: [{ file: "integrations/stardew/PipeWorker.cs", callee: "Twiddle", reason: "synthetic" }],
      dispatched: [],
    });
    const declared = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.deepEqual(codesOf(declared), []);

    tree.declare({
      unresolved: [{ file: "integrations/stardew/PipeWorker.cs", callee: "Nowhere", reason: "synthetic" }],
      dispatched: [],
    });
    const stale = await readAffinity({ root: tree.root, declarationsPath: tree.declarationsPath });
    assert.deepEqual(detailsOf(stale, "game_thread_declaration_stale"), ["integrations/stardew/PipeWorker.cs:Nowhere"]);
  } finally {
    tree.clean();
  }
});

test("a tree with no thread hop is a blocked reading, never a green one", () => {
  const tree = fixture({
    "GameLoopOnly.cs": `namespace GameBuddy.Stardew;

internal sealed class GameLoopOnly
{
    private void Tick()
    {
        Game1.player.stamina = 270f;
    }
}
`,
  });
  try {
    const run = () =>
      execFileSync(process.execPath, [GATE, "--root", tree.root, "--declarations", tree.declarationsPath], {
        encoding: "utf8",
        stdio: "pipe",
      });
    assert.throws(run, (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /stardew_game_thread_affinity_no_hop_found/u);
      return true;
    });
  } finally {
    tree.clean();
  }
});

test("a tree with no C# file is a blocked reading", () => {
  const tree = fixture({});
  try {
    const run = () =>
      execFileSync(process.execPath, [GATE, "--root", tree.root, "--declarations", tree.declarationsPath], {
        encoding: "utf8",
        stdio: "pipe",
      });
    assert.throws(run, (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /stardew_game_thread_affinity_no_population/u);
      return true;
    });
  } finally {
    tree.clean();
  }
});

test("the Mod's own tree is clean and its populations are counted", async () => {
  const reading = await readAffinity({ root: SOURCE_ROOT });
  assert.deepEqual(codesOf(reading), []);
  assert.ok(reading.touching > 0, "no entity-touching member was measured, so the reading is vacuous");
  assert.ok(reading.hops.length > 0, "no thread hop was derived, so everything would read as on the loop");
  assert.ok(reading.closure.length > 0, "the hop reached nothing, so the reachability test measured nothing");
  assert.equal(reading.touching, reading.onLoop + reading.dispatched);
});
