#!/usr/bin/env node
/**
 * Guard: a test may assert a lifecycle RULE over a derived set, but it may not pin ONE action's rung to a literal.
 *
 * WHY (measured 2026-11-14). Five Stardew actions were promoted in two commits (`834cab0e`, `a7552b6b`) and each
 * promotion turned a green test red - not because the product was wrong, but because a test had copied the row's rung
 * into itself. Promotion is the ordinary event this tree exists to perform; a test that has to be hand-edited on
 * promotion day is a test that will be edited wrong exactly once, and the rung it then asserts is a second authority
 * for a fact `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` already owns. Three Integration pins
 * were fixed by deriving from `ActionPolicyEngine.ComputeEnabledActions` (`92bede7a`); two Core pins stayed red
 * (`BreakResourceClumpRegistrationTests`, `OpenGeodeWireContractTests`). This gate is for the ones nobody has written
 * yet.
 *
 * WHAT IS A PIN. An assertion that ties a CATALOG action id to a LITERAL rung:
 *
 *   registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);            fluent, on the object
 *   entry.Should().Contain("FarmhandActionLifecycle.LiveVerified", "...");               source text, for one row
 *
 * Both break when the row moves, and both restate a value the catalog declares. What is NOT a pin, and is what a
 * fixed test looks like:
 *
 *   ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions()).Should().Contain("open_geode");
 *   registrations.Where(entry => entry.Lifecycle == FarmhandActionLifecycle.Experimental)   // a rule over a set
 *   registration.Lifecycle.Should().BeOneOf(new[] { Published, LiveVerified })             // a rule over a set
 *   ServiceLifetime.Scoped                                                                  // not this enum
 *
 * The rule is lexical on purpose: the reading is a property of the assertion's SHAPE, so a reviewer can check one
 * line and a new spelling of "pin this row's rung" is caught by the same regex class rather than by a member list.
 * The population of action ids is not a list either - it is `FarmhandActionFamilies`, read from the registration
 * table, and the rungs are read from the `FarmhandActionLifecycle` enum declaration, so a new rung or a renamed
 * action is in scope the moment it is declared.
 *
 * THE DECLARATION. A test that genuinely needs a rung to be a particular value (a fixture that must be Experimental
 * to exercise the opt-in path) says so on one line, and the gate accepts AND PRINTS it:
 *
 *   // lifecycle-pin: must be Experimental so the opt-in path has a rung to opt into
 *
 * The marker must carry a reason of at least `WHY` characters; a bare marker is a finding, because a declaration
 * nobody can read is a silencer rather than an exemption.
 *
 * THE BASELINE, and why this gate is not simply red. Measured when it landed: 49 pins exist in tests this lane may
 * not edit, each of them currently asserting the value the catalog declares. Writing 49 derivations from here would
 * be a change to files four other lanes are holding; declaring them "fine" would be the exception list this gate
 * exists to refuse. So the reading is published: `tools/stardew-lifecycle-pin-baseline.json` records those 49 pins by
 * content - file, action id, rung, count - never by line number, because a pin identified by position reports a
 * change that did not happen. The ratchet is both ways:
 *
 *   - a pin NOT recorded is a finding (`lifecycle_literal_pinned_in_a_test:<file>:<action>:<lifecycle>`), so a new
 *     pin cannot arrive quietly - which is the whole failure being prevented;
 *   - a recorded entry that is no longer a pin is a finding (`lifecycle_pin_baseline_entry_stale:...`) and must be
 *     deleted, so the record can only shrink and cannot outlive the pin it excuses. Deriving one of the 49 is
 *     therefore a two-line change: the test, and the deletion of its entry.
 *
 * The baseline is a record of measured debt, not a verdict that the debt is acceptable: every run prints
 * `recorded debt 49`, and a run over a tree where every pin is derived prints `action-lifecycle pins 0` and passes -
 * zero PINS is the goal, while zero TEST FILES EXAMINED is a blocked reading (`stardew_lifecycle_pins_no_population`),
 * never a clean tree.
 *
 * NOT THIS GATE'S BUSINESS: which rung an action SHOULD hold. That is `tools/check-stardew-action-promotion.mjs`
 * (lifecycle against the four places a promotion owns) and the C# suite. This gate only refuses the copy.
 *
 * Usage:
 *   node tools/check-stardew-lifecycle-pins.mjs                    # the reading; exit 1 on a finding
 *   node tools/check-stardew-lifecycle-pins.mjs --json             # the whole reading
 *   node tools/check-stardew-lifecycle-pins.mjs --update           # re-record the baseline from a real reading
 *   node tools/check-stardew-lifecycle-pins.mjs --tests-root <dir> --definitions <file> --baseline <file>
 *                                                                  # a historical tree, for a red proof
 *
 * red-proof: history `834cab0e~1` (the tree where both pins were still green) through `--tests-root`/`--definitions`
 *                    -> `lifecycle_literal_pinned_in_a_test:GameBuddy.Stardew.Core.Tests/BreakResourceClumpRegistrationTests.cs:break_resource_clump:Experimental`
 *                    and `:OpenGeodeWireContractTests.cs:open_geode:Experimental`, exit 1; the same reading after the
 *                    two derivations names neither (measured in this lane's report)
 * red-proof: inject  a synthetic test that pins `sweep_scythe` to `LiveVerified` -> `✖
 *                    lifecycle_literal_pinned_in_a_test:<file>:sweep_scythe:LiveVerified`; deleting the pin's baseline
 *                    entry -> `✖ lifecycle_pin_baseline_entry_stale:<file>:sweep_scythe:LiveVerified`
 *                    (tools/check-stardew-lifecycle-pins.test.mjs)
 */

