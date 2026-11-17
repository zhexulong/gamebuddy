import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXECUTION_REQUEST_ARGUMENT_RULES,
  EXECUTION_REQUEST_REQUIREMENTS,
  EXECUTION_REQUEST_SNAPSHOT_READS,
  EXECUTION_REQUEST_WORLD_FACTS_OWED_TO_THE_GAME,
  type ExecutionRequest,
  type ExecutionRequestReading,
  type ExecutionRequestRequirement,
  executionRequestReading,
  type Snapshot,
} from "./protocol.js";

/**
 * THE PREFLIGHT MAY BOUND THE ENVELOPE. IT MAY NOT DECIDE WHAT IS IN THE WORLD.
 *
 * <p>
 * `validateExecutionRequest` runs on the Host, before the request crosses the bridge, and it is given
 * `integration.state.snapshot` - a CACHED projection of the game the Mod pushed some milliseconds (or minutes) ago. The Mod
 * re-validates every request on the game thread against the live world (scope, player policy, revision, deadline,
 * idempotency, cancel, game state). So a predicate here that reads a snapshot row as a claim about the world is a SECOND
 * authority holding an older view, and its refusal is indistinguishable from the game's: the player sees "not valid" for a
 * ride her own world would have given her.
 * </p>
 *
 * <p>
 * That is not a hypothesis about this file. `ride_minecart` refused a station the snapshot's discovery radius no longer
 * covered, `use_raft` refused a water tile discovery never published, and `machine_load` refused a backpack slot the
 * machine's own data accepts because discovery had published only the FIRST slot that fits. Each of those travels, reaches
 * `ResolveMinecartRide`/`RequestLocalUseRaft`/`MachineLoadRefusal`, and is accepted there from the live world. The ceiling
 * that used to live in the `deadlineMs` row was the same defect one declaration over, and it was answered the same way:
 * DELETE the Host's copy instead of refreshing it - a fresher cache is still a second authority.
 * </p>
 *
 * <p>
 * THE POPULATION COMES FROM THE DECLARATIONS, NOT FROM A LIST HERE. Every row of `EXECUTION_REQUEST_REQUIREMENTS` and of
 * every action in `EXECUTION_REQUEST_ARGUMENT_RULES` is walked, and the snapshot each `isMet` consults is a recording
 * proxy: a row belongs to this suite's population when its predicate READS a snapshot field, whichever field that is and
 * whoever wrote the row. Nothing about the six rows this suite was written for is hard-coded, so the seventh - the one
 * nobody has written yet - is caught by the same walk.
 * </p>
 *
 * <p>
 * WHAT THIS SUITE CANNOT SEE, said rather than implied. It traces a predicate by EXECUTING it on two probe readings, so a
 * row that tests its arguments first and reads the snapshot only for payloads the probes do not build is not traced; it
 * also cannot tell that a traced read was load-bearing (a row may read `snapshot.capabilities` and ignore it). What it
 * does prove is the direction that matters: a row that consults a snapshot field it has no business consulting is never
 * silently admitted, and every world fact the Host stopped deciding still has a producer on the game thread that this
 * suite read by name.
 * </p>
 *
 * red-proof: inject  back the `ride_minecart` row that decides the station from `snapshot.minecartTargets` ->
 *                   `ride_minecart: a row reads snapshot.minecartTargets and no entry classifies it` exits 1 with
 *                   `predicates examined 3 · transport 1 · policy 1 · game-owned 0 · stale-snapshot 0 · unclassified 1`.
 * red-proof: inject  `snapshot.machineTargets` dropped from `validateMachineLoadAgainstPublishedRow`'s producer ->
 *                   `machine_load: the Host no longer decides snapshot.machineTargets, so
 *                   farmhandexecutioncontroller.machinesanimalsitemsactions.cs must produce machine_load_unsupported_input`
 *                   exits 1: the handoff is asserted, not described.
 */

/** The clock every reading is judged at. */
const NOW = 1_000_000;

/**
 * The snapshot the probes are judged against: every family present and EMPTY, so a predicate that consults one reads it
 * (and is traced) rather than falling out on a missing field.
 */
const PROBE_SNAPSHOT: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: { x: 10, y: 11 },
  stamina: 270,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  activeExecution: null,
  raftTargets: [],
  horseTargets: [],
  mineEntranceTargets: [],
  minecartTargets: [],
  machineTargets: [],
};

/** The repository root, found by walking up to the directory that holds `integrations`. */
function repoRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repoRoot(dirname(fileURLToPath(import.meta.url)));

/** One row under judgement, with the action whose payload it decides. */
type WalkedRow = Readonly<{
  action: ExecutionRequest["action"] | "the payload";
  row: ExecutionRequestRequirement;
}>;

/** Every row the validator folds over, in the order it decides them. */
function everyRow(): readonly WalkedRow[] {
  const walked: WalkedRow[] = EXECUTION_REQUEST_REQUIREMENTS.map((row) => ({ action: "the payload", row }));
  for (const action of Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES) as readonly ExecutionRequest["action"][])
    for (const row of EXECUTION_REQUEST_ARGUMENT_RULES[action]) walked.push({ action, row });
  return walked;
}

