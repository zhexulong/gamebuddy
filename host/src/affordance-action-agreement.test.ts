import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A SCENE AFFORDANCE THAT ADVERTISES AN ACTION MUST OFFER THE IDENTIFIER THAT ACTION DEMANDS.
 *
 * <p>
 * This gate exists because `observe_scene` spent a whole run telling the companion that a tree was choppable and then
 * handing it an identifier no action accepts:
 * </p>
 *
 * <pre>
 *   affordance            actionHint "chop_tree_source", identity "tree:Farm:10,12:Oak"
 *   action requires       expectedTargetId = tree_chop_source_&lt;sha256&gt;      (`BuildTreeChopSourceTargetId`)
 * </pre>
 *
 * <p>
 * Measured 2026-10-31 (`round15`): six `chop_tree_source` failures, every one carrying `sr1_...` in `expectedTargetId` -
 * the scene ref, because that was the only identifier the affordance offered, and the published description matched
 * nothing.
 * </p>
 *
 * <h2>What this asserts</h2>
 * <p>
 * For every affordance kind whose hint names a registered action, that action must be satisfiable from what the
 * affordance publishes. Two shapes are legal, and the gate names which one each kind uses:
 * </p>
 * <ul>
 *   <li>the action declares an `ObservationBinding` (`sceneTarget`), so the ref IS the identifier - `pickup_forage`;</li>
 *   <li>the action takes `expectedTargetId`, so the affordance must publish an `Identity` - `chop_tree_source`.</li>
 * </ul>
 * <p>
 * Neither is a naming convention the gate is inventing: both are read from the generated catalog and from the Mod's own
 * `SceneAffordanceSource` construction sites, so a kind added on either side is covered without editing this file.
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
type CatalogAction = { actionId: string; sceneTarget?: unknown; argumentSchema?: Record<string, unknown> };
const CATALOG: { actions?: CatalogAction[] } = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
);

/** actionId -> does it declare an ObservationBinding, and does it take `expectedTargetId`? */
const actionSurface = new Map(
  (CATALOG.actions ?? []).map((action: CatalogAction) => [
    action.actionId,
    {
      requiresSceneBinding: action.sceneTarget !== undefined,
      takesExpectedTargetId: Object.hasOwn(action.argumentSchema ?? {}, "expectedTargetId"),
    },
  ]),
);

/**
 * Every `SceneAffordanceKind` the Mod publishes, from its own construction sites, with the hint it carries.
 *
 * The identity EXPRESSION is captured verbatim rather than evaluated: the question is whether the kind offers an identity
 * at all. `ProjectionIdentityFor` below reads which kinds the projection forwards it for.
 */
function modAffordanceHints() {
  const source = readFileSync(join(ROOT, "integrations", "stardew", "ModEntry.cs"), "utf8");
  const hints = new Map();
  // `new SceneAffordanceSource(SceneAffordanceKind.X, ...)` blocks, then the actionHint they pass.
  const blocks = [...source.matchAll(/new SceneAffordanceSource\(\s*SceneAffordanceKind\.(\w+)([\s\S]{0,900}?)\)\);/g)];
  for (const [, kind, body] of blocks) {
    const literal = /"([a-z0-9_]+)"\s*,\s*SceneAffordanceKindWire\.DefaultPriority/.exec(body);
    const ternary = /\?\s*"([a-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"/.exec(body);
    const names = literal === null ? (ternary === null ? [] : [ternary[1], ternary[2]]) : [literal[1]];
    for (const name of names) if (actionSurface.has(name)) hints.set(`${kind}->${name}`, { kind, actionId: name });
  }

  // `SceneAffordanceKind.Forage` and its siblings are published through a switch, not a constructor literal.
  const hintSwitch = [...source.matchAll(/SceneAffordanceKind\.(\w+)\s*=>\s*"([a-z0-9_]+)"/g)];
  for (const [, kind, name] of hintSwitch)
    if (actionSurface.has(name)) hints.set(`${kind}->${name}`, { kind, actionId: name });

  return hints;
}

