#!/usr/bin/env node
/**
 * AN ARTEFACT THAT SAYS IT IS GENERATED MUST BE REPRODUCIBLE BY ITS OWN PRODUCER.
 *
 * Three incidents, one shape, two days: a file marked "generated" that nothing in the tree can regenerate, and a
 * reader who found out by diffing a hundred kilobytes by hand.
 *
 *   - `contracts/generated/native-multiplayer-sensitivity.v1.json` was hand-edited into a state its derive tool
 *     REFUSED (`action needs an explicit seam entry: use_mine_ladder`): 96 actions against a 106-action catalog,
 *     carrying 4 retired ids. Found only because a test compared action sets.
 *   - `contracts/generated/action-surface.v1.json` went stale twice in one day, once regenerated while a declaration
 *     still lagged, and once reverted by a lane's `restore`; nobody noticed until `plan_script_unknown_argument:<action>.charge`
 *     fired nine times.
 *   - `contracts/projection/action-source-projection.v1.json` drifted by 3 lines after 0d4ce1b2, and the drift test
 *     said `180614 !== 180548` - a byte count, not the member that moved.
 *
 * In every case the file said it was derived, nothing asserted that it COULD be derived, and the truth was recovered
 * by a human reading two documents side by side.
 *
 * POPULATION - DERIVED, THEN PAIRED. An artefact claims derivation two ways, both read from the tree rather than
 * listed here:
 *
 *   1. WHERE IT LIVES. A tracked path under a directory named `generated/` or `derived/`. A directory named `inputs/`
 *      is the one stated exclusion: those are pinned INPUT copies of another tree's artefact, not artefacts this tree
 *      owns, and the count of them is printed rather than folded away.
 *   2. WHAT ITS HEADER SAYS. A comment marker on one of the first three lines naming the file as generated
 *      (`// GENERATED`, `# AUTO-GENERATED`, an `@generated` marker). A JSON artefact that claims derivation only in prose
 *      has no header to read, so it is not found by this scan - the declared map below covers the JSON artefacts this
 *      tree has, and that limit is stated instead of hidden.
 *
 * Every claimant is paired with a producer from `ARTEFACT_PRODUCERS`. An artefact that claims derivation and has NO
 * declared producer is `generated_artifact_without_producer:<path>` - a finding, never a pass. That is exactly the
 * mp-sensitivity shape: the tree says "generated", and nothing can generate it.
 *
 * REPRODUCTION. Each declared artefact is re-derived INTO A TEMP PATH - never over the tracked file - and compared
 * byte for byte. A producer that writes its own output relative to its working directory is run in a sandbox under
 * `SANDBOX_ROOT` (the repository's gitignored `.tmp/`, so hard links and junctions stay on one volume) whose read
 * paths are junctions and hard links to the real tree and whose output path is a real empty directory. A mismatch is
 * `generated_artifact_not_reproducible:<path>:<line>:<member>`: the line is the artefact's own first differing line
 * and the member comes from a structural JSON diff that names action ids and array values, so the reader sees
 * `host.adapterActionIds: sweep_scythe` instead of two byte counts.
 *
 * THREE DISPOSITIONS, NEVER A SILENT PASS.
 *
 *   - `reproduced`: the producer's bytes equal the artefact's.
 *   - `not_re_derived:inputs_unchanged`: no declared input is newer than the artefact, so the producer's cost is not
 *     spent. The item is still named in the population and in the count. What this does NOT verify: a change deep
 *     inside a declared input DIRECTORY does not move that directory's own mtime, so `--re-derive-all` is the reading
 *     that covers a re-decompile or a directory reshuffle.
 *   - `not_re_derived:declared_by_test`: the artefact's only writer is a test that writes the tracked file in place
 *     (`snapshot-sample.v1.json`). It is counted in its own bucket - never reproduced, never a failure - and
 *     `--with-test-producers` runs that test, compares, and restores the artefact's original bytes either way.
 *
 * WHERE THE PRODUCER LIVES IS READ FROM THE TREE. The Mod export producer is a BUILD OUTPUT, and which configuration it
 * was built in depends on the tool that built it: the witness that wrote this gate saw `bin/Debug/net6.0/...`, while the
 * Mod build this repository makes (`build:stardew`, and the ladder) is `-c Release` and leaves only
 * `bin/Release/net6.0/...`. Pinning one configuration turned a tree that carried the assembly all along into
 * `missing_input`. Every `bin/<configuration>/<framework>/<assembly>` the tree holds is a candidate, the newest mtime
 * wins, and the report names the one it used - a Debug build never wins silently.
 *
 * A producer that cannot run - no build of the Mod export project, `dotnet` is absent, the producer exits non-zero - is
 * BLOCKED (exit 2) naming the project and the command that builds it, never green: "I could not measure this" and "the
 * artefact is correct" are different statements. `examined 0` is blocked for the same reason.
 *
 * USAGE:
 *   node tools/check-generated-artifact-reproducibility.mjs                    # the ladder's run
 *   node tools/check-generated-artifact-reproducibility.mjs --re-derive-all    # measure every item now
 *   node tools/check-generated-artifact-reproducibility.mjs --with-test-producers
 *
 * red-proof: history  `230775c7^`'s register laid over a copy of the tree outside the repo -> at its line 61, `$.declaredActionIds` and `$.actions by actionId`: the four retired ids it carries and the fifteen members the producer emits that it does not, exit 1
 * red-proof: history  the three-line projection drift put back (`sweep_scythe` dropped from the host lists) -> its line 4642, `$.mod.experimentalActionIds` and each host list, naming `sweep_scythe` rather than two byte counts, exit 1
 * red-proof: inject   an empty file at a `generated/` path in the same copy -> `generated_artifact_without_producer:<that path>`, exit 1
 * red-proof: inject   the assembly resolution pinned back to a Debug build (the pre-fix file replayed on a tree whose export project carries only a Release build) -> `generated_artifact_producer_unavailable:<each surface artefact>:missing_input`, `reproduced 2`, exit 2; this file reads `reproduced 5 · declared_by_test 1`, exit 0 (measured 2026-11-12)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const GATE_ID = "generated-artifact-reproducibility";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The gitignored scratch area the sandboxed producers write into: same volume as the tree, outside every rung. */