/**
 * The argument names one action's rows name in their own `field`, so the second probe carries them.
 *
 * Derived from the declaration rather than listed: `args.<name>` is how every row of this table states the argument it
 * decides, and a row that starts deciding a new one contributes it without this suite being edited.
 */
function argumentNamesOf(rows: readonly ExecutionRequestRequirement[]): readonly string[] {
  const names = new Set<string>();
  for (const row of rows)
    for (const part of row.field.split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("args.")) names.add(trimmed.slice("args.".length));
    }
  return [...names];
}

/** The request a probe is judged as: every envelope field present, so an envelope row reaches the snapshot it consults. */
function probeReading(
  action: ExecutionRequest["action"],
  args: Readonly<Record<string, unknown>>,
): ExecutionRequestReading {
  return executionRequestReading(
    {
      requestId: "request_probe_1",
      idempotencyKey: "idempotency_probe_1",
      action,
      args,
      expectedRevision: PROBE_SNAPSHOT.revision,
      deadlineMs: NOW + 30_000,
    },
    PROBE_SNAPSHOT,
    NOW,
  );
}

/**
 * Every snapshot field one row's predicate reads, traced rather than listed.
 *
 * The proxy wraps the snapshot the reading carries, so a `reading.snapshot.<field>` access - through destructuring, through
 * a family function handed the snapshot, or through a helper - is recorded wherever it happens. A predicate that throws on
 * a probe still reports what it read before the throw, which is the only thing this walk asks of it.
 */
function snapshotFieldsReadBy(row: ExecutionRequestRequirement, reading: ExecutionRequestReading): readonly string[] {
  const read = new Set<string>();
  const snapshot = new Proxy(reading.snapshot as object, {
    get(target, key, receiver) {
      if (typeof key === "string") read.add(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") read.add(key);
      return Reflect.has(target, key);
    },
  });
  const probed: ExecutionRequestReading = { ...reading, snapshot: snapshot as Snapshot };
  try {
    row.isMet(probed);
  } catch {
    // A probe input is not a dispatch: a predicate is allowed to be unhappy with it. The reads before it are the answer.
  }
  return [...read];
}

/** The fields one walked row reads on either probe, so a row is judged by what it CONSULTS and not by one lucky input. */
function snapshotFieldsOf(walked: WalkedRow): readonly string[] {
  const action: ExecutionRequest["action"] = walked.action === "the payload" ? "move_to_tile" : walked.action;
  const rows =
    walked.action === "the payload" ? EXECUTION_REQUEST_REQUIREMENTS : EXECUTION_REQUEST_ARGUMENT_RULES[action];
  const empty = snapshotFieldsReadBy(walked.row, probeReading(action, {}));
  const named = Object.fromEntries(argumentNamesOf(rows).map((name) => [name, "probe"]));
  const carried = snapshotFieldsReadBy(walked.row, probeReading(action, named));
  return [...new Set([...empty, ...carried])];
}

/** The identity of one row, from its own content: the field and shape it declares. */
function identityOf(row: Readonly<{ field: string; shape: string }>): string {
  return `${row.field}\u0000${row.shape}`;
}

test("no row of the preflight decides a world fact from the snapshot", () => {
  const rows = everyRow();
  const decisions = rows.map((walked) => ({ ...walked, fields: snapshotFieldsOf(walked) }));
  const population = decisions.filter((decision) => decision.fields.length > 0);

  const classified = new Map(EXECUTION_REQUEST_SNAPSHOT_READS.map((entry) => [identityOf(entry), entry]));

  const unclassified = population.filter((decision) => !classified.has(identityOf(decision.row)));
  const stray = EXECUTION_REQUEST_SNAPSHOT_READS.filter(
    (entry) =>
      !decisions.some((decision) => identityOf(decision.row) === identityOf(entry) && decision.fields.length > 0),
  );
  const counts = { transport: 0, policy: 0, "game-owned": 0, "stale-snapshot": 0 };
  for (const decision of population) {
    const entry = classified.get(identityOf(decision.row));
    if (entry !== undefined) counts[entry.bucket] += 1;
  }

  console.log(
    `snapshot-authority: predicates examined ${population.length} of ${rows.length} rows walked · ` +
      `transport ${counts.transport} · policy ${counts.policy} · game-owned ${counts["game-owned"]} · ` +
      `stale-snapshot ${counts["stale-snapshot"]} · unclassified ${unclassified.length}`,
  );

  assert.ok(rows.length > 0, "the declarations must have been read: every row of the preflight is in this population");
  assert.ok(
    population.length > 0,
    "no row reads the snapshot at all, which cannot be true while the revision row exists - this walk is not measured",
  );

  const report = population
    .filter((decision) => {
      const entry = classified.get(identityOf(decision.row));
      return entry === undefined || entry.bucket === "stale-snapshot";
    })
    .map(
      (decision) =>
        `${decision.action}: a row reads snapshot.${decision.fields.join(", snapshot.")} and ` +
        `${classified.has(identityOf(decision.row)) ? "is filed as stale-snapshot" : "no entry classifies it"} ` +
        `(field \`${decision.row.field}\`, shape \`${decision.row.shape}\`, refusal \`${decision.row.refusal}\`)`,
    );
  assert.deepEqual(
    report,
    [],
    "a row that refuses a request on a snapshot row is a second authority with an older view: the game thread re-validates the same fact live",
  );

  assert.deepEqual(
    stray.map((entry) => `${entry.field}: no live row reads the snapshot, so this classification outlived it`),
    [],
    "an entry that no longer matches a snapshot-reading row is an exemption that must expire",
  );
});

test("every world fact the Host stopped deciding is answered by a code this suite read from its producer", () => {
  const rowsByAction = new Map(
    (Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES) as readonly ExecutionRequest["action"][]).map((action) => [
      action,
      EXECUTION_REQUEST_ARGUMENT_RULES[action],
    ]),
  );
  assert.ok(EXECUTION_REQUEST_WORLD_FACTS_OWED_TO_THE_GAME.length > 0, "the handoff table must have been read");

  const offenders: string[] = [];
  const examined: string[] = [];
  const judged = new Set<string>();
  for (const fact of EXECUTION_REQUEST_WORLD_FACTS_OWED_TO_THE_GAME) {
    const problems: string[] = [];
    judged.add(`${fact.action}:${fact.snapshotField}`);
    const rows = rowsByAction.get(fact.action);
    if (rows === undefined) {
      offenders.push(
        `${fact.action}: no argument rows, so the handoff names an action this declaration does not carry`,
      );
      continue;
    }
    const stillDeciding = rows
      .map((row) => snapshotFieldsReadBy(row, probeReading(fact.action, { x: "probe", y: "probe", slot: "probe" })))
      .flat()
      .includes(fact.snapshotField);
    if (stillDeciding)
      problems.push(
        `${fact.action}: the Host still reads snapshot.${fact.snapshotField}, so the game is not the only authority on it`,
      );

    const producer = join(ROOT, fact.producer);
    if (!existsSync(producer)) {
      problems.push(`${fact.action}: ${fact.producer} does not exist, so \`${fact.gameRefusal}\` has no producer`);
      offenders.push(...problems);
      continue;
    }
    const source = readFileSync(producer, "utf8");
    if (source.length === 0)
      problems.push(`${fact.action}: ${fact.producer} is empty, which is not a reading of the producer`);
    if (!source.includes(fact.gameRefusal))
      problems.push(
        `${fact.action}: ${fact.producer} does not produce \`${fact.gameRefusal}\`, so the Host deleted its refusal and nobody answers it`,
      );
    if (problems.length === 0)
      examined.push(`${fact.action} -> ${fact.gameRefusal} in ${fact.producer} (${source.length} bytes)`);
    else offenders.push(...problems);
  }

  console.log(`snapshot-authority handoffs:\n  ${examined.join("\n  ")}`);
  assert.equal(
    judged.size,
    EXECUTION_REQUEST_WORLD_FACTS_OWED_TO_THE_GAME.length,
    "every handoff is judged once: a table that repeated an action and a field would hide the one it left out",
  );
  assert.deepEqual(offenders, [], "a deleted Host refusal must hand off to a game-thread refusal that exists");
});

