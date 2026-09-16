import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STARDEW_ACTION_ADAPTERS,
  STARDEW_ACTION_TOOL_NAMES,
  STARDEW_CANDIDATE_ACTION_IDS,
} from "./action-registry.js";

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
  resourceTemplate?: Readonly<{ claims?: readonly SurfaceActionClaim[] }>;
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
  const candidates = new Set(STARDEW_CANDIDATE_ACTION_IDS as readonly string[]);
  const missingCandidate = loadActionSurface()
    .filter(isPublishedWorthyExperimental)
    .filter((action) => !candidates.has(action.actionId))
    .map((action) => action.actionId);
  assert.deepEqual(missingCandidate, []);
});

test("every staged candidate action stays surfaceable through a Host tool name", () => {
  const unsurfaceable = [...STARDEW_CANDIDATE_ACTION_IDS].filter(
    (actionId) => !(actionId in STARDEW_ACTION_TOOL_NAMES),
  );
  assert.deepEqual(unsurfaceable, []);
});