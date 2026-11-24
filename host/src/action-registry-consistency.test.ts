import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ACTION_POLICY,
  MOD_DESCRIPTOR_REQUIREMENTS,
  STARDEW_ACTION_ADAPTERS,
  STARDEW_ACTION_TOOL_NAMES,
  STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS,
  isDescriptorDerivedActionId,
  isModDescriptorComplete,
  unprovenVisibilityActionIds,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { MOUNTED_GAME_SURFACE_TOOL_NAMES } from "./game-surface-prompt-floor.test-support.js";
import { createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import { DEFAULT_IDENTITY_PROFILE } from "./identity-profile.js";
import type { ActionRegistration, ActionRegistrationDescriptor, Scope } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

/**
 * The generated Mod action-surface artifact (stardew-action-development) is
 * the cross-language authority for which actions exist. These gates are
 * mechanical restrictor-alignment checks: a registered action must not be
 * silently invisible to the Host adapter list, and an experimental candidate
 * must not be silently unpublished. They never force every registered action
 * to be tooled: read_only / experimental / withdrawn actions stay
 * intentionally untooled.
 */
const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ACTION_SURFACE_ARTIFACT = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);

type SurfaceActionClaim = Readonly<{ key: string; value: string }>;
type SurfaceAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, Readonly<{ type: string; enum?: readonly string[] }>>>;
  resourceTemplate?: Readonly<{ claims?: readonly SurfaceActionClaim[] }>;
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
  /**
   * The engine member this action drives, on the actions that declare one. Published for the mount arms, which
   * require it: measured 2026-11-11, the artifact carried no such field while `express_emote` and
   * `face_direction` - the two actions the Game prompt names for body language - were refused by their own arms
   * on the only descriptor a consumer without a running game can read.
   */
  nativeBinding?: string;
  /**
   * The three presentation members the Mod publishes for an action whose text is its own declaration. They travel
   * together or not at all (`isValidActionDescriptor`), and the mount loop reads the first two: an action that has them
   * is mounted with the Mod's own words, one that has none is mounted by its own block.
   */
  label?: string;
  description?: string;
  targetKinds?: readonly string[];
}>;

function loadActionSurface(): readonly SurfaceAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ACTION_SURFACE_ARTIFACT, "utf8"));
  } catch (error) {
    throw new Error(`stardew_action_surface_artifact_unreadable:${ACTION_SURFACE_ARTIFACT}`, { cause: error });
  }
  const surface = parsed as Readonly<{ schema?: unknown; actions?: unknown }>;
  if (surface?.schema !== "gamebuddy-action-descriptors/v1" || !Array.isArray(surface.actions)) {
    throw new Error("stardew_action_surface_artifact_invalid_shape");
  }
  return surface.actions as readonly SurfaceAction[];
}

function claimsScopePlayer(action: SurfaceAction): boolean {
  return (action.resourceTemplate?.claims ?? []).some(
    (claim) => claim.key === "embodied_actor" && claim.value === "ScopePlayer",
  );
}

/**
 * The Mod-integrity universe the Host must surface: an action that is
 * published, executable, and player-scoped must appear as an adapter tool.
 * read_only / experimental / withdrawn actions are intentionally untooled.
 */
function hostMustSurfaceTool(action: SurfaceAction): boolean {
  return action.lifecycle === "published" && action.kind === "execution" && claimsScopePlayer(action);
}

/**
 * An experimental action with a dedicated (non-generic) postcondition is a
 * staged candidate the Host should have opted into; experiments that only
 * reuse the generic native_action_postcondition (e.g. clear_debris) stay
 * local and untooled.
 */
function isPublishedWorthyExperimental(action: SurfaceAction): boolean {
  return (
    action.lifecycle === "experimental" &&
    action.kind === "execution" &&
    claimsScopePlayer(action) &&
    typeof action.postcondition?.name === "string" &&
    action.postcondition.name.length > 0 &&
    action.postcondition.name !== "native_action_postcondition"
  );
}

const adapterIds = new Set<string>(STARDEW_ACTION_ADAPTERS.map((adapter) => adapter.actionId));

test("every published execution ScopePlayer artifact action has a Host adapter", () => {
  const missingAdapter = loadActionSurface()
    .filter(hostMustSurfaceTool)
    .filter((action) => !adapterIds.has(action.actionId))
    .map((action) => action.actionId);
  assert.deepEqual(missingAdapter, []);
});

test("every surfaced artifact action has a Host tool name", () => {
  const missingToolName = loadActionSurface()
    .filter(hostMustSurfaceTool)
    .filter((action) => !(action.actionId in STARDEW_ACTION_TOOL_NAMES))
    .map((action) => action.actionId);
  assert.deepEqual(missingToolName, []);
});

test("every published-worthy experimental artifact action is a staged candidate", () => {
  const candidates = new Set(STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS as readonly string[]);
  const missingCandidate = loadActionSurface()
    .filter(isPublishedWorthyExperimental)
    .filter((action) => !candidates.has(action.actionId))
    .map((action) => action.actionId);
  assert.deepEqual(missingCandidate, []);
});

test("every staged candidate action stays surfaceable through a Host tool name", () => {
  const unsurfaceable = [...STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS].filter(
    (actionId) => !(actionId in STARDEW_ACTION_TOOL_NAMES),
  );
  assert.deepEqual(unsurfaceable, []);
});

