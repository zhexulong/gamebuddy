import assert from "node:assert/strict";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { GameConnection } from "./game-connection.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createWorldBookTools, validateWorldBook, worldBookMetadata } from "./worldbook.js";

/**
 * The tools the Game surface mounts that this Host declares itself, built by the factories the composition calls.
 *
 * <p>
 * This is the population two gates read (`tool-parameter-described.test.ts`, `tool-query-duplication.test.ts`), so it
 * lives in one place: a second copy of the assembly would let the two gates drift into checking different tool sets, and
 * the drift would be invisible because each copy is self-consistent.
 * </p>
 *
 * <p>
 * WHAT IS IN IT, AND WHY THE BOUNDARY IS WHERE IT IS. The connection publishes no catalog, so the adapter materializes
 * exactly the tools it declares statically - its observation set and (with no knowledge bundle) its knowledge set -
 * and the world book's own two tools are added beside them. Every one of those has a schema written here, which is what
 * makes "the description must answer for the schema" a question about this repository's own declarations.
 * </p>
 *
 * <p>
 * WHAT IS NOT IN IT. Descriptor-derived per-action tools exist only for the actions the Mod publishes and their schemas
 * are built from those descriptors, so they are a different authority. The program tools
 * (`stardew_plan_work`, `stardew_action_program_status`, `stardew_action_program_shape`) are composed by the
 * materializer's module-private `createBodyProgramTools` behind a live journal, and `companion_status` by
 * `runtime-core.internal.ts`; both are named here rather than silently absent, because a gate's population is the first
 * thing to check when it reports nothing.
 * </p>
 */
export function gameSurfaceDeclaredTools(): readonly ToolDefinition[] {
  const set = STARDEW_GAME_INTEGRATION_ADAPTER.createToolSet({
    connection: connectionWithoutCatalog(),
    policy: STARDEW_GAME_INTEGRATION_ADAPTER.defaultPolicy,
    dispatchAdmissionFactory: () => {
      throw new Error("game_surface_inventory_never_dispatches");
    },
  });
  // The boundary is asserted rather than assumed: with nothing published the adapter has no action tool, so every tool
  // returned here is one this Host declares. A per-action tool arriving would mean its schema is no longer derived from
  // the Mod's descriptor, and the paragraph above about what these gates cover would be wrong.
  assert.deepEqual(
    [...set.actions],
    [],
    "the connection publishes no catalog, so the descriptor-derived action tools are not part of this population",
  );
  return [...set.observation, ...set.knowledge, ...emptyWorldBookTools()];
}

/**
 * A connection that is live enough to materialize tools and publishes no catalog.
 *
 * `requireLiveConnection` reads liveness from `executionGate.executable` alone
 * (`stardew-integration-launcher-body-program.internal.ts`), so a stub without it is refused before any tool exists.
 */
function connectionWithoutCatalog(): GameConnection {
  return {
    scope: {
      integrationId: "stardew",
      saveId: "save_tool_inventory",
      worldId: "world_tool_inventory",
      playerId: "player_tool_inventory",
      companionId: "companion_tool_inventory",
    },
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    executionGate: { executable: true },
    state: {
      connected: true,
      sessionId: "session_tool_inventory",
      capabilities: [],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot: null,
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: [],
    },
    async execute() {
      throw new Error("game_surface_inventory_never_executes");
    },
    async cancel() {
      throw new Error("game_surface_inventory_never_cancels");
    },
  } as unknown as GameConnection;
}

/** The empty reviewed world book: its tools are mounted on this surface whatever the book holds. */
function emptyWorldBookTools(): readonly ToolDefinition[] {
  const book = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "worldbook_tool_inventory",
    revision: 1,
    alwaysOnPremise: "",
    entries: [],
  });
  return createWorldBookTools(Object.freeze({ metadata: worldBookMetadata(book), book }), undefined, { char: null });
}
