/**
 * THE PROBE'S STEPS, HELD AGAINST THE VALIDATOR THAT DECIDES A DISPATCH.
 *
 * WHY THIS FILE EXISTS. `stardew-player-probe-driver.mjs` sent `{ targetRef: … }` on `harvest_crop` and
 * `chest_retrieve`, a name neither side of the bridge declares: the Mod's parser pins
 * `harvest_crop {x, y, expectedQualifiedItemId, expectedTargetId}` and
 * `chest_retrieve {chestId, expectedQualifiedItemId}` (`BridgeProtocol.ExecutionArgumentProperties`,
 * `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs:2487`), and the Host pins the same sets
 * (`EXECUTION_REQUEST_ARGUMENT_RULES`, `host/src/protocol.ts:4679`). The probe's own suite stayed green because its
 * dispatch stub echoed whatever it was handed, so the first real harvest would have been refused at the bridge with the
 * unit tests still passing. A test that never asks the question its subject is judged by is the same defect as a gate
 * that never reads the file it judges.
 *
 * THE LAYER IS THE POINT, so this file validates through the production module rather than a copy of its rules:
 *
 *   `validateExecutionRequest(request, snapshot, nowMs)`   the dispatch validator: the envelope rows (identity,
 *                                                          revision, deadline, capability) AND the action's own
 *                                                          argument rows. This is what `game-tools.ts` runs before a
 *                                                          request may leave the Host, and the probe's path through
 *                                                          `client.execute` skips it - which is why the test must not.
 *   `validateBridgeMessage(envelope, scope, nowMs)`        the transport validator. It checks the FRAME's shape and
 *                                                          only that: `validateExecutionRequestEnvelope` asks whether
 *                                                          `args` is a record of at most eight keys and never looks at
 *                                                          their NAMES. A test using this alone stays green on
 *                                                          `targetRef`, and the case below pins that division.
 *
 * THE TABLE THIS HOLDS, probe args beside the protocol's (the two columns must be equal):
 *
 *   action                 probe sends                                                    protocol requires
 *   move_to_tile           {x, y}                                                         {x, y}
 *   express_emote          {emote}                                                        {emote}  (Mod enum)
 *   send_multiplayer_chat  {text}                                                         {text}   (<=256, non-blank)
 *   chest_retrieve         {chestId, expectedQualifiedItemId}                             {chestId, expectedQualifiedItemId}
 *   harvest_crop           {x, y, expectedQualifiedItemId, expectedTargetId}              {x, y, expectedQualifiedItemId, expectedTargetId?}
 *
 * `expectedTargetId` is the ONE optional member: the catalogue declares it `ResolvedAtExecution` for `harvest_crop`, so
 * the executor mints it from the live tile when absent. The probe STATES it, because it read the crop's own published
 * `harvestTargets[].targetId` - the same `BuildCropTargetId` string the handler compares - and a stated id turns "the
 * world moved under this step" into the named refusal `harvest_crop_target_changed` instead of a silent success on a
 * neighbouring crop.
 *
 * THE SNAPSHOT FIXTURE IS A REAL FRAME. It is the committed golden replay's own snapshot payload plus the families this
 * run needs, and it is admitted by `validateBridgeMessage` before any step is judged: a fixture the Host would refuse
 * would prove nothing about the steps read out of it.
 *
 * RUN IT WITH BUN - `bun test tools/lib` - because `host/src/protocol.ts` imports its siblings as `.js` specifiers and
 * Bun maps those onto the `.ts` sources (the same reason `.github/workflows/ci.yml:237` gives for
 * `test:stardew-wire-agreement`). `node --test` cannot resolve them, and the compiled `host/dist-test/protocol.js` is a
 * build artifact whose revision is not this source's.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXECUTION_REQUEST_ARGUMENT_RULES,
  EXECUTION_REQUEST_DEADLINE_WINDOWS,
  newEnvelope,
  validateBridgeMessage,
  validateExecutionRequest,
} from "../../host/src/protocol.ts";
import {
  PROBE_EMOTE,
  PROBE_LINE,
  chestWithItem,
  gameClockMs,
  planProbeScript,
  readyGrabCrop,
} from "./stardew-player-probe-driver.mjs";

const GOLDEN = fileURLToPath(new URL("../../fixtures/bridge-v1/golden-sequence.json", import.meta.url));
const EMOTE_DECLARATION = fileURLToPath(
  new URL("../../integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs", import.meta.url),
);

/** The committed replay's own scope, clock and snapshot payload: the frame the Mod really sends, not a projection. */
const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
const scope = golden.scope;
const nowMs = golden.nowMs;
const goldenSnapshot = golden.messages.find((message) => message.type === "snapshot").payload;

