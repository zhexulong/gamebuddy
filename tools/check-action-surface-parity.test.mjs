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
 * red-proof: inject  the one tool that reaches `put_item_in_fish_tank` deleted, and separately the read-only tool
 *   `stardew_read_scene` deleted -> `surface_silently_omits_action:put_item_in_fish_tank:plan-grammar` with
 *   `action_has_no_route:put_item_in_fish_tank`, and `surface_silently_omits_action:observe_scene:wire` (one per surface)
 *   with `action_has_no_route:observe_scene` - the declaration each of them KEPT on the tree as it stands
 * red-proof: inject  the grammar's expression filter spelled as a hand-written id test, or the registry's
 *   `EXPRESSION_ONLY_ACTION_IDS` renamed -> `plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:*` and
 *   `plan_grammar_expression_declaration_unreadable`
 * red-proof: inject  a `charge` deleted from a mount's `parameters`, one deleted from its `toArgs`, the `sleep` key
 *   deleted from `EXECUTION_REQUEST_ARGUMENT_RULES`, its arm deleted from the Mod's `ExecutionArgumentProperties`, a
 *   `continue` added beside the grammar's declared filters, a `toArgs` spread, an argument deleted from the frozen
 *   table a forwarded mount names, and an empty source tree ->
 *   `surface_refuses_what_another_accepts:till_soil:charge:tool-schema:*`,
 *   `surface_refuses_what_another_accepts:till_soil:charge:tool-args:*`,
 *   `surface_silently_omits_action:sleep:wire`, `surface_silently_omits_action:sleep:mod`,
 *   `plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:*`, `tool_args_unreadable:till_soil`,
 *   `tool_args_declaration_unreadable:<action>:<table>`,
 *   `surface_refuses_what_another_accepts:harvest_bush:expectedTargetId:tool-args:catalog` and
 *   `tool_args_disagrees_with_declaration:harvest_bush`, and `action_surface_population_empty`
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
  readExpressionOnlyIds,
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
  argumentDeclarations: real(PATHS.actionRegistry),
  planSurfaceComposition: real(PATHS.planSurfaceComposition),
  planSurfaceFilter: real(PATHS.planSurfaceFilter),
});

/** A named assertion: a matrix finding has to be a whole line, and a near miss is worth reading. */
function assertFinding(report, pattern) {
  const found = report.findings.filter((finding) => pattern.test(finding));
  assert.ok(found.length > 0, `expected ${String(pattern)}; findings were:\n${report.findings.join("\n") || "(none)"}`);
  return found;
}

/**
 * `source` with ONE mount block removed, the way a hand edit removes it: from the `{` line that opens the block holding
 * `at` to the closing text the shape ends in. `at` is an anchor inside the block (an action id, a tool name), never a
 * line number, so the injection survives the mount moving.
 */
function withoutMountBlock(source, at, closer) {
  const start = source.lastIndexOf("\n  {\n", at);
  const end = source.indexOf(closer, at);
  assert.ok(start > 0 && end > at, "the injected mount is not a brace block of its own");
  return source.slice(0, start) + source.slice(end + closer.length);
}

