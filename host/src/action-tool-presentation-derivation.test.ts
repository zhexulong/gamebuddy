import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_ACTION_ADAPTERS, STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS } from "./action-registry.js";
import { createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import type { ActionRegistration, ActionRegistrationDescriptor, Scope, Snapshot } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { readSourceShape } from "./test-support/source-shape.test-support.js";

/**
 * `a_tool_states_its_own_declaration` — a mounted tool's label and the sentence a model reads are the Mod's declaration,
 * not a name in a Host file.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. Both facts lived in `game-tools.ts`'s `DECLARED_ACTION_TOOL_PRESENTATION`, a table of
 * forty-eight rows keyed by action id, and that table was the whole reason a generic tool factory could not be written
 * there: the mount loop could project an action's arguments, its domains and its name out of the descriptor, and then had
 * to stop and look the tool's own two sentences up by name. The three facts are published now
 * (`FarmhandActionPresentation.cs` on the Mod side), the table is deleted, and this gate holds the two sides to each
 * other so the table cannot come back as a copy: an action whose tool says something its declaration does not is a row
 * nobody can see.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE ARTIFACT, read as data: every action in `action-surface.v1.json`, with the mounted tool set built
 * by the product's own `createStardewActionTools` over registrations made from that same artifact. The reading is exact in
 * BOTH directions, which is what makes it a gate rather than a checklist: an action on
 * `STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS` that publishes no presentation fails by name (the loop has nothing to say about
 * it), and an action that publishes one without being on that list fails too (a fact on the wire that no mount reads is
 * the same defect from the other side).
 * </p>
 *
 * <p>
 * WHAT IT CANNOT SEE, SAID HERE. The adapter table (`action-registry.ts` `STARDEW_ACTION_ADAPTERS`) still declares a
 * label, a description and a `targetKinds` for every action, because `stardew_interaction_catalog` and
 * `stardew_search_interactions` print them and the text differs from the tool's own sentence. For the forty-eight actions
 * that now publish their own, that adapter entry is a COPY, so the target kinds it declares are compared with the
 * published set here and a drift names both sides: the copy may not disagree with the authority while it exists. Deleting
 * it is the unit that gives the catalog its text from the same declaration.
 * </p>
 *
 * red-proof: change one letter of a published label in `FarmhandActionPresentation.cs` and regenerate the artifact ->
 *   the mounted tool still says the old sentence, and this gate names that action and both readings.
 * red-proof: delete one action's row from `FarmhandActionPresentation.cs` and regenerate -> the action is on the derived
 *   list and publishes nothing, so the gate names it instead of the loop quietly mounting nothing.
 * red-proof: restore `DECLARED_ACTION_TOOL_PRESENTATION` in `game-tools.ts` -> `the_deleted_table_is_gone` fails.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, found by walking up to the directory that holds the generated action surface. */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository_root_not_found:${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(HERE);
const SURFACE_PATH = join(
  ROOT,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);
const GAME_TOOLS_PATH = join(ROOT, "host", "src", "game-tools.ts");

/** One action as the artifact publishes it, with the three presentation members the Mod may omit. */
type SurfaceAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, Readonly<{ type: string; enum?: readonly string[] }>>>;
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
  nativeBinding?: string;
  label?: string;
  description?: string;
  targetKinds?: readonly string[];
}>;

function publishedSurface(): readonly SurfaceAction[] {
  const parsed = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as Readonly<{
    schema?: unknown;
    actions?: readonly SurfaceAction[];
  }>;
  if (parsed.schema !== "gamebuddy-action-descriptors/v1" || !Array.isArray(parsed.actions))
    throw new Error("stardew_action_surface_artifact_invalid_shape");
  return parsed.actions;
}

/** The descriptor a `hello_ack` publishes for one artifact action, presentation included. */
function publishedDescriptor(action: SurfaceAction): ActionRegistrationDescriptor {
  return {
    arguments: Object.entries(action.argumentSchema ?? {}).map(([name, schema]) => ({
      name,
      type: schema.type,
      ...(schema.enum === undefined ? {} : { enum: schema.enum }),
    })),
    ...(action.effect === undefined ? {} : { effect: action.effect }),
    ...(action.postcondition?.name === undefined ? {} : { postcondition: { name: action.postcondition.name } }),
    ...(action.nativeBinding === undefined ? {} : { nativeBinding: action.nativeBinding }),
    ...(action.label === undefined ? {} : { label: action.label }),
    ...(action.description === undefined ? {} : { description: action.description }),
    ...(action.targetKinds === undefined ? {} : { targetKinds: action.targetKinds }),
  };
}

function registrationsFrom(published: readonly SurfaceAction[]): readonly ActionRegistration[] {
  return published.map((action) =>
    Object.freeze({
      actionId: action.actionId,
      familyId: action.actionId,
      identityVersion: action.identityVersion,
      lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
      kind: action.kind as ActionRegistration["kind"],
      descriptor: publishedDescriptor(action),
    }),
  );
}

const SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_tool_presentation",
  worldId: "world_tool_presentation",
  playerId: "player_tool_presentation",
  companionId: "companion_tool_presentation",
});

