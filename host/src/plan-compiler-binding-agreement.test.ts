import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY PRE-CONDITION THE CATALOG DECLARES MUST BE ENFORCED BY THE PLAN COMPILER, OR THE PLAN IS REFUSED LATE.
 *
 * <p>
 * A catalog entry carries more than `argumentSchema`: it may also declare a `sceneTarget` binding (an
 * `ObservationBinding/v1`) or an `approach` requirement. The plan compiler reads `action.arguments` and nothing else, so a
 * binding declared in the catalog is invisible to it - a script compiles, dispatches, and the Mod refuses it.
 * </p>
 *
 * <p>
 * Measured 2026-10-31 (`round17`): `pickup_forage` declares `sceneTarget`, the model wrote it five times with only the four
 * arguments it could see, the compiler accepted all five, and every one was refused `observation_binding_malformed`. The
 * `protocol-catalog-agreement` gate could not catch this: it compares ARGUMENT key sets, and a binding is not an argument.
 * </p>
 *
 * <h2>What this asserts</h2>
 * <p>
 * For every action in the catalog that declares `sceneTarget`, the plan compiler must know the name - because it is the
 * component that turns an incomplete call into a refusal at authoring time. The compiler is read for the binding names it
 * handles, so an action that gains a binding is covered without editing this file, and a compiler that stops handling one
 * fails here rather than in a live run.
 * </p>
 */
function repoRoot(start) {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));
const CATALOG = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
);
const COMPILER = readFileSync(join(ROOT, "host/src/body-program-script.ts"), "utf8");

/** Every binding name the catalog declares that is NOT an argument. */
function declaredBindings() {
  const bindings = new Map();
  for (const action of CATALOG.actions ?? []) {
    if (action.sceneTarget !== undefined) bindings.set(action.actionId, "sceneTarget");
  }
  return bindings;
}

test("the plan compiler knows every binding the catalog declares", () => {
  const bindings = declaredBindings();
  assert.ok((CATALOG.actions ?? []).length > 50, "the catalog must have been read");

  const unaware = [];
  for (const [actionId, binding] of bindings) {
    // The compiler must contain the binding's name somewhere: that is what makes it able to demand or accept it. A
    // compiler that never mentions `sceneTarget` cannot refuse a call that omits it, which is exactly the round17 defect.
    if (!COMPILER.includes(binding))
      awareActionLoop: {
        unaware.push(
          `${actionId} declares \`${binding}\`, and host/src/body-program-script.ts never mentions \`${binding}\` - so a call ` +
            `omitting it compiles and is refused only after dispatch`,
        );
      }
  }

  assert.deepEqual(
    unaware,
    [],
    `a pre-condition the compiler cannot see is a refusal deferred to the Mod, one round trip later:\n${unaware.join("\n")}`,
  );
});

test("the binding population is derived, not listed", () => {
  // A hand-written list here would fail open. The population is whatever the catalog marks with `sceneTarget`, so an
  // action that gains one is covered on the next regeneration.
  const bindings = declaredBindings();
  assert.ok(
    bindings.size >= 1,
    `at least one action must declare a sceneTarget today; found ${bindings.size}. If that number reached 0 because the ` +
      `feature was deleted, delete this gate instead of leaving it green over nothing.`,
  );
  for (const [actionId, binding] of bindings) {
    assert.equal(binding, "sceneTarget", `${actionId} declares an unexpected binding name`);
    const entry = (CATALOG.actions ?? []).find((action) => action.actionId === actionId);
    assert.equal(
      entry.sceneTarget.required,
      true,
      `${actionId}'s binding must be mandatory for this gate to mean anything`,
    );
  }
});
