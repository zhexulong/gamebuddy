/**
 * The PLAYER-SIDE probe: a fixed script, no model, dispatched through the ordinary authenticated bridge.
 *
 * WHAT IT IS, AND WHAT IT IS NOT
 * ------------------------------
 * The multiplayer live loop proved the world, the pipe and the recording, and it never ran an Agent. A run that
 * pairs a real companion with a deterministic player-side script needs the other half: something that acts with no
 * model in the decision path, so every dispatch it makes is the same on every run and `tGameMs` is a measurement
 * rather than a hope.
 *
 * The script is a PURE FUNCTION OF A SNAPSHOT (`planProbeScript`): hand it the same world reading twice and it
 * returns the same dispatch sequence, byte for byte. That is what makes "the companion acted on the tile the player
 * pointed at" falsifiable - if the probe picked its target by looking at the world, then the tile in the trace is
 * the world's answer, not an operator's wish.
 *
 * WHICH BODY IT DRIVES, said here because it decides what the trace can claim
 * ------------------------------------------------------------------------
 * ONE bridge exists on the Player Host wiki/AI-Farmhand topology, it belongs to the AI-client process, and it binds
 * that process's own `Game1.player` (`integrations/stardew/ModEntry.cs:900-905` returns early for the Host role, so
 * the Host never constructs a `LocalPipeBridge`; the one instance is `ModEntry.cs:1078-1094`, and
 * `LocalPipeBridge.cs` admits a single consumer). So the probe acts on the SAME body as the companion, and the
 * concurrency this module can express is two request streams racing on ONE actor - not two farmers. The only second
 * body the harness can move at all is the Host player, through the file-armed `SleepLifecycle`, and that is where
 * the paired night slice gets its second farmer.
 *
 * NO SECOND CONNECTION. Two writers on one pipe is the shape that produced `journal_key_owned_by_another_process`, so
 * every step here is sent through the client object the companion's runtime already owns: the client keeps one
 * `#pending` map keyed by `correlationId` (`host/src/local-stardew-bridge.ts:998-1023`, registration at `:1014`)
 * and hands each frame to the same transport at `:1016`, so concurrent requests are correlated rather than
 * interleaved into each other's answers.
 *
 * `tGameMs` IS THE WORLD'S CLOCK, NOT A WALL CLOCK
 * ------------------------------------------------
 * Both sides of a slice are stamped with the world's own clock so "the same tick" is comparable across two
 * dispatch streams: `Game1.timeOfDay` is the integer `HHMM` the snapshot publishes as `timeOfDay`
 * (`BridgeProtocolModels.cs:1220`) and that a settled receipt echoes as `observation.inGameTime`
 * (`farmhandexecutioncontroller.cs:637`). One conversion, two spellings, both below.
 */

/** The one player line the probe speaks into the world's own chat. In-world, short, and it names what it points at. */
export const PROBE_LINE = "这格我留给你了。";

/** The gesture the probe makes to point at a tile. From the closed emote set (`FarmhandActionDefinitions.cs:689`). */
export const PROBE_EMOTE = "exclamation";

/**
 * The world's clock in milliseconds from `Game1.timeOfDay`'s `HHMM` integer (600 = 06:00, 2600 = 02:00 next day).
 *
 * `null` rather than 0 when the reading is not a clock: a world that published no time must not read as midnight,
 * because midnight is a real reading and a fabricated one would be counted as "same tick" against another
 * fabricated one.
 */
export function gameClockMs(timeOfDay) {
  if (!Number.isSafeInteger(timeOfDay) || timeOfDay <= 0 || timeOfDay > 2600) return null;
  const hours = Math.trunc(timeOfDay / 100);
  const minutes = timeOfDay % 100;
  if (minutes > 59) return null;
  return (hours * 60 + minutes) * 60_000;
}

/** The same reading from a receipt's `observation.inGameTime` (a 4-digit `HHMM` string, e.g. `"1010"`). */
export function gameClockMsFromInGameTime(value) {
  if (typeof value !== "string" || !/^[0-9]{4}$/u.test(value)) return null;
  return gameClockMs(Number(value));
}

/**
 * The inverse, for the night records whose vocabulary is the `HHMM` integer (`multiday-baseline.mjs`'s `bedTime`).
 *
 * One pair, not two conversions: a clock read by `gameClockMs` and written back by this must be the same number, and
 * the round trip is what pins that.
 */
