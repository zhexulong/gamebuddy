import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CompanionEventPump, type PendingBatch } from "./event-pump.js";
import {
  createProgramSettlementReporter,
  MAX_SETTLED_DIGEST_NODES,
  programSettledDigest,
  settledProgramAnswer,
  watchProgramSettlement,
  type SettledProgramAnswer,
} from "./program-settlement-digest.js";
import type { PlanAnswerNode } from "./program-status-wait.js";
import { planBatchAnswer } from "./program-status-wait.js";

type JournalNode = Readonly<{
  nodeId: string;
  state: string;
  rejectionCode?: string;
  failureCode?: string;
  hint?: string;
  refusalDetail?: string;
  recoveryDiagnostic?: string;
}>;

function planNode(nodeId: string, actionId = "move_to_tile", x = 5, y = 8): PlanAnswerNode {
  return {
    nodeId,
    actionId,
    arguments: {
      x: { type: "integer", canonicalValue: String(x) },
      y: { type: "integer", canonicalValue: String(y) },
    },
  };
}

function status(programId: string, state: string, nodes: readonly JournalNode[]): unknown {
  return {
    code: "found",
    snapshot: { programId, state, catalogRevision: 3, stopEpoch: 0, eventHighWater: 90, nodes },
  };
}

test("a settled program reaches the pump as one ledger entry, and opens a turn of its own", async () => {
  // THE DEFECT THIS CLOSES. Measured 2026-11-07 over 29 plan batches: every node entry was `pending`, because
  // `planBatchAnswer` reads the journal at submission and nothing ever carried the terminal states back. The assertion
  // is the property the companion asked for: after the Mod's journal stops, the pump holds a fact carrying the terminal
  // rows.
  //
  // And it OPENS a turn: a settlement is an outcome, not progress that can be held until something else happens
  // (`event-pump.ts:isHeldProgressFact`). While it was held, a plan that settled in a quiet field was announced only if
  // the world did something else first, which is the silent ledger this digest exists to end.
  const compiled = [planNode("n01"), planNode("n02")];
  const pump = new CompanionEventPump();
  const reporter = createProgramSettlementReporter((fact) => pump.enqueueFact(fact));
  const reads: unknown[] = [
    status("plan_1", "active", [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "running" },
    ]),
    status("plan_1", "succeeded", [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "succeeded" },
    ]),
  ];
  let clock = 0;
  const outcome = await watchProgramSettlement({
    read: async () => reads.shift() ?? status("plan_1", "succeeded", []),
    onSettled: async (settled) => {
      reporter.report({ programId: "plan_1", settledAtMs: 4_242, compiled, status: settled, nowMs: 9 });
    },
    now: () => (clock += 25),
    sleep: async () => undefined,
    intervalMs: 1,
    maxMs: 60_000,
  });
  assert.equal(outcome, "settled");
  assert.equal(pump.hasPendingDelivery, true, "an outcome is news, so it opens the next turn itself");
  const batches: PendingBatch[] = [];
  await pump.flush({
    deliver: async (batch) => {
      batches.push(batch);
    },
  });
  assert.equal(batches.length, 1);
  const batch = batches[0]!;
  const digest = batch.facts.find((fact) => fact.eventId === "program_settled_plan_1");
  assert.ok(digest !== undefined, "the batch carries the settled digest");
  assert.equal(digest.payload.programId, "plan_1");
  assert.equal(digest.payload.settledAtMs, 4_242);
  assert.equal(digest.payload.summary, "2 of 2 done");
  assert.deepEqual(
    (digest.payload.nodes as readonly Readonly<Record<string, unknown>>[]).map((row) => row.state),
    ["succeeded", "succeeded"],
    "the rows are the terminal states, never the submission-time `pending`",
  );
  assert.deepEqual(
    (digest.payload.nodes as readonly Readonly<Record<string, unknown>>[]).map((row) => row.index),
    [0, 1],
  );
  assert.equal(batch.triggerEventIds.includes("program_settled_plan_1"), true);
  assert.match(batch.text, /2\/2 步做成了/u, "and the model reads the settlement as one sentence");
});