/** The anchor inside the `makeGameActionTool` mount that reaches `actionId`: the descriptor it looks up. */
const actionMountAnchor = (source, actionId) => {
  const at = source.indexOf(`modRegistrations.find((entry) => entry.actionId === "${actionId}")`);
  assert.ok(at > 0, `no mount looks ${actionId} up`);
  return at;
};

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
  // The catalog carries two kinds: the read-only actions reach none of the five execution surfaces, and every execution
  // action reaches all five. The plan vocabulary is that set minus the grammar's own declared exclusions, so a promotion
  // or a new expression action moves both numbers together instead of leaving a pinned count behind.
  const catalogSurface = readCatalogSurface(realCatalog());
  const execution = [...catalogSurface.actions.values()].filter((entry) => entry.kind === "execution").length;
  assert.ok(execution > 0 && execution < report.examined, `${execution} execution action(s) of ${report.examined}`);
  assert.equal(report.populations.wire, execution);
  assert.equal(report.populations.mod, execution);
  assert.equal(report.populations["tool-schema"], execution);
  assert.equal(report.populations["tool-args"], execution);
  assert.equal(
    report.populations["plan-grammar"],
    execution -
      report.grammar.omittedForLifecycle.length -
      report.grammar.omittedForExpression.length -
      report.grammar.omittedForArgumentType.length,
    "the plan vocabulary is every execution action minus the grammar's own declared exclusions",
  );
  // Every action the catalog publishes has a route, and none has none: the experimental ones through the tool
  // `keepsOwnToolOnPlanSurface` keeps, the read-only ones through their hand-written read tools.
  assert.equal(report.routes.reachable, report.examined);
  assert.deepEqual(report.routes.unreachable, []);
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
// The route: what makes an omission a declaration instead of an action that
// disappeared. Both are read from the authorities, neither from a list here.
// ---------------------------------------------------------------------------

test("a route is read for BOTH mount shapes, and the read-only actions have theirs", () => {
  const surface = readToolSurface(
    real(PATHS.toolSchema),
    readCatalogSurface(realCatalog()),
    real(PATHS.actionRegistry),
  );
  assert.deepEqual(surface.problems, []);
  // The hand-written read tools are not `makeGameActionTool` mounts; they name their action inside `execute`.
  assert.equal(surface.routes.get("observe_scene"), "stardew_read_scene");
  assert.equal(surface.routes.get("inspect_world_map"), "stardew_inspect_world_map");
  assert.equal(surface.routes.get("find_destination"), "stardew_find_destination");
  // The per-action mounts are labelled by the name member the mount writes.
  assert.ok(
    surface.routes.get("sweep_scythe")?.startsWith("STARDEW_ACTION_TOOL_NAMES"),
    surface.routes.get("sweep_scythe"),
  );
  assert.ok(surface.routes.get("till_soil")?.startsWith("STARDEW_ACTION_TOOL_NAMES"), surface.routes.get("till_soil"));
});

test("every plan omission is the declaration the registry and the grammar publish, and it names a route", () => {
  const report = readActionSurfaceParity();
  const catalogSurface = readCatalogSurface(realCatalog());
  const expressionOnly = readExpressionOnlyIds(real(PATHS.actionRegistry));
  assert.ok(expressionOnly !== null, `${PATHS.actionRegistry} must publish EXPRESSION_ONLY_ACTION_IDS`);
  assert.deepEqual([...report.grammar.expressionOnly].sort(), [...expressionOnly].sort());
  assert.deepEqual(
    [...report.grammar.omittedForExpression].sort(),
    [...expressionOnly].sort(),
    "an action the registry declares expression-only is exactly one the plan vocabulary omits for it",
  );
  // Cross-checked from the catalog, the other authority: the lifecycle omissions are the execution actions whose
  // published lifecycle the grammar does not admit, minus the expression ones the earlier filter already took.
  const lifecycleOmitted = [...catalogSurface.actions]
    .filter(
      ([actionId, entry]) =>
        entry.kind === "execution" &&
        !report.grammar.lifecycles.includes(entry.lifecycle) &&
        !expressionOnly.includes(actionId),
    )
    .map(([actionId]) => actionId)
    .sort();
  assert.deepEqual([...report.grammar.omittedForLifecycle].sort(), lifecycleOmitted);
  // The pair that makes each of them a declaration rather than a lost capability: a reason AND a route, printed.
  for (const actionId of [...expressionOnly, ...lifecycleOmitted]) {
    const entry = report.omittedWithRoute.find((candidate) => candidate.actionId === actionId);
    assert.ok(entry !== undefined, `${actionId} is omitted from a surface with no route line`);
    assert.ok(entry.surfaces.includes("plan-grammar"), `${actionId} was not omitted from the plan surface`);
    assert.ok(
      entry.declarations.includes("expression-only") || entry.declarations.includes("plan-grammar-lifecycle"),
      `${actionId} is declared ${entry.declarations.join("/")}`,
    );
    assert.ok(entry.route !== null && entry.route !== undefined, `${actionId} is declared with no route named`);
  }
});

