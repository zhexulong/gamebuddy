#!/usr/bin/env node
/**
 * SLICE ③ - A SECOND NAVIGATION DOES NOT ORPHAN THE FIRST.
 *
 * THE PROPERTY. With one `navigate_to_destination` in flight, a second navigation submitted against the same body ends
 * with the FIRST one settled - succeeded, refused, cancelled or failed - inside 30 s. It does not sit in flight for ten
 * minutes until a stale sweep abandons it.
 *
 * WHY IT IS A SLICE. Measured 2026-11-22 (`round93`): a second `navigate_to_destination` submitted while one was running
 * left the journal at `open_status=RecoveryRequired` for **627 s**, and again for **829 s**, until the stale sweep
 * abandoned it. `RecoveryRequired` is the state for a node whose outcome nobody knows, and it is sticky: every submission
 * after it answers for the abandoned work before it answers for the new call. Single-action success in that run was
 * 96.7% - the seam is not the navigation, it is what a second one does to the first.
 *
 * THE WORLD. Fixture key `navigation_mutation` arms `navigation_mutation_v1`, whose own initializer derives a reachable
 * one-hop destination from the live map and records it as `NavigationMutationTargetLabel`. This slice uses THAT label -
 * it is the world's own answer, and a slice that hard-coded `SeedShop` would be asserting a fact the fixture never armed.
 * `--destination <label>` asserts the armed label instead of accepting whatever the world chose.
 *
 * WHAT IT IS MEASURED AT, AND WHY. The action level, because that is where the property lives: whichever internal
 * authority goes sticky, the caller-visible fact is whether the first execution ever settles. The slice does not read the
 * body-program journal's `open_status` directly - it reads the first execution's terminal and, when the bound expires, the
 * state the world still reports in flight.
 *
 * WHAT IT DOES NOT COVER. It submits the second navigation as an action, not as a plan script, so the `plan_work`
 * admission path is not what is being interrupted here. It does not cover a second navigation to the SAME destination,
 * the STOP/redirect path that ends the first deliberately, or what the abandoned program's journal says afterwards.
 *
 * USAGE
 *   node tools/live-run/slices/double-navigate.mjs [--destination <label>] [--budget-ms <n>] [--dry-run] [--keep-log]
 */
import { readFile } from "node:fs/promises";
import { delay, executeFresh, observeFresh, TERMINAL_STATES } from "../../lib/stardew-native-smoke-harness-v1.mjs";
import { refusal, restoreEnding } from "../../live-action.mjs";
import {
  announceSlice,
  describeSlicePlan,
  finishSlice,
  observeReadyWorld,
  runSliceWorld,
  startSlice,
  USAGE_COMMON,
} from "./harness.mjs";

const NAME = "double-navigate";
const SCENARIO = "navigation_mutation";
const ACTION = "navigate_to_destination";
/** The property's own bound: a navigation that will not settle in half a minute is the ten-minute stall in miniature. */
const SETTLE_BOUND_MS = 30_000;

export const USAGE = `usage: node tools/live-run/slices/double-navigate.mjs [options]

  Starts one navigation, submits a second while the first runs, and asserts the FIRST settles inside
  ${String(SETTLE_BOUND_MS)} ms.

  --destination <label>      assert the label the fixture armed (default: accept the world's own one). A label the world
                             did not arm is refused: this slice will not point at a destination nobody measured.

${USAGE_COMMON}`;

/**
 * The armed destination label, read from the fixture config ON DISK.
 *
 * Read here and not at connect time because the Mod writes this field DURING the scenario: the initializer derives the
 * destination from the live map and then rewrites `config.json`, so the copy this run loaded before the launch still
 * carries the empty string. A slice that read the pre-launch copy would refuse every world it armed.
 */
export async function armedDestinationLabel(configPath) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const label = config?.NativeLocalPlayerFixture?.NavigationMutationTargetLabel;
  if (typeof label !== "string" || label.length === 0)
    throw refusal("slice_navigation_destination_not_armed:NavigationMutationTargetLabel");
  return label;
}

/** The resolved selector the action's own `destination` argument takes, from the world's search answer. */
export async function resolveDestination(client, label) {
  const found = await client.navigationRead({ operation: "find_destination", args: { query: label } });
  const payload = found?.payload ?? found;
  const resolved = payload?.destination;
  if (resolved !== null && resolved !== undefined && typeof resolved === "object") return resolved;
  // The world's search answered without a resolved row: the label the fixture armed is still a legal selector kind, and
  // the Mod is the authority that decides whether it addresses a destination. Nothing is invented beyond that kind.
  return { kind: "label", label };
}

async function awaitTerminalBy(receipts, accepted, boundMs) {
  const startedAt = Date.now();
  while (true) {
    const terminal = [accepted, ...receipts].find(
      (receipt) =>
        receipt?.requestId === accepted.requestId &&
        receipt?.executionId === accepted.executionId &&
        TERMINAL_STATES.has(receipt.state),
    );
    if (terminal !== undefined) return { terminal, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= boundMs) return { terminal: null, elapsedMs: Date.now() - startedAt };
    await delay(50);
  }
}

/** One fresh-enough observation for the second submission: the cache is the current truth when a read is refused. */
async function readForSecondSubmission(client) {
  try {
    return await observeFresh(client);
  } catch (error) {
    const cached = client.state?.snapshot;
    if (cached === null || cached === undefined) throw error;
    return cached;
  }
}