/**
 * The mount ledger. `game-tools.ts` mounts a descriptor-derived action only when `isModDescriptorComplete`
 * opens for the descriptor the Mod published, and the same gate also decides catalog visibility
 * (action-registry.ts `visibleActionsFromModCatalog`). An arm that is missing, or one that compares against a
 * shape the wire never sends, therefore withdraws a live_verified action from the Agent with NO error raised:
 * the mount block is simply skipped. That is how `advance_day`, `ride_minecart`, `answer_dialogue`,
 * `shop_purchase`, `ride_bus`, `select_mine_elevator_floor`, `build_farm_building` and `accept_daily_quest`
 * were all unreachable while every gate stayed green - the mount suite called `buildCandidateToolSchema`
 * directly and never asked the gate, and the descriptor suite never named these ids.
 *
 * These gates enumerate the mount blocks' own ids and read the Mod's published artifact for the descriptor
 * rather than hand-building one, so an arm that cannot fire is caught by the same check as an arm that is
 * missing.
 */
const GAME_TOOLS_SOURCE = readFileSync(resolve(hostRoot, "src", "game-tools.ts"), "utf8");

/**
 * Every action id a mount names, read from the source: a block's own literal, or the projection loop's list.
 *
 * The loop mounts ONE block for every id in `STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS`, so reading only the literals would
 * report those actions as unmounted and this ledger would name forty-eight mounts that are there.
 */
function mountedActionIds(): readonly string[] {
  const literals = [...GAME_TOOLS_SOURCE.matchAll(/^\s*action: "([a-z_]+)",/gm)].map((match) => match[1]!);
  const projected = /for \(const [A-Za-z_$][\w$]* of STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS\)/u.test(GAME_TOOLS_SOURCE)
    ? [...STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS]
    : [];
  return [...new Set([...literals, ...projected])].sort();
}

/**
 * The descriptor hello_ack publishes for one artifact action: the `arguments` array, the postcondition record and the
 * three presentation members.
 *
 * <p>
 * THE PRESENTATION IS PART OF THE WIRE DESCRIPTOR AND THE MOUNT READS IT. `createStardewActionTools` skips an action whose
 * descriptor carries no `label`/`description` pair, because the Host stopped hand-writing the label and the sentence
 * (`2026-11-24`: the Mod publishes them now). This projection kept four fields for a day after that change, so every
 * descriptor-derived action was examined as one the Mount could not build: the mount read 55 tools where the product
 * mounts 103, and the two gates below reported forty-eight actions "withheld" that no session had stopped mounting.
 * </p>
 */
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

/** The fields every action of the artifact carries; anything else is a field the Mod may omit. */
const PUBLISHED_ACTION_REQUIRED_KEYS: readonly string[] = [
  "actionId",
  "identityVersion",
  "lifecycle",
  "kind",
  "argumentSchema",
  "outputFacts",
  "resourceTemplate",
  "effect",
  "postcondition",
];

/**
 * The optional descriptor fields the Mod publishes, each with a value it publishes somewhere, read off the
 * artifact instead of a list here: a field the Mod stops publishing disappears from this population, and a
 * field it starts publishing joins it with no edit.
 */
function publishedOptionalFacts(actions: readonly SurfaceAction[]): ReadonlyMap<string, unknown> {
  const facts = new Map<string, unknown>();
  for (const action of actions) {
    for (const [key, value] of Object.entries(action)) {
      if (!PUBLISHED_ACTION_REQUIRED_KEYS.includes(key) && !facts.has(key)) facts.set(key, value);
    }
  }
  return facts;
}

/**
 * The optional members the Mod's projection RECORD declares, each with a probe value its declared type allows.
 *
 * Read from the record and not from the artifact, because the artifact is the suspect: a member the projection drops
 * is absent from every action at once, so an artifact-derived population would lose exactly the member the reader
 * needs named - the gate would keep passing on a vocabulary that had quietly shrunk. The probe value is a placeholder
 * of the member's own type, used only to ask an already-shut arm whether that member is what it waits for; it never
 * reaches a request.
 */
const MOD_PROJECTION_SOURCE = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/Policy/farmhandactionsurfacepublication.cs"),
  "utf8",
);

function declaredOptionalMemberProbes(): ReadonlyMap<string, unknown> {
  const probes = new Map<string, unknown>();
  const at = MOD_PROJECTION_SOURCE.indexOf("record FarmhandActionDescriptorProjection(");
  if (at < 0) throw new Error("stardew_action_descriptor_projection_record_not_found");
  const declaration = MOD_PROJECTION_SOURCE.slice(at, MOD_PROJECTION_SOURCE.indexOf(");", at));
  for (const match of declaration.matchAll(
    /\[property: JsonIgnore\(Condition = JsonIgnoreCondition\.WhenWritingNull\)\]\s*([A-Za-z_][\w.<>]*\??)\s+([A-Z][A-Za-z0-9_]*)\s*=/gu,
  )) {
    const [, type, name] = match;
    if (type === undefined || name === undefined) continue;
    probes.set(name[0]!.toLowerCase() + name.slice(1), type.startsWith("string") ? "probe.member" : undefined);
  }
  if (probes.size === 0) throw new Error("stardew_action_descriptor_projection_record_declares_no_optional_member");
  return probes;
}

/**
 * The string-valued members the HOST's own descriptor type admits, read from `protocol.ts`.
 *
 * The probe population has to survive the projection being reverted, so it also comes from the CONSUMER's contract and
 * not only from the Mod record under test: with `nativeBinding` removed from the Mod's record and from its artifact
 * at once, the member is still one the Host judges and still what its two arms wait for - which is the fact the reader
 * needs, and the one a probe built only from the Mod side cannot see.
 */
