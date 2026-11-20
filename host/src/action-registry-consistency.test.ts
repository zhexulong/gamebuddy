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
  UNPROVEN_VISIBILITY_DECLARATIONS,
  isDescriptorDerivedActionId,
  isModDescriptorComplete,
  unprovenVisibilityActionIds,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import { planActionsFromRegistrations } from "./body-program-script.js";
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
 * EVERYTHING THE MOD REGISTERS CARRIES ITS OWN PROOF OR A DECLARED REASON, AND NOTHING CARRIES BOTH.
 *
 * `design/architecture/game-action-model.md:44` gives visibility exactly one door - `live_verified`, earned by a real live
 * run on the target version - and `visibleActionsFromModCatalog` has two. The second is the descriptor-derived carve-out:
 * an enrolled action whose Mod-owned descriptor is complete is admitted while its lifecycle still says `experimental`.
 *
 * WHICH actions walk through that door is not listed anywhere else: `lifecycle` is a field the Mod's registration
 * publishes, so "carries no proof of its own" is `unprovenVisibilityActionIds(registrations)`, derived from the artifact
 * here, and `UNPROVEN_VISIBILITY_DECLARATIONS` is the DOOR itself - `visibleActionsFromModCatalog` admits an action its
 * lifecycle does not admit by finding its row, and by nothing else. This gate is the bijection between the two, failing
 * in both directions, each with its own name rather than a count:
 *
 *   `an_action_without_its_own_proof_is_undeclared:<action>`
 *       registered, lifecycle neither `live_verified` nor `published`, and no row: it is refused, and nobody wrote down
 *       whether that is intended. One direction alone would be a table that can only grow.
 *   `declared_row_names_a_proven_action:<action>`
 *       a row whose action has since earned its own proof. An exemption must expire, and a row left sitting there reads as
 *       authority for a fact the Mod already states.
 *   `declared_row_names_no_registered_action:<action>`
 *       a row whose action has left the surface altogether: it excuses nothing.
 *   `declared_row_admits_nothing:<action>`
 *       a row whose action the catalog gate still refuses: the row is the door, so a row that admits nothing has drifted
 *       away from the reason it states.
 *
 * The population is the Mod's own published surface, and "carries its own proof" is the lifecycle byte - which is not
 * taken on faith here either: `tools/check-stardew-action-promotion.mjs` re-derives `live_verified` from the recorded live
 * runs in `host/src/test-fixtures/stardew-live-receipts.json` and the target-version evidence directory, so the fact this
 * gate reads is the fact that gate checks.
 */
test("every action without its own proof has a declared reason, and no row outlives its reason", (t) => {
  const registrations = registrationsFor(loadActionSurface());
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const visible = visibleActionsFromModCatalog(registrations, capabilities, DEFAULT_ACTION_POLICY);

  const registered = [...new Set(registrations.map((registration) => registration.actionId))].sort();
  const lifecycleOf = new Map(registrations.map((registration) => [registration.actionId, registration.lifecycle]));
  const visibleIds = new Set(visible.map((action) => action.actionId));
  // "Proven" is the registered set MINUS the derived one: the two lifecycle values this gate is made of are read by
  // `unprovenVisibilityActionIds`, and reading them again here would be the same second spelling the row list was.
  const unproven = unprovenVisibilityActionIds(registrations);
  const unprovenIds = new Set(unproven);
  const proven = registered.filter((actionId) => !unprovenIds.has(actionId));
  const declared: readonly string[] = UNPROVEN_VISIBILITY_DECLARATIONS.map(
    (declaration) => declaration.actionId,
  ).sort();
  const declaredIds = new Set(declared);
  const refused = registered.filter((actionId) => !visibleIds.has(actionId));

  const failures: string[] = [];
  for (const actionId of unproven) {
    if (declaredIds.has(actionId)) continue;
    failures.push(
      `an_action_without_its_own_proof_is_undeclared:${actionId}:its registration lifecycle is ` +
        `\`${String(lifecycleOf.get(actionId))}\`, so the only door that could admit it is a row in that table, and ` +
        "there is none: it is refused, and nothing states whether that is intended",
    );
  }
  for (const declaration of UNPROVEN_VISIBILITY_DECLARATIONS) {
    const { actionId } = declaration;
    if (declaration.reason.trim().length === 0 || declaration.deleteWhen.trim().length === 0) {
      failures.push(`declared_row_states_no_reason_or_no_expiry:${actionId}`);
    }
    if (!lifecycleOf.has(actionId)) {
      failures.push(
        `declared_row_names_no_registered_action:${actionId}:the Mod's surface publishes no such action, so the row excuses nothing`,
      );
    } else if (!unprovenIds.has(actionId)) {
      failures.push(
        `declared_row_names_a_proven_action:${actionId}:its own lifecycle is ` +
          `\`${String(lifecycleOf.get(actionId))}\`, so delete the row and let its own proof admit it`,
      );
    }
  }

  // The population, printed so a green run states what it examined instead of agreeing with itself: a derivation that
  // stopped seeing the lifecycle would empty `unproven` and leave `declared` the only side still naming an action.
  t.diagnostic(
    `visible ${String(visible.length)} · proven ${String(proven.length)} · unproven ${String(unproven.length)}` +
      ` · declared ${String(declared.length)} · refused ${String(refused.length)} · of ${String(
        registered.length,
      )} registered · unproven [${unproven.join(", ")}] · declared [${declared.join(", ")}]`,
  );
  // The table IS the second door, so the third direction is a row that admits nothing: a row whose action is refused is
  // an exemption nobody can walk through, and it reads as authority for a visibility the Agent does not have.
  for (const actionId of declared) {
    if (visibleIds.has(actionId)) continue;
    failures.push(
      `declared_row_admits_nothing:${actionId}:the row states why it may be visible and the catalog gate refuses it ` +
        "anyway, so the reason and the door have drifted apart",
    );
  }
  // Zero population is BLOCKED, never green: a surface that registers nothing makes every count above agree on nothing.
  assert.ok(
    registered.length > 0,
    "blocked: the published surface registers no action at all, so this gate examines nothing",
  );
  assert.ok(
    visible.length > 0,
    "blocked: the published surface admits no action at all, so this gate examines nothing",
  );
  assert.deepEqual(failures, [], "the declared reasons do not account for the actions without a proof of their own");
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
  // The surface's own rule, DERIVED rather than recorded: a plan surface keeps a per-action tool for exactly the actions
  // its plan vocabulary does not carry (`action-registry.ts` `keepsOwnToolOnPlanSurface`), and carries the rest as plan
  // steps - one action, one route (`action-route-gate.test.ts` holds both directions). So the floor may not name the tool
  // of an action that reaches her as a plan row, and the population is that set of tools, not "every tool but expression".
  // Measured 2026-11-14: the old population also excused itself for the seven `experimental` actions, whose tools no
  // surface mounted at all, so the gate was quiet about a route that did not exist while calling it the right one.
  const planCarried = new Set<string>(
    planActionsFromRegistrations(registrationsFor(loadActionSurface())).map((action) => action.actionId),
  );
  const toolNameOfPlanCarried = new Set<string>(
    [...planCarried].flatMap((actionId) => {
      const name = STARDEW_ACTION_TOOL_NAMES[actionId as keyof typeof STARDEW_ACTION_TOOL_NAMES] as string | undefined;
      return name === undefined ? [] : [name];
    }),
  );
  const perAction = new Set<string>(
    mountedToolNames(loadActionSurface()).filter((name) => toolNameOfPlanCarried.has(name)),
  );
  assert.ok(
    perAction.size > 0,
    "blocked: the adapter mounts no per-action tool for a plan-carried action, so the negative below examines nothing",
  );
  assert.deepEqual(
    named.filter((name) => perAction.has(name)).map((name) => `floor_names_per_action_tool:${name}`),
    [],
    `the prompt names a per-action tool the plan surface drops: ${named.filter((name) => perAction.has(name)).join(", ")}`,
  );
});