export const gateDeclaration = {
  id: "check-stardew-lifecycle-pins",
  domain: "stardew",
  tier: "l0",
  kind: "ratchet",
};

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./audit-stardew-test-shape.mjs";
import { readStardewActionIds } from "../../tools/lib/stardew-published-action-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const MARKER = "\u2716";

/** The tests tree this gate reads: every Mod test project, so a Core pin and an Integration pin are one population. */
export const TESTS_ROOT = path.join(ROOT, "integrations", "stardew", "tests");

/** The registration table. The action ids and the rung names both come from here, never from a list in this file. */
export const DEFINITIONS_PATH = path.join(
  ROOT,
  "integrations",
  "stardew",
  "src",
  "Core",
  "Policy",
  "FarmhandActionDefinitions.cs",
);

/** The recorded debt: pins that exist in files this gate's owner does not own. See THE BASELINE above. */
export const BASELINE_PATH = path.join(ROOT, "tools", "stardew-lifecycle-pin-baseline.json");

/** The one-line declaration a test uses when it needs a rung to hold a particular value. */
export const PIN_MARKER = "// lifecycle-pin:";

/** A declaration has to say WHY, or it is a silencer. The same 40 characters `tools/audit-stardew-test-shape.mjs` asks. */
const WHY = 40;

/** A marker directly above, or trailing, the assertion it excuses - never three lines up in another statement. */
const MARKER_WINDOW = 2;

/** Every rung the enum declares. A new rung is in the population the moment it is added to the enum. */
export function readLifecycleRungs(source) {
  const body = source.match(/enum\s+FarmhandActionLifecycle\s*\{([^}]*)\}/u)?.[1];
  if (body === undefined) throw new Error("stardew_lifecycle_pins_no_lifecycle_enum");
  const rungs = body
    .split(",")
    .map((member) => member.trim())
    .filter((member) => /^[A-Za-z]\w*$/u.test(member));
  if (rungs.length === 0) throw new Error("stardew_lifecycle_pins_lifecycle_enum_declares_no_rung");
  return rungs;
}

/** Every `.cs` file under the tests tree, skipping build output. The population is a directory scan, never a list. */
export function testSourceFiles(testsRoot = TESTS_ROOT) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "obj" || entry.name === "bin") continue;
        walk(full);
      } else if (entry.name.endsWith(".cs")) files.push(full);
    }
  };
  walk(testsRoot);
  return files.sort();
}