const HOST_PROTOCOL_SOURCE = readFileSync(resolve(hostRoot, "src", "protocol.ts"), "utf8");

function hostDescriptorStringMembers(): readonly string[] {
  const at = HOST_PROTOCOL_SOURCE.indexOf("export type ActionRegistrationDescriptor = Readonly<{");
  if (at < 0) throw new Error("stardew_host_action_descriptor_type_not_found");
  const block = HOST_PROTOCOL_SOURCE.slice(at, HOST_PROTOCOL_SOURCE.indexOf("}>;", at));
  return [...block.matchAll(/^\s+([a-zA-Z][A-Za-z0-9]*)\?: string;$/gmu)].map((match) => match[1]!);
}

/** Every field worth probing, with a REAL published value taking precedence over a placeholder. */
function descriptorProbes(published: readonly SurfaceAction[]): ReadonlyMap<string, unknown> {
  const probes = new Map<string, unknown>(declaredOptionalMemberProbes());
  for (const member of hostDescriptorStringMembers()) {
    if (!probes.has(member)) probes.set(member, "probe.member");
  }
  for (const [member, value] of publishedOptionalFacts(published)) probes.set(member, value);
  return probes;
}

/**
 * Why the arm is shut, in a form the reader can act on.
 *
 * The arm is ASKED, never re-implemented: forty-odd per-action rules copied into a test would disagree with the
 * ones that matter the first time either changed. Each optional field the artifact publishes is added back on
 * its own, with a value the artifact itself publishes for that field, and the field whose ABSENCE alone keeps
 * the arm shut is what the reader needs to know.
 */
function whyTheArmClosed(
  actionId: string,
  descriptor: ActionRegistrationDescriptor,
  probes: ReadonlyMap<string, unknown>,
): string {
  const repairs: string[] = [];
  for (const [field, value] of probes) {
    if (value === undefined || field in descriptor) continue;
    if (isModDescriptorComplete(actionId, { ...descriptor, [field]: value } as ActionRegistrationDescriptor))
      repairs.push(field);
  }
  if (repairs.length > 0) return `the published descriptor carries no ${repairs.join("+")}, which its arm requires`;
  return "the arm is shut on a fact neither this artifact nor the Mod's projection record names";
}

/**
 * The registrations a `hello_ack` publishes for the artifact.
 *
 * `familyId` is the one registration field the artifact does not publish, and both readers below - the mount and the plan
 * vocabulary - group or mount by id and descriptor only.
 */
function registrationsFor(published: readonly SurfaceAction[]): readonly ActionRegistration[] {
  return published.map((action) => ({
    actionId: action.actionId,
    familyId: action.actionId,
    identityVersion: action.identityVersion,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    descriptor: publishedDescriptor(action),
  }));
}

/**
 * The tool list a Game session is handed, built by the function a session calls with the catalog hello_ack
 * publishes.
 */
function mountedToolNames(published: readonly SurfaceAction[]): readonly string[] {
  const registrations = registrationsFor(published);
  const capabilities = registrations.filter((registration) => registration.kind === "execution").map((r) => r.actionId);
  const scope: Scope = {
    integrationId: "stardew",
    saveId: "save_mount_gate",
    worldId: "world_mount_gate",
    playerId: "player_mount_gate",
    companionId: "companion_mount_gate",
  };
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_mount_gate",
      capabilities,
      catalogRevision: 1,
      enabledActionIds: capabilities,
      snapshot: {
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
      },
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: registrations,
    },
    async execute() {
      throw new Error("mount_gate_never_executes");
    },
    async cancel() {
      throw new Error("mount_gate_never_cancels");
    },
  };
  return createStardewActionTools(integration, undefined, () => {
    throw new Error("mount_gate_never_dispatches");
  }).map((tool) => tool.name);
}

function toolNameFor(actionId: string): string | undefined {
  return (STARDEW_ACTION_TOOL_NAMES as Readonly<Record<string, string>>)[actionId];
}

/**
 * EVERY ACTION THE AGENT CAN SEE WITHOUT ITS OWN PROOF CARRIES THAT REASON ON ITS OWN DECLARATION.
 *
 * `design/architecture/game-action-model.md:54` keeps `experimental` off the Agent surface by default. The Host's second
 * door is `adapter.declaredExperimental`: the action's own declaration states what its complete descriptor promises, what
 * the live record does not, and the fact that retires the offer. It replaced a table of action ids
 * (`UNPROVEN_VISIBILITY_DECLARATIONS`, retired 2026-11-24) that admitted an action by NAME - a hand-list beside the
 * derived unproven set, and one an edit could grow without touching the action it excused.
 *
 * Both sides of the comparison are derived, and neither is written here:
 *
 *   visible   `visibleActionsFromModCatalog` over the Mod's published surface; "unproved" is
 *             `unprovenVisibilityActionIds` - the lifecycle byte the Mod publishes.
 *   declared  `STARDEW_ACTION_ADAPTERS` entries whose own declaration carries `declaredExperimental`.
 *
 * The failures each name their action:
 *
 *   `visible_without_proof_and_without_a_declaration:<action>`
 *       the Agent can reach an action nothing proved and nothing declared. THE BYPASS this gate exists for: it is what
 *       the id table used to do silently, and it is red on the tree before the declaration moved onto the action.
 *   `declaration_states_no_reason_or_no_expiry:<action>`
 *       a declaration that offers no reason or names nothing that retires it is an exemption that never expires.
 *   `declared_action_is_not_registered:<action>`
 *       a declaration for an action the Mod's surface does not publish: it buys nothing.
 *   `declared_action_holds_its_own_proof:<action>`
 *       a declaration on an action whose lifecycle already admits it: the declaration has outlived its reason.
 *   `declared_action_is_not_visible:<action>`
 *       a declaration the catalog still refuses, so the declaration and the door have drifted apart.
 */
