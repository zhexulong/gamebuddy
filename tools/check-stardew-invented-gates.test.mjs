/**
 * The falsifier for `tools/check-stardew-invented-gates.mjs`.
 *
 * The gate exists for a restriction we invented that reads like a world fact: round 42 refused six
 * purchases at `radius=1` against the shop owner's tile, citing `Utility.cs:4100`, which is the
 * predicate's own declaration - its radius is a parameter. Every case below is one arm of that
 * reading, driven through the gate's real derivation on fixture sources and a fixture engine tree:
 * the citation that resolves to a number, the citation that resolves to a parameter, the inline
 * literal that agrees with the cited authority and the one that does not, the debt entry that has to
 * expire, and the empty population that must block rather than pass.
 *
 * red-proof: inject  a constant citing `Utility.cs:20` (the predicate, whose radius is a parameter) ->
 *   `invented_gate:...:ShopOwnerInteractionRadius:ours=1:engine=unstated` plus the subject it names
 * red-proof: inject  a `PanNativeReachTiles` re-valued from 2 to 3 -> `debt_expired` naming the stale entry
 * red-proof: self-check  no request path in the source set -> `invented_gates_no_population` (blocked, not green)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DECOMPILED_ROOT,
  RULES,
  STATED_DEBT,
  analyze,
  blockedReason,
  engineReadingAt,
  ruleChecks,
} from "./check-stardew-invented-gates.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = "tools/check-stardew-invented-gates.mjs";
const CONTROLLER = "integrations/stardew/farmhandexecutioncontroller.test.cs";

/** A file whose line `at` (1-based) is `text`, padded so the citation lands where it says it does. */
function atLine(text, at) {
  const lines = Array.from({ length: at - 1 }, (_, index) => `// filler ${index + 1}`);
  lines.push(text);
  return `${lines.join("\n")}\n`;
}

/** A decompiled-tree stand-in: the two engine members the fixture citations name. */
function engineFixture() {
  const directory = mkdtempSync(join(tmpdir(), "invented-gates-engine-"));
  const write = (name, text) => {
    const path = join(directory, name);
    writeFileSync(path, text);
    return path;
  };
  return new Map([
    [
      "Game1.cs",
      write(
        "Game1.cs",
        atLine("if (!Utility.tileWithinRadiusOfPlayer((int)grabTile.X, (int)grabTile.Y, 1, player))", 12),
      ),
    ],
    [
      "Utility.cs",
      write(
        "Utility.cs",
        atLine("public static bool tileWithinRadiusOfPlayer(int xTile, int yTile, int tileRadius, Farmer f)", 20),
      ),
    ],
  ]);
}

/** One controller partial: a request path with the constants and predicates under test. */
function controller({ constants, body }) {
  return {
    path: CONTROLLER,
    source: [
      "internal sealed partial class ExecutionManager",
      "{",
      ...constants,
      "    private static bool IsTileWithinChebyshevRadius(Farmer player, int targetX, int targetY, int radius)",
      "    {",
      "        return Math.Abs(targetX - (int)player.Tile.X) <= radius",
      "            && Math.Abs(targetY - (int)player.Tile.Y) <= radius;",
      "    }",
      "    public LocalExecutionReceipt RequestLocalThing(string requestId, int targetX, int targetY, Farmer player)",
      "    {",
      ...body,
      "        return null;",
      "    }",
      "}",
      "",
    ].join("\n"),
  };
}

const NATIVE_CLICK_RADIUS = [
  "    /// <summary>The native click radius (Game1.cs:12).</summary>",
  "    internal const int NativeInteractionRadius = 1;",
];

function analyzeFixture({ constants, body, engine, debt = [] }) {
  return analyze({ sources: [controller({ constants, body })], engine, debt });
}

test("a constant citing the engine decision is engine-cited and produces no finding", () => {
  const report = analyzeFixture({
    engine: engineFixture(),
    constants: NATIVE_CLICK_RADIUS,
    body: [
      "        bool within = Utility.tileWithinRadiusOfPlayer(targetX, targetY, NativeInteractionRadius, player);",
      "        if (!within)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "out_of_reach", "x");',
    ],
  });

  assert.deepEqual(report.findings, [], "a constant that copies a stated engine decision is the engine's number");
  assert.equal(report.examined, 1);
  assert.equal(report.engineCited, 1);
  assert.equal(report.authority.symbol, "NativeInteractionRadius");
  assert.match(report.named.join("\n"), /NativeInteractionRadius ours=1 engine=1 status=engine-cited measured=target/u);
});