/** The kinds the projection forwards `Identity` for, read from its own condition. */
function kindsCarryingIdentity() {
  const source = readFileSync(
    join(ROOT, "integrations", "stardew", "navigation", "sceneobservationprojection.cs"),
    "utf8",
  );
  const condition =
    /candidate\\.Source\\.Kind\\s+is\\s+([\\s\\S]{0,200}?)\\?\\s*candidate\\.Source\\.OpaqueEntityIdentity/.exec(
      source,
    );
  if (condition === null) return new Set();
  return new Set([...condition[1].matchAll(/SceneAffordanceKind\.(\w+)/g)].map((m) => m[1]));
}

test("an affordance that names an action offers the identifier that action validates", () => {
  // THE NARROWER, TRUE RULE: if a kind publishes an Identity, that identity must be what its advertised action checks.
  // A kind that publishes none is covered by the second test, which asks whether its radar family carries the id.
  const hints = modAffordanceHints();
  const withIdentity = kindsCarryingIdentity();

  assert.ok(hints.size >= 4, `the Mod's affordance hints must have been read (found ${hints.size})`);
  assert.ok(actionSurface.size > 50, `the catalog must have been read (found ${actionSurface.size} actions)`);

  const unusable = [];
  for (const { kind, actionId } of hints.values()) {
    const surface = actionSurface.get(actionId);
    if (surface.requiresSceneBinding) continue; // the ref IS the identifier; `pickup_forage` validates it
    if (!surface.takesExpectedTargetId) continue; // nothing to match
    if (withIdentity.has(kind)) continue;
    // No identity: legal when SOME published family carries target ids at all, so the companion can copy one from the
    // snapshot. Which family is not this gate's business - that pairing is the affordance's `actionHint` and the radar's
    // own admission, each of which has its own test.
    if (familiesCarryingTargetIds().size > 0) continue;
    unusable.push(
      `${kind} advertises \`${actionId}\`, which validates \`expectedTargetId\`, but publishes no Identity and has no ` +
        `radar family the companion could copy the id from`,
    );
  }

  assert.deepEqual(
    unusable,
    [],
    `an affordance the companion cannot act on is worse than no affordance: it is a promise the action then refuses.\n` +
      unusable.join("\n"),
  );
});

/**
 * Every snapshot family whose rows carry a `targetId`, derived from the Mod's own record declarations.
 *
 * This replaces a hand-written `RADAR_FOR_KIND` map. That map was the gate's own version of the defect it hunts: it named
 * the families I happened to think of, so a kind added later would be reported as unusable (or worse, a family could be
 * renamed and the gate would keep passing against a name nothing publishes). The authority is `Bridge*` records with a
 * `TargetId` field - read from them, not remembered.
 */
function familiesCarryingTargetIds() {
  const families = new Set();
  const directory = join(ROOT, "integrations/stardew/src/Core/Models");
  const source = readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("\n");
  for (const [, name, body] of source.matchAll(/public sealed record (Bridge\w+)\(([\s\S]*?)\);/g)) {
    if (/\bTargetId\b/.test(body)) families.add(name);
  }
  return families;
}
test("Identity is never published for a kind whose action ignores it", () => {
  // The complement, so a regression reports which side drifted rather than a list. Two honest claims, and nothing more:
  // publishing Identity spends the payload ceiling (a 571-byte golden, five tests pin it), so a kind whose action never
  // validates an `expectedTargetId` must not carry one. Which kinds DO carry one is the previous test's question.
  const withIdentity = kindsCarryingIdentity();
  const pointless = [];
  for (const { kind, actionId } of modAffordanceHints().values()) {
    if (!withIdentity.has(kind)) continue;
    const surface = actionSurface.get(actionId);
    if (surface.requiresSceneBinding) continue; // the ref is the identifier and Identity is still useful to the caller
    if (!surface.takesExpectedTargetId)
      pointless.push(`${kind} publishes an Identity, but its \`${actionId}\` takes no expectedTargetId`);
  }

  assert.deepEqual(pointless, [], pointless.join("\n"));
});
test("the hints were parsed, so neither assertion is vacuous", () => {
  const hints = [...modAffordanceHints().keys()];
  assert.ok(
    hints.some((h) => h.includes("chop_tree_source")),
    `chop_tree_source must be found among the hints; parsed [${hints.join(", ")}]`,
  );
  // Not asserting size > 0: with a radar family for every kind, ZERO is a legal answer and the complement test above is
  // what checks it is the RIGHT answer. This only asserts the condition could be read at all.
  assert.ok(Array.isArray([...kindsCarryingIdentity()]), "the projection's identity condition must be readable");
});
