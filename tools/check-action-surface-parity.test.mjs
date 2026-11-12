/**
 * The falsifier suite for `tools/check-action-surface-parity.mjs`: the matrix between the surfaces an action must cross.
 *
 * TWO KINDS OF PROOF, because the gate's own red proofs are worthless if the suite that replays them cannot fail.
 *
 * History first, replayed out of this repository's own commits into a copy under the OS temporary directory - never
 * synthesized, because a synthetic tree proves only that the gate can be turned red on a defect its author already had in
 * mind. Both trees are real, and both were found by a human noticing a live run that had already failed:
 *
 * red-proof: history  the pre-0d4ce1b2 tree, where the tool schema and the projector omitted `charge` on `till_soil` and
 *   `water_crop` while the wire required it -> `surface_refuses_what_another_accepts:till_soil:charge:tool-schema:catalog`
 *   and `...:till_soil:charge:tool-args:catalog`
 * red-proof: history  the pre-8c53105e tree, where the catalog carried `sweep_scythe` and no tool mounted it ->
 *   `surface_silently_omits_action:sweep_scythe:tool-schema` and `:tool-args`
 * red-proof: inject  a `charge` deleted from a mount's `parameters`, one deleted from its `toArgs`, the `sleep` key
 *   deleted from `EXECUTION_REQUEST_ARGUMENT_RULES`, its arm deleted from the Mod's `ExecutionArgumentProperties`, a
 *   `continue` added beside the grammar's two declared filters, a `toArgs` spread, and an empty source tree ->
 *   `surface_refuses_what_another_accepts:till_soil:charge:tool-schema:*`,
 *   `surface_refuses_what_another_accepts:till_soil:charge:tool-args:*`,
 *   `surface_silently_omits_action:sleep:wire`, `surface_silently_omits_action:sleep:mod`,
 *   `plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:*`, `tool_args_unreadable:till_soil`, and
 *   `action_surface_population_empty`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODES,
  checkActionSurfaceParity,
  PATHS,
  readActionSurfaceParity,
  readCatalogSurface,
  readModSurface,
  readToolSurface,
} from "./check-action-surface-parity.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const real = (path) => readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
const realCatalog = () => JSON.parse(real(PATHS.catalog));
const sources = () => ({
  catalog: realCatalog(),
  wire: real(PATHS.wire),
  planGrammar: real(PATHS.planGrammar),
  toolSchema: real(PATHS.toolSchema),
  mod: real(PATHS.mod),
});

/** A named assertion: a matrix finding has to be a whole line, and a near miss is worth reading. */
function assertFinding(report, pattern) {
  const found = report.findings.filter((finding) => pattern.test(finding));
  assert.ok(found.length > 0, `expected ${String(pattern)}; findings were:\n${report.findings.join("\n") || "(none)"}`);
  return found;
}

// ---------------------------------------------------------------------------
// The reading itself: every authority contributes a population, and none of
// them is reported as unreadable. A zero here is not a pass - it is the
// matrix having quietly lost a surface.
// ---------------------------------------------------------------------------

test("every authority of the real tree is read, and the catalog is the denominator", () => {
  const report = readActionSurfaceParity();
  assert.deepEqual(report.blocked, []);
  assert.equal(report.surfaces, 6);
  assert.equal(
    report.populations.catalog,
    report.examined,
    "the catalog is the population every surface is crossed with",
  );
  // The three read-only actions are execution-exempt everywhere else, and the plan grammar additionally declares
  // `experimental` out of a script: 103 execution actions reach five surfaces, 96 of them reach the grammar.
  assert.equal(report.populations.wire, 103);
  assert.equal(report.populations.mod, 103);
  assert.equal(report.populations["tool-schema"], 103);
  assert.equal(report.populations["tool-args"], 103);
  assert.equal(report.populations["plan-grammar"], 96);
  assert.ok(report.pairs > 100, `pairs checked ${report.pairs} does not describe an argument matrix`);
});

test("an action the Mod spells `Array.Empty` carries NO argument and is not reported as omitted", () => {
  const catalog = readCatalogSurface(realCatalog());
  const mod = readModSurface(real(PATHS.mod));
  assert.deepEqual(mod.problems, []);
  assert.deepEqual([...(mod.actions.get("sleep") ?? new Set(["unreadable"]))], []);
  assert.ok(catalog.actions.has("sleep"));
});

// ---------------------------------------------------------------------------
// Red proofs. Two of them are real history, replayed from this repository's
// own commits into a copy outside it; the rest inject the violation the gate
// exists for into the real declarations.
// ---------------------------------------------------------------------------

const treeCache = new Map();

/** A committed tree's five authorities, written under the OS temporary directory - never inside the repository. */
function historicalTree(revision) {
  if (!treeCache.has(revision)) {
    let unavailable = null;
    try {
      execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
        cwd: REPOSITORY_ROOT,
        stdio: "ignore",
      });
    } catch {
      unavailable = `${revision} is not in this clone`;
    }
    if (unavailable === null) {
      const root = mkdtempSync(join(tmpdir(), "action-surface-parity-"));
      for (const path of [PATHS.catalog, PATHS.wire, PATHS.planGrammar, PATHS.toolSchema, PATHS.mod]) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, execFileSync("git", ["show", `${revision}:${path}`], { cwd: REPOSITORY_ROOT }));
      }
      treeCache.set(revision, { root });
    } else treeCache.set(revision, { unavailable });
  }
  return treeCache.get(revision);
}