test("an action visible without its own proof carries its reason on its own declaration", (t) => {
  const registrations = registrationsFor(loadActionSurface());
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const visible = visibleActionsFromModCatalog(registrations, capabilities, DEFAULT_ACTION_POLICY);

  const registered = [...new Set(registrations.map((registration) => registration.actionId))].sort();
  const lifecycleOf = new Map(registrations.map((registration) => [registration.actionId, registration.lifecycle]));
  const visibleIds = new Set(visible.map((action) => action.actionId));
  const unprovenIds = new Set(unprovenVisibilityActionIds(registrations));
  const declared = STARDEW_ACTION_ADAPTERS.filter((adapter) => adapter.declaredExperimental !== undefined);
  const declaredIds = new Set<string>(declared.map((adapter) => adapter.actionId));

  const failures: string[] = [];
  for (const actionId of visibleIds) {
    if (!unprovenIds.has(actionId) || declaredIds.has(actionId)) continue;
    failures.push(
      `visible_without_proof_and_without_a_declaration:${actionId}:its registration lifecycle is ` +
        `\`${String(lifecycleOf.get(actionId))}\`, so the only door that could admit it is a declaration on its own ` +
        "adapter, and there is none",
    );
  }
  for (const adapter of declared) {
    const { actionId } = adapter;
    const declaration = adapter.declaredExperimental!;
    if (declaration.reason.trim().length === 0 || declaration.deleteWhen.trim().length === 0) {
      failures.push(`declaration_states_no_reason_or_no_expiry:${actionId}`);
    }
    if (!registered.includes(actionId)) {
      failures.push(
        `declared_action_is_not_registered:${actionId}:the Mod's surface publishes no such action, so the ` +
          "declaration buys nothing",
      );
      continue;
    }
    if (!unprovenIds.has(actionId)) {
      failures.push(
        `declared_action_holds_its_own_proof:${actionId}:its own lifecycle is ` +
          `\`${String(lifecycleOf.get(actionId))}\`, so delete the declaration and let its own proof admit it`,
      );
    }
    if (!visibleIds.has(actionId)) {
      failures.push(
        `declared_action_is_not_visible:${actionId}:the declaration states why it may be offered and the catalog gate ` +
          "refuses it anyway, so the declaration and the door have drifted apart",
      );
    }
  }

  // The population, printed so a green run states what it examined instead of agreeing with itself on two empty sets.
  t.diagnostic(
    `visible ${String(visible.length)} · unproven ${String(unprovenIds.size)} · declared ${String(declaredIds.size)}` +
      ` · refused ${String(registered.filter((actionId) => !visibleIds.has(actionId)).length)} · of ${String(
        registered.length,
      )} registered · unproven [${[...unprovenIds].sort().join(", ")}] · declared [${[...declaredIds].sort().join(", ")}]`,
  );
  // Zero population is BLOCKED, never green: a surface that registers nothing makes every set above agree on nothing.
  assert.ok(
    registered.length > 0,
    "blocked: the published surface registers no action at all, so this gate examines nothing",
  );
  assert.ok(
    visible.length > 0,
    "blocked: the published surface admits no action at all, so this gate examines nothing",
  );
  assert.deepEqual(
    failures,
    [],
    "the declarations do not account for the actions offered without a proof of their own",
  );
});

/**
 * THE DECLARED DOOR STILL OPENS - for the action that declares it, and for nothing else.
 *
 * The gate above is the negative: an action offered without its own proof must carry the declaration. This is the
 * positive, and it reads the same two populations from the artifact and from `STARDEW_ACTION_ADAPTERS`: every action that
 * declares itself experimental is (a) offered to the Agent, (b) still without a proof of its own, so the declaration is
 * doing the work rather than sitting beside an earned lifecycle, and (c) stating both what it buys and what retires it.
 */
test("an action that declares itself experimental is offered before its proof, with its reason on the declaration", (t) => {
  const registrations = registrationsFor(loadActionSurface());
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const visibleIds = new Set(
    visibleActionsFromModCatalog(registrations, capabilities, DEFAULT_ACTION_POLICY).map((action) => action.actionId),
  );
  const lifecycleOf = new Map(registrations.map((registration) => [registration.actionId, registration.lifecycle]));
  const declared = STARDEW_ACTION_ADAPTERS.filter((adapter) => adapter.declaredExperimental !== undefined);

  const failures: string[] = [];
  for (const adapter of declared) {
    const declaration = adapter.declaredExperimental!;
    if (!visibleIds.has(adapter.actionId)) {
      failures.push(
        `declared_action_is_refused:${adapter.actionId}:its own declaration offers it and the catalog gate does not ` +
          "hand it to the Agent",
      );
    }
    const lifecycle = lifecycleOf.get(adapter.actionId);
    if (lifecycle === undefined) {
      failures.push(`declared_action_is_not_published:${adapter.actionId}`);
      continue;
    }
    if (lifecycle !== "experimental") {
      failures.push(
        `declared_action_holds_its_own_proof:${adapter.actionId}:its lifecycle is \`${lifecycle}\`, which admits it ` +
          "without this declaration",
      );
    }
    if (declaration.reason.trim().length === 0 || declaration.deleteWhen.trim().length === 0) {
      failures.push(`declaration_states_no_reason_or_no_expiry:${adapter.actionId}`);
    }
  }

  t.diagnostic(
    `declared [${declared
      .map((adapter) => adapter.actionId)
      .sort()
      .join(", ")}] · offered without a proof of their own ` +
      `${String(declared.filter((adapter) => visibleIds.has(adapter.actionId)).length)} · of ${String(
        registrations.length,
      )} registrations · failures ${String(failures.length)}`,
  );
  assert.ok(
    declared.length > 0,
    "blocked: no action declares itself experimental, so the declared door admits nothing and this gate examines nothing",
  );
  assert.deepEqual(failures, [], "the declared-experimental door and the catalog gate disagree");
});

