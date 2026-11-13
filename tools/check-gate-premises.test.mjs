#!/usr/bin/env node
// Falsifiers for tools/check-gate-premises.mjs.
//
// The claim this file protects: a source gate's declared inputs exist, so a gate cannot be red for a reason that is not
// its subject. Two real gates were red for exactly that reason for a week - the commit that deleted the HUD module told
// neither the consumer gate nor the analyzer the gap gate spawns - and the decisive case below is that commit replayed
// through this gate, not a fixture invented here.
//
// red-proof: history  `checkPremises` over the two gates' `213cde50` texts names the deleted module for BOTH gates, with
//   `missing 2` - and dropping the analyzer from that gate's `reads` loses the second finding, which is why the
//   inheritance is in the registry and not in a comment.
// red-proof: inject  a registry row whose gate is a hand-written source declaring a path that does not exist reddens
//   `gate_premise_missing:<gate>:<path>` (the mechanism on its own, without the git history).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkPremises, deriveInputs, GATE_PREMISES, inputExists, report } from "./check-gate-premises.mjs";
import { EXEMPTIONS } from "./check-prelive-gate-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit that deleted the HUD: its own tree is where both gates named a file that was already gone. */
const DELETION_COMMIT = "213cde50";
const CONSUMERS_GATE = "tools/check-stardew-observation-consumers.mjs";
const GAP_GATE = "tools/check-stardew-observation-gap.mjs";
const DELETED_INPUT = "host/src/snapshot-hud.ts";

function fromHistory(revision, path) {
  return execFileSync("git", ["show", `${revision}:${path}`], { cwd: ROOT, encoding: "utf8" });
}

/** A registry whose `read` answers from git history: the tree as it was, checked against the tree as it is. */
function premisesAt(revision, gates) {
  return checkPremises({
    root: ROOT,
    registry: gates,
    read: (path) => fromHistory(revision, path),
  });
}