function integrationFor(registrations: readonly ActionRegistration[]): MoveCapableIntegration {
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const snapshot: Snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 10, y: 15 },
    stamina: 100,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities,
    catalogRevision: 1,
    enabledActionIds: capabilities,
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
  };
  return {
    scope: SCOPE,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_tool_presentation",
      capabilities,
      catalogRevision: 1,
      enabledActionIds: capabilities,
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: registrations,
    },
    async execute() {
      throw new Error("tool_presentation_gate_never_executes");
    },
    async cancel() {
      throw new Error("tool_presentation_gate_never_cancels");
    },
  } as unknown as MoveCapableIntegration;
}

/** What one mounted tool says about itself, which is the only thing this gate compares. */
type MountedPresentation = Readonly<{ label: string; description: string }>;

/** Every Game Action tool the product mounts for the artifact, keyed by the action the tool's own name names. */
function mountedPresentations(published: readonly SurfaceAction[]): ReadonlyMap<string, MountedPresentation> {
  const tools = createStardewActionTools(integrationFor(registrationsFrom(published)), undefined, () => {
    throw new Error("tool_presentation_gate_never_dispatches");
  });
  const known = new Set(published.map((action) => action.actionId));
  const mounted = new Map<string, MountedPresentation>();
  for (const tool of tools) {
    if (!tool.name.startsWith("stardew_")) continue;
    const actionId = tool.name.slice("stardew_".length);
    if (!known.has(actionId)) continue;
    if (mounted.has(actionId)) throw new Error(`two_mounted_tools_for_one_action:${actionId}`);
    mounted.set(actionId, Object.freeze({ label: tool.label, description: tool.description }));
  }
  return mounted;
}

type PresentationReading = Readonly<{
  examined: number;
  publishing: number;
  /** One line per action that breaks the claim, naming the action and both readings. */
  findings: readonly string[];
}>;

/**
 * The judgment, as one function over the readings, so the falsifier can drive it on purpose: the population is the
 * artifact, the mounted text is the product's own tool set, and the derived list is the registry's own declaration.
 */
