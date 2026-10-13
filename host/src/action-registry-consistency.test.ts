import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STARDEW_ACTION_ADAPTERS,
  STARDEW_ACTION_TOOL_NAMES,
  STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS,
  isDescriptorDerivedActionId,
  isModDescriptorComplete,
} from "./action-registry.js";
import type { ActionRegistrationDescriptor } from "./protocol.js";

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
  argumentSchema?: Readonly<Record<string, Readonly<{ type: string }>>>;
  resourceTemplate?: Readonly<{ claims?: readonly SurfaceActionClaim[] }>;
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
}>;

function loadActionSurface(): readonly SurfaceAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ACTION_SURFACE_ARTIFACT, "utf8"));
  } catch (error) {
    throw new Error(
      `stardew_action_surface_artifact_unreadable:${ACTION_SURFACE_ARTIFACT}`,
      { cause: error },
    );
  }
  const surface = parsed as Readonly<{ schema?: unknown; actions?: unknown }>;
  if (
    surface?.schema !== "gamebuddy-action-descriptors/v1" ||
    !Array.isArray(surface.actions)
  ) {
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
  return (
    action.lifecycle === "published" &&
    action.kind === "execution" &&
    claimsScopePlayer(action)
  );
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

const adapterIds = new Set<string>(
  STARDEW_ACTION_ADAPTERS.map((adapter) => adapter.actionId),
);

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
const GAME_TOOLS_SOURCE = readFileSync(
  resolve(hostRoot, "src", "game-tools.ts"),
  "utf8",
);

/** Every action id a mount block names, straight from the source. */
function mountedActionIds(): readonly string[] {
  return [
    ...new Set(
      [...GAME_TOOLS_SOURCE.matchAll(/^\s*action: "([a-z_]+)",/gm)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
}

/** The descriptor hello_ack publishes for one artifact action: an `arguments` array plus the postcondition record. */
function publishedDescriptor(action: SurfaceAction): ActionRegistrationDescriptor {
  return {
    arguments: Object.entries(action.argumentSchema ?? {}).map(([name, schema]) => ({
      name,
      type: schema.type,
    })),
    ...(action.effect === undefined ? {} : { effect: action.effect }),
    ...(action.postcondition?.name === undefined
      ? {}
      : { postcondition: { name: action.postcondition.name } }),
  };
}

/**
 * Mounts this gate cannot judge from the artifact, each with the reason. A reservation is a claim about the
 * ARTIFACT, never about the rule: the id still has to be complete on the descriptor hello_ack publishes, and a
 * reservation that is no longer needed fails the third test below rather than sitting here.
 */
const UNJUDGEABLE_FROM_THE_ARTIFACT: Readonly<Record<string, string>> = Object.freeze({
  express_emote:
    "its arm requires the emote argument's enum and a nativeBinding, and the exported artifact carries neither: FarmhandActionArgumentSchema is { type } only (farmhandactionsurfacepublication.cs:27) and the projection record has no native binding field at all (:14-25).",
  face_direction:
    "same projection gap as express_emote: the direction argument's enum (FarmhandActionCatalog.DirectionEnum) and the descriptor's nativeBinding are not projected into the artifact.",
});

test("every mounted descriptor-derived action opens the gate on the Mod's own published descriptor", () => {
  const mounted = mountedActionIds();
  assert.ok(
    mounted.length >= 70,
    `expected the mount blocks to be found, got ${mounted.length}`,
  );
  const published = new Map(loadActionSurface().map((action) => [action.actionId, action]));
  const failures: string[] = [];
  for (const actionId of mounted) {
    if (!isDescriptorDerivedActionId(actionId)) continue;
    if (actionId in UNJUDGEABLE_FROM_THE_ARTIFACT) continue;
    const action = published.get(actionId);
    if (action === undefined) {
      failures.push(`${actionId}: no published descriptor in the Mod artifact`);
      continue;
    }
    if (!isModDescriptorComplete(actionId, publishedDescriptor(action)))
      failures.push(`${actionId}: the gate stays shut on the descriptor the Mod publishes, so the Agent can never call it`);
  }
  assert.deepEqual(
    failures,
    [],
    `these mounted actions are unreachable: ${failures.join(" | ")}`,
  );
});

test("every descriptor-derived id is both mounted and published, so no arm is dead code", () => {
  const mounted = new Set(mountedActionIds());
  const published = new Set(loadActionSurface().map((action) => action.actionId));
  assert.deepEqual(
    STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.filter((actionId) => !mounted.has(actionId)),
    [],
    "a descriptor-derived id with no mount block is an arm nothing can reach",
  );
  assert.deepEqual(
    STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS.filter((actionId) => !published.has(actionId)),
    [],
    "a descriptor-derived id the Mod does not publish can never be complete",
  );
});

test("each reservation names a reason and is still required", () => {
  const published = new Map(loadActionSurface().map((action) => [action.actionId, action]));
  for (const [actionId, reason] of Object.entries(UNJUDGEABLE_FROM_THE_ARTIFACT)) {
    assert.equal(
      isDescriptorDerivedActionId(actionId),
      true,
      `${actionId} is reserved but is not gated by isModDescriptorComplete at all`,
    );
    assert.ok(reason.length > 80, `${actionId} needs a reason that names what is missing`);
    const action = published.get(actionId);
    assert.notEqual(action, undefined, `${actionId} is reserved but the Mod publishes no descriptor`);
    assert.equal(
      isModDescriptorComplete(actionId, publishedDescriptor(action!)),
      false,
      `${actionId} is now judgeable from the artifact: drop the reservation instead of weakening the gate`,
    );
  }
});