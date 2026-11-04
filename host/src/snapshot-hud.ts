import type { Snapshot } from "./protocol.js";

/**
 * How many bytes the state block may occupy.
 *
 * It is re-sent WHOLE with every turn, so it is a per-turn tax on every later turn's context. The block is
 * bounded here rather than trusted, and the bound names the line that grew instead of silently cutting state
 * in half (see `formatSnapshotHud`).
 */
export const MAX_SNAPSHOT_HUD_BYTES = 1_200;

/**
 * One line of the block, and the snapshot fields it reads.
 *
 * The declaration is the gate: `fields` is typed `keyof Snapshot`, so a line cannot be written for a field the
 * snapshot does not carry, and `snapshot-hud.test.ts` derives its population from the protocol's own
 * `SNAPSHOT_KEYS` to prove no line reads a field it did not declare.
 */
type SnapshotHudLine = Readonly<{
  /** The line's key in the block, and the name the size bound reports when this line is what grew. */
  name: string;
  fields: readonly (keyof Snapshot)[];
  render: (snapshot: Snapshot) => string;
}>;

/** Fixed order, because the block is re-sent every turn and a reordered block is a changed cache prefix. */
export const SNAPSHOT_HUD_LINES: readonly SnapshotHudLine[] = Object.freeze([
  { name: "time", fields: ["timeOfDay"], render: (snapshot) => formatGameClock(snapshot.timeOfDay) },
  {
    name: "calendar",
    fields: ["seasonIndex", "dayOfMonth", "year"],
    render: (snapshot) => `${seasonName(snapshot.seasonIndex)}, day ${snapshot.dayOfMonth}, year ${snapshot.year}`,
  },
  { name: "weather", fields: ["weather"], render: (snapshot) => snapshot.weather },
  {
    name: "where",
    fields: ["location", "tile"],
    render: (snapshot) => `${snapshot.location} at (${snapshot.tile.x}, ${snapshot.tile.y})`,
  },
  {
    name: "body",
    fields: ["actionable", "actorDispositionKind"],
    render: bodyStateOf,
  },
  { name: "stamina", fields: ["stamina"], render: (snapshot) => `${snapshot.stamina}` },
  { name: "health", fields: ["health"], render: (snapshot) => `${snapshot.health}` },
  { name: "exhausted", fields: ["exhausted"], render: (snapshot) => (snapshot.exhausted ? "yes" : "no") },
  { name: "held tool", fields: ["currentTool", "currentToolSlot"], render: heldToolOf },
  {
    name: "unwatered crops",
    fields: ["cropTargets"],
    render: (snapshot) => `${snapshot.cropTargets?.length ?? 0} in reach`,
  },
]);

/**
 * The Game model's standing state block: where the companion is, what time it is, and whether its body is free.
 *
 * <p>
 * STATE IS NOT A DELTA. A snapshot is delivered once, when it is observed; four turns later the model still
 * "knows" the stamina and the tile it read then, and the only way to find out what is true NOW is to call
 * `stardew_observe` again. That round trip is the defect this block removes, so the Host re-states the latest
 * snapshot into every turn's fact batch (`CompanionHostService.#restateWorldSnapshot`) and this renders it.
 * Events stay deltas: a receipt or a semantic event happened once and is delivered once.
 * </p>
 * <p>
 * Determinism is a requirement, not a courtesy. The fact batch is folded into the session's cached history, and
 * the model reads the block to decide what to do next: a block that changes when nothing happened is both a
 * cache invalidation and a false signal that something did. So: fixed line order, no clock of our own, no sampled
 * age, no map iteration, no field rendered twice.
 * </p>
 */
export function formatSnapshotHud(snapshot: Snapshot): string {
  const kept = SNAPSHOT_HUD_LINES.map((line) => ({ name: line.name, value: line.render(snapshot) }));
  const omitted: string[] = [];
  let text = composeHud(kept, omitted);
  // Over budget means one value carried more than a HUD line should. Drop the widest line first and NAME it:
  // the remedy is to bound that value at its source, never to raise the cap on the next turn's context.
  while (utf8Bytes(text) > MAX_SNAPSHOT_HUD_BYTES && kept.length > 0) {
    const widest = kept.reduce((worst, line) => (utf8Bytes(line.value) > utf8Bytes(worst.value) ? line : worst));
    omitted.push(widest.name);
    kept.splice(kept.indexOf(widest), 1);
    text = composeHud(kept, omitted);
  }
  return text;
}

/**
 * Whether the body can take a new command, and what holds it when it cannot.
 *
 * Deliberately not `activeExecution`: that key is withheld from the always-on block by name ("the Host already
 * owns execution state from action receipts"), and an action id here would read as an instruction to repeat the
 * previous turn rather than as a description of the body. `actionable` plus the disposition answer the question
 * from facts that are already projected every turn.
 */
function bodyStateOf(snapshot: Snapshot): string {
  const disposition = snapshot.actorDispositionKind;
  if (disposition !== undefined && disposition !== "idle") return `busy (${disposition})`;
  return snapshot.actionable ? "free" : "busy (not actionable)";
}

function heldToolOf(snapshot: Snapshot): string {
  const tool = snapshot.currentTool ?? "nothing";
  const slot = snapshot.currentToolSlot;
  return slot === undefined || slot === null ? tool : `${tool} in slot ${slot}`;
}

function composeHud(lines: readonly Readonly<{ name: string; value: string }>[], omitted: readonly string[]): string {
  const rendered = lines.map((line) => `- ${line.name}: ${line.value}`);
  if (omitted.length > 0)
    rendered.push(
      `- omitted over ${MAX_SNAPSHOT_HUD_BYTES} bytes: ${omitted.join(", ")} (bound the value at its source)`,
    );
  return `[State HUD:\n${rendered.join("\n")}\n]`;
}

/** Renders a Stardew time-of-day int (e.g. 2350) as HH:MM (23:50). */
export function formatGameClock(timeOfDay: number): string {
  if (!Number.isInteger(timeOfDay) || timeOfDay < 0 || timeOfDay > 2600) return `${timeOfDay}`;
  const hours = Math.floor(timeOfDay / 100);
  const minutes = timeOfDay % 100;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The season's own name, spelled once for every renderer that prints a calendar. */
export function seasonName(seasonIndex: number): string {
  return ["Spring", "Summer", "Fall", "Winter"][seasonIndex] ?? "Unknown";
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
