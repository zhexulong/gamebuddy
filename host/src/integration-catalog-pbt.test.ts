import assert from "node:assert/strict";
import test from "node:test";

import { createDeterministicBridgePair } from "./bridge.js";
import { GameBridgeClient } from "./game-bridge-client.js";
import { newEnvelope, type Scope } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { fc } from "./test-support/fast-check.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = 1_700_000_000_000;
const token = "a".repeat(16);
const TEST_RUNTIME_ATTESTATION = { runtimeRole: "unattested" as const, launchGeneration: null };
const registrations = [
  {
    actionId: "move_to_tile",
    familyId: "movement_navigation",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
  }
];

function sendSnapshot(
  endpoint: ReturnType<typeof createDeterministicBridgePair>[1],
  revision: number,
  catalogRevision: number,
  enabled: boolean,
): void {
  endpoint.send(
    newEnvelope(
      "snapshot",
      scope,
      {
        revision,
        location: "Farm",
        tile: { x: 10, y: 11 },
        stamina: 270,
        health: 100,
        actionable: true,
        capabilities: enabled ? ["inspect_self", "move_to_tile"] : ["inspect_self"],
        catalogRevision,
        enabledActionIds: enabled ? ["move_to_tile"] : [],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      `snapshot_${catalogRevision}`,
      now,
    ),
    now,
  );
}

test("Catalog PBT: Host projection follows complete monotone Mod publications", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { minLength: 0, maxLength: 12 }),
      (desiredMemberships) => {
        const [host, mod] = createDeterministicBridgePair(scope);
        const client = new GameBridgeClient(scope, host, STARDEW_GAME_INTEGRATION_ADAPTER);
        try {
          assert.equal(client.hello(token, now), null);
          mod.send(
            newEnvelope(
              "hello_ack",
              scope,
              {
                sessionId: "session_01",
                capabilities: ["inspect_self", "move_to_tile"],
                catalogRevision: 1,
                enabledActionIds: ["move_to_tile"],
                presentationLocale: "en-US",
                registrations,
                ...TEST_RUNTIME_ATTESTATION,
              },
              "hello_01",
              now,
            ),
            now,
          );
          let enabled = true;
          let catalogRevision = 1;
          let snapshotRevision = 1;
          sendSnapshot(mod, snapshotRevision, catalogRevision, enabled);

          for (const nextEnabled of desiredMemberships) {
            if (nextEnabled !== enabled) {
              catalogRevision++;
              enabled = nextEnabled;
              mod.send(
                newEnvelope(
                  "catalog_update",
                  scope,
                  {
                    catalogRevision,
                    enabledActionIds: enabled ? ["move_to_tile"] : [],
                  },
                  `catalog_${catalogRevision}`,
                  now,
                ),
                now,
              );
              // No stale snapshot may keep an old catalog executable.
              assert.equal(client.state.snapshot, null);
              snapshotRevision++;
              sendSnapshot(mod, snapshotRevision, catalogRevision, enabled);
            }

            assert.equal(client.state.catalogRevision, catalogRevision);
            assert.deepEqual(
              client.state.enabledActionIds,
              enabled ? ["move_to_tile"] : [],
            );
            assert.equal(
              client.execute(
                {
                  requestId: `request_${catalogRevision}`,
                  idempotencyKey: `idempotency_${catalogRevision}`,
                  action: "move_to_tile",
                  args: { x: 11, y: 12 },
                  expectedRevision: snapshotRevision,
                  deadlineMs: now + 10_000,
                },
                now,
              ),
              enabled ? null : "not_ready",
            );
          }
        } finally {
          client.dispose();
        }
      },
    ),
    { numRuns: 100 },
  );
});