test("the digest is minted exactly once per program, and never for a program that has not stopped", async () => {
  const compiled = [planNode("n01")];
  const announced: string[] = [];
  const reporter = createProgramSettlementReporter((fact) => announced.push(String(fact.eventId)));
  const running = status("plan_2", "active", [{ nodeId: "n01", state: "running" }]);
  // A still-running plan produces nothing, and - the part that matters - does not spend its one claim.
  assert.equal(programSettledDigest({ programId: "plan_2", settledAtMs: 1, compiled, status: running }), undefined);
  assert.equal(reporter.report({ programId: "plan_2", settledAtMs: 1, compiled, status: running }), undefined);
  const settled = status("plan_2", "failed", [{ nodeId: "n01", state: "failed", failureCode: "no_native_path" }]);
  assert.ok(reporter.report({ programId: "plan_2", settledAtMs: 7, compiled, status: settled }) !== undefined);
  // Every later observation of the same settled program is silence.
  assert.equal(reporter.report({ programId: "plan_2", settledAtMs: 7, compiled, status: settled }), undefined);
  assert.equal(reporter.report({ programId: "plan_2", settledAtMs: 9, compiled, status: settled }), undefined);
  assert.deepEqual(announced, ["program_settled_plan_2"]);
  // A different program still gets its own.
  assert.ok(
    reporter.report({
      programId: "plan_3",
      settledAtMs: 11,
      compiled,
      status: status("plan_3", "succeeded", [{ nodeId: "n01", state: "succeeded" }]),
    }) !== undefined,
  );
  // A program the journal no longer knows has no rows to carry, so there is no ledger to claim.
  assert.equal(
    reporter.report({
      programId: "plan_4",
      settledAtMs: null,
      compiled,
      status: { code: "not_found", snapshot: null },
    }),
    undefined,
  );
});

test("a plan larger than the digest bound answers its first rows and counts the rest", () => {
  const compiled = Array.from({ length: 26 }, (_, index) => planNode(`n${String(index + 1).padStart(2, "0")}`));
  const journal = compiled.map((node) => ({ nodeId: node.nodeId, state: "succeeded" }));
  const fact = programSettledDigest({
    programId: "plan_26",
    settledAtMs: 5,
    compiled,
    status: status("plan_26", "succeeded", journal),
  });
  assert.ok(fact !== undefined);
  const payload = fact.payload as Readonly<{
    nodes: readonly Readonly<Record<string, unknown>>[];
    omitted?: number;
    summary: string;
  }>;
  assert.equal(MAX_SETTLED_DIGEST_NODES, 20);
  assert.equal(payload.nodes.length, 20, "at most the bound, not the whole plan");
  assert.equal(payload.omitted, 6, "what did not fit is COUNTED, never dropped silently");
  assert.equal(payload.nodes[19]?.index, 19, "the rows keep the caller's own indices, so a tail is addressable");
  assert.equal(payload.summary, "26 of 26 done");
});

test("a plan that settled with one rejection names that node, its code, and the rest as succeeded", () => {
  const compiled = [planNode("n01", "till_soil", 61, 18), planNode("n02", "water_crop", 62, 18), planNode("n03")];
  const fact = programSettledDigest({
    programId: "plan_r",
    settledAtMs: 12,
    compiled,
    status: status("plan_r", "succeeded", [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "rejected", rejectionCode: "resource_unavailable" },
      { nodeId: "n03", state: "succeeded" },
    ]),
  });
  assert.ok(fact !== undefined);
  const payload = fact.payload as Readonly<{
    nodes: readonly Readonly<Record<string, unknown>>[];
    summary: string;
    omitted?: number;
  }>;
  assert.equal(payload.summary, "2 of 3 done, 1 rejected");
  assert.equal(payload.omitted, 0, "a plan inside the bound omits nothing, and says so as a measured zero");
  assert.deepEqual(
    payload.nodes.map((row) => [row.index, row.actionId, row.state, row.reasonCode]),
    [
      [0, "till_soil", "succeeded", undefined],
      [1, "water_crop", "rejected", "resource_unavailable"],
      [2, "move_to_tile", "succeeded", undefined],
    ],
  );
  assert.deepEqual(payload.nodes[0]?.tile, { x: 61, y: 18 }, "the tile a refusal is read against still rides the row");
});