export const SANDBOX_ROOT = ".tmp/generated-artefact-reproducibility";

/** A path that claims derivation by where it lives. */
export const DERIVATION_PATH_CLAIM = /(?:^|\/)(?:generated|derived)\//u;

/** A tree named `inputs/` holds pinned input copies of other artefacts, not artefacts this tree produces. */
export const PINNED_INPUT_TREE = /(?:^|\/)inputs\//u;

/** A comment marker naming the file as generated, matched only in the header (see `CLAIM_HEADER_LINES`). */
export const DERIVATION_MARKER_CLAIM =
  /^[ \t]*(?:\/\/|\/\*|\*|#|<!--)[ \t]*(?:@generated\b|generated[ \t]+(?:file|by|artefact|artifact)\b|auto-?generated\b)/iu;

/** How many leading lines count as a header: a claim below this is prose in the body, not a claim about the file. */
export const CLAIM_HEADER_LINES = 3;

const CONTRACTS = "integrations/stardew/action-development/contracts";
const SURFACE = `${CONTRACTS}/generated/action-surface.v1.json`;
const DEADLINE_WINDOWS = `${CONTRACTS}/generated/action-deadline-windows.v1.json`;
const HANDLER_GROUPS = `${CONTRACTS}/generated/action-handler-groups.v1.json`;
const REGISTER = `${CONTRACTS}/generated/native-multiplayer-sensitivity.v1.json`;
const SNAPSHOT_SAMPLE = `${CONTRACTS}/generated/snapshot-sample.v1.json`;
const PROJECTION = `${CONTRACTS}/projection/action-source-projection.v1.json`;
const MOD_EXPORT_DIRECTORY = "integrations/stardew/tests/actiondevelopmentactionsurfaceexport";
const MOD_EXPORT_PROJECT = `${MOD_EXPORT_DIRECTORY}/actiondevelopmentactionsurfaceexport.csproj`;
const MOD_EXPORT_ASSEMBLY = "GameBuddy.Stardew.ActionDevelopmentActionSurfaceExport.dll";

/** How a build-output producer is found: any configuration the tree carries, newest first (see `resolveBuildOutput`). */
const MOD_EXPORT_RESOLUTION = Object.freeze({
  directory: MOD_EXPORT_DIRECTORY,
  name: MOD_EXPORT_ASSEMBLY,
  project: MOD_EXPORT_PROJECT,
  build: `dotnet build ${MOD_EXPORT_PROJECT} -c Release`,
});
const REGISTER_PRODUCER = "tools/derive-stardew-native-multiplayer-sensitivity-register.mjs";
const PROJECTION_PRODUCER = "integrations/stardew/action-development/src/action-source-projection-producer.mjs";
const SNAPSHOT_SAMPLE_PROJECT =
  "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj";
const SNAPSHOT_SAMPLE_TEST =
  "GameBuddy.Stardew.Integration.Tests.SnapshotLoopbackExportTests.PublishesEveryFamilyTheHeadlessWorldCanHonestlyConstruct";

/** The Mod's own declaration is the surface's input: the catalog, the publication projection, and the export harness. */
const SURFACE_INPUTS = Object.freeze([
  "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
  "integrations/stardew/src/Core/Policy/farmhandactionsurfacepublication.cs",
  "integrations/stardew/src/Core/Policy/FarmhandActionDeadlineWindowExport.cs",
  "integrations/stardew/src/Core/Policy/FarmhandActionHandlerGroupExport.cs",
  MOD_EXPORT_PROJECT,
]);

/**
 * The declaration, one row per artefact.
 *
 * `producer` is the invocation a reader would type. `run` is how this gate performs it:
 *   stdout                    - the producer writes its artefact to stdout and no file.
 *   sandboxed_relative_writer - the producer writes a cwd-relative path, so it runs in a sandbox (see `sandbox`).
 *   in_place_test             - the producer is a test that writes the tracked file itself; only `--with-test-producers`
 *                               runs it, and the artefact's original bytes are restored either way.
 *
 * `resolve` marks a producer that lives in a build output rather than at a fixed path: the gate finds the newest
 * `bin/<configuration>/<framework>/<name>` under `directory` and runs that one, so building `-c Release` is not a
 * missing prerequisite. A tree with no build at all is blocked with `project` and `build` named.
 *
 * `inputs` is what decides whether the producer's cost is spent: a file or a directory, compared by mtime against the
 * artefact. The projection's list is the producer's own `ACTION_SOURCE_PATHS` read at the coarsest grain that stays
 * true (`tools/` because `runner_sources` reads that whole directory), so a stale artefact is re-derived rather than
 * skipped whenever any of those sources moved.
 */
export const ARTEFACT_PRODUCERS = Object.freeze([
  {
    artefact: SURFACE,
    producer: `dotnet ${MOD_EXPORT_DIRECTORY}/bin/<configuration>/<framework>/${MOD_EXPORT_ASSEMBLY}`,
    resolve: MOD_EXPORT_RESOLUTION,
    run: { kind: "stdout", command: "dotnet", args: [] },
    requires: { commands: ["dotnet"], paths: [MOD_EXPORT_PROJECT] },
    inputs: SURFACE_INPUTS,
  },
  {
    artefact: DEADLINE_WINDOWS,
    producer: `dotnet ${MOD_EXPORT_DIRECTORY}/bin/<configuration>/<framework>/${MOD_EXPORT_ASSEMBLY} --deadline-windows`,
    resolve: MOD_EXPORT_RESOLUTION,
    run: { kind: "stdout", command: "dotnet", args: ["--deadline-windows"] },
    requires: { commands: ["dotnet"], paths: [MOD_EXPORT_PROJECT] },
    inputs: SURFACE_INPUTS,
  },
  {
    artefact: HANDLER_GROUPS,
    producer: `dotnet ${MOD_EXPORT_DIRECTORY}/bin/<configuration>/<framework>/${MOD_EXPORT_ASSEMBLY} --handler-groups`,
    resolve: MOD_EXPORT_RESOLUTION,
    run: { kind: "stdout", command: "dotnet", args: ["--handler-groups"] },
    requires: { commands: ["dotnet"], paths: [MOD_EXPORT_PROJECT] },
    inputs: SURFACE_INPUTS,
  },
  {
    artefact: REGISTER,
    producer: `node ${REGISTER_PRODUCER} (sandboxed at its cwd-relative output)`,
    run: {
      kind: "sandboxed_relative_writer",
      script: REGISTER_PRODUCER,
      sandbox: {
        output: REGISTER,
        linkTrees: ["ref", "integrations/stardew/Handlers", "integrations/stardew/src"],
        linkFiles: [{ directory: "integrations/stardew", pattern: /^farmhandexecutioncontroller\..*\.cs$/u }],
      },
    },
    requires: {
      commands: [],
      paths: ["integrations/stardew/Handlers", "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"],
    },
    inputs: [
      "integrations/stardew/Handlers",
      "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
      "integrations/stardew",
      "ref/external/StardewValleyDecompiled/Stardew Valley",
    ],
  },
  {
    artefact: PROJECTION,
    producer: `node ${PROJECTION_PRODUCER}`,
    run: { kind: "stdout", command: process.execPath, args: [PROJECTION_PRODUCER] },
    requires: { commands: [], paths: [PROJECTION_PRODUCER] },
    inputs: [
      SURFACE,
      "integrations/stardew/BridgeSession.cs",
      "integrations/stardew/farmhandexecutioncontroller.cs",
      "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs",
      HANDLER_GROUPS,
      "host/src/action-registry.ts",
      "host/src/game-tools.ts",
      "host/src/protocol.ts",
      "protocol/bridge-v1.schema.json",
      "tools/stardew-action-gate-descriptors.mjs",
      "tools",
    ],
  },
  {
    artefact: SNAPSHOT_SAMPLE,
    producer: `xunit ${SNAPSHOT_SAMPLE_TEST} (in-place export)`,
    disposition: "declared_by_test",
    run: {
      kind: "in_place_test",
      command: "dotnet",
      args: ["test", SNAPSHOT_SAMPLE_PROJECT, "--filter", `FullyQualifiedName~${SNAPSHOT_SAMPLE_TEST}`, "--nologo"],
      test: SNAPSHOT_SAMPLE_TEST,
    },
    requires: { commands: ["dotnet"], paths: [SNAPSHOT_SAMPLE_PROJECT] },
    inputs: [
      "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SnapshotLoopbackExportTests.cs",
      "integrations/stardew/src/Core/Models",
      "integrations/stardew/Sensory",
    ],
  },
]);

const RULE_CODES = Object.freeze([
  "generated_artifact_without_producer",
  "generated_artifact_not_reproducible",
  "declared_producer_without_artefact",
  "generated_artifact_producer_unavailable",
]);

/** Identity members a structural diff aligns an array of objects on, in preference order. */
const IDENTITY_KEYS = Object.freeze(["actionId", "id", "name", "category", "path", "key"]);

/** How many member differences a single finding carries. A hundred would be a document, not a cause. */
const MAX_DIFFERENCES = 4;

const PRODUCER_TIMEOUT_MS = 120_000;

/**
 * The tracked files of the tree. One `git ls-files`, because the population is what the tree owns: an untracked
 * scratch artefact is not a claim the repository makes. A path the index still carries but the worktree no longer has
 * is not an artefact either - a lane's deletion is the tree saying the file is gone before the commit says so.
 */
export function trackedFiles({ root = REPOSITORY_ROOT, run = runCommand } = {}) {
  const outcome = run("git", ["ls-files", "-z"], { cwd: root });
  if (outcome.status !== 0) throw new Error(`generated_artifact_git_ls_files_failed:${outcome.status}`);
  return outcome.stdout
    .toString("utf8")
    .split("\u0000")
    .filter((entry) => entry.length > 0)
    .filter((entry) => fs.existsSync(path.join(root, entry)));
}

/**
 * The population: every tracked file that claims derivation, minus the pinned-input tree, plus the declared artefacts
 * (a declared artefact that carries no marker is still examined, and one that is missing is a finding).
 */
export function discoverClaimants({ root = REPOSITORY_ROOT, tracked = null, producers = ARTEFACT_PRODUCERS } = {}) {
  const files = tracked ?? trackedFiles({ root });
  const claimants = [];
  const pinnedInputs = [];
  for (const file of files) {
    if (!DERIVATION_PATH_CLAIM.test(file)) continue;
    if (PINNED_INPUT_TREE.test(file)) {
      pinnedInputs.push({ path: file, reason: "a copy pinned under an inputs/ tree, not an artefact this tree emits" });
      continue;
    }
    claimants.push({ path: file, claim: "path" });
  }
  for (const entry of producers) {
    if (claimants.some((claimant) => claimant.path === entry.artefact)) continue;
    // A declared artefact is examined whether or not it carries a marker; one that is not on disk is not added, so
    // `classifyPopulation` reports the declaration as outliving its artefact instead of this scan inventing a claimant.
    if (!fs.existsSync(path.join(root, entry.artefact))) continue;
    claimants.push({ path: entry.artefact, claim: "declared" });
  }
  const headerClaimed = files
    .filter((file) => !DERIVATION_PATH_CLAIM.test(file))
    .filter((file) => headerClaimsDerivation(path.join(root, file)))
    .filter((file) => !claimants.some((claimant) => claimant.path === file));
  for (const file of headerClaimed) claimants.push({ path: file, claim: "header" });
  return {
    claimants: claimants.sort((left, right) => left.path.localeCompare(right.path)),
    pinnedInputs,
  };
}

/** Whether one of the first `CLAIM_HEADER_LINES` lines says the file was generated. */
export function headerClaimsDerivation(absolutePath, read = (target) => fs.readFileSync(target, "utf8")) {
  let text;
  try {
    text = read(absolutePath);
  } catch {
    return false;
  }
  return text
    .split(/\r?\n/u)
    .slice(0, CLAIM_HEADER_LINES)
    .some((line) => DERIVATION_MARKER_CLAIM.test(line));
}

/** The map's index: artefact path -> declaration. */
export function producerIndex(producers = ARTEFACT_PRODUCERS) {
  const index = new Map();
  for (const entry of producers) index.set(entry.artefact, entry);
  return index;
}

/** The population's three counts, computed before any producer runs so a blocked run still states its population. */
export function classifyPopulation({ claimants, producers = ARTEFACT_PRODUCERS }) {
  const index = producerIndex(producers);
  const undeclared = claimants.filter((claimant) => !index.has(claimant.path)).map((claimant) => claimant.path);
  const declared = claimants.filter((claimant) => index.has(claimant.path));
  const declaredByTest = declared.filter((claimant) => index.get(claimant.path).disposition === "declared_by_test");
  const declaredProducersWithoutArtefact = producers
    .filter((entry) => !claimants.some((claimant) => claimant.path === entry.artefact))
    .map((entry) => entry.artefact);
  return {
    examined: claimants.length,
    declaredProducer: declared.length,
    undeclared,
    declaredByTest: declaredByTest.length,
    declaredProducersWithoutArtefact,
  };
}

/** The first byte at which two buffers part company, or -1 when they are identical. */
export function firstDifferingByte(produced, artefact) {
  const limit = Math.min(produced.length, artefact.length);
  for (let offset = 0; offset < limit; offset += 1) if (produced[offset] !== artefact[offset]) return offset;
  return produced.length === artefact.length ? -1 : limit;
}

/** A 1-based line number for a byte offset in a buffer. */
export function lineAt(buffer, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < buffer.length; index += 1) if (buffer[index] === 0x0a) line += 1;
  return line;
}