/** The five actions the probe plans, so the run can be held to them - and a sixth action cannot arrive unvalidated. */
const PROBE_ACTIONS = Object.freeze([
  "chest_retrieve",
  "express_emote",
  "harvest_crop",
  "move_to_tile",
  "send_multiplayer_chat",
]);

/** The two rows `readyGrabCrop` may pick from, at the coordinates the pairing run's own fixture grows them on. */
const harvestRows = () => [
  {
    targetId: "sr1_BBBBBBBBBBBBBBBB",
    x: 39,
    y: 18,
    cropId: "256",
    qualifiedHarvestItemId: "(O)256",
    displayName: "Tomato",
    regrowsAfterHarvest: false,
    readyForHarvest: true,
    harvestMethod: "grab",
  },
  {
    targetId: "sr1_AAAAAAAAAAAAAAAA",
    x: 38,
    y: 19,
    cropId: "256",
    qualifiedHarvestItemId: "(O)256",
    displayName: "Tomato",
    regrowsAfterHarvest: false,
    readyForHarvest: true,
    harvestMethod: "grab",
  },
  // A scythe crop is another action's target: offering one would make the probe's pointer a refusal.
  {
    targetId: "sr1_CCCCCCCCCCCCCCCC",
    x: 12,
    y: 9,
    cropId: "262",
    qualifiedHarvestItemId: "(O)262",
    displayName: "Wheat",
    regrowsAfterHarvest: false,
    readyForHarvest: true,
    harvestMethod: "scythe",
  },
];

/** The container `chestWithItem` may pick: its `chestId` IS the wire argument, minted by `BuildContainerTargetId`. */
const chestRows = () => [
  {
    chestId: "chest_0123456789abcdef",
    x: 30,
    y: 20,
    displayName: "Chest",
    isFridge: false,
    items: [{ slot: 0, qualifiedItemId: "(O)256", displayName: "Tomato", stack: 3 }],
  },
];

/**
 * The world the probe reads, as a snapshot payload the Host admits.
 *
 * `capabilities` is part of the request's contract, not decoration: `validateExecutionRequest` refuses an action the
 * snapshot does not advertise (`capability_not_declared`), and the real dispatch refuses it too
 * (`native_action_watchdog_unpublished`). A fixture that left the list empty would make every step above illegal for a
 * reason that has nothing to do with its arguments.
 */
function snapshotPayload({ chests }) {
  return { ...goldenSnapshot, revision: 7, capabilities: [...PROBE_ACTIONS], harvestTargets: harvestRows(), chests };
}

const withChest = snapshotPayload({ chests: chestRows() });
const noChest = snapshotPayload({ chests: [] });

/** The two worlds the plan has a branch for, and the slice ids `planProbeScript` plans for. */
const WORLDS = Object.freeze([
  Object.freeze({ label: "a world publishing a chest that holds an item", snapshot: withChest }),
  Object.freeze({ label: "a world publishing no chest", snapshot: noChest }),
]);
const SLICES = Object.freeze(["s1_attention", "s2_claim"]);

/**
 * The request the probe's own dispatch would build for one step, from the same fields the harness writes.
 *
 * `expectedRevision` is the observed revision and `deadlineMs` is inside the window the Host declares for the action,
 * because `executeFresh` writes exactly those two: a request built with different ones would be refused for a reason
 * this file is not asking about.
 */
function probeRequest({ slice, step, snapshot }) {
  const window = EXECUTION_REQUEST_DEADLINE_WINDOWS[step.action];
  assert.equal(
    typeof window,
    "number",
    `the Host declares no deadline window for ${step.action}, so the probe could never dispatch it`,
  );
  return {
    requestId: `probe_${slice}_${step.stepId}`,
    idempotencyKey: `probe_${slice}_${step.stepId}_idem`,
    action: step.action,
    args: step.args,
    expectedRevision: snapshot.revision,
    deadlineMs: nowMs + window,
  };
}