test("a constant citing the predicate names itself with ours and engine=unstated", () => {
  const report = analyzeFixture({
    engine: engineFixture(),
    constants: [
      "    /// <summary>The native interaction radius for a shop owner (Chebyshev, Utility.cs:20).</summary>",
      "    private const int ShopOwnerInteractionRadius = 1;",
      ...NATIVE_CLICK_RADIUS,
    ],
    body: [
      "        bool reach = Utility.tileWithinRadiusOfPlayer(npc.TilePoint.X, npc.TilePoint.Y, ShopOwnerInteractionRadius, player);",
      "        if (!reach)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shop_counter_out_of_reach", "x");',
    ],
  });

  assert.ok(
    report.findings.includes(`invented_gate:${CONTROLLER}:4:ShopOwnerInteractionRadius:ours=1:engine=unstated`),
    `the constant citing Utility.cs:20 is a finding; got:\n${report.findings.join("\n")}`,
  );
  assert.match(
    report.findings.join("\n"),
    /the radius at Utility\.cs:20 is the parameter "int tileRadius" - the citation names the predicate, not a decision/u,
  );
  assert.ok(
    report.findings.includes(`invented_gate_subject:${CONTROLLER}:4:ShopOwnerInteractionRadius:measured=npc.TilePoint`),
    "a citation that names no subject cannot say what the radius is measured against",
  );
  assert.match(report.findings.join("\n"), /measured: npc\.TilePoint at :\d+/u);
});

test("one constant measured against two tiles names both readings", () => {
  const report = analyzeFixture({
    engine: engineFixture(),
    constants: [
      "    /// <summary>The native interaction radius for a shop owner (Utility.cs:20).</summary>",
      "    private const int ShopOwnerInteractionRadius = 1;",
    ],
    body: [
      "        bool owner = Utility.tileWithinRadiusOfPlayer(npc.TilePoint.X, npc.TilePoint.Y, ShopOwnerInteractionRadius, player);",
      "        bool counter = Utility.tileWithinRadiusOfPlayer(x, y, ShopOwnerInteractionRadius, player);",
      "        if (!owner || !counter)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shop_counter_out_of_reach", "x");',
    ],
  });

  assert.equal(
    report.findings.find((finding) => finding.startsWith("invented_gate_subject:")),
    `invented_gate_subject:${CONTROLLER}:4:ShopOwnerInteractionRadius:measured=npc.TilePoint|x,y`,
    "the two tiles the one constant is applied to are the reading a reviewer needs",
  );
});

test("an inline literal is admissible when it equals the cited authority and a finding when it does not", () => {
  const report = analyzeFixture({
    engine: engineFixture(),
    constants: NATIVE_CLICK_RADIUS,
    body: [
      "        bool reach = IsTileWithinChebyshevRadius(player, targetX, targetY, 1);",
      "        bool wide = IsTileWithinChebyshevRadius(player, targetX, targetY, 2);",
      "        if (!reach || wide)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "out_of_reach", "x");',
    ],
  });

  assert.deepEqual(
    report.findings.filter((finding) => finding.startsWith("invented_gate:")),
    [`invented_gate:${CONTROLLER}:13:literal@RequestLocalThing:ours=2:engine=unstated`],
    "the 1 is the authority's number spelled inline; the 2 is ours alone",
  );
  assert.equal(report.engineCited, 1, "the 1-literal is admissible through the cited authority");
  assert.equal(report.authority.symbol, "NativeInteractionRadius");
});

test("a debt entry expires when its constant is gone", () => {
  const report = analyze({ sources: [controller({ constants: [], body: [] })], engine: new Map(), debt: STATED_DEBT });

  for (const entry of STATED_DEBT) {
    assert.ok(
      report.findings.includes(`debt_expired:${entry.path}:${entry.symbol}=${entry.value}`),
      `the entry for ${entry.symbol} must go red once the constant it excuses is not there; got:\n${report.findings.join(
        "\n",
      )}`,
    );
  }
});

test("a debt entry matches a live constant, and a re-valued one expires it", () => {
  const entry = STATED_DEBT.find((candidate) => candidate.symbol === "PanNativeReachTiles");
  assert.ok(entry, "the pan's geometric window is the standing example of a debt entry");
  // The entry as the fixture tree would spell it: the table names the real partial's path.
  const fixtureDebt = [{ ...entry, path: CONTROLLER }];
  const constants = (value) => [
    "    /// <summary>The native pan window, derived from Pan.cs:55-79.</summary>",
    `    internal const int ${entry.symbol} = ${value};`,
    ...NATIVE_CLICK_RADIUS,
  ];

  const live = analyzeFixture({
    engine: engineFixture(),
    constants: constants(entry.value),
    body: [`        bool reach = IsTileWithinChebyshevRadius(player, targetX, targetY, ${entry.symbol});`],
    debt: fixtureDebt,
  });
  assert.ok(
    !live.findings.some((finding) => finding.startsWith(`debt_expired:${fixtureDebt[0].path}:${entry.symbol}`)),
    "a live constant of the entry's own value is the entry doing its job",
  );
  assert.match(
    live.named.join("\n"),
    new RegExp(`${entry.symbol} ours=${entry.value} engine=unstated status=debt`, "u"),
  );

  const revalued = analyzeFixture({
    engine: engineFixture(),
    constants: constants(entry.value + 1),
    body: [`        bool reach = IsTileWithinChebyshevRadius(player, targetX, targetY, ${entry.symbol});`],
    debt: fixtureDebt,
  });
  assert.ok(
    revalued.findings.includes(`debt_expired:${fixtureDebt[0].path}:${entry.symbol}=${entry.value}`),
    "a re-valued constant leaves the entry matching nothing, so the gate goes red",
  );
});