export function gameClockHhmmFromMs(tGameMs) {
  if (!Number.isFinite(tGameMs) || tGameMs < 0) return null;
  const totalMinutes = Math.round(tGameMs / 60_000);
  return Math.trunc(totalMinutes / 60) * 100 + (totalMinutes % 60);
}

/** The world clock both sides of a slice are stamped with, or `null` with the reason it could not be read. */
export function snapshotClock(snapshot) {
  const tGameMs = gameClockMs(snapshot?.timeOfDay);
  if (tGameMs === null) return Object.freeze({ tGameMs: null, dayOfMonth: null, absent: "snapshot_published_no_clock" });
  return Object.freeze({
    tGameMs,
    dayOfMonth: Number.isSafeInteger(snapshot.dayOfMonth) ? snapshot.dayOfMonth : null,
    absent: null,
  });
}

/**
 * The ripe crop a probe points at, chosen deterministically out of the snapshot's OWN `harvestTargets`.
 *
 * Grab only, and ready only: `harvest_crop` acts on a row whose harvest method is `grab`, so a scythe crop or a
 * regrowing plant is a different action's target and offering one here would make the probe's tile a refusal
 * instead of a pointer. `(y, x, targetId)` orders the candidates so the choice is a property of the world, not of
 * iteration order.
 */
export function readyGrabCrop(snapshot, { index = 0 } = {}) {
  const rows = Array.isArray(snapshot?.harvestTargets) ? snapshot.harvestTargets : [];
  const candidates = rows.filter(
    (row) =>
      row !== null &&
      typeof row === "object" &&
      typeof row.targetId === "string" &&
      Number.isSafeInteger(row.x) &&
      Number.isSafeInteger(row.y) &&
      row.readyForHarvest !== false &&
      (row.harvestMethod === undefined || row.harvestMethod === "grab"),
  );
  if (candidates.length <= index) return null;
  return [...candidates].sort(
    (left, right) => left.y - right.y || left.x - right.x || (left.targetId < right.targetId ? -1 : 1),
  )[index];
}

/** The first chest holding an item, out of the snapshot's own `chests` family, or `null`. */
export function chestWithItem(snapshot) {
  const rows = Array.isArray(snapshot?.chests) ? snapshot.chests : [];
  const candidates = rows
    .filter(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        typeof row.chestId === "string" &&
        Array.isArray(row.items) &&
        row.items.some((item) => typeof item?.qualifiedItemId === "string"),
    )
    .sort((left, right) => left.y - right.y || left.x - right.x || (left.chestId < right.chestId ? -1 : 1));
  return candidates[0] ?? null;
}

/**
 * The probe's fixed script for one slice, as a pure function of the world reading it was handed.
 *
 * ONE SCRIPT, NOT ONE STEP PER SLICE, and the split is forced by what each slice measures:
 *   `s1_attention` - move to the ripe crop's tile, point at it with the emote, and say one line. It NEVER harvests:
 *                    the crop is the shared subject of the attention slice and the claim slice, and consuming it in
 *                    slice one would leave slice two with nothing to contend over.
 *   `s2_claim`     - harvest that same row, concurrently with whatever the companion decides to do with it.
 *   `s3_night`     - nothing. The probe's night is the HOST farmer's, and no program can drive the Host player
 *                    except the file-armed lifecycle; a step here would be this module claiming a body it does not
 *                    have.
 *
 * A step whose target the world does not publish is DROPPED WITH ITS REASON (`dropped`), never replaced by a
 * neighbouring tile and never fabricated: the run reports a fixture gap by name instead of testing the wrong thing.
 */