function render(value, limit = 48) {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function isPrimitive(value) {
  return value === null || typeof value !== "object";
}

/** The member an array of objects is aligned on, when every element of both sides carries the same one. */
function identityKey(produced, artefact) {
  if (produced.length === 0 || artefact.length === 0) return null;
  if (
    ![...produced, ...artefact].every((value) => value !== null && typeof value === "object" && !Array.isArray(value))
  ) {
    return null;
  }
  return (
    IDENTITY_KEYS.find((key) =>
      [...produced, ...artefact].every((value) => typeof value[key] === "string" && value[key] !== ""),
    ) ?? null
  );
}

function push(out, entry) {
  if (out.length < MAX_DIFFERENCES) out.push(entry);
}

function diffValue(produced, artefact, at, out) {
  if (out.length >= MAX_DIFFERENCES) return;
  if (isPrimitive(produced) || isPrimitive(artefact)) {
    if (render(produced) !== render(artefact)) {
      push(out, { path: at, detail: `the artefact says ${render(artefact)}, the producer emits ${render(produced)}` });
    }
    return;
  }
  if (Array.isArray(produced) !== Array.isArray(artefact)) {
    push(out, {
      path: at,
      detail: `the artefact is an ${Array.isArray(artefact) ? "array" : "object"}, the producer emits ${Array.isArray(produced) ? "an array" : "an object"}`,
    });
    return;
  }
  if (Array.isArray(produced)) {
    diffArray(produced, artefact, at, out);
    return;
  }
  const keys = [...new Set([...Object.keys(produced), ...Object.keys(artefact)])];
  for (const key of keys) diffValue(produced[key], artefact[key], `${at}.${key}`, out);
}

function diffArray(produced, artefact, at, out) {
  if (out.length >= MAX_DIFFERENCES) return;
  // An array of primitives names its members, not their positions: the projection's three host lists are sorted id
  // lists, and "index 57" would tell a reader nothing about `sweep_scythe`.
  if (produced.every(isPrimitive) && artefact.every(isPrimitive)) {
    const producedSet = new Set(produced);
    const artefactSet = new Set(artefact);
    const onlyArtefact = artefact.filter((value) => !producedSet.has(value));
    const onlyProduced = produced.filter((value) => !artefactSet.has(value));
    if (onlyArtefact.length > 0) {
      push(out, {
        path: at,
        detail: `the artefact carries ${onlyArtefact.length} member(s) the producer does not emit: ${onlyArtefact
          .slice(0, 6)
          .map((value) => render(value, 32))
          .join(", ")}`,
      });
    }
    if (onlyProduced.length > 0) {
      push(out, {
        path: at,
        detail: `the producer emits ${onlyProduced.length} member(s) the artefact does not carry: ${onlyProduced
          .slice(0, 6)
          .map((value) => render(value, 32))
          .join(", ")}`,
      });
    }
    if (onlyArtefact.length === 0 && onlyProduced.length === 0 && produced.join("\u0000") !== artefact.join("\u0000")) {
      const index = produced.findIndex((value, position) => value !== artefact[position]);
      push(out, {
        path: `${at}[${index}]`,
        detail: `same members, different order: the producer has ${render(produced[index])} where the artefact has ${render(artefact[index])}`,
      });
    }
    return;
  }
  const key = identityKey(produced, artefact);
  if (key !== null) {
    const byId = (values) => new Map(values.map((value) => [value[key], value]));
    const producedById = byId(produced);
    const artefactById = byId(artefact);
    const onlyArtefact = [...artefactById.keys()].filter((id) => !producedById.has(id));
    const onlyProduced = [...producedById.keys()].filter((id) => !artefactById.has(id));
    if (onlyArtefact.length > 0) {
      push(out, {
        path: `${at} by ${key}`,
        detail: `the artefact carries ${onlyArtefact.length} member(s) the producer does not emit: ${onlyArtefact.slice(0, 6).join(", ")}`,
      });
    }
    if (onlyProduced.length > 0) {
      push(out, {
        path: `${at} by ${key}`,
        detail: `the producer emits ${onlyProduced.length} member(s) the artefact does not carry: ${onlyProduced.slice(0, 6).join(", ")}`,
      });
    }
    for (const [id, value] of producedById) {
      if (out.length >= MAX_DIFFERENCES) return;
      if (artefactById.has(id)) diffValue(value, artefactById.get(id), `${at}[${id}]`, out);
    }
    return;
  }
  const shared = Math.min(produced.length, artefact.length);
  for (let index = 0; index < shared && out.length < MAX_DIFFERENCES; index += 1) {
    diffValue(produced[index], artefact[index], `${at}[${index}]`, out);
  }
  if (produced.length !== artefact.length) {
    push(out, {
      path: at,
      detail: `the producer emits ${produced.length} entries where the artefact carries ${artefact.length}`,
    });
  }
}

/**
 * What two artefacts disagree about, named by line and member. JSON is diffed structurally so the answer is a member
 * (`host.adapterActionIds: sweep_scythe`); anything that is not JSON is named by its first differing line only.
 */
export function describeMismatch({ producedBytes, artefactBytes }) {
  const offset = firstDifferingByte(producedBytes, artefactBytes);
  if (offset < 0) return null;
  const line = lineAt(artefactBytes, offset);
  const producedText = producedBytes.toString("utf8");
  const artefactText = artefactBytes.toString("utf8");
  let produced = null;
  let artefact = null;
  try {
    produced = JSON.parse(producedText);
    artefact = JSON.parse(artefactText);
  } catch {
    produced = null;
    artefact = null;
  }
  if (produced === null || artefact === null) {
    const artefactLine = artefactText.split(/\r?\n/u)[line - 1] ?? "";
    const producedLine = producedText.split(/\r?\n/u)[line - 1] ?? "";
    return {
      line,
      member: "(text)",
      detail: `the artefact's line ${line} reads ${render(artefactLine.trim(), 80)} and the producer's reads ${render(producedLine.trim(), 80)}`,
    };
  }
  const differences = [];
  diffValue(produced, artefact, "$", differences);
  if (differences.length === 0) {
    return {
      line,
      member: "(formatting)",
      detail: `the same JSON, byte-different from offset ${offset}: the artefact is ${artefactBytes.length} bytes and the producer emits ${producedBytes.length}`,
    };
  }
  const first = differences[0];
  return {
    line,
    member: first.path,
    detail: [first, ...differences.slice(1)].map((entry) => `${entry.path}: ${entry.detail}`).join("; "),
  };
}

function runCommand(command, args, options) {
  const outcome = spawnSync(command, args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    timeout: PRODUCER_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
    ...options,
  });
  return {
    status: typeof outcome.status === "number" ? outcome.status : 1,
    stdout: outcome.stdout ?? Buffer.alloc(0),
    stderr: outcome.stderr ?? Buffer.alloc(0),
    error: outcome.error ?? null,
  };
}

