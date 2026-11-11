// red-proof: inject  a terminal store-and-publish pair with no idle announcement into a throwaway tree ->
//   `terminal_without_idle_publication:<file>:<line>:<family>`, exit 1; the same reading on the revision before this
//   change, where every tool-approach family member was silent, is red on `ExecuteTillSoil` too
//   (tools/check-terminal-idle-publication.test.mjs)
// red-proof: inject  an exemption for a member whose site publishes the idle now -> `stale_terminal_idle_exemption`
// Tests for the terminal-idle-publication gate.
//
// The authority the gate reads (the `ExecutionState` enum and `IsTerminal`) is COPIED from the workspace into every
// throwaway tree rather than restated, because a second spelling of "which states are terminal" is the disagreement the
// gate exists to prevent. Each case below is one shape the Mod actually contains, so a green run cannot mean the scanner
// stopped matching.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifySites,
  EXEMPTION_PATH,
  IDLE_RUNTIME_PROOF,
  publishesIdleAfter,
  readTerminalStates,
  runGate,
  scanSourceForIdle,
} from "./check-terminal-idle-publication.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORITY = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const PARTIAL = "integrations/stardew/farmhandexecutioncontroller.quietactions.cs";
const authorityText = readFileSync(path.join(root, AUTHORITY), "utf8");
const terminalStates = readTerminalStates(authorityText);

/** A throwaway checkout holding the real state authority plus the sources a case names. */
function withTree(sources, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "terminal-idle-"));
  try {
    const authority = path.join(directory, AUTHORITY);
    mkdirSync(path.dirname(authority), { recursive: true });
    writeFileSync(authority, authorityText);
    for (const [relativePath, text] of Object.entries(sources)) {
      const target = path.join(directory, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** One action body in the shape every converted family uses, with the third step present or absent. */
function actionSource({ state = "ExecutionState.Succeeded", idle = true, guard = null, helper = false }) {
  const remember = helper
    ? "        LocalExecutionReceipt receipt = this.Mint(executionId, requestId);"
    : `        LocalExecutionReceipt receipt = new(executionId, requestId, ${state}, "reason", this.revision, "evidence");`;
  const body = [
    "    private LocalExecutionReceipt ExecuteQuietAction(string executionId, string requestId)",
    "    {",
    ...(guard === null ? [] : [guard, "        {"]),
    remember,
    "        this.Remember(receipt);",
    "        this.AddTrace(receipt);",
    ...(idle ? ["        this.PublishIdleAfterRelease(executionId, requestId);"] : []),
    "        return receipt;",
    ...(guard === null ? [] : ["        }"]),
    "    }",
  ];
  return `namespace GameBuddy.Stardew;\n\ninternal partial class ExecutionManager\n{\n${body.join("\n")}\n}\n`;
}

const findingsOf = (result) =>
  result.stderr.match(/terminal_(?:without_idle_publication|idle_state_unresolved)[^\s]*/gu) ?? [];

test("the authority names the three states an execution still occupies", () => {
  assert.deepEqual(terminalStates.occupied.sort(), ["Accepted", "MeaningfulProgress", "Running"]);
  assert.ok(terminalStates.terminal.includes("Uncertain"), "the gate reads the enum, not a hand-written list");
  assert.ok(!terminalStates.terminal.includes("Running"));
});

test("a terminal pair with no idle announcement is named with file, line and family", () => {
  withTree({ [PARTIAL]: actionSource({ idle: false }) }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(`terminal_without_idle_publication:${PARTIAL}:\\d+:quietactions`, "u"),
      `expected the site to be named, got ${result.stderr}`,
    );
    assert.match(result.stderr, /ExecuteQuietAction stores and publishes `Succeeded`/u, "the finding names the member");
  });
});

test("the same pair with the idle announcement is a pass", () => {
  withTree({ [PARTIAL]: actionSource({ idle: true }) }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(report.status, "passed");
    assert.equal(report.silentSites, 0, "a site that announces the idle is not in the judged population");
  });
});

test("a non-terminal marker is not a debt, whatever else it is missing", () => {
  withTree({ [PARTIAL]: actionSource({ state: "ExecutionState.Running", idle: false }) }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(report.nonTerminalMarkers, 1);
    assert.equal(report.terminalWithoutIdle, 0);
  });
});