after(() => {
  for (const entry of treeCache.values()) if (entry.root !== undefined) entry.root = null;
});

test("red proof (history, pre-0d4ce1b2): the wire required `charge` and the tool surface did not offer it", (t) => {
  const tree = historicalTree("0d4ce1b2~1");
  if (tree.unavailable !== undefined) {
    t.skip(`not measured: ${tree.unavailable}`);
    return;
  }
  const report = readActionSurfaceParity({ root: tree.root });
  // Both refusals are named: the schema the model is handed, and the projector that builds the wire args.
  assertFinding(report, new RegExp(`^${CODES.refuses}:till_soil:charge:tool-schema:[a-z-]+$`, "u"));
  assertFinding(report, new RegExp(`^${CODES.refuses}:till_soil:charge:tool-args:[a-z-]+$`, "u"));
  assertFinding(report, new RegExp(`^${CODES.refuses}:water_crop:charge:tool-schema:[a-z-]+$`, "u"));
});

test("red proof (history, pre-8c53105e): the catalog carried `sweep_scythe` and no tool mounted it", (t) => {
  const tree = historicalTree("8c53105e~1");
  if (tree.unavailable !== undefined) {
    t.skip(`not measured: ${tree.unavailable}`);
    return;
  }
  const report = readActionSurfaceParity({ root: tree.root });
  assertFinding(report, /^surface_silently_omits_action:sweep_scythe:tool-schema$/u);
  assertFinding(report, /^surface_silently_omits_action:sweep_scythe:tool-args$/u);
});

test("red proof (inject): an argument deleted from the mount's parameters is the schema refusing it", () => {
  const read = sources();
  read.toolSchema = read.toolSchema.replace(`          charge: declaredIntegerArgument("till_soil", "charge"),\n`, "");
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "failed");
  assertFinding(report, new RegExp(`^${CODES.refuses}:till_soil:charge:tool-schema:[a-z-]+$`, "u"));
});

test("red proof (inject): an argument the schema declares and `toArgs` drops is an intent thrown away", () => {
  const read = sources();
  read.toolSchema = read.toolSchema.replace(
    "toArgs: (params) => ({ x: params.x, y: params.y, charge: params.charge }),",
    "toArgs: (params) => ({ x: params.x, y: params.y }),",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "failed");
  assertFinding(report, new RegExp(`^${CODES.refuses}:till_soil:charge:tool-args:[a-z-]+$`, "u"));
});

test("red proof (inject): an action deleted from the wire declaration is a surface that omits it", () => {
  const read = sources();
  read.wire = read.wire.replace(`  sleep: [exactArgs([], "invalid_args")],\n`, "");
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "failed");
  assertFinding(report, /^surface_silently_omits_action:sleep:wire$/u);
});

test("red proof (inject): an action deleted from the Mod's reader is a surface that omits it", () => {
  const read = sources();
  read.mod = read.mod.replace(/"sleep" => Array\.Empty<string>\(\),\s*\n/u, "");
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "failed");
  assertFinding(report, /^surface_silently_omits_action:sleep:mod$/u);
});

test("red proof (inject): a skip the grammar adds beside its two declared filters BLOCKS the vocabulary reading", () => {
  const read = sources();
  // A hand-written skip inside the derivation: the shape a maintained vocabulary takes, and the one the lifecycle rule
  // exists to refuse. This gate cannot enumerate an arbitrary condition, so the honest verdict is blocked - not a green
  // matrix over the actions the skip removed. Changing `PLAN_ACTION_LIFECYCLES` instead is a DECLARATION and stays green.
  read.planGrammar = read.planGrammar.replace(
    "    const declared = declaredArgumentsOf(registration);",
    '    if (registration.actionId === "move_to_tile") continue;\n    const declared = declaredArgumentsOf(registration);',
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(
    report.blocked.some((entry) => entry.startsWith("plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:")),
    report.blocked.join("\n"),
  );
});

test("red proof (inject): a surface this reader cannot enumerate is BLOCKED, never green", () => {
  const read = sources();
  read.toolSchema = read.toolSchema.replace(
    "toArgs: (params) => ({ x: params.x, y: params.y, charge: params.charge }),",
    "toArgs: (params) => ({ ...params }),",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(report.blocked.includes("tool_args_unreadable:till_soil"), report.blocked.join("\n"));
});

test("red proof (inject): an empty source tree is a blocked population, not a clean matrix", () => {
  const report = checkActionSurfaceParity({
    catalog: { actions: null },
    wire: "",
    planGrammar: "",
    toolSchema: "",
    mod: "",
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.examined, 0);
  assert.ok(report.blocked.includes("action_surface_population_empty"));
});

test("the tool reader takes its identity fields from `callerRequestIds`, not from a list", () => {
  const surface = readToolSurface(real(PATHS.toolSchema), readCatalogSurface(realCatalog()));
  assert.deepEqual([...surface.identity].sort(), ["idempotencyKey", "requestId"]);
  // ... and therefore the schema for an action carries its ACTION arguments only.
  assert.deepEqual([...surface.actions.get("till_soil")].sort(), ["charge", "x", "y"]);
});
