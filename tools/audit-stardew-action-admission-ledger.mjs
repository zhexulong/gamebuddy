/**
 * Re-derive the "现状台账" numbers of
 * design/architecture/stardew-action-execution-kernel.md from the Mod source.
 *
 * The document requires its ledger to be reproducible ("台账可复跑" in its
 * acceptance section). This is that reproducible command: every value is
 * derived from the source at a pinned revision, never hand-counted.
 *
 * Usage:
 *   node tools/audit-stardew-action-admission-ledger.mjs --rev <sha>
 *   node tools/audit-stardew-action-admission-ledger.mjs --rev <sha> --check
 *
 * `--check` compares the derived values against the table embedded below and
 * exits non-zero on drift, so the document's numbers can be asserted in CI
 * rather than trusted.
 */
import { execFileSync } from "node:child_process";

const LEDGER_FILE = "design/architecture/stardew-action-execution-kernel.md";
const MOD_GLOB = /farmhandexecutioncontroller.*\.cs$/;

function parseArgs(argv) {
  const options = { rev: "HEAD", check: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--rev") options.rev = argv[++index];
    else if (argv[index] === "--check") options.check = true;
    else throw new Error(`unknown_argument:${argv[index]}`);
  }
  if (!options.rev) throw new Error("missing_rev");
  return options;
}

/** Source files of the Mod execution controller at one revision, path -> text. */
function readModSources(rev) {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", rev, "--", "integrations/stardew/"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((file) => file.length > 0 && MOD_GLOB.test(file));
  return new Map(
    files.map((file) => [file, execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" })]),
  );
}

/**
 * Count lines matching `pattern`. Patterns are matched with a RegExp per line so
 * an exact reasonCode string is counted exactly, never as a substring of a
 * longer identifier (the reason this audit exists: `target_out_of_range` must
 * not absorb `observation_binding_target_out_of_range`).
 */
function countLines(sources, pattern) {
  const regex = new RegExp(pattern);
  let total = 0;
  for (const text of sources.values()) for (const line of text.split("\n")) if (regex.test(line)) total += 1;
  return total;
}

/**
 * Classify each `player_not_actionable` emission by the condition that produced
 * it, so admission baselines are never conflated with action-body checks.
 * The condition is on the emission line or the line directly above it.
 */
function classifyActionableGuards(sources) {
  const physical = [];
  const general = [];
  const bodyLevel = [];
  for (const [file, text] of sources) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes("player_not_actionable")) continue;
      const condition = lines[index].includes("if (") ? lines[index] : (lines[index - 1] ?? "");
      const where = `${file}:${index + 1}`;
      if (/UsingTool|toolPower/.test(condition)) physical.push(where);
      else if (/activeClickableMenu|eventUp|CanMove/.test(condition)) general.push(where);
      // Not an admission baseline: an action-body check that rejects because the
      // actor is holding something (cookout kit / crab pot), not because the
      // actor cannot act at all.
      else bodyLevel.push(where);
    }
  }
  return { physical, general, bodyLevel };
}

/** Handlers that are `Request*` and their per-handler revision/Guid shape. */
function deriveHandlerShape(sources) {
  let handlers = 0;
  const anomalies = [];
  for (const [file, text] of sources) {
    const starts = [...text.matchAll(/public LocalExecutionReceipt (Request\w+)\(/g)];
    handlers += starts.length;
    for (let index = 0; index < starts.length; index += 1) {
      const body = text.slice(
        starts[index].index,
        index + 1 < starts.length ? starts[index + 1].index : text.length,
      );
      const revisions = (body.match(/this\.revision\+\+/g) ?? []).length;
      const ids = (body.match(/Guid\.NewGuid\(\)/g) ?? []).length;
      if (revisions !== 1 || ids !== 1)
        anomalies.push(`${file}:${starts[index][1]} revision=${revisions} guid=${ids}`);
    }
  }
  return { handlers, anomalies };
}

const options = parseArgs(process.argv.slice(2));
const sources = readModSources(options.rev);

const derived = {
  requestHandlers: deriveHandlerShape(sources).handlers,
  idempotentLookup: countLines(sources, String.raw`receiptsByRequestId\.TryGetValue\(requestId, out .*existing\)`),
  revisionIncrements: countLines(sources, String.raw`this\.revision\+\+`),
  executionIds: countLines(sources, String.raw`Guid\.NewGuid\(\)\.ToString`),
  bodyOwned: countLines(sources, String.raw`"body_owned"`),
  invalidDeadline: countLines(sources, String.raw`"invalid_deadline"`),
  playerNotActionable: countLines(sources, String.raw`"player_not_actionable"`),
  targetOutOfRange: countLines(sources, String.raw`"target_out_of_range"`),
  boundActorReferences: countLines(sources, String.raw`TryGetBoundActor`),
};
const guards = classifyActionableGuards(sources);
const shape = deriveHandlerShape(sources);
// Expression handlers gate on `actor.isEmoting`; count only real conditions, so a
// comment that merely mentions the property is not miscounted as a guard site.
const expressiveSites = [...sources]
  .flatMap(([file, text]) =>
    text
      .split("\n")
      .map((line, index) => ({ file, index, line }))
      .filter(({ line }) => /if\s*\(.*isEmoting/.test(line))
      .map(({ file: f, index }) => `${f}:${index + 1}`),
  )
  .filter(Boolean);

const report = {
  rev: options.rev,
  fileCount: sources.size,
  ledgerRows: derived,
  actionableGuardProfiles: {
    physical: guards.physical.length,
    general: guards.general.length,
    bodyLevelNotAdmission: guards.bodyLevel.length,
    expressive: expressiveSites.length,
    physicalSites: guards.physical,
    generalSites: guards.general,
    bodyLevelSites: guards.bodyLevel,
    expressiveSites,
  },
  handlerShapeAnomalies: shape.anomalies,
};

// Values the document currently states. Kept here so `--check` fails loudly when
// the document and the source diverge in either direction.
const DOCUMENTED = {
  requestHandlers: 42,
  idempotentLookup: 39,
  revisionIncrements: 74,
  executionIds: 44,
  bodyOwned: 39,
  invalidDeadline: 38,
  playerNotActionable: 37,
  targetOutOfRange: 30,
  boundActorReferences: 19,
  physical: 8,
  general: 27,
  expressive: 2,
};

const drift = Object.entries(DOCUMENTED).filter(([key, value]) => {
  const actual = derived[key] ?? report.actionableGuardProfiles[key];
  return actual !== value;
});

console.log(JSON.stringify(report, null, 2));
if (drift.length > 0) {
  console.error(`\n${LEDGER_FILE} ledger drift:`);
  for (const [key, value] of drift)
    console.error(`  ${key}: document says ${value}, source has ${derived[key] ?? report.actionableGuardProfiles[key]}`);
}
if (options.check && drift.length > 0) process.exitCode = 1;