test("a state held in a local variable is resolved through its assignments", () => {
  const source = actionSource({ state: "state", idle: false }).replace(
    "        LocalExecutionReceipt receipt =",
    "        ExecutionState state = succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain;\n        LocalExecutionReceipt receipt =",
  );
  withTree({ [PARTIAL]: source }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /stores and publishes `Succeeded\/Uncertain`/u);
  });
});

test("a parameter filtered by a progress guard is read as what the guard allows", () => {
  const source = actionSource({
    state: "state",
    idle: false,
    guard: "        if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)",
  }).replace("(string executionId, string requestId)", "(string executionId, string requestId, ExecutionState state)");
  withTree({ [PARTIAL]: source }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(report.nonTerminalMarkers, 1);
  });
});

test("a state the site does not say is unresolved, never a pass", () => {
  withTree({ [PARTIAL]: actionSource({ helper: true, idle: false }) }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`terminal_idle_state_unresolved:${PARTIAL}:\\d+:ExecuteQuietAction`, "u"));
  });
});

test("an exemption covers its site, and a member that owes fewer sites is stale", () => {
  const source = actionSource({ idle: false });
  const covered = {
    file: PARTIAL,
    member: "ExecuteQuietAction",
    line: 5,
    sites: 1,
    family: "quietactions",
    reason: "the execution never owned the body",
  };
  withTree(
    { [PARTIAL]: source, "tools/terminal-idle-publication-exemptions.json": JSON.stringify([covered]) },
    (directory) => {
      const result = runGate(directory);
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
      assert.equal(report.exempt, 1);
    },
  );
  const overRecorded = { ...covered, sites: 2 };
  withTree(
    { [PARTIAL]: source, "tools/terminal-idle-publication-exemptions.json": JSON.stringify([overRecorded]) },
    (directory) => {
      const result = runGate(directory);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`stale_terminal_idle_exemption:${PARTIAL}:5`, "u"));
    },
  );
});

test("an exemption for a member that announces the idle now is stale", () => {
  const entry = {
    file: PARTIAL,
    member: "ExecuteQuietAction",
    line: 5,
    sites: 1,
    family: "quietactions",
    reason: "recorded before the site was converted",
  };
  withTree(
    {
      [PARTIAL]: actionSource({ idle: true }),
      "tools/terminal-idle-publication-exemptions.json": JSON.stringify([entry]),
    },
    (directory) => {
      const result = runGate(directory);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`stale_terminal_idle_exemption:${PARTIAL}:5`, "u"));
    },
  );
});

test("a tree with no store-and-publish pair is blocked, not green", () => {
  withTree({ [PARTIAL]: "namespace GameBuddy.Stardew;\n\ninternal static class Quiet { }\n" }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no_terminal_idle_site/u);
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(report.status, "blocked");
    for (const check of report.checks) assert.equal(check.status, "blocked");
  });
});

test("an authority whose IsTerminal cannot be read blocks the run", () => {
  const broken = authorityText.replace(
    /public static bool IsTerminal\(this ExecutionState state\) =>/u,
    "public static bool Other(",
  );
  withTree({ [PARTIAL]: actionSource({ idle: false }) }, (directory) => {
    writeFileSync(path.join(directory, AUTHORITY), broken);
    const result = runGate(directory);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /terminal_state_population_unreadable/u);
    assert.equal(findingsOf(result).length, 0, "a blocked run decides nothing about individual sites");
  });
});