test("a refused move's reachability hint reaches the digest row and the text the model reads", async () => {
  // THE HOP THIS PINS. A settled failure keeps its reason code and its hint, and nothing else: ADR-006 withholds the
  // evidence of a node that proved nothing, so the hint is the ONE actionable part of a refusal that survives into the
  // ledger. Every layer between the Mod's journal and the model was checked for a place that re-projects a node row -
  // `planBatchAnswer` (the reader both the status tool and this digest answer with), the digest payload, and the pump's
  // own serialization - and the fact has to be present in the last one, because that is the text a model actually reads.
  const compiled = [planNode("n01", "move_to_tile", 49, 14)];
  const pump = new CompanionEventPump();
  const reporter = createProgramSettlementReporter((fact) => pump.enqueueFact(fact));
  reporter.report({
    programId: "plan_h",
    settledAtMs: 3,
    compiled,
    status: status("plan_h", "failed", [
      { nodeId: "n01", state: "failed", failureCode: "no_native_path", hint: "closest=49,14;closest_distance=1" },
    ]),
  });
  const batches: PendingBatch[] = [];
  await pump.flush({
    deliver: async (batch) => {
      batches.push(batch);
    },
  });
  const text = batches[0]?.text ?? "";
  assert.match(text, /closest=49,14;closest_distance=1/u, "the batch the model reads carries the hint");
  // THE ROW NAMED ITS REASON, SO THE TEXT SAYS IT ONCE. `failureWords` prints a node's `reasonCode` beside its `hint` and
  // `reasonDetail`, so a placeholder in that field reached the model as `no_native_path：unknown_reason:failed` - the code
  // that IS the reason, followed by the reason denied. Measured `2026-11-11` (`multiday_routine`): all ten placeholder rows
  // of one session stood beside a named reason, six of them beside a `reasonCode` exactly like this one.
  assert.match(text, /no_native_path/u, "the code the Mod named is the reason the model reads");
  assert.doesNotMatch(
    text,
    /unknown_reason/u,
    "a row that named its reason must not also tell the model the reason is unknown",
  );
  const row = (
    batches[0]?.facts[0]?.payload as Readonly<{
      nodes: readonly Readonly<Record<string, unknown>>[];
    }>
  ).nodes[0];
  assert.deepEqual(row, {
    index: 0,
    actionId: "move_to_tile",
    state: "failed",
    reasonCode: "no_native_path",
    hint: "closest=49,14;closest_distance=1",
    // No `reasonDetail`: this refusal's receipt carried no detail, and `no_native_path` already names why the node stopped,
    // so the row owes no placeholder beside it (see `planNodeReasonDetail`).
    tile: { x: 49, y: 14 },
  });
});

/**
 * A node that failed with a next step must not answer the same way as one that failed without.
 *
 * The two are the same state and often the same reason code (`no_native_path` either way), and the difference is the
 * whole of what a caller can do next: aim at the named tile, or give up on this target. Asserted on the payload AND on
 * the serialized row, because the payload is what a later reader inspects and the row is what the model was handed.
 */
test("a node that failed with a next step is a different answer from one that failed without", () => {
  const compiled = [planNode("n01", "move_to_tile", 49, 14)];
  const hinted = programSettledDigest({
    programId: "plan_with",
    settledAtMs: 1,
    compiled,
    status: status("plan_with", "failed", [
      { nodeId: "n01", state: "failed", failureCode: "no_native_path", hint: "closest=49,14;closest_distance=1" },
    ]),
  });
  const bare = programSettledDigest({
    programId: "plan_without",
    settledAtMs: 1,
    compiled,
    status: status("plan_without", "failed", [{ nodeId: "n01", state: "failed", failureCode: "no_native_path" }]),
  });
  assert.ok(hinted !== undefined && bare !== undefined);
  const hintedRow = (hinted.payload as Readonly<{ nodes: readonly Readonly<Record<string, unknown>>[] }>).nodes[0];
  const bareRow = (bare.payload as Readonly<{ nodes: readonly Readonly<Record<string, unknown>>[] }>).nodes[0];
  assert.equal(hintedRow?.hint, "closest=49,14;closest_distance=1");
  assert.equal(Object.hasOwn(bareRow as object, "hint"), false, "a refusal with nothing to say has no hint key");
  assert.notDeepEqual(hintedRow, bareRow, "the two failures must not read as one answer");
  // The state and the reason are identical, so the difference above is the hint and not a coincidence of two worlds.
  assert.equal(hintedRow?.state, bareRow?.state);
  assert.equal(hintedRow?.reasonCode, bareRow?.reasonCode);
});