/** The newest mtime of a declared input: a file's own, or the directory's (the entry that moved, not its contents). */
export function newestInputTime(root, inputs) {
  let newest = 0;
  let newestPath = null;
  for (const input of inputs) {
    let stat;
    try {
      stat = fs.statSync(path.join(root, input));
    } catch {
      continue;
    }
    if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
      newestPath = input;
    }
  }
  return { mtimeMs: newest, path: newestPath };
}

/** Whether the gate should spend this producer's cost: any declared input newer than the artefact it produced. */
export function inputsMovedSince({ root, entry, artefact }) {
  let artefactStat;
  try {
    artefactStat = fs.statSync(path.join(root, entry.artefact));
  } catch {
    return { moved: true, reason: "artefact_missing" };
  }
  const newest = newestInputTime(root, entry.inputs ?? []);
  if (newest.path === null) return { moved: true, reason: "no_declared_input_resolved" };
  return {
    moved: newest.mtimeMs > artefactStat.mtimeMs,
    reason: newest.mtimeMs > artefactStat.mtimeMs ? `input_newer:${newest.path}` : "inputs_unchanged",
    newest,
    artefactMtimeMs: artefactStat.mtimeMs,
  };
}

function missingPrerequisites(root, entry) {
  for (const command of entry.requires?.commands ?? []) {
    const probe = spawnSync(command, ["--version"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 60_000,
    });
    if (probe.error?.code === "ENOENT") return `missing_toolchain:${command}`;
  }
  for (const required of entry.requires?.paths ?? []) {
    if (!fs.existsSync(path.join(root, required))) return `missing_input:${required}`;
  }
  if (entry.run.kind === "sandboxed_relative_writer") {
    for (const tree of entry.run.sandbox.linkTrees) {
      if (!fs.existsSync(path.join(root, tree))) return `missing_input:${tree}`;
    }
  }
  return null;
}

