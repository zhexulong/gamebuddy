/**
 * What WOULD change if the forked admission sites converged onto `AdmitExecution`.
 *
 * Why this exists: 21 handler entry points write the body-environment triple
 * (`Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove`) inline and never call the
 * shared admission, so the authority on whether an actor can act is implemented twice. The two are not
 * equivalent, and the difference only runs one way - shared admission requires disposition Idle, and Idle
 * implies every fact the triple tests - so a converged site can only become STRICTER. That makes the migration
 * a behavioural decision, not a refactor, and this tool exists to put the exact delta in front of whoever
 * decides: which states each site admits today that the authority would refuse.
 *
 * It measures and never edits. Site detection matches the reconciliation test on purpose, so the worklist and
 * the measured list cannot drift apart.
 *
 * THE ASSERTION IT NOW CARRIES: `forked 0`. For two days this tool printed its count and exited 0 whichever count it
 * found, so the invariant it exists for - every handler routes through the shared admission - was vacuous and could not
 * be observed failing. A forked site is now exit 1 (naming each one), a source root that is absent is exit 2
 * (`stardew_admission_fork_delta_skipped:`, "I could not look" rather than "there are none"), and the file count is
 * printed beside the site count because the two zeros have to be told apart by the reader: an existing root with no
 * controller partial holds no fork and no population, which the tool's own falsifier pins as an empty worklist rather
 * than a blocked reading.
 *
 * Usage:
 *   node tools/audit-stardew-admission-fork-delta.mjs [--source-root <dir>] [--json]
 *
 * red-proof: inject  a handler body that tests the triple inline in a synthetic source root -> `forked 1` and exit 1
 *   (`the detector still finds a fork in all three spellings`); a `--source-root` that does not exist ->
 *   `stardew_admission_fork_delta_skipped: stardew_source_root_missing:...` and exit 2
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const TRIPLE = "Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove";
const TRIPLE_ACTOR = "Game1.activeClickableMenu is not null || Game1.eventUp || !actor.CanMove";

/**
 * The states the authority refuses that the triple does NOT test.
 *
 * Each entry names the fact in `ActorWorldFacts` that produces it, so the claim is checkable against
 * `WorldModel.Classify` rather than asserted here. `reachable` records whether the state happens on its own in
 * normal play - a delta nobody can reach is not a behavioural change.
 */
const DELTA_STATES = Object.freeze([
  { state: "dialogueUp without a mounted menu", fact: "DialogueUp", reachable: true },
  { state: "the pass-out hour", fact: "TimeOfDay >= 2600", reachable: true },
  { state: "exhausted stamina", fact: "Stamina <= -15", reachable: true },
  { state: "freezePause (warp/cutscene transition)", fact: "FreezePaused", reachable: true },
  { state: "eating", fact: "Eating", reachable: true },
  { state: "a tool swing in progress", fact: "UsingTool", reachable: true },
  { state: "a charged tool", fact: "ToolCharged (toolPower != 0)", reachable: true },
  {
    state: "another body slot is owned (navigate/mount/bus/day)",
    fact: "ExecutionManager body exclusivity",
    reachable: true,
  },
]);

/** The extra clauses a site tests BEYOND the triple, which the migration keeps or drops deliberately. */
const EXTRA_CLAUSE_PATTERNS = Object.freeze([
  {
    text: "|| Game1.player.isEating",
    means: "already tests eating; the authority covers it too, so this clause becomes redundant",
  },
  { text: "|| Game1.dialogueUp", means: "already tests a dialogue; the authority's DialogueUp fact is the same fact" },
]);

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") values.set("json", "true");
    else if (arg.startsWith("--")) {
      values.set(arg.slice(2), args[index + 1]);
      index += 1;
    }
  }
  return values;
}

