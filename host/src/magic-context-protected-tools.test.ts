import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewObservationTools } from "./game-tools.js";
import { createStardewKnowledgeTools } from "./knowledge.js";
import { GAMEBUDDY_PROTECTED_TOOLS } from "./magic-context-protected-tools.js";
import { createCompanionStatusTool } from "./runtime-core.internal.js";
import { createWorldBookTools, validateWorldBook, worldBookMetadata } from "./worldbook.js";

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
} as const;

/**
 * The connection the Stardew tool mounts read. Tool mounting is constant for a connected session and
 * execution readiness is re-checked per call, so only the tool NAMES this test needs are real here.
 */
function stardewConnection(): StardewBridgeConnection {
  return {
    scope,
    module: {} as StardewBridgeConnection["module"],
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: [],
      catalogRevision: 1,
      enabledActionIds: [],
      snapshot: {
        revision: 1,
        location: "Farm",
        tile: { x: 1, y: 1 },
        stamina: 100,
        exhausted: false,
        health: 100,
        actionable: true,
        capabilities: [],
        catalogRevision: 1,
        enabledActionIds: [],
        presentationLocale: "en-US",
        weather: "sunny",
        timeOfDay: 600,
        dayOfMonth: 1,
        seasonIndex: 0,
        year: 1,
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
    },
  };
}

const book = validateWorldBook({
  schemaVersion: 1,
  worldBookId: "worldbook_protected_tools",
  revision: 1,
  alwaysOnPremise: "A small reviewed premise.",
  entries: [
    {
      entryId: "companion",
      title: "Companion background",
      content: "Always visible background.",
      scope: "companion",
      provenance: "authored",
      tokenBudget: "small",
    },
  ],
});

/**
 * Every tool name the Game surface registers, read from the modules that build those tools instead of
 * retyped here. The Game Action surface is a closed projection (`STARDEW_ACTION_TOOL_NAMES`), which is
 * the same registry the mount itself reads.
 */
function registeredGameToolNames(): readonly string[] {
  const connection = stardewConnection();
  return [
    createCompanionStatusTool().name,
    ...createStardewObservationTools(connection).map((tool) => tool.name),
    ...createStardewKnowledgeTools(connection).map((tool) => tool.name),
    ...createWorldBookTools({ metadata: worldBookMetadata(book), book }, undefined).map((tool) => tool.name),
  ];
}

/**
 * Upstream's own two defaults. They belong to the coding-agent surface rather than to this Host's
 * registry, and they are present here only so the policy can switch their counts off explicitly.
 */
const UPSTREAM_DEFAULT_TOOL_NAMES: readonly string[] = Object.freeze(["todowrite", "ctx_reduce"]);

test("every protected tool names a tool this Host registers, apart from upstream's two switched off", () => {
  const registered = registeredGameToolNames();
  const protectedNames = Object.keys(GAMEBUDDY_PROTECTED_TOOLS);

  assert.deepEqual(
    protectedNames.filter((name) => !registered.includes(name)),
    [...UPSTREAM_DEFAULT_TOOL_NAMES],
    "a protected name this Host does not register protects nothing and hides a rename",
  );
  // An action or receipt tool result is the record of what happened, not a frame of the world: the
  // newest one is already carried by the live snapshot/status surfaces, and protecting it would keep a
  // superseded receipt in front of the model.
  const actionAndReceiptNames = [...Object.values(STARDEW_ACTION_TOOL_NAMES), "stardew_execution_status"];
  assert.deepEqual(
    protectedNames.filter((name) => actionAndReceiptNames.includes(name)),
    [],
    "an action or receipt tool must never be protected",
  );
});

test("the Game surface keeps exactly one frame per protected tool and switches the upstream defaults off", () => {
  const registered = registeredGameToolNames();
  for (const name of Object.keys(GAMEBUDDY_PROTECTED_TOOLS).filter((key) => registered.includes(key)))
    assert.equal(GAMEBUDDY_PROTECTED_TOOLS[name], 1, `${name} must keep exactly its newest frame`);
  // Zero is how a name overrides upstream's own default count, so `0` here is the explicit refusal of
  // `{todowrite: 1, ctx_reduce: 3}` rather than the key being left out.
  assert.equal(GAMEBUDDY_PROTECTED_TOOLS.todowrite, 0);
  assert.equal(GAMEBUDDY_PROTECTED_TOOLS.ctx_reduce, 0);
});

test("every protected count is a non-negative whole number upstream's schema accepts", () => {
  for (const [name, count] of Object.entries(GAMEBUDDY_PROTECTED_TOOLS))
    assert.ok(
      Number.isSafeInteger(count) && count >= 0,
      `${name} must be a whole number of results to keep, read ${String(count)}`,
    );
});

test("the runtime writes the policy into the config Magic Context reads", () => {
  // The table above is only half the contract: it has to reach the file the extension loads. Magic Context
  // accepts the key and its own suite (protection-window.test.ts, config/protected-tools.test.ts) covers the
  // reclaim that honours it, so this pins the one seam between them - if a future edit stops passing the table
  // to the config writer, nothing else would notice.
  const source = readFileSync(new URL("../src/runtime-core.internal.ts", import.meta.url), "utf8");
  assert.match(source, /protected_tools: GAMEBUDDY_PROTECTED_TOOLS,/u);
  assert.match(source, /from "\.\/magic-context-protected-tools\.js"/u);
});
