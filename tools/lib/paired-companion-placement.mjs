/**
 * THE COMPANION'S OWN PLACEMENT, read from the fixture's record stream.
 *
 * WHY IT IS A RECORD AND NOT A TILE IN THE PROMPT. Her body is hers: a Farmhand joining a LAN world is placed by its own
 * client (`Client.setUpGame` -> `BedFurniture.ApplyWakeUpPosition`, Client.cs:208; `NetWorldState.ResetFarmhandState`
 * puts it in its Cabin, NetWorldState.cs:756-775), and `Farmer.warpFarmer` warps `Game1.player` of the process that
 * calls it (Farmer.cs:5753 -> Game1.cs:10019-10032). So the Host builds the world and publishes the tile, and HER process
 * stands there and reports the tile it reached.
 *
 * WHY IT IS ITS OWN MODULE. Both records travel the fixture's existing record stream - the same file the Host player's
 * steps are written to - and the GENERATION is what binds a report to this publication rather than to whichever launch
 * wrote a line first. Both sides of that handshake are read here, so the runner's S1 gate and any future harness read one
 * implementation of "was she placed".
 *
 * AN ACT, NOT AN ASSUMPTION: S1 refuses to start without a matching `placed` record.
 */
import { readFileSync } from "node:fs";

/** The action name every placement record carries, so one reader can pick them out of a stream of steps. */
export const PLACEMENT_RECORD_ACTION = "placement";

/** A tile as the one spelling every reason code uses: `<x>,<y>`, or `null` for a tile that was never named. */
export const tileKey = (tile) => (tile === null || tile === undefined ? null : `${tile.x},${tile.y}`);

/** Every placement record on the stream, in file order. A line that does not parse is skipped (another process appends). */
export function readPlacementRecords(path) {
  if (typeof path !== "string" || path.length === 0) return [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed?.action !== PLACEMENT_RECORD_ACTION) continue;
    if (!Number.isInteger(parsed?.x) || !Number.isInteger(parsed?.y)) continue;
    records.push(
      Object.freeze({
        state: typeof parsed.state === "string" ? parsed.state : "unknown",
        reasonCode: typeof parsed.reasonCode === "string" ? parsed.reasonCode : null,
        location: typeof parsed.location === "string" ? parsed.location : null,
        tile: Object.freeze({ x: parsed.x, y: parsed.y }),
        requestedTile: Object.freeze({
          x: Number.isInteger(parsed.requestedX) ? parsed.requestedX : parsed.x,
          y: Number.isInteger(parsed.requestedY) ? parsed.requestedY : parsed.y,
        }),
        generation: generationOf(parsed.detail),
      }),
    );
  }
  return records;
}

/** The generation a record carries, out of the `;`-separated `key=value` detail both sides write. Never assumed. */
export function generationOf(detail) {
  if (typeof detail !== "string") return null;
  for (const part of detail.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    if (part.slice(0, at).trim() === "generation") return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * The newest publication, and the newest report made against THAT publication, from one read of the stream.
 *
 * `placed` is matched on the generation, so a report from an earlier launch of the same save cannot confirm this one.
 */
export function readPlacementHandshake(path) {
  const records = readPlacementRecords(path);
  const published =
    records.filter((record) => record.state === "published" && record.generation !== null).pop() ?? null;
  // A REFUSAL BEFORE ANY PUBLICATION IS STILL THE HOST'S ANSWER. The Host writes its own refusal onto the same stream
  // when it cannot build the world or resolve her, and it carries no generation because there was nothing to publish -
  // so it is surfaced here rather than left for a wait that could only report its own clock.
  if (published === null)
    return Object.freeze({
      published: null,
      placed: null,
      rejected: records.filter((record) => record.state === "rejected").pop() ?? null,
    });
  const answered = records.filter((record) => record.generation === published.generation);
  return Object.freeze({
    published,
    placed: answered.filter((record) => record.state === "placed").pop() ?? null,
    rejected: answered.filter((record) => record.state === "rejected").pop() ?? null,
  });
}

/**
 * Wait for her placement, or report by name that it never happened.
 *
 * A REFUSAL ENDS THE WAIT, under HER process's own code: a tile she could not stand on is a named fact, and reporting it
 * as a timeout would replace it with this run's clock. A TIMEOUT IS A REFUSAL TOO -
 * `paired_companion_placement_unconfirmed` with the tile that was published and the wall time spent - because a slice
 * that ran with her still in her Cabin would find no subject and blame the world for a handshake this run never
 * completed.
 */
export async function awaitCompanionPlacement({ path, timeoutMs, now = () => Date.now(), pollMs = 250 }) {
  const startedAtMs = now();
  const deadline = startedAtMs + timeoutMs;
  while (true) {
    const handshake = readPlacementHandshake(path);
    const elapsedMs = now() - startedAtMs;
    if (handshake.rejected !== null)
      return Object.freeze({
        confirmed: false,
        reasonCode: handshake.rejected.reasonCode ?? "paired_companion_placement_rejected",
        publishedTile: handshake.published?.tile ?? null,
        placedTile: handshake.rejected.tile,
        generation: handshake.published?.generation ?? null,
        elapsedMs,
      });
    if (handshake.placed !== null)
      return Object.freeze({
        confirmed: true,
        reasonCode: null,
        publishedTile: handshake.published.tile,
        placedTile: handshake.placed.tile,
        generation: handshake.published.generation,
        elapsedMs,
      });
    if (now() >= deadline) {
      const where = handshake.published === null ? "unpublished" : tileKey(handshake.published.tile);
      return Object.freeze({
        confirmed: false,
        reasonCode: `paired_companion_placement_unconfirmed:${where}:${Math.max(0, Math.round(elapsedMs))}`,
        publishedTile: handshake.published?.tile ?? null,
        placedTile: null,
        generation: handshake.published?.generation ?? null,
        elapsedMs,
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }
}