function presentationReading(
  published: readonly SurfaceAction[],
  mounted: ReadonlyMap<string, MountedPresentation>,
  derivedIds: readonly string[] = STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS,
  adapterTargetKinds: ReadonlyMap<string, readonly string[]> = new Map(
    STARDEW_ACTION_ADAPTERS.map((adapter) => [adapter.actionId, adapter.targetKinds]),
  ),
): PresentationReading {
  const derived = new Set(derivedIds);
  const findings: string[] = [];
  let publishing = 0;
  for (const action of published) {
    const declared = action.label !== undefined || action.description !== undefined || action.targetKinds !== undefined;
    if (!declared) {
      if (derived.has(action.actionId))
        findings.push(
          `${action.actionId}: on STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS and publishes no label/description/targetKinds, ` +
            `so the one mount that projects its declaration has nothing to say about it`,
        );
      continue;
    }
    publishing += 1;
    if (action.label === undefined || action.description === undefined || action.targetKinds === undefined) {
      findings.push(
        `${action.actionId}: publishes part of its presentation (label=${String(action.label !== undefined)}, ` +
          `description=${String(action.description !== undefined)}, targetKinds=${String(action.targetKinds !== undefined)}) ` +
          `- the three are one declaration and travel together`,
      );
      continue;
    }
    // A published label no mount reads is the same defect seen from the other side: the fact exists on the wire and the
    // tool the model is handed does not carry it, so nothing holds the two to each other.
    if (!derived.has(action.actionId)) {
      findings.push(
        `${action.actionId}: publishes a label and is not on STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS, so no mount reads it`,
      );
      continue;
    }
    const tool = mounted.get(action.actionId);
    if (tool === undefined) {
      findings.push(`${action.actionId}: publishes a presentation and mounts no tool, so nothing carries it`);
      continue;
    }
    if (tool.label !== action.label)
      findings.push(
        `${action.actionId}: the mounted tool's label is ${JSON.stringify(tool.label)} while the declaration publishes ` +
          `${JSON.stringify(action.label)}`,
      );
    if (tool.description !== action.description)
      findings.push(
        `${action.actionId}: the mounted tool's description is not the declaration's ` +
          `(${String(tool.description.length)} characters mounted, ${String(action.description.length)} published)`,
      );
    const adapterKinds = adapterTargetKinds.get(action.actionId);
    if (adapterKinds === undefined) {
      findings.push(`${action.actionId}: publishes targetKinds and the Host adapter table has no entry to compare with`);
      continue;
    }
    if (adapterKinds.join(",") !== action.targetKinds.join(","))
      findings.push(
        `${action.actionId}: the declaration publishes targetKinds [${action.targetKinds.join(", ")}] while the Host ` +
          `adapter table restates [${adapterKinds.join(", ")}] - the adapter's copy may not disagree with the authority`,
      );
  }
  return Object.freeze({ examined: published.length, publishing, findings: Object.freeze(findings) });
}

function summaryLine(reading: PresentationReading): string {
  return (
    `actions examined ${String(reading.examined)} · publishing a label ${String(reading.publishing)} · ` +
    `publishing none ${String(reading.examined - reading.publishing)} · findings ${String(reading.findings.length)}`
  );
}

test("a_tool_states_its_own_declaration: its label and sentence are the descriptor's, not a name in a Host file", (t) => {
  const published = publishedSurface();
  const mounted = mountedPresentations(published);
  const reading = presentationReading(published, mounted);

  t.diagnostic(summaryLine(reading));

  // A population that measured nothing agrees with itself, and a reading whose arithmetic does not close is measuring a
  // subset: both are blocked rather than green.
  assert.ok(published.length > 50, `blocked: the artifact published only ${String(published.length)} actions`);
  assert.ok(mounted.size > 50, `blocked: the product mounted only ${String(mounted.size)} action tools`);
  assert.ok(
    STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.length > 0,
    "blocked: the registry declares no descriptor-derived action, so this gate has nothing holding the loop to account",
  );
  assert.equal(
    reading.publishing,
    STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.length,
    `${summaryLine(reading)}: the actions that publish a label must be exactly the actions whose tool reads one - ` +
      `the derived list has ${String(STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.length)} members`,
  );

  assert.deepEqual(reading.findings, [], reading.findings.join("\n"));

  t.diagnostic(
    `descriptor-derived actions: ${String(STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.length)} · ` +
      `actions that publish no presentation: ${String(reading.examined - reading.publishing)} (their tool text is still ` +
      `written in its own mount block)`,
  );
});