/** The enclosing method declaration for a line, walking back to the nearest member declaration. */
function enclosingMethod(lines, index) {
  for (let at = index; at >= 0; at -= 1) {
    const line = lines[at];
    if (/^\s{4}(private|internal|public|protected)\s/.test(line) && line.includes("(") && !line.trim().startsWith("//"))
      return {
        name: line
          .trim()
          .replace(/\s*\{?\s*$/, "")
          .slice(0, 120),
        line: at + 1,
      };
  }
  return { name: "(unknown)", line: null };
}

function findSites(sourceRoot) {
  const directory = join(sourceRoot, "integrations", "stardew");
  // A source root that is not there is "I could not look", not "there are no sites": reporting 0 for a missing
  // directory would read as a clean worklist, which is the one answer that must never be wrong here.
  if (!existsSync(directory)) throw new Error(`stardew_source_root_missing:${directory}`);
  const sites = [];
  for (const file of readdirSync(directory).filter((name) => /^farmhandexecutioncontroller.*\.cs$/.test(name))) {
    const text = readFileSync(join(directory, file), "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes(TRIPLE) && !line.includes(TRIPLE_ACTOR)) continue;
      // The split spelling (three separate guards with their own reason codes) is reported separately below.
      const method = enclosingMethod(lines, index);
      const extra = EXTRA_CLAUSE_PATTERNS.filter((pattern) => line.includes(pattern.text));
      sites.push({
        file,
        line: index + 1,
        spelling: line.includes(TRIPLE_ACTOR) ? "actor.CanMove variant" : "exact triple",
        method: method.name,
        methodLine: method.line,
        extraClauses: extra.map((pattern) => pattern.text),
      });
    }
  }
  // The other spelling: three guards, three reason codes, same three facts. The reason code sits on the NEXT
  // line (`if (...) \n return this.RememberTerminal(requestId, "player_menu_open", ...)`), so looking for it on
  // the same line misses it - which under-reported this spelling as 0 until a live count disagreed.
  const split = [];
  for (const file of readdirSync(directory).filter((name) => /^farmhandexecutioncontroller.*\.cs$/.test(name))) {
    const lines = readFileSync(join(directory, file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes("if (Game1.activeClickableMenu is not null)")) continue;
      const near = lines.slice(index, index + 4).join("\n");
      if (!near.includes("player_menu_open")) continue;
      const window = lines.slice(index, index + 16).join("\n");
      if (!window.includes("player_event_active") || !window.includes("player_cannot_move")) continue;
      const method = enclosingMethod(lines, index);
      split.push({
        file,
        line: index + 1,
        spelling: "three separate guards (player_menu_open / player_event_active / player_cannot_move)",
        method: method.name,
        methodLine: method.line,
        extraClauses: [],
      });
    }
  }
  return {
    fileCount: readdirSync(directory).filter((name) => /^farmhandexecutioncontroller.*\.cs$/.test(name)).length,
    sites: [...sites, ...split].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    splitCount: split.length,
  };
}

const values = parseArguments(process.argv.slice(2));
const sourceRoot = values.get("source-root") ?? ".";
let scanned;
try {
  scanned = findSites(sourceRoot);
} catch (error) {
  // "I could not look" is not "there are none": the one answer this must never give silently is a clean worklist.
  console.log(`stardew_admission_fork_delta_skipped: ${error.message}`);
  console.log("stardew_admission_fork_delta: blocked - a source root that is not there is not an empty worklist");
  process.exit(2);
}
const { fileCount, sites, splitCount } = scanned;
const exactTriple = sites.filter((site) => site.spelling === "exact triple").length;

const report = {
  artifactKind: "stardew_admission_fork_delta",
  status: sites.length === 0 ? "passed" : "failed",
  fileCount,
  siteCount: sites.length,
  exactTripleCount: exactTriple,
  splitSpellingCount: splitCount,
  /** Every site that converges becomes at least this much stricter, in states that all happen in normal play. */
  newlyRefusedStates: DELTA_STATES,
  sites: sites.map((site) => ({
    ...site,
    forkedGateAdmitsWhen: "menu absent AND no cutscene AND CanMove",
    sharedAdmissionAlsoRequires: "disposition == Idle",
    newlyRefused: DELTA_STATES.map((state) => state.state),
  })),
  /**
   * The decision this measurement exists for. Not a defect report: every forked site is MORE permissive than
   * the authority, so converging is a choice about how strict admission should be, and it can newly refuse a
   * request that would have worked (e.g. a tool use issued while the actor is eating).
   */
  decisionQuestion:
    "Should 'the actor body is in a transient/modal/pass-out state' refuse these actions uniformly? Yeh: the authority is single and the refusal is named. No: keep the forked sites and record them as deliberate.",
  nonGuarantees: [
    "site detection follows the two spellings that exist today; a third spelling would be missed until the reconciliation test's count changes",
    "the delta states are read from WorldModel's facts, not proven per action: whether a given action would ACTUALLY have worked in that state needs a live probe",
    "body-slot exclusivity is listed as a state but the specific slot each action claims is not enumerated here",
  ],
};

if (values.has("json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(
    `${report.artifactKind}: examined ${report.fileCount} file(s) · forked ${report.siteCount} ` +
      `(${report.exactTripleCount} exact triple, ${report.splitSpellingCount} split spelling)`,
  );
  if (report.siteCount === 0)
    console.log(`${report.artifactKind}: passed - every handler routes through the authority`);
  console.log("");
  for (const site of report.sites)
    console.log(
      `  ${site.file}:${site.line}  ${site.method}\n      ${site.spelling}${site.extraClauses.length ? ` (+ ${site.extraClauses.join(" ")})` : ""}`,
    );
  console.log("");
  console.log("Every converging site would ALSO refuse these states (the authority requires disposition Idle):");
  for (const state of report.newlyRefusedStates) console.log(`  - ${state.state}   [${state.fact}]`);
  console.log("");
  console.log(report.decisionQuestion);
}

// The assertion: the fork count is 0, so a future fork fails this. Exit 2 above is the blocked reading (no source root).
process.exit(report.siteCount === 0 ? 0 : 1);
