import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NativeSmokeHarnessError,
  assertRequiredCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const REQUIRED_CAPABILITIES = ["inspect_self", "cancel_active_execution", "move_to_tile"];
const SCENARIO = "native_move_ladder_v1";
const DEFAULT_RESULT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scratch",
  "a3-move-ladder-result.json",
);

/**
 * The Farm's own landmarks, as the ladder's fixed end points.
 *
 * The measured map is 80 wide and 65 tall, so column 79 / row 64 are the last
 * IN-MAP column/row and 80 / 65 are OFF-MAP. They are literals because the
 * snapshot exposes no map dimensions and the question is specifically about
 * these absolute columns; the ladder's near targets are derived from the
 * actor's own post-warp tile instead.
 */
const LAST_IN_MAP_COLUMN = 79;
const OFF_MAP_COLUMN = 80;
const OFF_MAP_ROW = 65;

/**
 * The ladder. Short same-map steps first, then the long open walk the earlier
 * live run already reached, then the Farm's edge landmark (the undecided tile),
 * then a building footprint and its neighbour, then two off-map targets. The
 * order is fixed so a run-to-run diff means something.
 */
export function ladderTargets(anchor) {
  const clampX = (x) => Math.max(0, Math.min(LAST_IN_MAP_COLUMN, x));
  const raw = [
    ["short_east", anchor.x + 2, anchor.y, "in_map"],
    ["short_south", anchor.x, anchor.y + 2, "in_map"],
    ["long_west", clampX(anchor.x - 8), anchor.y, "in_map"],
    ["far_west", clampX(anchor.x - 24), anchor.y, "in_map"],
    ["last_in_map_column", LAST_IN_MAP_COLUMN, 15, "in_map"],
    // The save records `doorMap=(64,14) entryMap=(64,15)` for the Farmhouse, so the
    // ENTRY landing is the tile a real exit puts the actor on (expected walkable) and
    // the DOOR tile is the building's own footprint (expected blocked_by=building).
    ["farmhouse_entry_tile", 64, 15, "in_map"],
    ["farmhouse_door_tile", 64, 14, "in_map"],
    ["beside_farmhouse", 68, 14, "in_map"],
    ["off_map_east", OFF_MAP_COLUMN, 15, "off_map"],
    ["off_map_corner", OFF_MAP_COLUMN, OFF_MAP_ROW, "off_map"],
  ];
  return raw.map(([label, x, y, shape]) => ({ label, x, y, shape }));
}

/**
 * Pull the Mod's own refusal facts out of a receipt's evidence string.
 *
 * `no_native_path` evidence is `key=value` pairs joined by `;` (the
 * `approaches` value contains commas but no `;`), so each field is read by its
 * own name and returned verbatim. A missing key means "this receipt did not
 * carry that fact", which is different from a false value.
 */
export function parseMoveFacts(evidence) {
  if (typeof evidence !== "string" || evidence.length === 0) return {};
  const grab = (key) => {
    const match = evidence.match(new RegExp(`(?:^|;)${key}=([^;]*)`));
    return match ? match[1] : null;
  };
  return {
    from: grab("from"),
    to: grab("to"),
    location: grab("location"),
    target_standable: grab("target_standable"),
    target_walkable: grab("target_walkable"),
    blocked_by: grab("blocked_by"),
    target_enclosed: grab("target_enclosed"),
    probe_says_reachable: grab("probe_says_reachable"),
    route_exists_cardinal: grab("route_exists_cardinal"),
    component_tiles: grab("component_tiles"),
    approaches: grab("approaches"),
    closest: grab("closest"),
    path_search: grab("path_search"),
    staged_approach: grab("staged_approach"),
    staged_target: grab("staged_target"),
    requested: grab("requested"),
    already_at_target: grab("already_at_target"),
  };
}

/**
 * Which of the three refusal classes a rejected move falls into.
 *
 * `off_map` is the target's own declared shape; a building/obstacle footprint
 * is any named occupant; everything else is the class the measurement exists
 * for and is reported with its facts verbatim rather than explained away.
 */
export function classifyRefusal(attempt) {
  if (attempt.terminal?.state !== "rejected") return null;
  if (attempt.shape === "off_map") return "off_map";
  const blockedBy = attempt.facts?.blocked_by;
  if (blockedBy !== null && blockedBy !== undefined && blockedBy !== "none") return "building_or_obstacle_footprint";
  return "unexplained";
}