test("a_tool_states_its_own_declaration: the deleted Host table is gone", (t) => {
  // The other half of "not from a name in a Host file": the table that held the label and the sentence is deleted, so the
  // only way to state them is the declaration. A token read, on the collapsed shape, because the formatter may break the
  // line this name sits on and the claim is about the name rather than the layout.
  const shape = readSourceShape(GAME_TOOLS_PATH).shape;
  assert.equal(
    shape.includes("DECLARED_ACTION_TOOL_PRESENTATION"),
    false,
    "DECLARED_ACTION_TOOL_PRESENTATION is back in game-tools.ts: the label and the sentence are the Mod's declaration " +
      "now (`FarmhandActionPresentation.cs`), and a second table keyed by action id is the copy this unit deleted",
  );
  // The mount reads the declaration: the label is the descriptor's member, not a literal. Named as the one line the loop
  // must carry, so a mount that reintroduces its own text fails here by name.
  assert.ok(
    shape.includes("label: descriptor.label"),
    "the descriptor-derived mount loop no longer reads `label: descriptor.label`, so it is stating a label the Mod did " +
      "not declare",
  );
  assert.ok(
    shape.includes("description: descriptor.description"),
    "the descriptor-derived mount loop no longer reads `description: descriptor.description`",
  );
  t.diagnostic("game-tools.ts: DECLARED_ACTION_TOOL_PRESENTATION absent · the loop reads label and description from the descriptor");
});

test("a_tool_states_its_own_declaration: falsifier — a moved label, a missing row, an unread family", () => {
  const published = publishedSurface();
  const mounted = mountedPresentations(published);

  // Control: the real tree explains every member, so each red below is the injection and not the tree.
  const control = presentationReading(published, mounted);
  assert.deepEqual(control.findings, [], summaryLine(control));
  assert.equal(control.publishing, STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.length);

  // The finding this gate exists for: a declaration whose text the mounted tool does not carry (the shape a one-letter
  // edit in the Mod and a stale artifact produce).
  const drifted = new Map(mounted);
  const sample = published.find((action) => action.label !== undefined);
  assert.ok(sample !== undefined, "the control must have a publishing action to drift");
  drifted.set(sample.actionId, { label: `${sample.label}x`, description: sample.description ?? "" });
  const driftedReading = presentationReading(published, drifted);
  assert.equal(driftedReading.findings.length, 1);
  assert.match(driftedReading.findings[0] ?? "", new RegExp(`^${sample.actionId}: the mounted tool's label`, "u"));

  // A row the Mod forgot: the action is on the derived list, publishes nothing, and the loop mounts nothing for it.
  const withoutRow = published.map((action) =>
    action.actionId === sample.actionId
      ? { actionId: action.actionId, identityVersion: action.identityVersion, lifecycle: action.lifecycle, kind: action.kind }
      : action,
  );
  const missingReading = presentationReading(withoutRow, mounted);
  assert.deepEqual(
    missingReading.findings,
    [`${sample.actionId}: on STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS and publishes no label/description/targetKinds, so the one mount that projects its declaration has nothing to say about it`],
  );

  // A fact on the wire that no mount reads: publish a label for an action nobody mounts, and the claim is called what it
  // is rather than passing because the tool happens to exist elsewhere.
  const unpublished = [...published, { ...sample, actionId: "an_action_no_mount_reads" }];
  const unread = presentationReading(unpublished, mounted);
  assert.deepEqual(unread.findings, [
    "an_action_no_mount_reads: publishes a label and is not on STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS, so no mount reads it",
  ]);

  // The adapter's restated kinds may not disagree with the authority while the copy exists.
  const adapters = new Map<string, readonly string[]>(
    STARDEW_ACTION_ADAPTERS.map((adapter) => [adapter.actionId, adapter.targetKinds]),
  );
  adapters.set(sample.actionId, ["not_the_published_kind"]);
  const kindsReading = presentationReading(published, mounted, STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS, adapters);
  assert.equal(kindsReading.findings.length, 1);
  assert.match(kindsReading.findings[0] ?? "", /targetKinds.*adapter/u);
});