/** The whole measurement: start one navigation, submit a second, then hold the first to its bound. */
export async function measureDoubleNavigate({ client, receipts, configPath, budgetMs, expectedDestination = null }) {
  const before = await observeReadyWorld(client, { budgetMs });
  const label = await armedDestinationLabel(configPath);
  if (expectedDestination !== null && expectedDestination !== label)
    throw refusal(`slice_navigation_destination_disagrees:${expectedDestination}:armed=${label}`);
  const destination = await resolveDestination(client, label);

  const firstRequestId = `slice_double_navigate_first_${Date.now()}`;
  const first = await executeFresh(client, {
    requestId: firstRequestId,
    idempotencyKey: `${firstRequestId}_idem`,
    action: ACTION,
    args: { destination },
    snapshot: before,
  });

  // The second submission is the whole point: it arrives while the first owns the body. Its own answer is recorded and
  // never judged - a caller is allowed to be refused here, and refusing is one of the endings this seam owes.
  const secondSnapshot = await readForSecondSubmission(client);
  const secondRequestId = `slice_double_navigate_second_${Date.now()}`;
  let second = null;
  try {
    second = await executeFresh(client, {
      requestId: secondRequestId,
      idempotencyKey: `${secondRequestId}_idem`,
      action: ACTION,
      args: { destination },
      snapshot: secondSnapshot,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    second = { refused: String(error.message ?? error).slice(0, 300) };
  }

  const { terminal, elapsedMs } = await awaitTerminalBy(receipts, first, SETTLE_BOUND_MS);
  let stillInFlight = null;
  if (terminal === null) {
    const last = client.state?.snapshot ?? secondSnapshot;
    stillInFlight = last?.activeExecution ?? null;
  }
  return {
    destination: { label, selector: destination },
    location: before.location,
    first: {
      requestId: firstRequestId,
      admission: { state: first.state ?? null, reasonCode: first.reasonCode ?? null },
      terminal: terminal === null ? null : { state: terminal.state, reasonCode: terminal.reasonCode },
      elapsedMs,
    },
    second: describeSecondRecord(second),
    stillInFlight:
      stillInFlight === null
        ? null
        : { state: stillInFlight.state ?? null, reasonCode: stillInFlight.reasonCode ?? null },
  };
}

/**
 * The verdict. A first navigation that reaches any terminal inside the bound is the property; a refusal counts, and so
 * does a cancellation - what must not happen is silence while the second one runs.
 */
export function judgeDoubleNavigate(measured) {
  if (measured.first.terminal === null)
    return {
      status: "failed",
      detail: `first_navigation_unsettled_within_${String(SETTLE_BOUND_MS)}ms:elapsed=${String(measured.first.elapsedMs)}:in_flight=${String(measured.stillInFlight?.state ?? "none")}:second=${describeSecond(measured.second)}`,
    };
  if (measured.first.elapsedMs > SETTLE_BOUND_MS)
    return {
      status: "failed",
      detail: `first_navigation_settled_late:${String(measured.first.elapsedMs)}ms:${String(measured.first.terminal.state)}`,
    };
  return {
    status: "passed",
    detail: `first_settled_in_${String(measured.first.elapsedMs)}ms:${String(measured.first.terminal.state)}:${String(measured.first.terminal.reasonCode)}`,
  };
}

function describeSecond(second) {
  if (second === null) return "none";
  if ("refused" in second) return `refused:${second.refused}`;
  return `${String(second.state)}:${String(second.reasonCode)}`;
}

/** The second submission as the block carries it: the Mod's answer, or the bridge's refusal. */
function describeSecondRecord(second) {
  if (second === null) return null;
  if ("refused" in second) return second;
  return { state: second.state ?? null, reasonCode: second.reasonCode ?? null };
}

async function main(argv) {
  const started = await startSlice({
    name: NAME,
    argv,
    usage: USAGE,
    scenarioKey: SCENARIO,
    budgetMs: 90_000,
    subjectFlags: ["--destination"],
  });
  if (started === null) return;
  const { options, plan } = started;
  const calls = [`${ACTION}(armed)`, `${ACTION}(again)`];
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(describeSlicePlan({ name: NAME, plan, calls }), null, 2)}\n`);
    return;
  }
  announceSlice({ name: NAME, plan, calls });
  let run;
  try {
    run = await runSliceWorld({
      plan,
      body: ({ client, receipts }) =>
        measureDoubleNavigate({
          client,
          receipts,
          configPath: plan.clientConfigPath,
          budgetMs: options.budgetMs,
          expectedDestination: options.subject.destination ?? null,
        }),
    });
  } catch (error) {
    finishSlice({ name: NAME, status: "blocked", detail: String(error?.message ?? error), facts: {} });
    return;
  }
  const ending = restoreEnding(run.restore);
  if (ending !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: ending,
      facts: { measured: run.result, restore: run.restore },
    });
    return;
  }
  if (run.failure !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: String(run.failure?.message ?? run.failure),
      facts: { restore: run.restore },
    });
    return;
  }
  const judged = judgeDoubleNavigate(run.result);
  finishSlice({
    name: NAME,
    status: judged.status,
    detail: judged.detail,
    facts: { measured: run.result, restore: run.restore, elapsedMs: run.elapsedMs },
  });
}

await main(process.argv.slice(2));