/** Poll until the actor is a settled, actionable body on the Farm. */
async function waitForFarmActor(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await observeFresh(client);
  while (Date.now() < deadline) {
    if (
      latest?.location === "Farm" &&
      Number.isInteger(latest?.tile?.x) &&
      Number.isInteger(latest?.tile?.y) &&
      latest.tile.x >= 0 &&
      latest.tile.y >= 0 &&
      latest.actionable === true &&
      latest.activeExecution == null
    )
      return latest;
    await delay(100);
    try {
      latest = await observeFresh(client);
    } catch (error) {
      if (!(error instanceof NativeSmokeHarnessError && error.code === "stale_native_snapshot")) throw error;
    }
  }
  throw new NativeSmokeHarnessError("native_move_ladder_actor_not_on_farm");
}

/**
 * Send one move per ladder target and record the Mod's own answer for each.
 *
 * The measurement is the TABLE, not a pass/fail: a refusal is a result, and the
 * runner only reports `invalid` when it could not observe the world well enough
 * to attribute one.
 */
export async function runMoveLadderSmoke(client, receipts, config, { resultFile = null } = {}) {
  if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const scenario = config.NativeLocalPlayerFixture?.FixtureScenario;
  if (scenario !== SCENARIO) throw new Error(`native_local_fixture_invalid_scenario:${scenario}`);

  const before = await waitForFarmActor(client, 30_000);
  assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
  const anchor = { x: before.tile.x, y: before.tile.y };
  const location = before.location;
  const targets = ladderTargets(anchor);

  const attempts = [];
  for (const target of targets) {
    const record = { label: target.label, shape: target.shape, target: { x: target.x, y: target.y } };
    const startedAt = Date.now();
    try {
      const snapshot = await waitForFarmActor(client, 20_000);
      record.beforeTile = { x: snapshot.tile.x, y: snapshot.tile.y };
      const requestId = `native_move_ladder_${target.label}_${Date.now()}`;
      const accepted = await executeFresh(client, {
        requestId,
        idempotencyKey: `${requestId}_idem`,
        action: "move_to_tile",
        args: { x: target.x, y: target.y },
        snapshot,
        timeoutMs: 25_000,
      });
      const terminal = await waitForTerminal(receipts, accepted, 30_000);
      record.accepted = summarizeReceipt(accepted);
      record.acceptedEvidence = accepted.evidence ?? null;
      record.terminal = summarizeReceipt(terminal);
      record.terminalState = terminal.state;
      record.terminalReasonCode = terminal.reasonCode;
      record.terminalEvidence = terminal.evidence ?? null;
      record.facts = parseMoveFacts(terminal.evidence);
      const after = await observeFresh(client).catch((error) => ({ error: String(error?.message ?? error) }));
      record.after = after?.error
        ? { observeError: after.error }
        : { revision: after.revision, location: after.location, tile: after.tile ?? null };
      record.postTerminalRevisionMatches =
        !after?.error && Number.isSafeInteger(terminal.revision) && after.revision === terminal.revision;
      record.classification = classifyRefusal(record);
    } catch (error) {
      record.error = String(error?.message ?? error);
    }
    record.elapsedMs = Date.now() - startedAt;
    attempts.push(record);
  }

  const refusals = attempts.filter((attempt) => attempt.terminalState === "rejected");
  const result = {
    state: "measured",
    scenario,
    topology: "native_local_player_fixture",
    location,
    anchor,
    ladder: targets,
    attempts,
    summary: {
      attempted: attempts.length,
      succeeded: attempts.filter((attempt) => attempt.terminalState === "succeeded").length,
      rejected: refusals.length,
      rejectedInMap: refusals.filter((attempt) => attempt.shape !== "off_map").length,
      unexplained: refusals
        .filter((attempt) => attempt.classification === "unexplained")
        .map((attempt) => attempt.label),
      errored: attempts.filter((attempt) => attempt.error !== undefined).map((attempt) => attempt.label),
    },
    trace: receipts.map((receipt) => summarizeReceipt(receipt)),
  };
  if (resultFile !== null) {
    mkdirSync(dirname(resultFile), { recursive: true });
    writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const resultIndex = process.argv.indexOf("--result-file");
  const resultFile =
    resultIndex >= 0 && process.argv[resultIndex + 1] !== undefined
      ? resolve(process.argv[resultIndex + 1])
      : (process.env.GAMEBUDDY_MOVE_LADDER_RESULT ?? DEFAULT_RESULT_PATH);
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runMoveLadderSmoke(session.client, session.receipts, config, { resultFile });
    console.log(JSON.stringify(result));
    if (result.state !== "measured") process.exitCode = 2;
  } finally {
    session.close();
  }
}
