import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { diagnoseBridgeMessage, validateBridgeMessage, type Scope } from "./protocol.js";

/**
 * THE HOST MUST ACCEPT WHAT THE MOD'S OWN PROJECTION ACTUALLY PUBLISHES.
 *
 * <p>
 * Five defects in one day were one shape: a fact written on both sides of the bridge with no authority.
 * </p>
 *
 * <pre>
 *   health          Mod `tree.health.Value > 0f`   |  Host `value.health === 1`       -> bridge closed on a real farm
 *   sceneTarget     Mod declares it                |  artifact omits it                -> 14 dispatches, 0 successes
 *   chest_retrieve  artifact [chestId, item]       |  Host wanted [slot, x, y, id]     -> every request refused
 *   identity        Mod publishes it               |  Host `hasExactKeys` missed it    -> invalid_observe_scene_result
 *   sr1_            affordance offers a ref        |  action validates a sha256 id     -> 6 chop failures
 * </pre>
 *
 * <p>
 * Every one was found by a live run, and every one was findable without the game. The Mod's own projection, run over a
 * real world, produces entries the Host must accept - so the Mod now publishes exactly that, and this gate is the Host
 * half: it runs the SHIPPED validator over the SHIPPED projection's output.
 * </p>
 *
 * <h2>What makes this evidence rather than a second opinion</h2>
 * <p>
 * The Artifact is not written by this test, and not written by hand. It is produced by
 * `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SnapshotLoopbackExportTests.cs`, which builds a
 * headless farm from the game's own types and calls the real `Discover*` methods. `validateSnapshot` then reads that
 * output, so a field the Host names and the Mod does not (or the reverse) fails HERE, at the boundary, instead of on a
 * player's farm.
 * </p>
 *
 * <h2>The distinction the artifact keeps</h2>
 * <p>
 * A family the headless world cannot construct is recorded as `absent` with a reason, never omitted. This gate checks
 * only the `real` families: an absent one proves nothing about what the Host accepts, and must never be read as
 * agreement.
 * </p>
 */

const ARTIFACT_URL = new URL(
  "../../integrations/stardew/action-development/contracts/generated/snapshot-sample.v1.json",
  import.meta.url,
);
const SCOPE: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

type Artifact = Readonly<{
  schema: string;
  producedBy: string;
  consumedBy: string;
  real: Record<string, readonly unknown[]>;
  absent: readonly Readonly<{ field: string; reason: string }>[];
}>;

const ARTIFACT: Artifact = JSON.parse(readFileSync(fileURLToPath(ARTIFACT_URL), "utf8")) as Artifact;

/**
 * The families this gate refuses to lose.
 *
 * <p>
 * The artifact's `real` set is derived from the exporter's world, which is right - but a world that quietly stopped
 * building trees would move that family to `absent`, and every assertion below would stay green while the coverage it
 * exists for disappeared. So the minimum is named here, once, with the reason each family matters. It is a floor, not a
 * census: the exporter may publish more.
 * </p>
 */
const FAMILIES_THAT_MUST_STAY_REAL: ReadonlyMap<string, string> = new Map([
  ["treeChopSourceTargets", "the family whose Host bound of `=== 1` closed the bridge on a real farm"],
  ["treeStumpTargets", "the felled tree, published at the engine's own stump health"],
  ["weedTargets", "an object-layer weed, decided by the native `Object.IsWeeds()` category"],
  ["rockSourceTargets", "a multi-hit stone, which the old one-swing predicate hid entirely"],
  ["grassTargets", "a TerrainFeature tuft, the family distinct from the object-layer weeds"],
  ["chests", "one container carrying its whole contents, the shape that replaced the cross product"],
  ["npcRelationshipTargets", "a villager the player has never met, published as the zeroed record"],
]);

/** The scalar members a snapshot payload must carry before any family is even read. */
const SNAPSHOT_SCALARS = Object.freeze({
  revision: 7,
  location: "ProbeFarm",
  tile: { x: 2, y: 2 },
  stamina: 270,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: ["chop_tree_source"],
  catalogRevision: 1,
  enabledActionIds: [] as readonly string[],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  activeExecution: null,
});

/** One real snapshot envelope carrying the artifact's families, exactly as the Mod would send them. */
function sampleEnvelope(families: Record<string, readonly unknown[]>, label: string): unknown {
  return {
    protocolVersion: 1,
    messageId: `snapshot_loopback_${label}`,
    correlationId: `snapshot_loopback_${label}`,
    timestampMs: Date.now(),
    scope: SCOPE,
    type: "snapshot",
    payload: { ...SNAPSHOT_SCALARS, ...families },
  };
}

