import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * EVERY ARGUMENT THE HOST REQUIRES MUST BE PUBLISHED IN THE CATALOG THE MOD EMITS.
 *
 * <p>
 * This gate exists because `pickup_forage` was structurally unusable for months and nothing noticed. The chain:
 * </p>
 *
 * <pre>
 *   Mod declares    FarmhandActionObservationBindingDescriptor(required: true, ["observationId","ref"])
 *   Catalog omits   action-surface.mjs:454 builds the entry without `sceneTarget`
 *   Host requires   protocol.ts:2812 hasExactKeys(args, [... , "sceneTarget"])
 *   The model       can only copy fields the snapshot publishes; forageTargets has no observationId
 * </pre>
 *
 * <p>
 * Result: 14 dispatches, 14 `observation_binding_malformed`, 0 successes. The companion reached for the action every
 * time, said the right thing, and the request could never have been legal.
 * </p>
 *
 * <h2>Why a gate and not a fix</h2>
 * <p>
 * The fix for `pickup_forage` is one line in one file. The DEFECT is that a Host validator and the Mod's own published
 * catalog can disagree with nothing failing, so the same class can reappear on any of the 95 actions. This asserts the
 * agreement over the whole surface: for every action the Host validates by hand, the arguments it demands must all be
 * present in `argumentSchema` of the generated artifact.
 * </p>
 *
 * <p>
 * It DERIVES both sides: the catalog from `action-surface.v1.json`, and the Host's requirement from `protocol.ts` itself,
 * so an action added to either side is covered without touching this file.
 * </p>
 */
const CATALOG = JSON.parse(
  readFileSync(
    new URL(
      "../../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  actions?: readonly {
    actionId: string;
    argumentSchema?: Record<string, unknown>;
    sceneTarget?: { type: string; version: number; required: boolean; requiredProperties: readonly string[] };
  }[];
};
const PROTOCOL = readFileSync(new URL("./protocol.ts", import.meta.url), "utf8");

export {};

/** actionId -> the exact `hasExactKeys(value.args, [...])` list the Host demands for it. */
function hostRequiredArguments(): Map<string, string[] | null> {
  const required = new Map<string, string[] | null>();
  // Every branch of the envelope validator reads `value.action === "x"` and then a key list. A branch that does not use
  // `hasExactKeys` still validates arguments, so it is recorded with its action id and no key list rather than skipped -
  // "we could not read it" and "it demands nothing" must not look the same.
  const branches = [
    ...PROTOCOL.matchAll(
      /value\.action === "([a-z0-9_]+)"\s*\)\s*\{([\s\S]{0,2400}?)(?=\}\s*else if \(value\.action ===|$)/g,
    ),
  ];
  for (const [, actionId, body] of branches) {
    if (actionId === undefined || body === undefined) continue;
    const keys = /hasExactKeys\(value\.args,\s*\[([^\]]*)\]\)/.exec(body);
    if (keys === null) {
      required.set(actionId, null);
      continue;
    }
    required.set(
      actionId,
      [...(keys[1] ?? "").matchAll(/"([A-Za-z0-9_]+)"/g)].map((match) => match[1] ?? ""),
    );
  }
  return required;
}

test("every argument the Host demands is published in the catalog", () => {
  const published = new Map<string, { argumentSchema?: Record<string, unknown>; sceneTarget?: { required: boolean } }>(
    (CATALOG.actions ?? []).map((action) => [action.actionId, action]),
  );
  const demanded = hostRequiredArguments();

  assert.ok(demanded.size > 20, `the Host validator must have been parsed (found ${demanded.size} branches)`);
  assert.ok(published.size > 50, `the catalog must have been read (found ${published.size} actions)`);

  const disagreements = [];
  for (const [actionId, keys] of demanded) {
    if (keys === null) continue; // hand-validated without a key list; nothing to compare
    const entry = published.get(actionId);
    if (entry === undefined) {
      disagreements.push(`${actionId}: the Host validates it but the catalog does not publish it`);
      continue;
    }
    const schemaKeys = new Set(Object.keys(entry.argumentSchema ?? {}));
    // `sceneTarget` is a BINDING, not an argument: the catalog carries it as a top-level descriptor because that is
    // what it describes (which properties a caller must supply, per `ObservationBinding/v1`), while the Host reads it
    // as one more field of `args`. Both are right; the gate has to know that they are the same fact in two places.
    if (entry.sceneTarget !== undefined) schemaKeys.add("sceneTarget");
    for (const key of keys) {
      if (key === "requestId" || key === "idempotencyKey" || key === "expectedRevision" || key === "deadlineMs")
        continue;
      if (!schemaKeys.has(key))
        disagreements.push(
          `${actionId}: the Host requires \`${key}\` but the catalog publishes [${[...schemaKeys].join(", ")}]`,
        );
    }
  }

  assert.deepEqual(
    disagreements,
    [],
    `a Host requirement the catalog does not publish cannot be satisfied by any caller: the model reads the catalog, and a\n` +
      `field it never sees is a field it can never send.\n${disagreements.join("\n")}`,
  );
});

test("pickup_forage publishes the scene binding its validator demands", () => {
  // The named case, kept as its own assertion so a regression reports the action rather than a list.
  const entry = (CATALOG.actions ?? []).find((action) => action.actionId === "pickup_forage");
  assert.ok(entry !== undefined, "pickup_forage is published");
  assert.ok(
    entry.sceneTarget !== undefined,
    "the catalog must carry the ObservationBinding/v1 descriptor the Host validates against",
  );
  assert.equal(entry.sceneTarget.type, "ObservationBinding");
  assert.equal(entry.sceneTarget.version, 1);
  assert.equal(entry.sceneTarget.required, true);
  assert.deepEqual(entry.sceneTarget.requiredProperties, ["observationId", "ref"]);
});

test("the gate is not vacuous: the parser finds a requirement that exists", () => {
  // A parser that silently matched nothing would report agreement with everything. `enter_exit` is a branch with an
  // exact key list, so it must be found with the args the Host really checks.
  const demanded = hostRequiredArguments();
  const enterExit = demanded.get("enter_exit");
  assert.ok(Array.isArray(enterExit), "enter_exit is parsed as a branch WITH a key list");
  assert.ok(enterExit.includes("x"), `enter_exit demands x; parsed [${enterExit.join(", ")}]`);
});