export function planProbeScript({ snapshot, slice, targetIndex = 0 }) {
  if (slice === "s3_night")
    return Object.freeze({
      slice,
      tile: null,
      steps: Object.freeze([]),
      dropped: Object.freeze([
        Object.freeze({ step: "sleep", reason: "probe_body_is_the_host_farmer_and_only_the_file_armed_lifecycle_can_sleep_it" }),
      ]),
    });
  const crop = readyGrabCrop(snapshot, { index: targetIndex });
  if (crop === null)
    return Object.freeze({
      slice,
      tile: null,
      steps: Object.freeze([]),
      dropped: Object.freeze([
        Object.freeze({ step: "all", reason: `snapshot_published_no_ready_grab_crop_at_index_${targetIndex}` }),
      ]),
    });
  const tile = Object.freeze({ x: crop.x, y: crop.y });
  if (slice === "s1_attention") {
    const steps = [
      Object.freeze({ stepId: "move", action: "move_to_tile", args: Object.freeze({ x: crop.x, y: crop.y }) }),
      Object.freeze({ stepId: "emote", action: "express_emote", args: Object.freeze({ emote: PROBE_EMOTE }) }),
      Object.freeze({
        stepId: "say",
        action: "send_multiplayer_chat",
        args: Object.freeze({ text: PROBE_LINE }),
      }),
    ];
    const chest = chestWithItem(snapshot);
    if (chest === null) {
      return Object.freeze({
        slice,
        tile,
        steps: Object.freeze(steps),
        dropped: Object.freeze([
          Object.freeze({ step: "chest", reason: "snapshot_published_no_chest_holding_an_item" }),
        ]),
      });
    }
    const item = chest.items.find((entry) => typeof entry?.qualifiedItemId === "string");
    steps.push(
      Object.freeze({
        stepId: "chest",
        action: "chest_retrieve",
        args: Object.freeze({ targetRef: chest.chestId, expectedQualifiedItemId: item.qualifiedItemId }),
      }),
    );
    return Object.freeze({ slice, tile, steps: Object.freeze(steps), dropped: Object.freeze([]) });
  }
  if (slice === "s2_claim")
    return Object.freeze({
      slice,
      tile,
      steps: Object.freeze([
        Object.freeze({ stepId: "claim", action: "harvest_crop", args: Object.freeze({ targetRef: crop.targetId }) }),
      ]),
      dropped: Object.freeze([]),
    });
  throw new Error(`probe_slice_unknown:${String(slice)}`);
}

/**
 * Where a settled receipt says its work happened, in the Mod's own two spellings.
 *
 * `evicted` is the TYPED address list (`BodyProgramModels.cs:IsEvictedAddress` admits a tile as `62:19`), so it is
 * read first; the `key=value;` evidence detail is the older projection and is read through the existing parser
 * (`multiday-baseline.mjs:parseReceiptEvidence`) rather than a second splitter here. `null` when the receipt names
 * no tile - the honest answer for a receipt whose action does not address one.
 */
export function receiptTargetTile(receipt, { parseEvidence }) {
  const evicted = Array.isArray(receipt?.evicted) ? receipt.evicted : [];
  for (const address of evicted) {
    const match = typeof address === "string" ? /^(-?[0-9]{1,9}):(-?[0-9]{1,9})$/u.exec(address) : null;
    if (match !== null) return Object.freeze({ x: Number(match[1]), y: Number(match[2]), source: "evicted" });
  }
  const parsed = parseEvidence(receipt?.evidence);
  const tile = typeof parsed.tile === "string" ? /^(-?[0-9]{1,9}),(-?[0-9]{1,9})$/u.exec(parsed.tile) : null;
  if (tile !== null) return Object.freeze({ x: Number(tile[1]), y: Number(tile[2]), source: "evidence.tile" });
  return null;
}

/**
 * Run the script, one step at a time, recording every dispatch with the world clock it was bound to and the receipt
 * it settled with.
 *
 * `observe` and `dispatch` are injected so the whole loop can be driven by a test without a game; the runner passes
 * the harness's own `observeFresh` and `executeFreshAfterReobserve` path. A step that cannot be dispatched is
 * RECORDED as such (`state: "not_dispatched"` + `reasonCode`), never skipped silently: a probe trace with a missing
 * step is a trace whose "she followed me" claim has no pointer in it.
 */
export async function runProbeScript({
  slice,
  plan,
  observe,
  dispatch,
  now = () => Date.now(),
  startedAtMs = now(),
}) {
  const records = [];
  for (const step of plan.steps) {
    const atMs = now() - startedAtMs;
    let snapshot;
    try {
      snapshot = await observe();
    } catch (error) {
      records.push(
        Object.freeze({
          slice,
          stepId: step.stepId,
          action: step.action,
          atMs,
          tGameMs: null,
          dayOfMonth: null,
          revision: null,
          requestId: null,
          state: "not_dispatched",
          reasonCode: `probe_observe_failed:${String(error?.message ?? error)}`,
        }),
      );
      continue;
    }
    const clock = snapshotClock(snapshot);
    const result = await dispatch({ step, snapshot });
    records.push(
      Object.freeze({
        slice,
        stepId: step.stepId,
        action: step.action,
        args: step.args,
        atMs,
        tGameMs: clock.tGameMs,
        dayOfMonth: clock.dayOfMonth,
        clockAbsent: clock.absent,
        revision: Number.isSafeInteger(snapshot?.revision) ? snapshot.revision : null,
        requestId: result.requestId ?? null,
        state: result.state,
        reasonCode: result.reasonCode,
      }),
    );
  }
  return Object.freeze(records);
}