test("the live Game surface delivers a fifth of the tools the adapter builds, and the gate says which", () => {
  const report = readActionSurfaceParity();
  // Built and delivered are different facts. The composition declares `planActionSurface` and mounts one tool per action
  // the PLAN cannot carry, so a green argument face over the built set is a claim about the adapter and not about what the
  // model is handed; the run prints both, and the route an omitted action needs is read from the delivery.
  assert.equal(report.delivery.measured, true);
  assert.equal(report.delivery.declared, true);
  assert.equal(report.delivery.built, report.populations["tool-schema"]);
  assert.equal(
    report.delivery.delivered,
    report.delivery.expressionKept + report.delivery.keptBecauseNotCarried,
    "the delivered tools are the expression ones plus the ones the plan cannot carry",
  );
  assert.equal(
    report.delivery.expressionKept,
    report.grammar.omittedForExpression.length,
    "every expression-only action keeps its own tool on a plan surface",
  );
  assert.equal(
    report.delivery.keptBecauseNotCarried,
    report.grammar.omittedForLifecycle.length + report.grammar.omittedForArgumentType.length,
    "every other action the plan cannot carry keeps its own tool too",
  );
  assert.deepEqual(report.delivery.droppedWithNoPlanRow, [], "no built action tool is dropped without a plan row");
  assert.equal(
    report.delivery.notApplicable.length,
    report.populations["plan-grammar"],
    "the tool faces that do not exist on the plan surface are the actions the plan carries",
  );
});

// ---------------------------------------------------------------------------
// Red proofs. Two of them are real history, replayed from this repository's
// own commits into a copy outside it; the rest inject the violation the gate
// exists for into the real declarations.
// ---------------------------------------------------------------------------

const treeCache = new Map();