test("the trace sees a world-fact read, so a green run is a measurement and not a hole", () => {
  // The falsifier: a row whose predicate is exactly the shape this suite exists to forbid. If the trace could not see this
  // one, every assertion above would pass for the wrong reason.
  const worldFactRow: ExecutionRequestRequirement = {
    field: "args.x, args.y",
    shape: "a machine this exact snapshot published at that tile",
    refusal: "machine_target_moved",
    isMet: (reading) =>
      Array.isArray(reading.snapshot.machineTargets) &&
      reading.snapshot.machineTargets.some((target) => target.x === reading.args.x),
    violated: (reading) => reading,
  };
  assert.deepEqual(
    snapshotFieldsReadBy(worldFactRow, probeReading("machine_load", { x: 1, y: 2 })),
    ["machineTargets"],
    "a row that decides a world fact must be traced to the field it decides, or the gate above cannot see it",
  );

  // ...and a row that reads the snapshot only through a family function handed to it is traced just the same: that is how
  // the five deleted target rows were written.
  const family = (snapshot: Snapshot) => snapshot.horseTargets;
  const viaHelper: ExecutionRequestRequirement = {
    field: "args.expectedTargetId",
    shape: "the horse this exact snapshot published",
    refusal: "horse_target_not_published",
    isMet: (reading) =>
      family(reading.snapshot)?.some((target) => target.targetId === reading.args.expectedTargetId) === true,
    violated: (reading) => reading,
  };
  assert.deepEqual(snapshotFieldsReadBy(viaHelper, probeReading("mount_transport", { expectedTargetId: "horse_1" })), [
    "horseTargets",
  ]);
});
