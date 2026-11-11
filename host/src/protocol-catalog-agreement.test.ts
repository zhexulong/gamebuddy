import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 *
 *   (The binding was removed afterwards: no producer published a joinable `ref`, and a Body Program node could not
 *   carry one. `pickup_forage` is addressed by `expectedTargetId` alone, like every other `*Targets` action.)
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
 * It DERIVES both sides: the catalog from `action-surface.v1.json`, and the Host's requirement from the Host's own
 * declaration - `EXECUTION_REQUEST_ARGUMENT_RULES`, imported rather than scraped out of `protocol.ts` by regex, so a
 * rename or a reformat cannot quietly empty this gate. An action added to either side is covered without touching this
 * file.
 * </p>
 */
import { EXECUTION_REQUEST_ARGUMENT_RULES } from "./protocol.js";

/**
 * The repository root, found by walking up to the directory that holds `integrations`.
 *
 * Not `new URL("./protocol.ts", import.meta.url)`: this file is compiled into `dist-test/`, so a relative URL resolves to
 * `dist-test/protocol.ts` - a file that does not exist. The gate reads SOURCE, so it has to find the source tree rather
 * than its own build output. Measured 2026-10-31: `ENOENT ... dist-test/protocol.ts`.
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
const CATALOG = JSON.parse(
  readFileSync(
    join(ROOT, "integrations/stardew/action-development/contracts/generated/action-surface.v1.json"),
    "utf8",
  ),
) as {
  actions?: readonly {
    actionId: string;
    argumentSchema?: Record<string, { type: string; enum?: readonly string[] }>;
    targetFamily?: string;
  }[];
};
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "protocol", "bridge-v1.schema.json"), "utf8")) as {
  $defs?: Record<
    string,
    {
      snapshot?: { properties?: Record<string, { items?: { $ref?: string } }> };
      [definition: string]: unknown;
    }
  >;
};

export {};

/** actionId -> the exact argument names the Host's declaration pins for it. */
function hostRequiredArguments(): Map<string, readonly string[] | null> {
  return new Map(
    Object.entries(EXECUTION_REQUEST_ARGUMENT_RULES).map(([actionId, rows]) => [
      actionId,
      rows.find((row) => row.argumentNames !== undefined)?.argumentNames ?? null,
    ]),
  );
}

