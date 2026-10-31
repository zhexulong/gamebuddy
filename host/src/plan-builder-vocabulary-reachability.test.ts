import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planActionsFromRegistrations, planWorkDescription } from "./body-program-script.js";

/**
 * THE PLAN BUILDER'S VOCABULARY IS CAPABILITY, NOT PROSE.
 *
 * <p>
 * The Game surface mounts `stardew_plan_work` instead of 95 per-action tools, and the whole action
 * vocabulary reaches the model as action ids printed inside that tool's description (one line per family).
 * A model that cannot see an id cannot call it, so the description is the capability surface: a reduction
 * that dropped an id, or that quietly stopped generating the block, would remove gameplay the player can
 * reach while every existing test stayed green.
 * </p>
 *
 * <p>
 * Three things are asserted, each against a derived population rather than a copied list:
 * </p>
 *
 * <ul>
 *   <li>the population is the Mod's own published surface artifact, read here exactly as the attested-pipe
 *       fixture reads it, so a newly published action is covered without editing this file;</li>
 *   <li>every plannable action is named in the description the model is handed;</li>
 *   <li>the generator derives that list from the actions it is given - it holds no hand-written ids, which
 *       is what makes "every action is named" a property of the product instead of a property of one
 *       author's memory.</li>
 * </ul>
 *
 * <p>
 * What this file cannot assert: that the model ATTENDS to the description. It pins that the text is
 * present and complete, not that a model acts on it.
 * </p>
 */

function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));
const HOST_SOURCE = join(ROOT, "host", "src");

type SurfaceAction = Readonly<{
  actionId: string;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
}>;

/** The Mod-owned surface, rebuilt into the registrations a live hello_ack advertises. */
function publishedRegistrations(): readonly Record<string, unknown>[] {
  const path = join(
    ROOT,
    "integrations",
    "stardew",
    "action-development",
    "contracts",
    "generated",
    "action-surface.v1.json",
  );
  const surface = JSON.parse(readFileSync(path, "utf8")) as { actions: readonly SurfaceAction[] };
  return surface.actions.map((action) => ({
    actionId: action.actionId,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle,
    kind: action.kind,
    ...(action.argumentSchema === undefined
      ? {}
      : {
          descriptor: {
            argumentSchema: action.argumentSchema,
            outputFacts: action.outputFacts ?? {},
            ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
          },
        }),
  }));
}

const ACTIONS = planActionsFromRegistrations(publishedRegistrations() as never);
const DESCRIPTION = planWorkDescription(ACTIONS);

/** The description names an action id, and not merely as a substring of a longer id. */
function names(actionId: string): boolean {
  return new RegExp(`(^|[\\s:,])${actionId}([\\s,]|$)`, "u").test(DESCRIPTION);
}

test("the plan builder still names every plannable action the Mod publishes", () => {
  const unnamed = ACTIONS.filter((action) => !names(action.actionId)).map((action) => action.actionId);
  assert.deepEqual(
    unnamed,
    [],
    `these actions are plannable on the Mod's surface but no longer named in stardew_plan_work's description, ` +
      `so the model cannot call them and the player cannot reach them: ${unnamed.join(", ")}`,
  );
});

test("the vocabulary population is the Mod's surface, so this gate covers actions nobody has written yet", () => {
  // If this ever becomes a hand-maintained subset, the assertion above starts passing over a smaller
  // population and its silence stops meaning "every action is reachable".
  assert.ok(
    ACTIONS.length >= 50,
    `only ${ACTIONS.length} plannable actions were derived from the Mod's surface; a collapse this large means the ` +
      "descriptor gates stopped admitting the catalog, not that the game got smaller",
  );
});

test("the vocabulary generator holds no hand-written action ids", () => {
  // The property that makes the count above durable: `planActionVocabularyText` groups whatever actions it is
  // handed. A literal action id inside it would be a second spelling of the catalog.
  const source = readFileSync(join(HOST_SOURCE, "body-program-script.ts"), "utf8");
  const at = source.indexOf("function planActionVocabularyText");
  assert.notEqual(at, -1, "the vocabulary generator is gone, so where the names come from is no longer checkable");
  const body = source.slice(at, source.indexOf("\n}", at));
  const stringLiterals = [...body.matchAll(/"([^"\\]*)"/gu)]
    .map((match) => match[1])
    .filter((literal): literal is string => literal !== undefined);
  const suspicious = stringLiterals.filter((literal) => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(literal));
  assert.deepEqual(
    suspicious,
    [],
    `planActionVocabularyText hard-codes action ids (${suspicious.join(", ")}), which is a second spelling of the ` +
      "Mod's catalog and can drift from it",
  );
});

test("a builder method the model is told about actually exists on every mount", () => {
  // A name the model can read but that no mount accepts is worse than an absent one: it costs a round trip
  // and teaches the model to stop trusting the list.
  const named = ACTIONS.map((action) => action.actionId);
  assert.equal(
    new Set(named).size,
    named.length,
    "the vocabulary prints a duplicate action id, so the model is told the same capability twice",
  );
  for (const actionId of named) {
    assert.match(
      DESCRIPTION,
      new RegExp(`(^|[\\s:,])${actionId}([\\s,]|$)`, "u"),
      `${actionId} is a plannable action but the description does not carry it`,
    );
  }
});