/** The same request as the frame the transport carries. */
const probeFrame = (request, slice, step) =>
  newEnvelope("execution_request", scope, request, `corr_${slice}_${step.stepId}`, nowMs);

/** Every step the probe can plan, over both worlds and both planning slices, as `{slice, step, snapshot}`. */
function plannedSteps() {
  const planned = [];
  for (const world of WORLDS)
    for (const slice of SLICES) {
      const plan = planProbeScript({
        snapshot: world.snapshot,
        slice,
        targetIndex: slice === "s2_claim" ? 1 : 0,
      });
      // A plan that dropped everything would make every assertion below vacuous over a real population of zero.
      assert.ok(plan.steps.length > 0, `${slice} over ${world.label} planned no step: ${JSON.stringify(plan.dropped)}`);
      for (const step of plan.steps) planned.push({ slice, step, snapshot: world.snapshot, world: world.label });
    }
  return planned;
}

test("the fixture is a snapshot frame the Host admits, so what is read out of it are real rows", () => {
  assert.equal(
    validateBridgeMessage(newEnvelope("snapshot", scope, withChest, "corr_snapshot", nowMs), scope, nowMs),
    null,
    "the chest world is not a snapshot the Host would accept, so no step read from it proves anything",
  );
  assert.equal(validateBridgeMessage(newEnvelope("snapshot", scope, noChest, "corr_snapshot", nowMs), scope, nowMs), null);
  // The three readings the plan selects through are the family's own fields, not the wire's argument names: that
  // distinction is exactly what `targetRef` got wrong, so the fixture is asserted to carry them under the FAMILY's
  // spelling and the tests below are asserted to carry them under the ARGUMENT's.
  assert.equal(readyGrabCrop(withChest, { index: 0 }).targetId, "sr1_BBBBBBBBBBBBBBBB");
  assert.equal(readyGrabCrop(withChest, { index: 1 }).targetId, "sr1_AAAAAAAAAAAAAAAA");
  assert.equal(chestWithItem(noChest), null);
});

/** The names the Host's own table pins for one action: required first, then the ones the executor may mint. */
function declaredArguments(action) {
  const rows = EXECUTION_REQUEST_ARGUMENT_RULES[action];
  const declared = rows.flatMap((row) => row.argumentNames ?? []);
  const optional = rows.flatMap((row) => row.resolvableArguments ?? []);
  return {
    required: declared.filter((name) => !optional.includes(name)),
    optional,
  };
}

test("every step the probe can plan is a dispatch the Host's own validator admits", () => {
  const examined = new Set();
  for (const { slice, step, snapshot, world } of plannedSteps()) {
    const request = probeRequest({ slice, step, snapshot });
    const verdict = validateExecutionRequest(request, snapshot, nowMs);
    const { required, optional } = declaredArguments(step.action);
    assert.equal(
      verdict,
      null,
      `${step.action} over ${world} was refused ${String(verdict)}: the probe sends ${JSON.stringify(step.args)} ` +
        `and the protocol takes exactly [${required.join(", ")}]` +
        (optional.length === 0 ? " and nothing else" : `, plus [${optional.join(", ")}] which the body may mint`) +
        " (EXECUTION_REQUEST_ARGUMENT_RULES, host/src/protocol.ts)",
    );
    const envelopeVerdict = validateBridgeMessage(probeFrame(request, slice, step), scope, nowMs);
    assert.equal(envelopeVerdict, null, `the ${step.action} frame was refused ${String(envelopeVerdict)}`);
    examined.add(step.action);
  }
  // The population is named, not counted: a step that stopped being planned would otherwise shrink this file silently.
  assert.deepEqual([...examined].sort(), [...PROBE_ACTIONS]);
});

