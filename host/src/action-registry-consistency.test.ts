import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MOD_DESCRIPTOR_REQUIREMENTS,
  STARDEW_ACTION_ADAPTERS,
  STARDEW_ACTION_TOOL_NAMES,
  STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS,
  isDescriptorDerivedActionId,
  isModDescriptorComplete,
} from "./action-registry.js";
import { createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { MOUNTED_GAME_SURFACE_TOOL_NAMES } from "./game-surface-prompt-floor.test-support.js";
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

/** Every action id a mount block names, straight from the source. */
function mountedActionIds(): readonly string[] {
  return [...new Set([...GAME_TOOLS_SOURCE.matchAll(/^\s*action: "([a-z_]+)",/gm)].map((match) => match[1]!))].sort();
}

/** The descriptor hello_ack publishes for one artifact action: an `arguments` array plus the postcondition record. */
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
 * The tool list a Game session is handed, built by the function a session calls with the catalog hello_ack
 * publishes. `familyId` is the one registration field the artifact does not publish, and mounting reads only the
 * id and the descriptor.
 */
function mountedToolNames(published: readonly SurfaceAction[]): readonly string[] {
  const registrations: readonly ActionRegistration[] = published.map((action) => ({
    actionId: action.actionId,
    familyId: action.actionId,
    identityVersion: action.identityVersion,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    descriptor: publishedDescriptor(action),
  }));
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
 * The Game conduct told the companion "Body language goes through the native actions stardew_express_emote and
 * stardew_face_direction" while neither tool was in the mounted list: measured round44, `stardew_express_emote`
 * appeared zero times as a mounted tool definition and only in that sentence. Nothing compared the two - the
 * floor is prose, the mount ledger is code, and each was checked on its own. This gate reads the rendered floor
 * the model receives and holds every tool name in it against the list a Game session actually mounts.
 *
 * THE LIST A GAME SESSION ACTUALLY MOUNTS IS NOT `mountedToolNames` BELOW. That one is `createStardewActionTools`'
 * output, and a plan surface drops every entry of it (`runtime-core.internal.ts`, asserted structurally by
 * `game-surface-prompt-floor.test.ts`) - so this gate compared the floor against a list the request never carried,
 * and stayed green while the floor named `stardew_express_emote` and the Agent was handed `stardew_plan_work`
 * instead (measured 2026-11-11, `round46b`: 68 tool calls, no emote). The population is the recorded mounted set.
 */
const FLOOR_TOOL_NAME = /\bstardew_[a-z0-9_]+/gu;

test("every tool the Game prompt floor names is a tool a Game session mounts", () => {
  const floor = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  const named = [...new Set([...floor.matchAll(FLOOR_TOOL_NAME)].map((match) => match[0]))].sort();
  assert.ok(named.length > 0, "blocked: the rendered Game prompt names no tool at all, so this gate examines nothing");
  const mounted = new Set(MOUNTED_GAME_SURFACE_TOOL_NAMES);
  assert.ok(mounted.size > 0, "blocked: the recorded mounted Game tool set is empty, so every name would pass");
  assert.deepEqual(
    named.filter((name) => !mounted.has(name)).map((name) => `floor_names_unmounted_tool:${name}`),
    [],
    `the prompt tells the companion to use a tool no Game session mounts: ${named.join(", ")}`,
  );
  // The surface's own rule, DERIVED rather than recorded: a plan surface drops every tool `createStardewActionTools`
  // returns, so none of those names can appear in the floor however the recorded set changes.
  const perAction = new Set(mountedToolNames(loadActionSurface()));
  assert.ok(
    perAction.size > 0,
    "blocked: the adapter mounts no per-action tool, so the negative below examines nothing",
  );
  assert.deepEqual(
    named.filter((name) => perAction.has(name)).map((name) => `floor_names_per_action_tool:${name}`),
    [],
    `the prompt names a per-action tool the plan surface drops: ${named.filter((name) => perAction.has(name)).join(", ")}`,
  );
});