/** A committed tree's authorities, written under the OS temporary directory - never inside the repository. */
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
      for (const path of [
        PATHS.catalog,
        PATHS.wire,
        PATHS.planGrammar,
        PATHS.toolSchema,
        PATHS.mod,
        PATHS.actionRegistry,
        PATHS.planSurfaceComposition,
        PATHS.planSurfaceFilter,
      ]) {
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

test("red proof (history, pre-58ca1f73): the plan surface kept no action tool, so seven actions had no route", (t) => {
  const tree = historicalTree("58ca1f73~1");
  if (tree.unavailable !== undefined) {
    t.skip(`not measured: ${tree.unavailable}`);
    return;
  }
  const report = readActionSurfaceParity({ root: tree.root });
  // The filter then read `actionId === null || isExpressionOnlyAction(actionId)`: only non-action tools and the two
  // expression ones survived. `round54`'s seven experimental actions were built, advertised and reachable by nothing,
  // and the tree as it stands called every one of them an explained omission.
  assert.equal(report.delivery.measured, true);
  assert.equal(report.delivery.expressionKept, report.grammar.omittedForExpression.length);
  assert.equal(report.delivery.keptBecauseNotCarried, 0);
  assert.deepEqual(report.delivery.droppedWithNoPlanRow.sort(), [...report.grammar.omittedForLifecycle].sort());
  for (const actionId of report.grammar.omittedForLifecycle) {
    assertFinding(report, new RegExp(`^action_has_no_route:${actionId}$`, "u"));
    assertFinding(report, new RegExp(`^surface_silently_omits_action:${actionId}:plan-grammar$`, "u"));
  }
});

test("red proof (inject): a plan-surface filter this reader cannot classify is a FINDING, never a silent pass", () => {
  const read = sources();
  read.planSurfaceFilter = read.planSurfaceFilter.replace("keepsOwnToolOnPlanSurface(", "someLaterPredicate(");
  const report = checkActionSurfaceParity(read);
  assert.equal(report.delivery.measured, false);
  assert.equal(report.status, "failed", "a delivery this gate could not measure must not pass as agreement");
  assertFinding(report, new RegExp(`^${CODES.notMeasured}:plan_surface_filter_unreadable`, "u"));
});

test("red proof (inject): a predicate that stops being the two declarations is a FINDING, never a guess", () => {
  const read = sources();
  // The predicate narrowed to the expression exception alone - the shape that dropped the seven experimental actions.
  read.argumentDeclarations = read.argumentDeclarations.replace(
    "return isExpressionOnlyAction(actionId) || !planActionIds.has(actionId);",
    "return isExpressionOnlyAction(actionId);",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.delivery.measured, false);
  assert.equal(report.status, "failed");
  assertFinding(report, new RegExp(`^${CODES.notMeasured}:plan_surface_predicate_not_the_two_declarations$`, "u"));
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

test("red proof (inject): a plan-surface declaration whose route is gone is the action disappearing", () => {
  const read = sources();
  // The one tool that reaches this action, deleted - which is what `keepsOwnToolOnPlanSurface` prevents and what nothing
  // checked until the route was read. The action keeps its `plan-grammar-lifecycle` reason and loses its only way to be
  // carried out, so the reason stops being an excuse.
  read.toolSchema = withoutMountBlock(
    read.toolSchema,
    actionMountAnchor(read.toolSchema, "put_item_in_fish_tank"),
    "\n    }\n  }\n",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "failed");
  assertFinding(report, /^surface_silently_omits_action:put_item_in_fish_tank:plan-grammar$/u);
  assertFinding(report, /^action_has_no_route:put_item_in_fish_tank$/u);
  assert.deepEqual(report.routes.unreachable, ["put_item_in_fish_tank"]);
  assert.ok(
    !report.omittedWithRoute.some((entry) => entry.actionId === "put_item_in_fish_tank"),
    "a declaration with no route is not an omission a route explains",
  );
});

test("red proof (inject): a read-only action that loses its read tool is named on every surface it is absent from", () => {
  const read = sources();
  // `read_only` is the declaration for five surfaces at once, so its route has to hold for it to be any excuse at all.
  const at = read.toolSchema.indexOf('name: "stardew_read_scene"');
  assert.ok(at > 0, "the scene tool is not mounted by that name");
  read.toolSchema = withoutMountBlock(read.toolSchema, at, "\n    );\n  }\n");
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.routes.unreachable, ["observe_scene"]);
  assertFinding(report, /^action_has_no_route:observe_scene$/u);
  assertFinding(report, /^surface_silently_omits_action:observe_scene:wire$/u);
  assertFinding(report, /^surface_silently_omits_action:observe_scene:plan-grammar$/u);
});

test("red proof (inject): the expression filter spelled as ids by hand BLOCKS the vocabulary reading", () => {
  const read = sources();
  read.planGrammar = read.planGrammar.replace(
    "    if (isExpressionOnlyAction(registration.actionId)) continue;\n",
    '    if (registration.actionId === "express_emote" || registration.actionId === "face_direction") continue;\n',
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(
    report.blocked.some((entry) => entry.startsWith("plan_grammar_vocabulary_not_descriptor_derived:undeclared_skip:")),
    report.blocked.join("\n"),
  );
});

test("red proof (inject): a missing expression declaration BLOCKS instead of reading as `no action is expression`", () => {
  const read = sources();
  read.argumentDeclarations = read.argumentDeclarations.replace(
    "EXPRESSION_ONLY_ACTION_IDS = Object.freeze([",
    "EXPRESSION_ONLY_ACTION_IDS_RENAMED = Object.freeze([",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(
    report.blocked.some((entry) => entry.startsWith("plan_grammar_expression_declaration_unreadable")),
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
    argumentDeclarations: "",
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.examined, 0);
  assert.ok(report.blocked.includes("action_surface_population_empty"));
});

test("the tool reader takes its identity fields from `callerRequestIds`, not from a list", () => {
  const surface = readToolSurface(
    real(PATHS.toolSchema),
    readCatalogSurface(realCatalog()),
    real(PATHS.actionRegistry),
  );
  assert.deepEqual([...surface.identity].sort(), ["idempotencyKey", "requestId"]);
  // ... and therefore the schema for an action carries its ACTION arguments only.
  assert.deepEqual([...surface.actions.get("till_soil")].sort(), ["charge", "x", "y"]);
});
test("a mount that forwards a table is read through the DECLARATION, not through the literal it stopped writing", () => {
  const surface = readToolSurface(
    real(PATHS.toolSchema),
    readCatalogSurface(realCatalog()),
    real(PATHS.actionRegistry),
  );
  assert.deepEqual(surface.problems, []);
  assert.deepEqual([...surface.forwarded.get("harvest_bush")].sort(), ["expectedTargetId", "x", "y"]);
  // ... and the loop mounts resolve the action's own descriptor, which is the set the catalog already projects.
  assert.deepEqual([...surface.forwarded.get("machine_inspect")].sort(), ["expectedTargetId", "x", "y"]);
});

test("both shapes of one mount resolve to the same set for the same action", () => {
  const catalog = readCatalogSurface(realCatalog());
  const registry = real(PATHS.actionRegistry);
  const forwarded = readToolSurface(real(PATHS.toolSchema), catalog, registry);
  const literal = readToolSurface(
    real(PATHS.toolSchema).replace(
      "toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),",
      "toArgs: (params) => ({ x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),",
    ),
    catalog,
    registry,
  );
  const sets = (surface) =>
    Object.fromEntries([...surface.forwarded].map(([actionId, names]) => [actionId, [...names].sort()]));
  assert.deepEqual(sets(literal), sets(forwarded), "a forwarded mount and a hand-written one must read the same");
  assert.deepEqual([...literal.forwarded.get("harvest_bush")].sort(), ["expectedTargetId", "x", "y"]);
});

test("red proof (inject): an argument deleted from the forwarded table is a finding that names the action", () => {
  const read = sources();
  read.argumentDeclarations = read.argumentDeclarations.replace(
    'export const TILE_TARGET_ARGUMENTS = Object.freeze(["x", "y", "expectedTargetId"] as const);',
    'export const TILE_TARGET_ARGUMENTS = Object.freeze(["x", "y"] as const);',
  );
  const report = checkActionSurfaceParity(read);
  // A finding, not a block: both readings were taken and they are what disagree.
  assert.equal(report.status, "failed");
  assertFinding(report, /^tool_args_disagrees_with_declaration:harvest_bush$/u);
  assertFinding(report, new RegExp(`^${CODES.refuses}:harvest_bush:expectedTargetId:tool-args:[a-z-]+$`, "u"));
});

// ---------------------------------------------------------------------------
// The Host's OWN action tables. Six surfaces were crossed with the catalog and none of them was the one the Host
// publishes a name FROM: `STARDEW_ACTION_ADAPTERS` and the three tables that project it. A name that only ever existed
// in one of those was an offer -- the model could be told the action exists -- with nothing in the tree asking whether
// the Mod had ever declared it.
// ---------------------------------------------------------------------------

test("every action the Host publishes is one the Mod declares, and the census prints both sides", () => {
  const report = readActionSurfaceParity();
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.hostActions.namedNowhere, [], "a Host action name the Mod never declared");
  // Both sides of the crossing, derived: the Host's tables against the Mod's published surface, whose population this
  // gate already states as `catalog`. A hand-written pair of counts here would be the disagreement, not the check.
  assert.equal(report.hostActions.declaredInMod, report.populations.catalog);
  for (const [surfaceId, named] of Object.entries(report.hostActions.bySurface))
    assert.ok(named > 0, `${surfaceId} named no action, so its crossing examined nothing`);
  // The adapter table and the tool-name table are the same action set - `STARDEW_ACTION_TOOL_NAMES` is typed against
  // `StardewActionId`, which IS the adapter table - and both are the Mod's execution actions, which the wire and the
  // Mod's own reader already count. Three independent readings of one number.
  assert.equal(report.hostActions.bySurface["host-adapters"], report.hostActions.bySurface["host-tool-names"]);
  assert.equal(report.hostActions.bySurface["host-adapters"], report.populations.mod);
  assert.equal(report.hostActions.named, report.populations.mod);
});

test("red proof (inject): the phantom the brief names is caught in the adapter table, with its surface", () => {
  const read = sources();
  read.argumentDeclarations = read.argumentDeclarations.replace(
    "export const STARDEW_ACTION_ADAPTERS = Object.freeze([",
    'export const STARDEW_ACTION_ADAPTERS = Object.freeze([\n  actionAdapter(\n    "place_decor_or_furniture",\n' +
      '    "Place decor",\n    "Place one piece of furniture.",\n    ["world_object"],\n  ),',
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(
    report.blocked.includes("action_not_in_catalog:place_decor_or_furniture:host-adapters"),
    report.blocked.join("\n"),
  );
  assert.deepEqual(report.hostActions.namedNowhere, ["place_decor_or_furniture"]);
});

test("red proof (inject): a descriptor-derived id the Mod never declared is named by ITS table", () => {
  const read = sources();
  read.argumentDeclarations = read.argumentDeclarations.replace(
    '  "place_owned_object",\n  "remove_placed_item",',
    '  "place_owned_object",\n  "tool_transform_object",\n  "remove_placed_item",',
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(
    report.blocked.includes("action_not_in_catalog:tool_transform_object:host-descriptor-derived"),
    report.blocked.join("\n"),
  );
});

test("red proof (inject): a tool-name table that publishes a name for nothing is caught", () => {
  const read = sources();
  read.argumentDeclarations = read.argumentDeclarations.replace(
    "export const STARDEW_ACTION_TOOL_NAMES = {",
    'export const STARDEW_ACTION_TOOL_NAMES = {\n  place_tapper: "stardew_place_tapper",',
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(report.blocked.includes("action_not_in_catalog:place_tapper:host-tool-names"), report.blocked.join("\n"));
});

test("red proof (inject): a Host action table this reader cannot find BLOCKS, never reads as `no names`", () => {
  const read = sources();
  read.argumentDeclarations = read.argumentDeclarations.replace(
    "export const STARDEW_ACTION_ADAPTERS",
    "export const STARDEW_ACTION_ADAPTERS_RENAMED",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(report.blocked.includes("host_action_table_unreadable:host-adapters"), report.blocked.join("\n"));
});

test("red proof (inject): a Host action table that names nothing is BLOCKED, not a clean crossing", () => {
  const read = sources();
  const start = read.argumentDeclarations.indexOf("export const STARDEW_ACTION_ADAPTERS");
  const end = read.argumentDeclarations.indexOf("satisfies readonly StardewActionAdapter[]");
  assert.ok(start > 0 && end > start);
  read.argumentDeclarations = `${read.argumentDeclarations.slice(0, start)}export const STARDEW_ACTION_ADAPTERS = Object.freeze([\n${read.argumentDeclarations.slice(end)}`;
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(report.blocked.includes("host_action_table_empty:host-adapters"), report.blocked.join("\n"));
});

test("red proof (inject): a forwarded table the declarations do not carry is BLOCKED by name", () => {
  const read = sources();
  read.toolSchema = read.toolSchema.replace(
    "toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),",
    "toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS_MISSING, params),",
  );
  const report = checkActionSurfaceParity(read);
  assert.equal(report.status, "blocked");
  assert.ok(
    report.blocked.includes("tool_args_declaration_unreadable:harvest_bush:TILE_TARGET_ARGUMENTS_MISSING"),
    report.blocked.join("\n"),
  );
});