/** The rung names, as a regex alternation, longest first so a prefix rung cannot shadow the one it prefixes. */
function rungAlternation(rungs) {
  return [...rungs].sort((left, right) => right.length - left.length).join("|");
}

/**
 * Find every literal pin in one file, with the action id it is about.
 *
 * ATTRIBUTION, and why it is scoped to the enclosing test. An action id is named in the file in many shapes -
 * `FindRegistration("sweep_scythe")`, `candidate.ActionId == "cut_weeds"`, `const string ActionId = "open_geode"` -
 * so the id is read as "a token of the catalog's own vocabulary", not as one hard-coded spelling of a lookup. The
 * search is bounded by the enclosing `[Fact]`/`[Theory]` because an unbounded backward search would label a pin with
 * an id from the test above it, and a finding that names the wrong action costs the next reader more than the pin.
 *
 * A pin with no attributable id inside its own test is still a finding, named `unattributed`: a reading that cannot
 * place the pin is reported, never dropped - a dropped one is exactly how this class would go quiet.
 */
export function findLifecyclePins({ file, source, actionIds, rungs }) {
  const stripped = stripComments(source);
  const rawLines = source.split("\n");

  const declarations = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index].endsWith("\r") ? rawLines[index].slice(0, -1) : rawLines[index];
    const at = line.indexOf(PIN_MARKER);
    if (at === -1) continue;
    declarations.push({ line: index + 1, reason: line.slice(at + PIN_MARKER.length).trim() });
  }

  const actionIdPattern = new RegExp(`\\b(${[...actionIds].join("|")})\\b`, "gu");
  const mentions = [...stripped.matchAll(actionIdPattern)]
    .filter((match) => actionIds.has(match[1]))
    .map((match) => ({ index: match.index, actionId: match[1] }));

  const testStarts = [...stripped.matchAll(/\[(?:Fact|Theory)\]/gu)].map((match) => match.index);
  const testRanges = testStarts.map((start, position) => [start, testStarts[position + 1] ?? stripped.length]);

  const fileWide = new Set(mentions.map((mention) => mention.actionId));
  const attribute = (index) => {
    const range = testRanges.find(([start, end]) => index >= start && index < end);
    if (range === undefined) return fileWide.size === 1 ? [...fileWide][0] : "unattributed";
    const inside = mentions.filter((mention) => mention.index >= range[0] && mention.index < range[1]);
    const preceding = inside.filter((mention) => mention.index <= index);
    if (preceding.length > 0) return preceding[preceding.length - 1].actionId;
    const named = new Set(inside.map((mention) => mention.actionId));
    if (named.size === 1) return [...named][0];
    return fileWide.size === 1 ? [...fileWide][0] : "unattributed";
  };

  const lineOf = (index) => stripped.slice(0, index).split("\n").length;

  const rung = rungAlternation(rungs);
  const patterns = [
    // The object: `registration.Lifecycle.Should().Be(FarmhandActionLifecycle.X)`, in any namespace qualification.
    new RegExp(
      `\\.Lifecycle\\s*\\.Should\\(\\)\\s*\\.Be\\s*\\(\\s*(?:[\\w.]+\\.)?FarmhandActionLifecycle\\.(${rung})\\b`,
      "gu",
    ),
    // The row's own source text, for one action: `entry.Should().Contain("FarmhandActionLifecycle.X", ...)`.
    new RegExp(`\\.Should\\(\\)\\.Contain\\(\\s*"[^"\\n]*FarmhandActionLifecycle\\.(${rung})\\b`, "gu"),
  ];

  const pins = [];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const line = lineOf(match.index);
      pins.push({
        file,
        line,
        actionId: attribute(match.index),
        lifecycle: match[1],
        form: pattern === patterns[0] ? "object" : "source-text",
        declaredBy:
          declarations.find((declaration) => declaration.line <= line && line - declaration.line <= MARKER_WINDOW) ??
          null,
      });
    }
  }
  return { pins: pins.sort((left, right) => left.line - right.line), declarations };
}