test("the mounted descriptor-derived set is exactly the published set whose arm opens", () => {
  const published = loadActionSurface();
  const publishedById = new Map(published.map((action) => [action.actionId, action]));
  const publishedDescriptorDerived = published.filter((action) => isDescriptorDerivedActionId(action.actionId));
  // Zero population is BLOCKED, never green: an artifact with no descriptor-derived action would make both
  // sides of the equality agree on nothing at all.
  assert.ok(
    publishedDescriptorDerived.length > 0,
    "blocked: the artifact publishes no descriptor-derived action, so this gate examines nothing",
  );

  const probes = descriptorProbes(published);
  const mountBlocks = new Set(mountedActionIds());
  const failures: string[] = [];
  const armOpen = new Set<string>();
  for (const action of publishedDescriptorDerived) {
    const descriptor = publishedDescriptor(action);
    if (!isModDescriptorComplete(action.actionId, descriptor)) {
      failures.push(
        `action_published_but_not_mounted:${action.actionId}:${whyTheArmClosed(action.actionId, descriptor, probes)}`,
      );
      continue;
    }
    armOpen.add(action.actionId);
    if (!mountBlocks.has(action.actionId)) {
      failures.push(
        `action_published_and_open_but_not_mounted:${action.actionId}:no mount block in game-tools.ts, so nothing hands it to the Agent`,
      );
    }
  }
  for (const actionId of mountBlocks) {
    if (!isDescriptorDerivedActionId(actionId)) continue;
    if (!publishedById.has(actionId)) {
      failures.push(
        `action_mounted_but_not_published:${actionId}:game-tools.ts mounts it and the artifact publishes no descriptor for it`,
      );
    }
  }

  // What the session is actually handed, not a second reading of the same gate.
  const mounted = new Set(mountedToolNames(published));
  const mountedDescriptorDerived = publishedDescriptorDerived
    .filter((action) => {
      const toolName = toolNameFor(action.actionId);
      if (toolName === undefined) {
        failures.push(
          `action_published_but_not_mounted:${action.actionId}:STARDEW_ACTION_TOOL_NAMES carries no name for it, so no session can be handed the tool`,
        );
        return false;
      }
      return mounted.has(toolName);
    })
    .map((action) => action.actionId)
    .sort();

  assert.deepEqual(
    mountedDescriptorDerived,
    [...armOpen].sort(),
    `mounted tools differ from the actions whose arm opens: ${failures.join(" | ")}`,
  );
  assert.deepEqual(failures, [], `the mount ledger is inconsistent: ${failures.join(" | ")}`);
});

/**
 * The requirement table IS the gate, so it is walked rather than trusted.
 *
 * Each row is a claim about what the mounted tool needs, and a claim is only worth the refusal it prints. So every
 * requirement is violated on the Mod's OWN published descriptor for that action - the producer's output, not a
 * fixture - and three things must follow: the requirement itself goes unmet, the gate shuts on the copy, and the
 * refusal still names the field it asked for. A requirement no valid descriptor can fail is a comment, one whose
 * violated copy still opens the gate is a requirement the gate never reads, and a refusal that stops naming its
 * field stops being usable by the reader who has to fix the Mod.
 */
test("every requirement in the table is one the gate reads, on the Mod's own descriptor", () => {
  const published = new Map(loadActionSurface().map((action) => [action.actionId, action]));
  const failures: string[] = [];
  let examined = 0;
  for (const actionId of STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS) {
    const action = published.get(actionId);
    if (action === undefined) {
      failures.push(`requirements_for_an_action_the_artifact_does_not_publish:${actionId}`);
      continue;
    }
    const descriptor = publishedDescriptor(action);
    if (!isModDescriptorComplete(actionId, descriptor)) {
      failures.push(`requirements_reject_the_publishers_own_descriptor:${actionId}`);
      continue;
    }
    for (const required of MOD_DESCRIPTOR_REQUIREMENTS[actionId]) {
      examined += 1;
      if (!required.refusal.includes(required.field)) {
        failures.push(`refusal_does_not_name_its_field:${actionId}:${required.field}`);
      }
      const violated = required.violated(descriptor);
      if (required.isMet(violated)) failures.push(`requirement_not_violated:${actionId}:${required.field}`);
      else if (isModDescriptorComplete(actionId, violated))
        failures.push(`requirement_is_not_read_by_the_gate:${actionId}:${required.field}`);
    }
  }
  // Zero population is BLOCKED, never green: a table that states nothing makes this loop agree with itself.
  assert.ok(
    examined > 0,
    "blocked: the requirement table states nothing for any action, so this gate examines nothing",
  );
  assert.deepEqual(failures, [], "the requirement table and the gate have drifted apart");
});

