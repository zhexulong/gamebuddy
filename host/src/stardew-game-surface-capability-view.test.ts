import assert from "node:assert/strict";
import test from "node:test";

import { projectCapabilityView } from "./stardew-production-lifecycle-coordinator.internal.js";
import { GameBrowserValidatorsV1, type GameBrowserStateV1 } from "./game-browser-contract/index.js";

/**
 * `capabilityReader` IS THE WIRE BETWEEN A FACT THE HOST ALREADY MEASURES AND THE PANEL THAT RENDERS IT.
 *
 * <p>
 * `IntegrationLifecycleSnapshot` reduces the attached connection to `availableCapabilities`
 * (`continuity-semantic-game-runtime-materializer.ts`), and `game-status.ts`'s `projectGameStatus` projected it with no
 * production caller. The browser's `capabilitySummary` was the literal `{available: false, count: 0}`, so the companion
 * board read "no capability published" whatever the runtime said — measured 2026-11-23 in the 7-dimension review.
 * </p>
 *
 * <p>
 * THE THREE ZEROS ARE THE POINT. `unavailable` (no reading), a stale/mismatched freshness (a reading that is not this
 * moment's) and a measured `0` (the runtime answered and advertised nothing) are three different facts, and only the
 * third is a number. A mapping that returned `count: 0` for either of the first two would restore exactly the lie the
 * literal told, one layer up.
 * </p>
 */

/** A reading the lease really produces, in the shape `IntegrationLifecycleSnapshot.snapshot()` returns. */
function lifecycle(
  over: Partial<{
    availability: "available" | "unavailable";
    freshness: "current" | "absent" | "stale" | "mismatch";
    category: "available" | "none";
    count: number;
  }> = {},
): Parameters<typeof projectCapabilityView>[0] {
  return Object.freeze({
    availability: over.availability ?? "available",
    surface: "active" as const,
    freshness: over.freshness ?? "current",
    availableCapabilities: Object.freeze({
      category: over.category ?? "available",
      count: over.count ?? 3,
    }),
    activeExecution: "none" as const,
    latestAuthoritativeReceipt: "none" as const,
  });
}

test("an attached runtime's own count is published, never a default", () => {
  for (const count of [0, 1, 7, 512]) {
    const view = projectCapabilityView(lifecycle({ count, category: count === 0 ? "none" : "available" }));
    assert.deepEqual(view, { status: "published", count }, `count ${String(count)}`);
  }
  // The count is the source's, so two readings are two answers.
  assert.notDeepEqual(projectCapabilityView(lifecycle({ count: 3 })), projectCapabilityView(lifecycle({ count: 9 })));
});

test("a measured zero is published and carries no reason, because nothing went unmeasured", () => {
  const zero = projectCapabilityView(lifecycle({ count: 0, category: "none" }));
  assert.deepEqual(zero, { status: "published", count: 0 });
  assert.equal("reason" in zero, false, "a measured zero does not explain itself away");
});

test("no reading at all is not_measured, with a reason and no count", () => {
  for (const view of [
    projectCapabilityView(undefined),
    projectCapabilityView(lifecycle({ availability: "unavailable" })),
    ...(["absent", "stale", "mismatch"] as const).map((freshness) => projectCapabilityView(lifecycle({ freshness }))),
  ]) {
    assert.equal(view.status, "not_measured");
    assert.equal("count" in view, false, `an unmeasured reading must carry no count: ${JSON.stringify(view)}`);
    if (view.status === "not_measured") {
      assert.ok(view.reason.length > 0, "the reason is the half a reader acts on");
      assert.ok(view.reason.length <= 64, `the wire bounds the reason to 64 characters: ${view.reason}`);
    }
  }
  // And the three absences are three different reasons, so a diagnosis is never "some kind of nothing".
  assert.deepEqual(
    [
      projectCapabilityView(undefined),
      projectCapabilityView(lifecycle({ availability: "unavailable" })),
      projectCapabilityView(lifecycle({ freshness: "mismatch" })),
    ].map((view) => (view.status === "not_measured" ? view.reason : "")),
    ["no_attached_runtime", "host_game_state_unavailable", "host_game_state_mismatch"],
  );
});

test("both shapes are the ones the browser contract validates", () => {
  // The summary lives inside `game`, so the shape is checked where it is consumed rather than in isolation: a union
  // member the schema would reject is a projection the panel can never read.
  const summary = (value: GameBrowserStateV1["game"]["capabilitySummary"]) => ({
    apiVersion: 1 as const,
    build: { browserContract: "game_browser_api/v1" as const, profileId: "gamebuddy.game.preview" },
    csrfToken: "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
    browserSession: { expiresAtMs: 100_000 },
    game: {
      prerequisites: { status: "unknown" as const, detectedGame: null },
      instance: { status: "none" as const, gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked" as const, message: null },
      attachment: { status: "none" as const, generation: 0 },
      connectionStatus: "none" as const,
      actionAuthority: "unavailable" as const,
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: value,
      latestOutcome: "none" as const,
    },
  });
  const validator = GameBrowserValidatorsV1.GameBrowserStateV1Schema;
  assert.equal(validator.Check(summary(projectCapabilityView(lifecycle({ count: 4 })))), true);
  assert.equal(validator.Check(summary(projectCapabilityView(undefined))), true);
  // A count reported beside an unmeasured reading is the shape this contract exists to refuse.
  assert.equal(validator.Check(summary({ status: "not_measured" } as unknown as never)), false);
  assert.equal(
    validator.Check(summary({ status: "published", count: 0 } as unknown as never)),
    true,
    "a measured zero is a legal published value",
  );
});