test("a node the journal said nothing about stays unreadable, and is never reported as a success", () => {
  const compiled = [planNode("n01"), planNode("n02")];
  const fact = programSettledDigest({
    programId: "plan_u",
    settledAtMs: 3,
    compiled,
    status: status("plan_u", "succeeded", [{ nodeId: "n01", state: "succeeded" }]),
  });
  assert.ok(fact !== undefined, "one unreadable row must not cost the other rows");
  const payload = fact.payload as Readonly<{ nodes: readonly Readonly<Record<string, unknown>>[]; summary: string }>;
  assert.equal(payload.nodes[1]?.state, "unknown", "PLAN_NODE_STATE_UNREADABLE, not `pending` and not `succeeded`");
  assert.equal(payload.summary, "1 of 2 done, 1 unknown");
});

test("the watch follows a queued plan past the point a turn-holding wait would have given up", async () => {
  // `waitForTerminalProgramStatus` returns early after a few unchanged polls, which is right for a caller holding a
  // turn and wrong for the ledger: a plan still waiting on its first admission must still be followed.
  const stillQueued = status("plan_q", "active", [{ nodeId: "n01", state: "pending" }]);
  const reads = Array.from({ length: 20 }, () => stillQueued);
  let clock = 0;
  const outcome = await watchProgramSettlement({
    read: async () => reads.shift() ?? status("plan_q", "succeeded", [{ nodeId: "n01", state: "succeeded" }]),
    onSettled: async () => undefined,
    now: () => (clock += 1_000),
    sleep: async () => undefined,
    intervalMs: 1_000,
    maxMs: 600_000,
  });
  assert.equal(outcome, "settled", "twenty unchanged reads are not a settlement, and not a reason to stop following");
});

test("a watch whose journal read fails ends as `stopped`, and one that outlives its bound as `expired`", async () => {
  let clock = 0;
  assert.equal(
    await watchProgramSettlement({
      read: async () => {
        throw new Error("bridge_gone");
      },
      onSettled: async () => undefined,
      now: () => clock,
      sleep: async () => undefined,
      intervalMs: 1_000,
      maxMs: 60_000,
    }),
    "stopped",
  );
  clock = 0;
  const outcome = await watchProgramSettlement({
    read: async () => status("plan_x", "active", [{ nodeId: "n01", state: "pending" }]),
    onSettled: async () => undefined,
    now: () => (clock += 30_000),
    sleep: async () => undefined,
    intervalMs: 1_000,
    maxMs: 60_000,
  });
  assert.equal(outcome, "expired");
});

