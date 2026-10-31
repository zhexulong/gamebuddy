import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionRegistration, Snapshot } from "./protocol.js";

/**
 * A MANDATORY SCENE BINDING MUST BE DEMANDED BY THE COMPILER AND ACCEPTED BY IT.
 *
 * <p>
 * The first version of this gate checked that `body-program-script.ts` MENTIONED `sceneTarget`. It passed while the file did
 * not compile: the property did not exist on `PublishedPlanAction`, `planActionsFromRegistrations` never populated it, and
 * both guards read `undefined`. Text matching is satisfied by writing the word.
 * </p>
 *
 * <p>
 * So this asserts BEHAVIOUR against the real catalog, in both directions, which is what caught the second defect the mention
 * check could not see: once the binding was demanded, a call that supplied it was refused
 * `plan_script_unknown_argument:pickup_forage.sceneTarget` - the compiler wanted a key it also rejected.
 * </p>
 */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));
type CatalogAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: ActionRegistration["lifecycle"];
  kind: ActionRegistration["kind"];
  argumentSchema: Readonly<Record<string, Readonly<{ type: string; enum?: readonly string[] }>>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  approach?: Readonly<{ relation: string; withinTiles?: number }>;
  sceneTarget?: Readonly<{ type: string; version: number; required: boolean; requiredProperties: readonly string[] }>;
}>;

const CATALOG: Readonly<{ actions?: readonly CatalogAction[] }> = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
);

const { compilePlanScript, planActionsFromRegistrations } = await import("./body-program-script.js");

/** The Host rebuilds registrations from the catalog at runtime; this does the same, from the same artifact. */
function actionsFromCatalog(): ReturnType<typeof planActionsFromRegistrations> {
  const registrations = (CATALOG.actions ?? []).map((action: CatalogAction) => ({
    actionId: action.actionId,
    familyId: "gate",
    identityVersion: action.identityVersion,
    lifecycle: action.lifecycle,
    kind: action.kind,
    descriptor: Object.freeze({
      argumentSchema: action.argumentSchema,
      ...(action.outputFacts === undefined ? {} : { outputFacts: action.outputFacts }),
      ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
      ...(action.approach === undefined ? {} : { approach: action.approach }),
      ...(action.sceneTarget === undefined ? {} : { sceneTarget: action.sceneTarget }),
    }),
  }));
  return planActionsFromRegistrations(registrations);
}

/** A snapshot complete enough for the compiler to reach its argument checks. */
function snapshot(): Snapshot {
  return {
    revision: 10,
    location: "Farm",
    tile: { x: 5, y: 5 },
    stamina: 270,
    health: 100,
    exhausted: false,
    currentTool: "(T)Axe",
    inventorySlots: 36,
    actionable: true,
    actorDispositionKind: "idle",
    catalogRevision: 1,
    capabilities: [],
    enabledActionIds: [],
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    forageTargets: [{ targetId: "forage_1", x: 6, y: 6, qualifiedItemId: "(O)22", displayName: "Daffodil", stack: 1 }],
  };
}

/** Every action the catalog says carries a mandatory binding. Population from the artifact, not a list. */
const WITH_BINDING = (CATALOG.actions ?? []).filter((action: CatalogAction) => action.sceneTarget?.required === true);

test("the catalog still declares at least one mandatory binding", () => {
  assert.ok(
    WITH_BINDING.length >= 1,
    `no action declares a mandatory sceneTarget any more. If the feature was deleted, delete this gate rather than leaving ` +
      `it green over nothing.`,
  );
});

test("a call that omits the mandatory binding is refused, and the refusal names the action", () => {
  const actions = actionsFromCatalog();
  const refusals = [];
  for (const action of WITH_BINDING) {
    const argumentsOnly = Object.keys(action.argumentSchema ?? {})
      .map((name) => `${name}: ${sampleFor(name)}`)
      .join(", ");
    const result = compilePlanScript(
      { script: `builder.${action.actionId}({ ${argumentsOnly} });` },
      { snapshot: snapshot(), actions },
    );
    if (result.ok !== false || !String(result.reasonCode).startsWith("plan_script_missing_binding:"))
      refusals.push(
        `${action.actionId}: omitting \`sceneTarget\` should be refused at authoring time with plan_script_missing_binding, ` +
          `but the compiler returned ${JSON.stringify(result.ok === true ? "ok" : result.reasonCode)}`,
      );
  }
  assert.deepEqual(refusals, [], refusals.join("\n"));
});

test("a call that supplies the binding is ACCEPTED - the compiler must not demand what it rejects", () => {
  // This is the direction that a "does the file mention sceneTarget" gate cannot see, and the one that failed after the
  // first fix: the binding was demanded and then refused as an unknown argument.
  const actions = actionsFromCatalog();
  const refused = [];
  for (const action of WITH_BINDING) {
    const supplied = {
      ...Object.fromEntries(Object.keys(action.argumentSchema ?? {}).map((name) => [name, sampleFor(name)])),
      sceneTarget: { observationId: "observation_1", ref: "sr1_0123456789abcdef" },
    };
    const call = Object.entries(supplied)
      .map(([name, value]) => `${name}: ${typeof value === "object" ? JSON.stringify(value) : value}`)
      .join(", ");
    const result = compilePlanScript(
      { script: `builder.${action.actionId}({ ${call} });` },
      { snapshot: snapshot(), actions },
    );
    if (result.ok !== true)
      refused.push(
        `${action.actionId}: supplying the binding it demands was refused ${JSON.stringify(result.reasonCode)} - a ` +
          `pre-condition that cannot be satisfied is worse than one that is not enforced`,
      );
  }
  assert.deepEqual(refused, [], refused.join("\n"));
});

/** A literal of the right shape for one argument name, so the compiler reaches the binding check rather than failing earlier. */
function sampleFor(name: string) {
  if (name === "x" || name === "y" || name === "slot") return name === "slot" ? "0" : name === "x" ? "6" : "6";
  if (name === "expectedTargetId") return '"forage_1"';
  if (name === "expectedQualifiedItemId") return '"(O)22"';
  return `"${name}_value"`;
}