/**
 * The prompt floor's own tool names.
 *
 * <p>
 * The Game conduct told the companion "Body language goes through the native actions stardew_express_emote and
 * stardew_face_direction" while neither tool was in the mounted list: measured round44, `stardew_express_emote` appeared
 * zero times as a mounted tool definition and only in that sentence. Nothing compared the two - the floor is prose, the
 * mount ledger is code - so this gate read the rendered floor and held every tool name in it against the list a Game
 * session actually mounts. THE MOUNTED LIST IS THE RECORDED ONE, not `createStardewActionTools`' output: a plan surface
 * drops every one of those, so that comparison held the floor against a list the request never carried and stayed green
 * while the floor named `stardew_express_emote` and the Agent was handed `stardew_plan_work` instead (measured 2026-11-11,
 * `round46b`: 68 tool calls, no emote).
 * </p>
 *
 * <p>
 * THE FLOOR NAMES NOTHING NOW, AND THAT IS THE ASSERTION, not a population that went empty by accident. The floor stopped
 * being a list of conduct rules on `2026-11-24` and became the message's syntax header: the sentence that named the two
 * tools moved to those tools' own descriptions, which is what the model reads at the call - the Mod's own `express_emote`
 * text still says it is `NOT a step inside stardew_plan_work`. Measured on the tree, the rendered prompt is 1863
 * characters and carries no `stardew_*` name at all, and the floor's OWN suite cannot see one put back: its
 * `a_rule_the_prompt_states_has_an_owner` classified every sentence as syntax with a tool name injected into it. So this is
 * the one gate that notices a name returning, and the failure names it and asks for the mounted-set comparison to be
 * re-established rather than dropped.
 * </p>
 */
const FLOOR_TOOL_NAME = /\bstardew_[a-z0-9_]+/gu;

test("the Game prompt floor names no tool, and any name it renders is one a Game session mounts", (t) => {
  const floor = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  const named = [...new Set([...floor.matchAll(FLOOR_TOOL_NAME)].map((match) => match[0]))].sort();
  const mounted = new Set(MOUNTED_GAME_SURFACE_TOOL_NAMES);
  t.diagnostic(
    `floor tool names ${String(named.length)} · mounted Game tools ${String(mounted.size)} · over ${String(
      floor.length,
    )} characters of rendered floor`,
  );
  // Zero population is BLOCKED on both sides: an empty prompt says nothing, and an empty mounted set would let every name
  // through. Neither is the state of a Game session today.
  assert.ok(floor.trim().length > 0, "blocked: the rendered Game prompt is empty, so this gate examines nothing");
  assert.ok(mounted.size > 0, "blocked: the recorded mounted Game tool set is empty, so every name would pass");
  assert.deepEqual(
    named.filter((name) => !mounted.has(name)).map((name) => `floor_names_unmounted_tool:${name}`),
    [],
    `the prompt tells the companion to use a tool no Game session mounts: ${named.join(", ")}`,
  );
  assert.deepEqual(
    named.map((name) => `floor_names_a_tool:${name}`),
    [],
    "the prompt header names a tool, so a conduct rule has moved back into the layer that owns none of them: state why a " +
      `name belongs in the message's syntax and restore the mounted-set comparison for it - ${named.join(", ")}`,
  );
});

/**
 * EVERY SITE THAT DECIDES AN ACTION IS VISIBLE DOES SO THROUGH A DECLARATION THAT CAN EXPIRE - OR IT IS A FINDING.
 *
 * <p>
 * The defect this gate exists for, measured on the tree rather than reported. Visibility had TWO answers, and only one of
 * them expired with its evidence: the lifecycle byte, and a predicate `isVisibleWithoutLiveProof` = "descriptor-derived and
 * its descriptor is complete", which carried no reason and no expiry. The next action to arrive through the predicate
 * would have been visible with nobody having said why or when it stops.
 * </p>
 *
 * <p>
 * THE RULE, one fact per visibility decision: an action is admitted by its own lifecycle proof (`carriesItsOwnProof` -
 * `live_verified` re-derived from recorded live runs by `gates/stardew/check-stardew-action-promotion.mjs`, or
 * `published`), or by its own `declaredExperimental`, which states its reason and what retires it. So every site that
 * reads a visibility fact gets one verdict:
 * </p>
 *
 *   `declaration`  reads `declaredExperimental` - the action's own offer, which names its expiry.
 *   `lifecycle`    reads `carriesItsOwnProof` - the door the architecture names, whose evidence expires on its own.
 *   `restrictor`   `!isModDescriptorComplete(...)`, a guard that only ever CLOSES. A door that cannot open is not a
 *                  second answer.
 *   `definition`   the declaration or the function itself, which decides nothing.
 *   `predicate`    anything else: a visibility fact combined into an admission with no expiry written down. THE FINDING.
 *
 * <p>
 * POPULATION FROM SOURCE, verdict from use. The files are every production `.ts` under `host/src` (tests and test support
 * excluded by name, imports stripped so an import is not mistaken for a use), and the facts are the vocabulary the module
 * itself exports plus the two doors - which is to say the population is whatever the tree contains, not a list of sites
 * written here. The counter is printed so a green run states what it read: `sites S · declared D · predicate P`.
 * </p>
 *
 * <p>
 * WHAT THIS READING DOES NOT SEE, stated rather than hidden: a site that admits an action through a fact outside the
 * vocabulary (a new field on the registration, a second table of ids) is invisible to it. That is why the file's other
 * gates hold the PRODUCT's own answer - `visibleActionsFromModCatalog` against the mount, and the actions it offers
 * without a proof against their own declarations - to each other, rather than trusting this census alone. red-proof:
 * `isVisibleWithoutLiveProof` restored beside `hasAnAdmissionPath` reads `predicate` and fails naming
 * `action-registry.ts:visibleActionsFromModCatalog`.
 * </p>
 */