test("the ids the probe reads from the SNAPSHOT travel under the ARGUMENT names the executor parses", () => {
  const claim = planProbeScript({ snapshot: withChest, slice: "s2_claim", targetIndex: 1 });
  const harvest = claim.steps.find((step) => step.action === "harvest_crop");
  const contended = readyGrabCrop(withChest, { index: 1 });
  assert.deepEqual(claim.tile, { x: contended.x, y: contended.y });
  assert.equal(harvest.args.x, contended.x);
  assert.equal(harvest.args.y, contended.y);
  // `harvestTargets[].targetId` -> `expectedTargetId`: the same `BuildCropTargetId` string, under the wire's name.
  assert.equal(harvest.args.expectedTargetId, contended.targetId);
  // `qualifiedHarvestItemId` -> `expectedQualifiedItemId`: the item the handler compares against its own harvest roll.
  assert.equal(harvest.args.expectedQualifiedItemId, contended.qualifiedHarvestItemId);

  const attention = planProbeScript({ snapshot: withChest, slice: "s1_attention" });
  const chest = attention.steps.find((step) => step.action === "chest_retrieve");
  const container = chestWithItem(withChest);
  // `chests[].chestId` -> `chestId`: the container id already binds the location and the tile.
  assert.equal(chest.args.chestId, container.chestId);
  assert.equal(chest.args.expectedQualifiedItemId, container.items[0].qualifiedItemId);
  // The container's tile and the crop's id are NOT arguments of these two actions, and sending them would be refused.
  assert.equal("x" in chest.args || "targetId" in chest.args, false);
  assert.equal("slot" in harvest.args || "targetRef" in harvest.args, false);
});

test("the invented name is refused by the dispatch validator - and the frame half never looked at it", () => {
  // RED CASE, the exact two requests this probe sent before: they are what a live run refused, and what the stubbed
  // suite could not see. `invalid_args` is the Host's code for a wrong argument set.
  const refused = {
    "harvest_crop {targetRef}": { targetRef: "sr1_BBBBBBBBBBBBBBBB" },
    "chest_retrieve {targetRef, expectedQualifiedItemId}": {
      targetRef: "chest_0123456789abcdef",
      expectedQualifiedItemId: "(O)256",
    },
  };
  for (const [label, args] of Object.entries(refused)) {
    const action = label.startsWith("harvest_crop") ? "harvest_crop" : "chest_retrieve";
    const request = {
      requestId: `probe_${action}_red`,
      idempotencyKey: `probe_${action}_red_idem`,
      action,
      args,
      expectedRevision: withChest.revision,
      deadlineMs: nowMs + EXECUTION_REQUEST_DEADLINE_WINDOWS[action],
    };
    assert.equal(
      validateExecutionRequest(request, withChest, nowMs),
      "invalid_args",
      `${label} must be refused by the dispatch validator`,
    );
    // AND THE LAYER THAT STAYED GREEN: the transport validator admits the frame, because its execution-request row
    // asks whether `args` is a record of at most eight keys and never reads their names. A test validating at this
    // layer alone is the mock that echoed, moved one function up.
    assert.equal(
      validateBridgeMessage(newEnvelope("execution_request", scope, request, `corr_${action}_red`, nowMs), scope, nowMs),
      null,
      `${label} is a well-formed FRAME; only the dispatch validator can refuse its arguments`,
    );
  }
});

test("the probe's emote and chat line are inside the domains the Mod's own handlers parse", () => {
  // The emote is the one probe argument the Host cannot judge: its row bounds the string, and the domain lives in the
  // Mod's declaration. This reads that DECLARATION (`FarmhandActionDefinitions.cs:689`) and not a copy of it.
  // source-invariant: FarmhandActionCatalog.EmoteEnum - the set `BridgeProtocol.cs:1541` rejects an emote against.
  // source-expiry: when `EmoteEnum` moves, this read reports `not_measured` rather than passing over an empty list.
  const source = readFileSync(EMOTE_DECLARATION, "utf8");
  const declaration = /EmoteEnum\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/u.exec(source);
  assert.ok(declaration, "not_measured: EmoteEnum is no longer declared where this test reads it");
  const emotes = [...declaration[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(emotes.length > 0, "not_measured: the EmoteEnum declaration parsed to no member");
  assert.ok(
    emotes.includes(PROBE_EMOTE),
    `the probe's emote ${PROBE_EMOTE} is not one the Mod parses; the bridge would answer invalid_envelope`,
  );
  // The chat line is bounded by the Mod's ChatMessageMaximumLength (256), which is also the Host's `text` row.
  assert.ok(PROBE_LINE.trim().length > 0 && PROBE_LINE.length <= 256, `the probe's line is not a chat line: ${PROBE_LINE}`);
  // The plan's clock is the world's own: a step is stamped with the snapshot it was planned against.
  assert.equal(gameClockMs(withChest.timeOfDay), gameClockMs(goldenSnapshot.timeOfDay));
});