test("the artifact names what it can prove and what it cannot", () => {
  assert.equal(ARTIFACT.schema, "gamebuddy-stardew-snapshot-sample/v1");
  assert.ok(
    ARTIFACT.producedBy.includes("SnapshotLoopbackExportTests"),
    `producedBy must name the real producer: ${ARTIFACT.producedBy}`,
  );
  assert.equal(ARTIFACT.consumedBy, "host/src/snapshot-loopback.test.ts");

  const real = Object.keys(ARTIFACT.real);
  const absent = ARTIFACT.absent.map((entry) => entry.field);
  assert.deepEqual(
    real.filter((field) => absent.includes(field)),
    [],
    "a family cannot be both constructed and absent - that would make the artifact contradict itself",
  );
  for (const entry of ARTIFACT.absent)
    assert.ok(
      typeof entry.reason === "string" && entry.reason.length > 0,
      `${entry.field} is absent without a reason; an unexplained absence reads as agreement`,
    );
  assert.ok(real.length > 0, "an artifact with no real families would make every assertion below vacuous");
});

test("the families the artifact proves are still the families it proved last time", () => {
  const real = new Set(Object.keys(ARTIFACT.real));
  const lost = [...FAMILIES_THAT_MUST_STAY_REAL.entries()]
    .filter(([field]) => !real.has(field))
    .map(([field, reason]) => `${field} -> no longer constructed: ${reason}`);
  assert.deepEqual(
    lost,
    [],
    "a family that stopped being constructed moved to `absent`, and every acceptance assertion stayed green while the " +
      "coverage it exists for disappeared. Either the exporter's world lost a capability it had, or the family is gone " +
      "from the Mod on purpose - and then this list is what should change, not the silence",
  );
});

test("the Host accepts the entries the Mod's own projection publishes", () => {
  const refused: string[] = [];
  for (const [field, entries] of Object.entries(ARTIFACT.real)) {
    const message = sampleEnvelope({ [field]: entries }, field);
    const diagnosis = diagnoseBridgeMessage(message, SCOPE);
    if (diagnosis !== null && diagnosis !== "accepted") {
      refused.push(`${field}: ${diagnosis} <- ${JSON.stringify(entries).slice(0, 400)}`);
      continue;
    }
    const decision = validateBridgeMessage(message, SCOPE);
    if (decision !== null) refused.push(`${field}: decision path returned ${decision}`);
  }
  assert.deepEqual(
    refused,
    [],
    "the Mod published these targets and the Host refused them - which is not a wire fault, it is the two sides " +
      "disagreeing about a field or a bound, and it disconnects the bridge on a real farm",
  );
});

test("every real family is validated ON THE DECISION PATH, not only by the diagnostic", () => {
  // The two paths are deliberately not the same function, and a family validated by one and forgotten by the other is
  // the defect `SNAPSHOT_FAMILY_RULES` was introduced for. This asserts the pair agrees on the artifact's own entries,
  // so a family added to the diagnostic alone cannot pass here.
  for (const [field, entries] of Object.entries(ARTIFACT.real)) {
    const message = sampleEnvelope({ [field]: entries }, `pair_${field}`);
    assert.equal(validateBridgeMessage(message, SCOPE), null, `${field}: the decision path refused a published entry`);
    const diagnosis = diagnoseBridgeMessage(message, SCOPE);
    assert.ok(
      diagnosis === null || diagnosis === "accepted",
      `${field}: the diagnostic refused what the decision path admitted (${diagnosis})`,
    );
  }
});

test("a family the Host refuses is NAMED, so the next reader knows which side moved", () => {
  // The red case this gate exists for, in miniature: one entry the Host's own predicate refuses must be reported with
  // its FIELD. A bare `invalid_snapshot` is what turns a field disagreement into a mystery on a live run.
  const [field, entries] = Object.entries(ARTIFACT.real).find(([name]) => name === "treeChopSourceTargets") ?? [];
  assert.ok(field !== undefined && Array.isArray(entries), "the artifact must carry treeChopSourceTargets");
  const first = entries[0] as Record<string, unknown>;

  for (const broken of [
    { ...first, unexpected: 1 },
    { ...first, health: 0 },
  ]) {
    const envelope = sampleEnvelope({ [field]: [broken] as readonly unknown[] }, "named");
    const diagnosis = diagnoseBridgeMessage(envelope, SCOPE);
    assert.ok(
      diagnosis !== null && diagnosis.startsWith(`invalid_snapshot:${field}`),
      `a ${field} entry the Host refuses must name ${field}; got ${String(diagnosis)}`,
    );
  }
});

test("an absent family is never counted as accepted", () => {
  // The failure this guards: a reader treating "no entry in `real`" as "the Host is fine with this family". The
  // artifact says the opposite - nothing was constructed, so nothing was proved - and this pins that reading.
  const real = new Set(Object.keys(ARTIFACT.real));
  const acceptedButUnproven = ARTIFACT.absent.map((entry) => entry.field).filter((field) => real.has(field));
  assert.deepEqual(acceptedButUnproven, [], "an absent family must not also appear as real");
  assert.ok(
    ARTIFACT.absent.length > 0,
    "this sample world cannot build every family; an artifact claiming otherwise would be lying about its own limits",
  );
});