/**
 * EVERY SITE THAT DECIDES AN ACTION IS VISIBLE DOES SO THROUGH A DECLARATION THAT CAN EXPIRE - OR IT IS A FINDING.
 *
 * <p>
 * The defect this gate exists for, measured on the tree rather than reported. Visibility had TWO answers: the table
 * `UNPROVEN_VISIBILITY_DECLARATIONS`, where each row carries a `reason` and a `deleteWhen`, and a predicate
 * `isVisibleWithoutLiveProof` = "descriptor-derived and its descriptor is complete", which carried neither. The predicate
 * admitted exactly the two actions the table already named, so nothing downstream could tell the two apart - and the next
 * action to arrive through the predicate would have been visible with nobody having said why or when it stops.
 * </p>
 *
 * <p>
 * THE RULE, one fact per visibility decision: an action is admitted by its own lifecycle proof (`carriesItsOwnProof` -
 * `live_verified` re-derived from recorded live runs by `tools/check-stardew-action-promotion.mjs`, or `published`), or by
 * a row of the table, which states its expiry. So every site that reads a visibility fact gets one verdict:
 * </p>
 *
 *   `declaration`  reads `UNPROVEN_VISIBILITY_DECLARATIONS`. The row is the door, and a row has a `deleteWhen`.
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
 * gates hold the PRODUCT's own answer - `visibleActionsFromModCatalog` against the mount, and the table against the Mod's
 * lifecycle - to each other, rather than trusting this census alone. red-proof: `isVisibleWithoutLiveProof` restored
 * beside `hasAnAdmissionPath` reads `predicate` and fails naming `action-registry.ts:visibleActionsFromModCatalog`.
 * </p>
 */
const VISIBILITY_FACTS = /\b(UNPROVEN_VISIBILITY_DECLARATIONS|carriesItsOwnProof|isModDescriptorComplete)\b/gu;

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
      const definition =
        /function\s+$/u.test(before) || (fact === "UNPROVEN_VISIBILITY_DECLARATIONS" && /const\s+$/u.test(before));
      const negated = /!\s*\(?\s*$/u.test(before);
      const verdict: VisibilitySiteVerdict = definition
        ? "definition"
        : fact === "UNPROVEN_VISIBILITY_DECLARATIONS"
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
    "blocked: no site reads UNPROVEN_VISIBILITY_DECLARATIONS, so the second door is a path this census cannot see",
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

  t.diagnostic(
    `mounted actions ${String(mounted.size)} · visible ${String(visible.size)} · divergent ${String(failures.length)}`,
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