test("a seam body that stops announcing the idle is a finding, not 908 silent callers", () => {
  const seam = [
    "namespace GameBuddy.Stardew;",
    "",
    "internal partial class ExecutionManager",
    "{",
    "    private LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence)",
    "    {",
    "        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence, ActionId: null, Observation: null, Hint: null);",
    "        this.Remember(receipt);",
    "        LocalExecutionReceipt published = this.AddTrace(receipt);",
    "        return published;",
    "    }",
    "}",
  ].join("\n");
  const SEAM_PARTIAL = "integrations/stardew/farmhandexecutioncontroller.seam.cs";
  withTree({ [SEAM_PARTIAL]: `${seam}\n` }, (directory) => {
    const result = runGate(directory);
    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(`terminal_without_idle_publication:${SEAM_PARTIAL}:\\d+:seam`, "u"),
      `expected the seam's own body to be judged, got ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /RememberTerminal stores and publishes every receipt its callers pass without PublishIdleAfterRelease/u,
      "the finding says the silence covers every converted site",
    );
  });
  withTree(
    {
      [SEAM_PARTIAL]: `${seam.replace(
        "        return published;",
        "        if (state.IsTerminal())\n            this.PublishIdleAfterRelease(executionId, requestId);\n        return published;",
      )}\n`,
    },
    (directory) => {
      const result = runGate(directory);
      assert.equal(result.code, 0, result.stderr);
    },
  );
});

test("the idle announcement is read after the commit, in the site's own block", () => {
  const lines = [
    "    private void ExecuteQuietAction(string executionId, string requestId)",
    "    {",
    "        this.Remember(receipt);",
    "        this.AddTrace(receipt);",
    "        this.PublishIdleAfterRelease(executionId, requestId);",
    "    }",
  ];
  assert.equal(publishesIdleAfter(lines, 2), true);
  assert.equal(publishesIdleAfter(["    {", "        this.Remember(receipt);", "    }"], 1), false);
});

/** The real tree, scanned through the same functions the gate runs. */
test("the workspace population is derived, and the one silence it still watches is the one exempted", () => {
  const scanned = scanSourceForIdle(
    "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
    readFileSync(path.join(root, "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs"), "utf8"),
    terminalStates.terminal,
  );
  const tillSoil = scanned.sites.filter((site) => site.member === "ExecuteTillSoil");
  assert.deepEqual(tillSoil, [], "till_soil reaches the seam, so it keeps no pair left to be silent in");

  const result = runGate(root);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.status, "passed");
  assert.ok(report.examined > 0, `examined ${report.examined} store-and-publish pair(s)`);
  const ratchet = JSON.parse(readFileSync(path.join(root, EXEMPTION_PATH), "utf8")).exemptions;
  assert.equal(
    report.exempt,
    ratchet.reduce((total, entry) => total + entry.sites, 0),
    "the exemption file is the whole exempt count, so a stale entry cannot hide beside a live one",
  );
  assert.equal(report.unresolvedStates, 0, "every silent site's state is readable");
  assert.ok(
    report.seamCallsOutsidePopulation > 0,
    "the sites the seam conversion moved out of this population are named as outside it, not dropped",
  );
  assert.match(result.stdout, /outside this population \d+ seam call\(s\)/u, "the census says what it does not cover");
  assert.equal(report.propertyLivesAt, IDLE_RUNTIME_PROOF);
  assert.ok(
    existsSync(path.join(root, IDLE_RUNTIME_PROOF)),
    `the replacement the census names exists: ${IDLE_RUNTIME_PROOF}`,
  );
  assert.match(result.stdout, /^sites examined \d+ · silent \d+ \(terminal \d+ · marker \d+ · unresolved \d+\)/mu);
});

/**
 * The revision before this change: the last tree in which every tool-approach family member was silent. Pinned rather
 * than read as `HEAD`, because `HEAD` becomes the fixed tree the moment this lands, and a proof that follows `HEAD`
 * would then be asserting that the gate is green on the fix.
 */
const PRE_FIX_REVISION = "b1a8bee08d3ec1582133b78250f576089530882d";

/** The same reading, on the tree as it was before this change: the gate is red on real history, not only on a fixture. */
test("the commit before this change is red on the tool families it converted", (t) => {
  let before;
  try {
    before = execFileSync(
      "git",
      ["show", `${PRE_FIX_REVISION}:integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs`],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
  } catch {
    t.skip(`revision ${PRE_FIX_REVISION} is not in this checkout`);
    return;
  }
  const scanned = scanSourceForIdle(
    "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
    before,
    terminalStates.terminal,
  );
  const owed = scanned.sites.filter((site) => (site.terminal ?? []).length > 0);
  assert.deepEqual(
    owed.map((site) => site.member),
    ["ExecuteTillSoil"],
    "the revision before this change stored and published a Succeeded/Uncertain terminal without the idle",
  );
  const verdict = classifySites(scanned.sites, []);
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code.replace(/:\d+:/u, ":<line>:")),
    [
      "terminal_without_idle_publication:integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:<line>:resourcetoolactions",
    ],
  );
});