test("an empty population blocks instead of passing", () => {
  const empty = analyze({ sources: [], engine: new Map() });
  assert.equal(empty.examined, 0);
  assert.equal(blockedReason(empty), "invented_gates_no_population");

  const unrelated = analyzeFixture({
    engine: new Map(),
    constants: NATIVE_CLICK_RADIUS,
    body: ["        int unaffected = targetX + targetY;"],
  });
  assert.equal(blockedReason(unrelated), "invented_gates_no_population");

  const checks = ruleChecks({ findings: unrelated.findings, blocked: blockedReason(unrelated) });
  assert.deepEqual(
    checks.map((check) => check.id),
    RULES.map((rule) => rule.id),
    "a blocked run still names every rule, so the report says what was not measured rather than nothing",
  );
  assert.deepEqual(
    checks.filter((check) => check.status === "not_measured").map((check) => check.id),
    RULES.map((rule) => rule.id),
    "no rule passed over a population that was never read",
  );
  assert.equal(checks[1].reason, "invented_gates_no_population");
  assert.equal(checks[2].reason, "not reached: invented_gates_no_population");
});

test("the report names the failing rule, and the rule that passed still enumerates", () => {
  const report = analyzeFixture({
    engine: engineFixture(),
    constants: [
      "    /// <summary>The native interaction radius for a shop owner (Chebyshev, Utility.cs:20).</summary>",
      "    private const int ShopOwnerInteractionRadius = 1;",
      ...NATIVE_CLICK_RADIUS,
    ],
    body: [
      "        bool reach = Utility.tileWithinRadiusOfPlayer(npc.TilePoint.X, npc.TilePoint.Y, ShopOwnerInteractionRadius, player);",
      "        if (!reach)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "shop_counter_out_of_reach", "x");',
    ],
  });

  const checks = ruleChecks({ findings: report.findings });
  assert.deepEqual(
    checks.map((check) => check.id),
    RULES.map((rule) => rule.id),
    "every rule is enumerated on a red run too - the list is the gate's capability, not its findings",
  );
  assert.deepEqual(
    checks.filter((check) => check.status === "failed").map((check) => check.id),
    ["every_bound_is_the_engine_number", "one_constant_measures_one_subject"],
    "the two findings this fixture produces belong to those two rules and to no others",
  );
  assert.deepEqual(
    checks[3].findings,
    [`invented_gate:${CONTROLLER}:4:ShopOwnerInteractionRadius:ours=1:engine=unstated`],
    "the rule's entry carries the finding itself, not a second spelling of it",
  );
});

test("a debt entry that expired is the one rule that goes red for it", () => {
  const report = analyze({ sources: [controller({ constants: [], body: [] })], engine: new Map(), debt: STATED_DEBT });
  const checks = ruleChecks({ findings: report.findings });
  assert.deepEqual(
    checks.filter((check) => check.status === "failed").map((check) => check.id),
    ["stated_debt_expires"],
    "the ended entry is a debt finding, not an invented bound",
  );
});

test("a citation of a member the decompiled tree has not got states no number", () => {
  const reading = engineReadingAt("Absent.cs:7", new Map());
  assert.equal(reading.value, null);
  assert.match(reading.why, /is not in ref\/external\/StardewValleyDecompiled/u);
});

test("the real tree: the reach authority is engine-cited and no debt entry has expired", (t) => {
  if (!existsSync(join(ROOT, DECOMPILED_ROOT))) {
    t.skip(`no ${DECOMPILED_ROOT} in this checkout, so no citation can be read`);
    return;
  }
  const { stdout, status } = runGate();
  assert.ok(status === 0 || status === 1, `the gate measures the tree (exit 0 or 1), not blocked (exit 2):\n${stdout}`);
  assert.match(
    stdout,
    /invented-gates: constants examined \d+ · engine-cited \d+ · debt \d+ · invented \d+/u,
    "the verdict line is the reading",
  );
  assert.match(stdout, /NativeInteractionRadius ours=1 engine=1 status=engine-cited/u);
  assert.doesNotMatch(stdout, /debt_expired:/u, "every debt entry names a constant the tree still declares");

  // The report the harness reads: the last JSON line of the default run, carrying one entry per rule.
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(report.gate, "stardew-invented-gates");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    RULES.map((rule) => rule.id),
    "the default run's report enumerates every rule this gate is able to report red",
  );
  assert.equal(report.status, status === 0 ? "passed" : "failed", "the exit code and the report are one verdict");
});

function runGate() {
  try {
    return { stdout: execFileSync(process.execPath, [GATE], { cwd: ROOT, encoding: "utf8" }), status: 0 };
  } catch (error) {
    return { stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`, status: error.status ?? 1 };
  }
}