/** A tree-relative, forward-slashed path: one spelling for the report and for a command a reader could type. */
function toTreePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function directoriesIn(absolute) {
  let names;
  try {
    names = fs.readdirSync(absolute);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        // Through the link: a lane may have junctioned `bin/Release` into place, and that is still the build the tree has.
        return fs.statSync(path.join(absolute, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * The build output the tree actually has, in whichever configuration it was built.
 *
 * The configuration is not a property of this gate. A lane's witness recorded `bin/Debug/net6.0/...` and every build
 * on the ladder is `-c Release`, so a pinned configuration turned a tree that carried the assembly all along into
 * `missing_input` - a blocked gate reading as a defect in the artefact. Every `bin/<configuration>/<framework>/<name>`
 * the tree holds is a candidate; the newest mtime wins, the path breaks a tie so two readings of one tree cannot
 * disagree, and the caller prints the one it used.
 */
function resolveBuildOutput({ root, directory, name }) {
  const bin = path.join(root, directory, "bin");
  const configurations = directoriesIn(bin);
  const candidates = [];
  for (const configuration of configurations) {
    for (const framework of directoriesIn(path.join(bin, configuration))) {
      const assembly = path.join(bin, configuration, framework, name);
      let stat;
      try {
        stat = fs.statSync(assembly);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      candidates.push({ configuration, path: toTreePath(root, assembly), mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return { searched: configurations, candidates, chosen: candidates[0] ?? null };
}

/**
 * The entry as it will run: prerequisites checked, and a producer that lives in a build output resolved to the assembly
 * the tree carries. No build is a stated reason naming the project and the command, never a silent skip.
 */
function resolveProducer(root, entry) {
  const missing = missingPrerequisites(root, entry);
  if (missing !== null) return { status: "blocked", reason: missing, detail: entry.producer };
  if (entry.resolve === undefined) return { status: "ready", entry };
  const resolution = resolveBuildOutput({ root, directory: entry.resolve.directory, name: entry.resolve.name });
  if (resolution.chosen === null) {
    const searched = resolution.searched.length === 0 ? "no configuration" : resolution.searched.join(", ");
    return {
      status: "blocked",
      reason: `missing_built_assembly:${entry.resolve.project}`,
      detail:
        `no bin/<configuration>/<framework>/${entry.resolve.name} under ${entry.resolve.directory} carries it ` +
        `(searched: ${searched}); build it with: ${entry.resolve.build}`,
    };
  }
  const args = [resolution.chosen.path, ...entry.run.args];
  return {
    status: "ready",
    entry: {
      ...entry,
      producer: `${entry.run.command} ${args.join(" ")}`,
      assembly: {
        path: resolution.chosen.path,
        configuration: resolution.chosen.configuration,
        builds: resolution.candidates.length,
      },
      run: { ...entry.run, args },
    },
  };
}

/**
 * Run one producer into a temp path. The sandboxed writer gets a root whose read paths are junctions/hard links into
 * the real tree and whose output path is a real empty directory, so the tracked artefact is never opened for writing.
 */
export function deriveInSandbox({ root, entry, sandboxPath, run = runCommand }) {
  const { sandbox, script } = entry.run;
  fs.rmSync(sandboxPath, { recursive: true, force: true });
  try {
    for (const tree of sandbox.linkTrees) {
      const link = path.join(sandboxPath, tree);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(root, tree), link, "junction");
    }
    for (const group of sandbox.linkFiles ?? []) {
      for (const name of fs.readdirSync(path.join(root, group.directory))) {
        if (!group.pattern.test(name)) continue;
        fs.linkSync(path.join(root, group.directory, name), path.join(sandboxPath, group.directory, name));
      }
    }
    const output = path.join(sandboxPath, sandbox.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const outcome = run(process.execPath, [path.join(root, script)], { cwd: sandboxPath });
    if (outcome.status !== 0) {
      return {
        status: "unavailable",
        reason: `producer_failed:${outcome.status}:${outcome.stderr.toString("utf8").split("\n")[0].slice(0, 200)}`,
      };
    }
    return { status: "measured", bytes: fs.readFileSync(output) };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `sandbox_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    fs.rmSync(sandboxPath, { recursive: true, force: true });
  }
}

/** Run one producer to stdout, with the tree as its working directory. */
export function deriveToStdout({ root, entry, run = runCommand }) {
  const outcome = run(entry.run.command, entry.run.args, { cwd: root });
  if (outcome.error?.code === "ENOENT")
    return { status: "unavailable", reason: `missing_toolchain:${entry.run.command}` };
  if (outcome.status !== 0) {
    return {
      status: "unavailable",
      reason: `producer_failed:${outcome.status}:${outcome.stderr.toString("utf8").split("\n")[0].slice(0, 200)}`,
    };
  }
  return { status: "measured", bytes: outcome.stdout };
}

/**
 * The test-owned producer. It writes the tracked file itself, so the gate reads the artefact's bytes before the run,
 * runs the test, compares, and puts the original bytes back - the tree is left exactly as it was found, whatever the
 * test wrote.
 */
export function deriveWithInPlaceTest({ root, entry, run = runCommand }) {
  const artefact = path.join(root, entry.artefact);
  const original = fs.readFileSync(artefact);
  let after = null;
  try {
    const outcome = run(entry.run.command, entry.run.args, { cwd: root });
    if (outcome.status !== 0) {
      return {
        status: "unavailable",
        reason: `producer_failed:${outcome.status}:${
          outcome.stdout
            .toString("utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .pop()
            ?.slice(0, 200) ?? ""
        }`,
      };
    }
    after = fs.readFileSync(artefact);
    return { status: "measured", bytes: after };
  } finally {
    if (after === null || Buffer.compare(original, after) !== 0) fs.writeFileSync(artefact, original);
  }
}

function ruleOutcome(id, { status, findings }) {
  if (status === "blocked")
    return { status: "blocked", detail: "the run could not measure, so this rule was not exercised" };
  const named = findings.filter((finding) => finding.code.startsWith(id));
  return {
    status: named.length === 0 ? "passed" : "failed",
    detail: named.length === 0 ? "no violation" : named.map((finding) => finding.code).join("; "),
  };
}

/**
 * The gate. `reDeriveAll` measures every declared artefact now (the reading that covers a directory reshuffle);
 * `withTestProducers` runs the test-owned producer and restores the artefact either way.
 */
export function runGate(root = REPOSITORY_ROOT, options = {}) {
  let written = "";
  let writtenError = "";
  const code = decide(
    root,
    options,
    (text) => {
      written += text;
    },
    (text) => {
      writtenError += text;
    },
  );
  return { code, stdout: written, stderr: writtenError };
}

function decide(root, options, out, err) {
  const {
    reDeriveAll = false,
    withTestProducers = false,
    run = runCommand,
    tracked = null,
    producers = ARTEFACT_PRODUCERS,
  } = options;
  let discovered;
  try {
    discovered = discoverClaimants({ root, tracked, producers });
  } catch (error) {
    err(`${GATE_ID}_blocked:${error instanceof Error ? error.message : String(error)}\n`);
    report(out, { status: "blocked", examined: 0, findings: [], blocked: null });
    return 2;
  }
  const classification = classifyPopulation({ claimants: discovered.claimants, producers });
  const findings = [];
  for (const claim of discovered.pinnedInputs) {
    out(`pinned_input:${claim.path} (${claim.reason})\n`);
  }
  for (const path of classification.undeclared) {
    findings.push({
      code: `generated_artifact_without_producer:${path}`,
      detail:
        "the file claims derivation and no producer in tools/check-generated-artifact-reproducibility.mjs emits it",
    });
  }
  for (const path of classification.declaredProducersWithoutArtefact) {
    findings.push({
      code: `declared_producer_without_artefact:${path}`,
      detail: "a producer is declared for a path no tracked artefact carries, so the declaration outlived its artefact",
    });
  }

  const index = producerIndex(producers);
  const counts = { reproduced: 0, inputsUnchanged: 0, declaredByTest: 0, mismatched: 0 };
  /** artefact path -> the build output its bytes came from, for the artefacts whose producer was resolved from a build. */
  const producerAssemblies = {};
  let blocked = null;
  const sandboxRoot = path.join(root, SANDBOX_ROOT);
  for (const claimant of discovered.claimants) {
    const entry = index.get(claimant.path);
    if (entry === undefined) continue;
    const artefactPath = path.join(root, entry.artefact);

    if (entry.disposition === "declared_by_test" && !withTestProducers) {
      const staleness = inputsMovedSince({ root, entry, artefact: artefactPath });
      counts.declaredByTest += 1;
      out(
        `not_re_derived:declared_by_test:${entry.artefact}:${entry.run.test}` +
          `${staleness.moved ? " (an input moved: " + staleness.reason + ")" : " (inputs unchanged)"} - ` +
          `its only writer is a test that writes the artefact in place; run --with-test-producers to measure it\n`,
      );
      continue;
    }

    if (entry.disposition !== "declared_by_test" && !reDeriveAll) {
      const staleness = inputsMovedSince({ root, entry, artefact: artefactPath });
      if (!staleness.moved) {
        counts.inputsUnchanged += 1;
        out(
          `not_re_derived:inputs_unchanged:${entry.artefact} (newest input ${staleness.newest.path} is older than the artefact)\n`,
        );
        continue;
      }
    }

    const prepared = resolveProducer(root, entry);
    if (prepared.status === "blocked") {
      blocked = { path: entry.artefact, reason: prepared.reason, producer: prepared.detail };
      findings.push({
        code: `generated_artifact_producer_unavailable:${entry.artefact}:${prepared.reason}`,
        detail: prepared.detail,
      });
      continue;
    }
    const resolved = prepared.entry;
    if (resolved.assembly !== undefined) {
      producerAssemblies[entry.artefact] = resolved.assembly.path;
      out(
        `producer assembly: ${resolved.assembly.path} (${entry.artefact}; ${resolved.assembly.builds} build(s) ` +
          `present, newest wins)\n`,
      );
    }

    let derived;
    if (resolved.run.kind === "sandboxed_relative_writer") {
      derived = deriveInSandbox({
        root,
        entry: resolved,
        sandboxPath: path.join(sandboxRoot, slug(entry.artefact)),
        run,
      });
    } else if (resolved.run.kind === "in_place_test") {
      derived = deriveWithInPlaceTest({ root, entry: resolved, run });
    } else {
      derived = deriveToStdout({ root, entry: resolved, run });
    }
    if (derived.status !== "measured") {
      blocked = { path: entry.artefact, reason: derived.reason, producer: resolved.producer };
      findings.push({
        code: `generated_artifact_producer_unavailable:${entry.artefact}:${derived.reason}`,
        detail: resolved.producer,
      });
      continue;
    }

    const artefactBytes = fs.readFileSync(artefactPath);
    const mismatch = describeMismatch({ producedBytes: derived.bytes, artefactBytes });
    if (mismatch === null) {
      counts.reproduced += 1;
      out(`reproduced:${entry.artefact} (${artefactBytes.length} bytes from ${resolved.producer})\n`);
      continue;
    }
    counts.mismatched += 1;
    findings.push({
      code: `generated_artifact_not_reproducible:${entry.artefact}:${mismatch.line}:${mismatch.member}`,
      detail: `${mismatch.detail} [producer: ${resolved.producer}]`,
    });
  }

  for (const finding of findings) err(`${finding.code} ${finding.detail}\n`);
  const notReDerived = counts.inputsUnchanged + counts.declaredByTest;
  out(
    `artefacts examined ${classification.examined} · with a declared producer ${classification.declaredProducer} · ` +
      `undeclared ${classification.undeclared.length} · declared_by_test ${classification.declaredByTest} · ` +
      `reproduced ${counts.reproduced} · not re-derived ${notReDerived} (inputs_unchanged ${counts.inputsUnchanged}, ` +
      `declared_by_test ${counts.declaredByTest}) · pinned inputs ${discovered.pinnedInputs.length}\n`,
  );

  if (classification.examined === 0) {
    err(`${GATE_ID}_blocked:no_artefact_claims_derivation\n`);
    report(out, { status: "blocked", examined: 0, findings, blocked, counts });
    return 2;
  }
  const status = findings.length === 0 ? "passed" : "failed";
  report(out, {
    status,
    examined: classification.examined,
    findings,
    blocked,
    counts,
    classification,
    producerAssemblies,
  });
  if (blocked !== null) return 2;
  return findings.length === 0 ? 0 : 1;
}

function slug(artefactPath) {
  return artefactPath.replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function report(
  out,
  { status, examined, findings, blocked, counts = null, classification = null, producerAssemblies = {} },
) {
  out(
    `${JSON.stringify({
      gate: GATE_ID,
      status,
      examined,
      withADeclaredProducer: classification?.declaredProducer ?? 0,
      undeclared: classification?.undeclared.length ?? 0,
      declaredByTest: classification?.declaredByTest ?? 0,
      reproduced: counts?.reproduced ?? 0,
      inputsUnchanged: counts?.inputsUnchanged ?? 0,
      mismatched: counts?.mismatched ?? 0,
      producerAssemblies,
      blockedBy: blocked === null || blocked === undefined ? null : blocked.reason,
      findings: findings.length,
      checks: RULE_CODES.map((id) => ({ id, ...ruleOutcome(id, { status, findings }) })),
    })}\n`,
  );
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runGate(REPOSITORY_ROOT, {
    reDeriveAll: process.argv.includes("--re-derive-all"),
    withTestProducers: process.argv.includes("--with-test-producers"),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