/** Read one tree: every file classified, every pin named, every declaration counted. */
export function readLifecyclePins({ testsRoot = TESTS_ROOT, definitionsPath = DEFINITIONS_PATH } = {}) {
  const rungs = readLifecycleRungs(readFileSync(definitionsPath, "utf8"));
  const actionIds = readStardewActionIds({ registrationsPath: definitionsPath });
  if (actionIds.size === 0) throw new Error("stardew_lifecycle_pins_catalog_declares_no_action");

  const files = testSourceFiles(testsRoot);
  const pins = [];
  const declarations = [];
  const findings = [];
  for (const file of files) {
    const relative = path.relative(testsRoot, file).split(path.sep).join("/");
    const classified = findLifecyclePins({
      file: relative,
      source: readFileSync(file, "utf8"),
      actionIds,
      rungs,
    });
    pins.push(...classified.pins);
    declarations.push(...classified.declarations.map((declaration) => ({ file: relative, ...declaration })));
    for (const pin of classified.pins) {
      if (pin.declaredBy === null) continue;
      if (pin.declaredBy.reason.length >= WHY) continue;
      findings.push({
        code: `lifecycle_pin_marker_has_no_reason:${relative}:${pin.declaredBy.line}`,
        detail:
          `${relative}:${pin.declaredBy.line} declares "${PIN_MARKER}" with ${pin.declaredBy.reason.length}` +
          ` characters of reason; ${WHY}+ are required, or the declaration is a silencer rather than an exemption`,
      });
    }
  }
  return { rungs, actionCount: actionIds.size, filesExamined: files.length, pins, declarations, findings };
}

/** A pin's identity: its content, never its position. Two pins of the same rung in one file are two entries. */
export function keyOf(pin) {
  return `${pin.file}:${pin.actionId}:${pin.lifecycle}`;
}

function countKeys(pins) {
  const counted = new Map();
  for (const pin of pins) counted.set(keyOf(pin), (counted.get(keyOf(pin)) ?? 0) + 1);
  return counted;
}

/**
 * The ratchet. `recorded` is the baseline's content; a pin it does not carry is a finding, and a recorded pin that
 * no longer exists is a finding too - the record can only shrink.
 */
export function evaluateLifecyclePins({ reading, recorded }) {
  const observed = countKeys(reading.pins.filter((pin) => pin.declaredBy === null));
  const findings = [...reading.findings];

  for (const [key, count] of observed) {
    const held = recorded.get(key) ?? 0;
    for (let excess = held; excess < count; excess += 1)
      findings.push({
        code: `lifecycle_literal_pinned_in_a_test:${key}`,
        detail: `${key} ties one action to a literal rung; ask the authority that decides it instead (see the header)`,
      });
  }
  for (const [key, held] of recorded) {
    const count = observed.get(key) ?? 0;
    for (let missing = count; missing < held; missing += 1)
      findings.push({
        code: `lifecycle_pin_baseline_entry_stale:${key}`,
        detail: `${key} is no longer a pin (or no longer exists); delete its entry from the baseline so the record only shrinks`,
      });
  }
  return findings;
}

export function readBaseline(baselinePath = BASELINE_PATH) {
  // A missing baseline is an EMPTY one, never a pass: every pin then reads as unrecorded and the run is red. It is
  // how the historical proof runs, and it means a baseline deleted by accident cannot turn this gate green.
  if (!existsSync(baselinePath)) return [];
  const text = readFileSync(baselinePath, "utf8");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.entries)) throw new Error("stardew_lifecycle_pin_baseline_malformed:entries");
  return parsed.entries;
}

export function baselineCounts(entries) {
  const counted = new Map();
  for (const entry of entries) {
    const key = `${entry.file}:${entry.actionId}:${entry.lifecycle}`;
    counted.set(key, (counted.get(key) ?? 0) + (entry.count ?? 1));
  }
  return counted;
}