const VISIBILITY_FACTS = /\b(declaredExperimental|carriesItsOwnProof|isModDescriptorComplete)\b/gu;

type VisibilitySiteVerdict = "declaration" | "lifecycle" | "restrictor" | "definition" | "predicate";

type VisibilitySite = Readonly<{ file: string; site: string; verdict: VisibilitySiteVerdict }>;

/** The text with every comment removed, so a mention in prose is not counted as a site. */
function withoutComments(text: string): string {
  const out: string[] = [];
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const character = text[index]!;
    if (quote !== null) {
      out.push(character);
      if (character === "\\") {
        out.push(text[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      out.push(character);
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    out.push(character);
    index += 1;
  }
  return out.join("");
}

/** Every production file under `host/src`: a test and its support are not the product, whatever they are called after that. */
function productionSources(): readonly Readonly<{ file: string; text: string }>[] {
  return readdirSync(resolve(hostRoot, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => {
      const name = basename(path);
      return !name.includes(".test.") && !name.endsWith(".test-support.ts");
    })
    .map((path) => ({
      file: relative(hostRoot, path).split("\\").join("/"),
      text: withoutComments(readFileSync(path, "utf8")).replace(/^import\b[^;]*;/gmu, ""),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

/** The top-level declaration a match sits under, so a failure names the site rather than a byte offset. */
function enclosingDeclaration(text: string, index: number): string {
  const declarations = [
    ...text
      .slice(0, index)
      .matchAll(
        /(?:^|\n)(?:export )?(?:async )?function ([A-Za-z_$][\w$]*)|(?:^|\n)(?:export )?const ([A-Za-z_$][\w$]*) =/gu,
      ),
  ];
  const last = declarations[declarations.length - 1];
  return last === undefined ? "<module>" : (last[1] ?? last[2] ?? "<module>");
}

/** One verdict for every occurrence of a visibility fact in the product. */
function visibilitySites(): readonly VisibilitySite[] {
  const sites: VisibilitySite[] = [];
  for (const { file, text } of productionSources()) {
    for (const match of text.matchAll(VISIBILITY_FACTS)) {
      const fact = match[1]!;
      const index = match.index;
      const before = text.slice(Math.max(0, index - 24), index);
      const definition = /function\s+$/u.test(before);
      const negated = /!\s*\(?\s*$/u.test(before);
      const verdict: VisibilitySiteVerdict = definition
        ? "definition"
        : fact === "declaredExperimental"
          ? "declaration"
          : fact === "carriesItsOwnProof"
            ? "lifecycle"
            : negated
              ? "restrictor"
              : "predicate";
      sites.push(Object.freeze({ file, site: enclosingDeclaration(text, index), verdict }));
    }
  }
  return Object.freeze(sites);
}

test("every visibility decision is a declaration with an expiry, never a predicate", (t) => {
  const sources = productionSources();
  const sites = visibilitySites();
  const withVerdict = (verdict: VisibilitySiteVerdict) => sites.filter((site) => site.verdict === verdict);
  const declared = withVerdict("declaration");
  const predicates = withVerdict("predicate");
  t.diagnostic(
    `sites ${String(sites.length)} · declared ${String(declared.length)} · predicate ${String(predicates.length)}` +
      ` · lifecycle ${String(withVerdict("lifecycle").length)} · restrictor ${String(withVerdict("restrictor").length)}` +
      ` · definitions ${String(withVerdict("definition").length)} · over ${String(sources.length)} production files`,
  );
  assert.ok(sources.length > 0, "blocked: host/src holds no production source, so this census examines nothing");
  assert.ok(
    sites.length > 0,
    "blocked: no production file names a visibility fact, so every verdict above agrees on nothing",
  );
  assert.ok(
    declared.length > 0,
    "blocked: no production site reads declaredExperimental, so the second door is a path this census cannot see",
  );
  assert.deepEqual(
    predicates.map((site) => `visibility_decided_by_a_predicate_with_no_expiry:${site.file}:${site.site}`),
    [],
    "a site admits an action through a fact that states no reason and no expiry",
  );
});

/**
 * THE MOUNT IS NOT A SECOND VISIBILITY DECISION, AND THIS GATE HOLDS IT TO THE ONE THAT IS.
 *
 * `game-tools.ts` mounts a descriptor-derived tool when the Mod's own descriptor opens it - it reads
 * `registration.descriptor` and `isModDescriptorComplete`, and deliberately NOT `lifecycle`, the live capability snapshot
 * or the policy, because the mounted NAME set has to stay constant for the provider prefix cache and per-action
 * eligibility is decided at execution time. `visibleActionsFromModCatalog` is the one visibility decision.
 *
 * MEASURED 2026-11-20: the two agree - 103 actions each, and the mount's 104th tool is `stardew_stop_action`, which is not
 * an action. Agreement today is a disagreement scheduled for later unless something reads both, and the difference is
 * reachable in one edit: delete one row of `UNPROVEN_VISIBILITY_DECLARATIONS` while its action stays `experimental` and the
 * visibility gate refuses the action while the mount keeps handing it out. So the population is derived on both sides -
 * the artifact for the registrations, the product's own `createStardewActionTools` for the tools, and
 * `STARDEW_ACTION_TOOL_NAMES` read BACKWARDS for the action each mounted tool names - and either difference fails by name.
 */
test("the derived mount shows exactly the actions the one visibility decision admits", (t) => {
  const published = loadActionSurface();
  const registrations = registrationsFor(published);
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const visible = new Set(
    visibleActionsFromModCatalog(registrations, capabilities, DEFAULT_ACTION_POLICY).map((action) => action.actionId),
  );
  const actionIdByToolName = new Map<string, string>(
    Object.entries(STARDEW_ACTION_TOOL_NAMES as Readonly<Record<string, string>>).map(([actionId, toolName]) => [
      toolName,
      actionId,
    ]),
  );
  const mounted = new Set(
    mountedToolNames(published).flatMap((toolName) => {
      const actionId = actionIdByToolName.get(toolName);
      return actionId === undefined ? [] : [actionId];
    }),
  );

  const failures: string[] = [];
  for (const actionId of mounted) {
    if (visible.has(actionId)) continue;
    failures.push(
      `mount_shows_an_action_the_visibility_decision_refuses:${actionId}:game-tools.ts mounts its tool while ` +
        "visibleActionsFromModCatalog refuses the action, so the Agent reaches what the visibility gate closed",
    );
  }
  for (const actionId of visible) {
    if (mounted.has(actionId)) continue;
    failures.push(
      `visibility_decision_shows_an_action_the_mount_withholds:${actionId}:the catalog hands the action to the Agent ` +
        "and no mounted tool can act on it",
    );
  }

  // The population, printed so a green run states what it examined: the artifact's own lifecycle counts beside the two
  // sets this gate compares, read out of the artifact rather than listed here.
  const lifecycleCount = (lifecycle: string) => published.filter((action) => action.lifecycle === lifecycle).length;
  t.diagnostic(
    `actions ${String(published.length)} · published ${String(lifecycleCount("published"))} · live_verified ${String(
      lifecycleCount("live_verified"),
    )} · experimental ${String(lifecycleCount("experimental"))} · mounted ${String(mounted.size)} · visible ${String(
      visible.size,
    )} · divergent ${String(failures.length)}`,
  );
  assert.ok(mounted.size > 0, "blocked: the artifact mounts no action tool, so this gate examines nothing");
  assert.ok(
    visible.size > 0,
    "blocked: the visibility decision admits no action, so every mounted tool would be a failure",
  );
  assert.deepEqual(failures, [], "the mount and the visibility decision answer the visibility question differently");
});

/**
 * AN ACTION THE MOD HAS PROVED IS NEVER WITHHELD FOR A HOST-SIDE ROW - OR THE REFUSAL IS NAMED HERE.
 *
 * The one door the architecture names is the action's own proof (`live_verified`, `published`), and it is not enough on
 * its own: `visibleActionsFromModCatalog` also needs a row in the Host's hand-written `STARDEW_ACTION_ADAPTERS` (a
 * capability name and the identity versions this build understands), so an action the Mod proved can be refused because
 * the Host forgot a row - the failure a reader would otherwise see as "the action is not there". Measured 2026-11-20
 * with `some_future_action` registered `live_verified`: refused. The three adapter-less actions on the Mod's own surface
 * (`observe_scene`, `find_destination`, `inspect_world_map`) are `read_only` and belong to the observation tools, which
 * is why the population is the `execution` actions and not the whole registry.
 *
 * "Proved" is derived, not re-spelled: registered minus `unprovenVisibilityActionIds`, which is the product's own answer
 * to the same question.
 */
test("an action whose own lifecycle proved it is never withheld for a missing Host adapter row", (t) => {
  const registrations = registrationsFor(loadActionSurface());
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const visible = new Set(
    visibleActionsFromModCatalog(registrations, capabilities, DEFAULT_ACTION_POLICY).map((action) => action.actionId),
  );
  const unproven = new Set(unprovenVisibilityActionIds(registrations));
  const provedExecution = registrations.filter(
    (registration) => registration.kind === "execution" && !unproven.has(registration.actionId),
  );
  const adapters = new Map<string, (typeof STARDEW_ACTION_ADAPTERS)[number]>(
    STARDEW_ACTION_ADAPTERS.map((adapter) => [adapter.actionId, adapter]),
  );

  const failures: string[] = [];
  for (const registration of provedExecution) {
    if (visible.has(registration.actionId)) continue;
    const adapter = adapters.get(registration.actionId);
    const reason =
      adapter === undefined
        ? "the Host's STARDEW_ACTION_ADAPTERS carries no row for it, so no tool can be built for the action its own " +
          "registration already proved"
        : !adapter.supportedIdentityVersions.includes(registration.identityVersion)
          ? `the Host adapter understands identityVersion ${adapter.supportedIdentityVersions.join("/")} and the Mod ` +
            `registers ${String(registration.identityVersion)}`
          : "another arm of the visibility gate refuses it, and nothing here names which";
    failures.push(
      `proved_action_is_withheld:${registration.actionId}:its lifecycle is \`${registration.lifecycle}\`; ${reason}`,
    );
  }

  t.diagnostic(
    `proved execution actions ${String(provedExecution.length)} · visible ${String(
      provedExecution.filter((registration) => visible.has(registration.actionId)).length,
    )} · withheld ${String(failures.length)}`,
  );
  assert.ok(
    provedExecution.length > 0,
    "blocked: the surface registers no proved execution action, so this gate examines nothing",
  );
  assert.deepEqual(failures, [], "the Mod proved an action and the Host cannot hand it to the Agent");
});
