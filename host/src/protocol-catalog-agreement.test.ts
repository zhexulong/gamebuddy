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
import { EXECUTION_REQUEST_ARGUMENT_RULES, type Snapshot, validateExecutionRequest } from "./protocol.js";

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
   *
   * `surface` is the third such description, and it became one for eight families at once: it is what the GROUND under a
   * tile is (`stone`, `wood`, `soil`, `not_measured:...`), from the Mod's one ground reading, so every family about a
   * tilled tile publishes it - a crop, a pick, a scythe crop, a fertilizer, a clear, a dug spot, a seed, and the soil
   * itself. Reading it as the subject made each of those families demand the others' `targetId`, which is the wrong
   * question: two rows about one tile are not two names for one entity. (`surfaceOwner` never reaches this filter - its
   * declared type is the array `["string", "null"]`, not `string`.)
   */
  const subjectProperties = (family: string, addressing: ReadonlySet<string>) =>
    [...(families.get(family) ?? new Map())]
      .filter(
        ([property, spec]) =>
          !addressing.has(property) &&
          property !== "displayName" &&
          property !== "location" &&
          property !== "surface" &&
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

/**
 * THE TARGET IDENTITY IS THE EXECUTOR'S, ON BOTH SIDES OF THE WIRE, FOR EVERY ACTION WHOSE OWN ROW SAYS SO.
 *
 * <p>
 * The Host's argument table is a copy of `BridgeProtocol.ExecutionArgumentProperties`, and a copy is what makes this
 * dangerous: an argument the Mod's row declares resolved at execution (`FarmhandActionArgument.ResolvedAtExecution`) may
 * be ABSENT, because the handler mints it on the game thread from the arguments that are there. While the Host still
 * demanded the key, a `water_crop` that named its tile and left the crop to the executor was refused `invalid_args`
 * before it left the Host - the wire refusing the call the action's own argument description teaches ("OMIT IT: the body
 * mints it from the LIVE tile"), which is also the call the plan description's own example shows.
 * </p>
 *
 * <p>
 * BOTH DIRECTIONS, because each is a different lie. A row that permits an omission the catalogue never declared lets a
 * caller leave out a value nothing will answer for; a row that still demands a name the catalogue declares resolved
 * refuses a call the Mod accepts. The population is the catalogue's own actions that declare `expectedTargetId`
 * resolved - not a list here - so a fourteenth action that declares it is examined the moment it exists, and the
 * behaviour half drives the REAL `validateExecutionRequest` with the real row bounds, because a permission the table
 * states and the validator does not apply would be the same defect one layer down.
 * </p>
 *
 * <p>
 * WHAT THIS GATE DOES NOT COVER, stated so nobody reads its green as more than it is: `slot` is resolved at execution on
 * twenty of these actions too, and the Host rows still demand it. That omission is a DIFFERENT reading - the tool the
 * action's own claim selects, not the target's identity - and closing it is its own unit; the count of actions still
 * demanding a resolved `slot` is printed below so the size of that debt is visible rather than silent.
 * </p>
 */
test("every action whose row resolves the target identity accepts the omission on the Host's wire", () => {
  const identity = "expectedTargetId";
  const published = new Map<
  string,
  { argumentSchema?: Record<string, { type?: string; enum?: readonly string[]; resolvedAtExecution?: boolean }> }
>(
    (CATALOG.actions ?? []).map((action) => [action.actionId, action]),
  );
  assert.ok(published.size > 50, `the catalog must have been read (found ${published.size} actions)`);

  const population = [...published]
    .filter(([, action]) => action.argumentSchema?.[identity]?.resolvedAtExecution === true)
    .map(([actionId]) => actionId);
  assert.ok(
    population.length >= 13,
    `the catalogue must declare the tile-addressed actions this gate is about (found ${population.length}: ${population.join(", ")})`,
  );

  const resolvedSlot = [...published].filter(
    ([, action]) => action.argumentSchema?.slot?.resolvedAtExecution === true,
  ).length;
  process.stdout.write(
    `\ntarget identity resolved at execution ${population.length}: ${population.join(", ")} · slot resolved at execution ${resolvedSlot} (still demanded by the Host rows, its own unit)\n`,
  );

  const findings: string[] = [];
  for (const actionId of population) {
    const row = EXECUTION_REQUEST_ARGUMENT_RULES[actionId as keyof typeof EXECUTION_REQUEST_ARGUMENT_RULES]?.find(
      (candidate) => candidate.argumentNames !== undefined,
    );
    if (row === undefined) {
      findings.push(`${actionId}: the Host declares no argument set for an action the catalogue publishes`);
      continue;
    }
    if (!(row.resolvableArguments ?? []).includes(identity))
      findings.push(`${actionId}: the Mod resolves \`${identity}\` and the Host still demands it, so the call its own description teaches is refused \`${row.refusal}\``);
    if (!(row.argumentNames ?? []).includes(identity))
      findings.push(`${actionId}: \`${identity}\` is not one of the arguments this row names, so nothing can omit it`);
  }
  // AND THE OTHER DIRECTION: no row may permit an omission the catalogue does not declare.
  for (const [actionId, rules] of Object.entries(EXECUTION_REQUEST_ARGUMENT_RULES)) {
    for (const name of rules.find((candidate) => candidate.argumentNames !== undefined)?.resolvableArguments ?? [])
      if (published.get(actionId)?.argumentSchema?.[name]?.resolvedAtExecution !== true)
        findings.push(
          `${actionId}: the Host lets a caller omit \`${name}\`, and the Mod's row resolves nothing of that name - nothing would answer for it`,
        );
  }
  assert.deepEqual(
    findings,
    [],
    `a copy of the Mod's wire that names different permissions is the defect this gate exists for:\n${findings.join("\n")}`,
  );
});

/**
 * THE PERMISSION IS THE ONE THE VALIDATOR APPLIES, AND IT IS NOTHING ELSE.
 *
 * <p>
 * The table above is data; this drives the real `validateExecutionRequest` with a payload built from each row's own
 * declared names, so a row that states a permission the validator does not apply is red here. Both sides are asserted,
 * because a relaxation one argument too far is invisible in the other direction: the identity may be absent exactly
 * where the catalogue declares it resolved, and every other omission - the tile, the item, the charge, or the identity
 * of an action whose row resolves nothing - still refuses `invalid_args`.
 * </p>
 */
test("the validator accepts exactly the omissions the rows declare, and refuses every other one", () => {
  const catalogActions = new Set(
    (CATALOG.actions ?? []).map((action: { actionId: string }) => action.actionId),
  );
  const capability = [...Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES)].filter((actionId) =>
    catalogActions.has(actionId),
  );
  const snapshot = {
    revision: 11,
    location: "Farm",
    tile: { x: 10, y: 10 },
    stamina: 100,
    health: 100,
    actionable: true,
    exhausted: false,
    capabilities: capability,
    catalogRevision: 1,
    enabledActionIds: capability,
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
  } as unknown as Snapshot;
  const verdict = (action: string, args: Record<string, unknown>): string | null =>
    validateExecutionRequest(
      {
        requestId: "req_aaaaaaaaaaaaaaaaaaaaaaaa",
        idempotencyKey: "idem_aaaaaaaaaaaaaaaaaaaaaaa",
        action,
        args,
        expectedRevision: 11,
        deadlineMs: Date.now() + 60_000,
      },
      snapshot,
    );
  /** A value each declared argument accepts: the bounds are the rows' own and every one of them admits these. */
  const valueOf = (name: string): unknown => {
    switch (name) {
      case "x":
      case "y":
        return 5;
      case "slot":
        return 0;
      case "charge":
        return 0;
      case "expectedQualifiedItemId":
        return "(O)24";
      default:
        return "crop_d3adbeef";
    }
  };

  const findings: string[] = [];
  let omitted = 0;
  let refused = 0;
  for (const [actionId, rules] of Object.entries(EXECUTION_REQUEST_ARGUMENT_RULES)) {
    const row = rules.find((candidate) => candidate.argumentNames !== undefined);
    if (row === undefined) continue;
    const names = row.argumentNames ?? [];
    const resolvable = row.resolvableArguments ?? [];
    const args: Record<string, unknown> = {};
    for (const name of names) if (!resolvable.includes(name)) args[name] = valueOf(name);
    // THE OMISSION THE MOD PERMITS IS THE ONE THE HOST ACCEPTS.
    if (resolvable.length > 0) {
      omitted += 1;
      const withOnlyOmitted = verdict(actionId, { ...args });
      if (withOnlyOmitted !== null)
        findings.push(
          `${actionId}: the row permits [${resolvable.join(", ")}] to be absent and the validator answered \`${withOnlyOmitted}\``,
        );
      // A VALUE THAT IS SENT IS STILL HELD TO ITS SHAPE, so a stated identity keeps meaning something - and its
      // refusal is the row's own word for that action's target, not the envelope's `invalid_args`.
      const statedButNotAnId = verdict(actionId, { ...args, [resolvable[0]!]: "not an id" });
      if (statedButNotAnId === null)
        findings.push(`${actionId}: a stated \`${resolvable[0]}\` that is not an opaque id was ACCEPTED`);
    }
    // EVERY OTHER NAME IS STILL THE CALLER'S: one removal at a time, answered by the row that owns the key set.
    for (const name of names) {
      if (resolvable.includes(name)) continue;
      refused += 1;
      const without = { ...args };
      delete without[name];
      const answer = verdict(actionId, without);
      if (answer !== row.refusal)
        findings.push(
          `${actionId}: \`${name}\` is required by this row and its omission answered \`${answer}\` instead of \`${row.refusal}\``,
        );
    }
  }

  // THE ACTION THAT RESOLVES NO IDENTITY STILL DEMANDS ITS OWN, which is what keeps this a permission and not a habit.
  assert.equal(
    verdict("remove_placed_item", { x: 5, y: 6, slot: 0 }),
    "invalid_args",
    "`worldObjectTargets` is not a family the mint can name, so its id is still the caller's to send",
  );
  assert.equal(
    verdict("water_crop", { x: 5, y: 6, charge: 0, expectedQualifiedItemId: "(O)24" }),
    "invalid_args",
    "an argument this action never declared is still refused",
  );
  assert.ok(omitted >= 13, `the permitted-omission population must have been walked (found ${omitted})`);
  assert.ok(refused > 40, `the required-argument population must have been walked (found ${refused})`);
  assert.deepEqual(findings, [], `the rows and the validator disagree:\n${findings.join("\n")}`);
});