test("every argument the Host demands is published in the catalog", () => {
  const published = new Map<string, { argumentSchema?: Record<string, unknown> }>(
    (CATALOG.actions ?? []).map((action) => [action.actionId, action]),
  );
  const demanded = hostRequiredArguments();

  assert.ok(
    demanded.size > 20,
    `the Host's declaration must have been read (found ${demanded.size} action(s) with argument rules)`,
  );
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

test("the gate is not vacuous: the declaration names a requirement that exists", () => {
  // A reader that silently returned nothing would report agreement with everything. `enter_exit` is an action whose rows
  // pin an exact argument set, so it must be found with the args the Host really checks.
  const demanded = hostRequiredArguments();
  const enterExit = demanded.get("enter_exit");
  assert.ok(Array.isArray(enterExit), "enter_exit is declared with an argument set");
  assert.ok(enterExit.includes("x"), `enter_exit demands x; read [${enterExit.join(", ")}]`);
});

/**
 * EVERY ACTION A CALLER CAN ONLY ADDRESS BY COPYING AN ID MUST HAVE A FAMILY THAT PUBLISHES IT.
 *
 * <p>
 * `pickup_forage` and `talk_to_npc` both failed this and neither had a gate:
 * </p>
 * <ul>
 *   <li>`pickup_forage` required a `sceneTarget` whose producer published `identity` = the qualified item id, while the
 *       action compared `BuildForageTargetId` - two ids for one object and no key between them;</li>
 *   <li>`talk_to_npc` required `npcRelationshipTargets[].targetId`, a family bounded to the 6-tile discovery envelope,
 *       while the roster that lists every villager published a tile and no id at all.</li>
 * </ul>
 * <p>
 * Both are the same class: an argument that is an opaque identifier can only be COPIED out of an observation, so some
 * published family must carry it - and every family that publishes the same subject must carry it too, or the row the
 * model can see is not the row the action accepts. The population is the catalog's own argument list and `targetFamily`
 * declarations; the row shapes are the wire schema's `$defs`. Nothing here is a list of actions.
 * </p>
 */
test("every action addressed by a copied id has a family that publishes it", () => {
  const definitions = SCHEMA.$defs ?? {};
  /** family -> row property -> its declared shape, so a closed vocabulary can be told from a name. */
  const families = new Map<string, ReadonlyMap<string, { type?: unknown; enum?: unknown }>>();
  for (const [field, spec] of Object.entries(definitions.snapshot?.properties ?? {})) {
    const reference = spec?.items?.$ref;
    if (typeof reference !== "string") continue;
    const definition = definitions[reference.slice(reference.lastIndexOf("/") + 1)] as
      | { properties?: Record<string, { type?: unknown; enum?: unknown }> }
      | undefined;
    const properties = definition?.properties;
    if (properties === undefined) continue;
    families.set(field, new Map(Object.entries(properties)));
  }
  assert.ok(families.size > 40, `the wire's snapshot families must have been read (found ${families.size})`);

  /** `expectedTargetId` -> `targetId`: the row property the argument is checked against. */
  const rowPropertyOf = (argumentName: string) => {
    if (!argumentName.startsWith("expected")) return argumentName;
    const rest = argumentName.slice("expected".length);
    return rest[0]!.toLowerCase() + rest.slice(1);
  };

  /**
   * The row properties that name the SUBJECT of a row, rather than its address, its coordinates or its label.
   *
   * Two families share a subject when they share one of these: `npcRelationshipTargets` and `villagerWhereabouts` both
   * carry `npcName`, which is the villager - so both must be able to name her. `displayName` and `location` are
   * excluded because they describe rather than identify: every family with a readable name has a `displayName`.
   */
  const subjectProperties = (family: string, addressing: ReadonlySet<string>) =>
    [...(families.get(family) ?? new Map())]
      .filter(
        ([property, spec]) =>
          !addressing.has(property) &&
          property !== "displayName" &&
          property !== "location" &&
          property !== "x" &&
          property !== "y" &&
          !/Id$/u.test(property) &&
          // A closed vocabulary names a CATEGORY (`kind`, `branch`, `status`), not one entity: it cannot be the
          // subject two families share, because two rows of different families routinely share the category.
          spec?.type === "string" &&
          spec?.enum === undefined,
      )
      .map(([property]) => property);

  const problems: string[] = [];
  let examined = 0;
  for (const action of CATALOG.actions ?? []) {
    const declaredFamily = (action as { targetFamily?: string }).targetFamily;
    // The argument this gate is about is the one an action re-resolves against live state: an opaque id it compares
    // after copying it out of a row. `qualifiedItemId` and `chestId` are copyable facts too, but they name an item or a
    // container inside a row rather than the row's own target, so they are a different question.
    const addressing = Object.entries(action.argumentSchema ?? {})
      .filter(([name, spec]) => name === "expectedTargetId" && spec.type === "string" && spec.enum === undefined)
      .map(([name]) => rowPropertyOf(name));
    if (addressing.length === 0) continue;
    examined += 1;
    if (declaredFamily === undefined) {
      problems.push(`${action.actionId} -> (no targetFamily) -> ${addressing.join(",")}`);
      continue;
    }
    const declared = families.get(declaredFamily);
    if (declared === undefined) {
      problems.push(
        `${action.actionId} -> ${declaredFamily} -> ${addressing.join(",")} (the wire publishes no such family)`,
      );
      continue;
    }
    for (const property of addressing)
      if (!declared.has(property))
        problems.push(
          `${action.actionId} -> ${declaredFamily} -> ${property} (the family it declares does not publish it)`,
        );

    const addressingNames = new Set(addressing);
    const subject = subjectProperties(declaredFamily, addressingNames);
    if (subject.length === 0) continue;
    for (const [family, properties] of families) {
      if (family === declaredFamily) continue;
      // A sibling has to describe the SAME subject AT A TILE: that is what makes its rows alternative addresses for
      // the same dispatch. A family that shares a word but publishes no coordinates (`tailoringTargets` and
      // `fixedInteractionPoints` both say `kind`) is answering a different question.
      if (!properties.has("x") || !properties.has("y")) continue;
      const shared = subject.filter((property) => properties.has(property));
      if (shared.length === 0) continue;
      for (const property of addressing)
        if (!properties.has(property))
          problems.push(
            `${action.actionId} -> ${family} -> ${property} (it publishes ${shared.join(",")}, the same subject ` +
              `${declaredFamily} publishes, but not the id \`${action.actionId}\` is called with)`,
          );
    }
  }

  assert.ok(examined > 25, `the catalog must declare id-addressed actions (found ${examined})`);
  assert.deepEqual(
    problems,
    [],
    `a caller can only COPY an opaque id out of an observation, so a family must publish it - and a family that lists ` +
      `the same subject without the id is a row the model can see and cannot act on.\n${problems.join("\n")}`,
  );
});