test("an input is declared in three shapes, and prose about a path is not a declaration", () => {
  const source = [
    "/**",
    " * A header that discusses `host/src/snapshot-hud.ts` is documentation, not an input.",
    " */",
    'export const LOOKUP_SOURCE = "host/src/game-lookup.ts";',
    "export const RENDERER_SOURCES = Object.freeze([",
    '  { path: "host/src/fact-brief.ts", audience: COMPANION },',
    "]);",
    "export const REQUIRED_INPUTS = Object.freeze([",
    '  "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",',
    "]);",
    'const MESSAGE = "render it in host/src/fact-brief.ts";',
    'export const AUDIENCE = "companion";',
  ].join("\n");
  assert.deepEqual(deriveInputs(source), [
    "host/src/fact-brief.ts",
    "host/src/game-lookup.ts",
    "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  ]);
  assert.deepEqual(deriveInputs("export const NOTHING = 1;"), [], "a module with no declared input derives nothing");
});

test("a declared input that is gone reddens by name, with the three counts printed", () => {
  const gate = "tools/check-planted-premise.mjs";
  const result = checkPremises({
    root: ROOT,
    registry: [{ gate }],
    read: (path) => (path === gate ? `export const HUD_SOURCE = "${DELETED_INPUT}";` : ""),
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    [`gate_premise_missing:${gate}:${DELETED_INPUT}`],
  );
  assert.equal(result.gates, 1);
  assert.equal(result.inputs, 1);
  assert.equal(result.missing, 1, "the count names the same set the findings do");

  const lines = [];
  const exitCode = report(result, { write: (text) => lines.push(text) });
  assert.equal(exitCode, 1);
  assert.match(
    lines.join("\n"),
    /gate_premises: gates examined 1 · inputs checked 1 · missing 1/u,
    "the population is printed, because `missing 1` means nothing without what was examined",
  );
  assert.match(lines.join("\n"), new RegExp(`gate_premise_missing:${gate}:${DELETED_INPUT}`, "u"));
});

test("the deletion commit's own gate text names the file it deleted, for both gates", () => {
  const result = premisesAt(DELETION_COMMIT, GATE_PREMISES);
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.findings.map((finding) => finding.code).sort(),
    [`gate_premise_missing:${CONSUMERS_GATE}:${DELETED_INPUT}`, `gate_premise_missing:${GAP_GATE}:${DELETED_INPUT}`],
    "the commit that deleted the HUD is the reading this gate exists to produce",
  );
  assert.equal(result.missing, 2);
  assert.ok(result.inputs > 10, `the population is the whole premise, not one path: examined ${result.inputs}`);
});

test("the gate that SPAWNS the analyzer inherits its inputs, which is why `reads` is in the registry", () => {
  const inherited = premisesAt(DELETION_COMMIT, GATE_PREMISES);
  assert.ok(
    inherited.findings.some((finding) => finding.gate === GAP_GATE),
    "the spawner inherits the analyzer's input",
  );

  const withoutInheritance = premisesAt(DELETION_COMMIT, [
    { gate: GAP_GATE },
    { gate: CONSUMERS_GATE, reads: ["tools/check-snapshot-field-rendering.mjs"] },
  ]);
  assert.ok(
    !withoutInheritance.findings.some((finding) => finding.gate === GAP_GATE),
    "reading only the gate's own text is exactly how this defect survived: its own file names no HUD",
  );
  assert.ok(
    withoutInheritance.findings.some((finding) => finding.gate === CONSUMERS_GATE),
    "the gate whose own file names the input is still caught, so the two cases are told apart",
  );
});

test("a gate that declares no input, a gate that is gone, and an empty registry are all reported", () => {
  const unread = checkPremises({
    root: ROOT,
    registry: [{ gate: "tools/check-planted-silent.mjs" }],
    read: () => "export const NOTHING = 1;",
  });
  assert.deepEqual(
    unread.findings.map((finding) => finding.code),
    ["gate_premise_unread:tools/check-planted-silent.mjs"],
  );

  const absent = checkPremises({
    root: ROOT,
    registry: [{ gate: "tools/check-deleted-gate.mjs" }],
    read: () => {
      throw new Error("ENOENT");
    },
  });
  assert.deepEqual(
    absent.findings.map((finding) => finding.code),
    ["gate_premise_gate_missing:tools/check-deleted-gate.mjs"],
  );

  const empty = checkPremises({ root: ROOT, registry: [] });
  assert.deepEqual(
    empty.findings.map((finding) => finding.code),
    ["gate_premise_registry_empty"],
  );
  const lines = [];
  assert.equal(report(empty, { write: (text) => lines.push(text) }), 2, "zero population is blocked, not green");
  assert.match(lines.join("\n"), /gates examined 0 · inputs checked 0 · missing 0/u);
  assert.match(lines.join("\n"), /a green run reads gates examined >= 1/u);
});

test("a glob input must match something, and a directory input is its own existence", () => {
  assert.equal(inputExists({ root: ROOT, path: "tools/lib/*.mjs" }), true);
  assert.equal(
    inputExists({ root: ROOT, path: "tools/lib/deleted-*.mjs" }),
    false,
    "a glob matching nothing is missing",
  );
  assert.equal(inputExists({ root: ROOT, path: "host/src" }), true);
  assert.equal(inputExists({ root: ROOT, path: "host/src/not-a-directory" }), false);
});

test("the real tree passes, and the registry is the population rather than a sample of it", () => {
  const result = checkPremises({ root: ROOT });
  assert.deepEqual(result.findings, [], `HEAD must be green: ${JSON.stringify(result.findings)}`);
  assert.equal(result.status, "passed");
  assert.equal(result.gates, GATE_PREMISES.length);
  assert.ok(result.inputs >= 10, `examined ${result.inputs} inputs: a population this small would not be a reading`);
  for (const row of result.derived) assert.ok(row.inputs.length > 0, `${row.gate} derived no input at all`);
  // The two gates this unit repaired are in the population BY NAME - a registry that quietly dropped them would still
  // print `gates examined 2` and mean nothing.
  assert.deepEqual(result.derived.map((row) => row.gate).sort(), [GAP_GATE, CONSUMERS_GATE].sort());
});

test("the gate is reachable: a script runs it, and the prelive register says where", () => {
  const scripts = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts ?? {};
  const declared = Object.entries(scripts).filter(([, command]) => command.includes("tools/check-gate-premises.mjs"));
  assert.ok(declared.length > 0, "a gate no script runs is indistinguishable from a passing one");
  const entry = EXEMPTIONS.find((exemption) => exemption.path === "tools/check-gate-premises.mjs");
  assert.ok(entry, "the prelive register must carry a row for it, or `gate_forgotten` is the verdict");
  assert.ok(
    typeof entry.runsIn === "string" && entry.runsIn.length > 0,
    "the row must say where it runs, not only that it exists",
  );
});