/** The baseline's own content, from a real reading: one entry per distinct pin, sorted, no line numbers. */
export function baselineFrom(reading) {
  const entries = [...countKeys(reading.pins.filter((pin) => pin.declaredBy === null))]
    .map(([key, count]) => {
      const [file, actionId, lifecycle] = key.split(":");
      return { file, actionId, lifecycle, count };
    })
    .sort((left, right) =>
      `${left.file}${left.actionId}${left.lifecycle}`.localeCompare(`${right.file}${right.actionId}${right.lifecycle}`),
    );
  return { schema: "gamebuddy-stardew-lifecycle-pin-baseline/v1", entries };
}

function report(reading, entries, findings) {
  const ofRule = (prefix) => findings.filter((finding) => finding.code.startsWith(`${prefix}:`));
  const outcome = (prefix) => (ofRule(prefix).length === 0 ? "passed" : "failed");
  return {
    gate: "stardew-lifecycle-pins",
    status: findings.length === 0 ? "passed" : "failed",
    examined: reading.filesExamined,
    pins: reading.pins.length,
    declared: reading.pins.filter((pin) => pin.declaredBy !== null).length,
    unrecorded: reading.pins.filter((pin) => pin.declaredBy === null).length,
    recordedDebt: entries.reduce((total, entry) => total + (entry.count ?? 1), 0),
    recordedEntries: entries.length,
    actions: reading.actionCount,
    rungs: reading.rungs,
    checks: [
      {
        id: "lifecycle_literal_pinned_in_a_test",
        status: outcome("lifecycle_literal_pinned_in_a_test"),
        detail: `${reading.pins.length} pin(s) in ${reading.filesExamined} test file(s), ${ofRule("lifecycle_literal_pinned_in_a_test").length} of them outside the baseline and undeclared`,
      },
      {
        id: "lifecycle_pin_baseline_current",
        status: outcome("lifecycle_pin_baseline_entry_stale"),
        detail: `${ofRule("lifecycle_pin_baseline_entry_stale").length} recorded pin(s) that no longer exist`,
      },
      {
        id: "lifecycle_pin_marker_reason",
        status: outcome("lifecycle_pin_marker_has_no_reason"),
        detail: `${ofRule("lifecycle_pin_marker_has_no_reason").length} declaration(s) without a stated reason`,
      },
    ],
    findings,
  };
}

function main(argv) {
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const testsRoot = path.resolve(option("--tests-root", TESTS_ROOT));
  const definitionsPath = path.resolve(option("--definitions", DEFINITIONS_PATH));
  const baselinePath = path.resolve(option("--baseline", BASELINE_PATH));

  const reading = readLifecyclePins({ testsRoot, definitionsPath });
  if (reading.filesExamined === 0) throw new Error(`stardew_lifecycle_pins_no_population:${testsRoot}`);

  if (argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(reading), null, 2)}\n`);
    console.log(`stardew_lifecycle_pins_baseline_recorded pins=${reading.pins.length} into ${baselinePath}`);
    return 0;
  }

  const entries = readBaseline(baselinePath);
  const findings = evaluateLifecyclePins({ reading, recorded: baselineCounts(entries) });
  const summary = report(reading, entries, findings);

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return findings.length === 0 ? 0 : 1;
  }

  console.log(
    `test files examined ${summary.examined} · action-lifecycle pins ${summary.pins}` +
      ` · declared ${summary.declared} · recorded debt ${summary.recordedDebt} · unrecorded ${summary.unrecorded}`,
  );
  console.log(
    `catalog ${summary.actions} actions · rungs ${summary.rungs.join(", ")} · baseline ${path.relative(ROOT, baselinePath)}` +
      ` (${summary.recordedEntries} entries)`,
  );
  for (const declaration of reading.declarations)
    console.log(`  declared  ${declaration.file}:${declaration.line} - ${declaration.reason}`);
  if (findings.length === 0) {
    console.log(`lifecycle-pin: ok (no pin outside the recorded debt)`);
    console.log(JSON.stringify(summary));
    return 0;
  }
  console.log(`lifecycle-pin: ${findings.length} finding(s)`);
  for (const finding of findings) console.log(`${MARKER} ${finding.code}`);
  console.log(JSON.stringify(summary));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`${MARKER} ${error.message}`);
    process.exitCode = 2;
  }
}