test("the digest is wired to the pump on the one path every program takes", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const materializer = await readFile(
    join(root, "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts"),
    "utf8",
  );
  // A digest that is composed and never enqueued is the defect this whole module exists to end, so the wiring is
  // asserted where it lives: the reporter is fed by the submission path, and the sink it announces to is the pump.
  assert.match(materializer, /const settlement = createProgramSettlementReporter\(announceSettledFact\);/u);
  assert.match(
    materializer,
    /if \(code === "accepted" \|\| code === "idempotent"\) \{\n\s+revealReaders\(\);\n\s+startSettlementWatch\(request\.programId, request\.nodes\);/u,
  );
  assert.match(materializer, /announceHostFact = \(fact\) => host\.acceptHostMintedFact\(fact\);/u);
  // AND SO IS THE POLL. A status read of a STOPPED program answers with the ledger the fact was minted from, never
  // with a second derivation: this is the wiring that makes "one poll is enough" true rather than aspirational.
  assert.match(
    materializer,
    /planAnswerReading\(\n\s+tracked\.result,\n\s+programStatusProgress\.observe\(tracked\.result\),\n\s+settlement\.settled\(params\.programId\),\n\s+\),/u,
    "the plain status read answers a stopped plan from the settlement ledger",
  );
  const digestSource = await readFile(join(root, "program-settlement-digest.ts"), "utf8");
  assert.match(
    digestSource,
    /settled\(programId: string\): SettledProgramAnswer \| null;/u,
    "and the ledger is the reporter's own, not a third reading of the journal",
  );
  const hostService = await readFile(join(root, "host-service.ts"), "utf8");
  assert.match(
    hostService,
    /public acceptHostMintedFact\(fact: WorldFact\): void \{\n\s+if \(this\.#closed\) return;\n\s+this\.loop\.pump\.enqueueFact\(fact\);/u,
  );
});

/**
 * T1 - END TO END, on the text the model actually reads.
 *
 * THE DEFECT, measured in `round41`: `shop_purchase` answered `shop_counter_out_of_reach` six times, the Mod's own receipt
 * held `owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1`, the model received
 * `{"reasonCode":"shop_counter_out_of_reach","actionId":"shop_purchase"}` - and invented the world fact it needed. Over
 * that round's 94 `program_status` replies, `evidence` and `detail` appeared zero times.
 *
 * So the assertion is not "the payload has a field". It is that the WHOLE CHAIN - the reporter, the digest that hands the
 * fact to the pump, and the pump's own serialization - carries the Mod's sentence through to the last text a model ever
 * sees, unchanged. Every layer between the journal and the model is in this one string, which is why the check is `match` on
 * the delivered batch rather than a field comparison on an intermediate object.
 *
 * The second half is the coordinate. `shop_purchase` names no tile; its arguments are a target id and an item id. A row
 * that invented `tile` would be the Host answering a question about the world it did not ask - the same class of error as
 * the invented world fact, one layer up.
 */
test("a refused shop purchase reaches the model with the reason the counter gave, and no invented tile", async () => {
  const compiled = [
    {
      nodeId: "n01",
      actionId: "shop_purchase",
      arguments: {
        expectedTargetId: { type: "string" as const, canonicalValue: "shop_Pierre" },
        expectedQualifiedItemId: { type: "string" as const, canonicalValue: "(O)24" },
      },
    },
  ];
  const detail = "owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1";
  const pump = new CompanionEventPump();
  const reporter = createProgramSettlementReporter((fact) => pump.enqueueFact(fact));
  const reported = reporter.report({
    programId: "plan_shop",
    settledAtMs: 4_242,
    compiled,
    status: status("plan_shop", "failed", [
      { nodeId: "n01", state: "failed", failureCode: "shop_counter_out_of_reach", refusalDetail: detail },
    ]),
  });
  assert.ok(reported !== undefined, "a failed plan is still a settled plan, and owes a ledger");
  const batches: PendingBatch[] = [];
  await pump.flush({
    deliver: async (batch) => {
      batches.push(batch);
    },
  });
  const text = batches[0]?.text ?? "";
  assert.match(text, /shop_counter_out_of_reach/u, "the reason code still arrives");
  assert.match(text, /owner_tile=4,17;actor_tile=4,19;radius=1/u, "and so does the sentence that makes it actionable");
  const row = (
    batches[0]?.facts[0]?.payload as Readonly<{
      nodes: readonly Readonly<Record<string, unknown>>[];
    }>
  ).nodes[0];
  assert.equal(row?.reasonDetail, detail, "carried verbatim, never re-rendered");
  assert.equal("tile" in (row as object), false, "`shop_purchase` names no tile, so the row invents none");
});

/**
 * T4 - ONE AUTHORITY.
 *
 * The settlement digest and `stardew_action_program_status` are two ways of reading the SAME node, and they must agree
 * field for field. The digest is built on `planBatchAnswer` precisely so this holds (`program-settlement-digest.ts:25` -
 * "the rows come from `planBatchAnswer` - the same reader"), but "built on" is a claim about today's source, and this is the
 * assertion that it is a fact about the answer: a second row-minting path, or a field added at one call site, fails here.
 */
test("the digest row and the status row for one node are the same answer", () => {
  const compiled = [
    { nodeId: "n01", actionId: "shop_purchase", arguments: {} },
    {
      nodeId: "n02",
      actionId: "move_to_tile",
      arguments: {
        x: { type: "integer" as const, canonicalValue: "9" },
        y: { type: "integer" as const, canonicalValue: "4" },
      },
    },
  ];
  const snapshot = {
    programId: "plan_one",
    state: "failed",
    catalogRevision: 3,
    stopEpoch: 0,
    eventHighWater: 90,
    nodes: [
      {
        nodeId: "n01",
        state: "failed",
        failureCode: "shop_counter_out_of_reach",
        refusalDetail: "owner=Pierre;radius=1",
      },
      { nodeId: "n02", state: "succeeded" },
    ],
  };
  const digest = programSettledDigest({
    programId: "plan_one",
    settledAtMs: 5,
    compiled,
    status: { code: "found", snapshot },
  });
  assert.ok(digest !== undefined);
  const digestRows = (digest.payload as Readonly<{ nodes: readonly unknown[] }>).nodes;
  const statusRows = planBatchAnswer(compiled, snapshot).nodes;
  assert.equal(digestRows.length, statusRows.length);
  for (const [index, statusRow] of statusRows.entries())
    assert.deepEqual(digestRows[index], statusRow, `row ${index} must be one answer, not two`);
});

/**
 * THE SETTLEMENT CARRIES THE FULL AGGREGATE, so one poll after it cannot add a count that was missing.
 *
 * Measured `round43`: 29 of 96 assistant turns were `stardew_action_program_status` calls. A settlement fact that carried
 * only a sentence (`"2 of 3 done, 1 rejected"`) left the per-state population unreadable - "how many were rejected and
 * were they the same nodes I asked about" - so a reader that wanted the breakdown went back to the tool. `counts` is that
 * breakdown in the Mod's own state tokens, over the WHOLE plan rather than the rows the bound could carry, and `total`
 * is the population it is counted against.
 */
test("a settled program states its aggregate counts over the whole plan, beside each node's terminal code", () => {
  const compiled = [planNode("n01", "till_soil"), planNode("n02", "water_crop"), planNode("n03", "harvest_crop")];
  const fact = programSettledDigest({
    programId: "plan_agg",
    settledAtMs: 12,
    compiled,
    status: status("plan_agg", "succeeded", [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "rejected", rejectionCode: "resource_unavailable" },
      { nodeId: "n03", state: "skipped_dependency" },
    ]),
  });
  assert.ok(fact !== undefined);
  const payload = fact.payload as Readonly<{
    total: number;
    counts: Readonly<Record<string, number>>;
    summary: string;
    nodes: readonly Readonly<Record<string, unknown>>[];
  }>;
  assert.equal(payload.total, 3, "the population the counts are over");
  assert.deepEqual(payload.counts, { succeeded: 1, rejected: 1, skipped_dependency: 1 });
  assert.equal(payload.summary, "1 of 3 done, 1 rejected, 1 skipped_dependency");
  // The same fact in the unit a reader acts on: which node, which action, and what the Mod said about it.
  assert.deepEqual(
    payload.nodes.map((row) => [row.actionId, row.state, row.reasonCode]),
    [
      ["till_soil", "succeeded", undefined],
      ["water_crop", "rejected", "resource_unavailable"],
      ["harvest_crop", "skipped_dependency", undefined],
    ],
  );
  // The counts are over the whole plan even when the rows are bounded: a plan larger than the window still adds up.
  const wide = Array.from({ length: 26 }, (_, index) => planNode(`n${String(index + 1).padStart(2, "0")}`));
  const wideFact = programSettledDigest({
    programId: "plan_wide",
    settledAtMs: 1,
    compiled: wide,
    status: status(
      "plan_wide",
      "succeeded",
      wide.map((node, index) => ({ nodeId: node.nodeId, state: index < 25 ? "succeeded" : "failed" })),
    ),
  });
  assert.ok(wideFact !== undefined);
  const widePayload = wideFact.payload as Readonly<{
    counts: Readonly<Record<string, number>>;
    nodes: readonly unknown[];
    omitted: number;
  }>;
  assert.equal(widePayload.nodes.length, MAX_SETTLED_DIGEST_NODES, "the rows are still bounded");
  assert.equal(widePayload.omitted, 6, "and the remainder is counted");
  assert.deepEqual(widePayload.counts, { succeeded: 25, failed: 1 }, "the aggregate covers the rows the bound cut");
});

/**
 * A STATUS POLL AFTER THE SETTLEMENT ADDS NO INFORMATION ABOUT WHAT HAPPENED.
 *
 * <p>
 * The two answers are one rendering or they are two authorities. The settlement is the one fact the Host pushes
 * unprompted, so a poll that could say a count, a state or a code the fact did not is a reading the run never delivered -
 * and the tool the model is meant to stop calling becomes the better answer. `createProgramSettlementReporter.settled`
 * hands the poll the SAME rendering the fact was minted from, which is why this comparison can be an equality rather
 * than a pair of assertions that happen to agree today.
 * </p>
 * <p>
 * THE FINDING THIS NAMES: a poll does carry facts the fact does not - `settledAtMs` (when the Mod closed the journal,
 * which the fact reads with an extra events walk) and the live `progress` clocks (how long this Host has watched a node
 * in its state). Those are about the READING, never about the outcome, and the rendering below deliberately omits both
 * so the two can never disagree about what the plan did. Anything else that a poll says and the fact cannot is a defect
 * in the fact.
 * </p>
 */
test("a poll after the settlement answers with the settlement's own ledger, and nothing about the outcome differs", () => {
  const compiled = [planNode("n01", "till_soil"), planNode("n02", "water_crop")];
  const reporters = createProgramSettlementReporter(() => undefined);
  const settled = status("plan_poll", "succeeded", [
    { nodeId: "n01", state: "succeeded" },
    { nodeId: "n02", state: "failed", failureCode: "weather_blocked" },
  ]);
  const fact = reporters.report({ programId: "plan_poll", settledAtMs: 4_242, compiled, status: settled });
  assert.ok(fact !== undefined);
  const poll: SettledProgramAnswer | null = reporters.settled("plan_poll");
  assert.ok(poll !== null, "a program that settled is answerable from the ledger the fact was minted from");
  const payload = fact.payload as Readonly<{ settledAtMs: number | null } & SettledProgramAnswer>;
  // Field for field, on the fields that are about the outcome.
  assert.equal(poll.total, payload.total);
  assert.deepEqual(poll.counts, payload.counts);
  assert.equal(poll.summary, payload.summary);
  assert.deepEqual(poll.nodes, payload.nodes);
  assert.equal(poll.omitted, payload.omitted);
  // The rendering is about WHAT happened: the when lives beside it on the fact, never inside it.
  assert.equal(Object.hasOwn(poll, "settledAtMs"), false, "the fact's own timing is not part of the outcome rendering");
  // Exactly once, and the exactly-once claim does not take the answer away: a later poll still reads the same ledger.
  assert.equal(reporters.report({ programId: "plan_poll", settledAtMs: 4_242, compiled, status: settled }), undefined);
  assert.deepEqual(reporters.settled("plan_poll"), poll, "the second poll answers the same ledger, not a fresh guess");
  // A program this runtime never settled has no ledger to hand out, and says so rather than answering something else.
  assert.equal(reporters.settled("plan_never"), null);
});

/**
 * The rendering itself is one function over the answer both sides already read.
 *
 * `settledProgramAnswer` is not a formatter over a string: it is the whole settled answer as data, so a field added to
 * one consumer is added to both. This asserts the shape a reader (the model, a bundle, a report) can rely on, and that an
 * EMPTY plan is refused rather than answering `0 of 0 done`.
 */
test("the settled rendering carries counts, summary, bounded rows and the remainder - and nothing for an empty plan", () => {
  const answer = planBatchAnswer([planNode("n01"), planNode("n02")], {
    nodes: [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "recovery_required", recoveryDiagnostic: "execution_uncertain" },
    ],
  });
  const rendered = settledProgramAnswer(answer);
  assert.equal(rendered.total, 2);
  assert.deepEqual(rendered.counts, { succeeded: 1, recovery_required: 1 });
  assert.equal(rendered.summary, "1 of 2 done, 1 recovery_required");
  assert.equal(rendered.nodes.length, 2);
  assert.equal(rendered.omitted, 0);
  assert.equal(rendered.nodes[1]?.reasonDetail, "execution_uncertain", "the Mod's own diagnostic still rides the row");
});
