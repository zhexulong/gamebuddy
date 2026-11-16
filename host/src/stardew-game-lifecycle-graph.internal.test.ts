/**
 * The two lifecycle gates, over ONE declared graph.
 *
 * What they replace: the coordinator used to hold its lifecycle four times over - an
 * activation state string, a `launchTerminal` boolean latched by two sites and cleared by
 * none, the facade's process-owner slot, and a projection rule that overrode that slot. The
 * reading the player got was the one that could not advance (`game.instance.status` could
 * only ever be `launching`), and no test could see it because every test pinned one of the
 * four readings.
 *
 * So the population of these gates is the transition table itself
 * (`stardew-game-lifecycle-state.internal.ts`), which is also what the coordinator's
 * `transition()` refuses against at runtime. The code cannot disagree with the graph, and the
 * gate cannot drift from the code: there is one declaration.
 *
 *   unreachable_target_state:<state>  a BFS from the initial state over the declared
 *                                     transitions cannot reach a state whose published fact
 *                                     the product requires (`game.instance.status: running`).
 *   trapped_terminal_state:<state>    a state with in-degree > 0 and out-degree 0 that is
 *                                     neither the deliberate shutdown nor a declared
 *                                     trapped terminal with a stated reason. That is exactly
 *                                     what `launchTerminal` was.
 *
 * Both print the population they examined and fail on zero: `N states · M transitions ·
 * K reachable`. A check whose population is empty agrees with itself.
 *
 * `lifecycle-graph.3` is the falsifier and it is not synthetic: the planted graph in it is
 * `0dce992a`'s own shape, read from that commit's source in `lifecycle-graph.4`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  STARDEW_GAME_LIFECYCLE_INITIAL_STATE,
  STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
  STARDEW_GAME_LIFECYCLE_STATES,
  STARDEW_GAME_LIFECYCLE_TARGETS,
  STARDEW_GAME_LIFECYCLE_TRANSITIONS,
  STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS,
} from "./stardew-game-lifecycle-state.internal.js";
import { composeCoordinatorRoleLifecycleView } from "./stardew-role-lifecycle-projection.internal.js";
import { createGameBrowserStateProvider } from "./game-browser/game-browser-state-provider.js";
import { composeGameProfile } from "./game-browser-contract/index.js";
import type { StardewRoleLifecycleView } from "./stardew-role-lifecycle-facade.js";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The commit whose tree the coordinator's lifecycle was four readings rather than one. */
const PRE_UNIFICATION_COMMIT = "0dce992a";
const COORDINATOR_SOURCE = "host/src/stardew-production-lifecycle-coordinator.internal.ts";

type LifecycleGraph = Readonly<Record<string, readonly string[]>>;

type Target = Readonly<{ state: string; published: string }>;

/**
 * The rule, over any graph, so a planted graph drives the exact comparison the gates run.
 *
 * The trapped-terminal rule is deliberately NOT "out-degree 0". That formulation was tested
 * against `0dce992a` and PASSED on it: the failed state could always reach `closing`, so its
 * out-degree was 1 while the only place it led was the process going away. The property that
 * actually failed for the player is "from here, this lifecycle can never get back to a state
 * where the game is playable again, except by shutting down", so the rule is a reachability
 * one: a state with an incoming edge from which no TARGET state is reachable - the deliberate
 * shutdown is the exit, not a recovery - must declare its egress or declare why it has none.
 */
export function lifecycleGraphFindings(
  input: Readonly<{
    graph: LifecycleGraph;
    initial: string;
    targets: readonly Target[];
    shutdownStates: readonly string[];
    trapped: Readonly<Record<string, string>>;
  }>,
): Readonly<{ findings: readonly string[]; examined: number; transitions: number; reachable: number }> {
  const findings: string[] = [];
  const states = Object.keys(input.graph);
  const transitions = states.reduce((count, state) => count + (input.graph[state] ?? []).length, 0);

  const walk = (from: string): ReadonlySet<string> => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const next of input.graph[state] ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const reachable = walk(input.initial);
  const targetStates = input.targets.map((target) => target.state);

  for (const target of input.targets) {
    if (!states.includes(target.state)) {
      findings.push(
        `unreachable_target_state:${target.state} the product requires ${target.published}, and no state produces it`,
      );
      continue;
    }
    if (!reachable.has(target.state)) {
      findings.push(
        `unreachable_target_state:${target.state} ${target.published} is required, and no path from ` +
          `${input.initial} reaches ${target.state}`,
      );
    }
  }

  const inDegree = new Map<string, number>(states.map((state) => [state, 0]));
  for (const state of states)
    for (const next of input.graph[state] ?? []) inDegree.set(next, (inDegree.get(next) ?? 0) + 1);

  const recovers = (state: string): boolean => {
    const onward = walk(state);
    return targetStates.some((target) => onward.has(target));
  };

  for (const state of states) {
    if ((inDegree.get(state) ?? 0) === 0) continue;
    if (input.shutdownStates.includes(state)) continue;
    if (recovers(state)) continue;
    if (input.trapped[state] !== undefined) continue;
    findings.push(
      `trapped_terminal_state:${state} in-degree ${inDegree.get(state)} and no target state is reachable from it ` +
        `(successors ${JSON.stringify(input.graph[state] ?? [])}): it must declare an egress edge, or declare in ` +
        "STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS why the only exit is process death",
    );
  }

  for (const [state, reason] of Object.entries(input.trapped)) {
    if (!states.includes(state)) {
      findings.push(`trapped_terminal_state:${state} declares a reason but no longer exists as a state`);
      continue;
    }
    if (recovers(state))
      findings.push(
        `trapped_terminal_state:${state} declares a reason ("${reason.slice(0, 40)}...") but can now reach ` +
          `${targetStates.join(", ")}: remove the exemption`,
      );
    if (reason.trim().length === 0) findings.push(`trapped_terminal_state:${state} declares an empty reason`);
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    examined: states.length,
    transitions,
    reachable: reachable.size,
  });
}

const DECLARED = Object.freeze({
  graph: STARDEW_GAME_LIFECYCLE_TRANSITIONS,
  initial: STARDEW_GAME_LIFECYCLE_INITIAL_STATE,
  targets: STARDEW_GAME_LIFECYCLE_TARGETS,
  shutdownStates: STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
  trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
});

test("lifecycle-graph.1: the declared graph reaches every published target", (t) => {
  const reading = lifecycleGraphFindings(DECLARED);
  t.diagnostic(
    `lifecycle-graph.1: states examined ${reading.examined} · transitions ${reading.transitions} · ` +
      `reachable ${reading.reachable} · targets ${STARDEW_GAME_LIFECYCLE_TARGETS.map((target) => `${target.state}=>${target.published}`).join(", ")}`,
  );
  // Fail on zero: an empty graph agrees with itself.
  assert.ok(reading.examined > 0, "the declared graph has states to examine");
  assert.ok(reading.transitions > 0, "the declared graph has transitions to follow");
  assert.ok(reading.reachable > 1, "more than the initial state is reachable, so the BFS really walked the graph");
  assert.deepEqual(reading.findings, []);
});

test("lifecycle-graph.2: no state is a trap except the deliberate shutdown and the declared ones", (t) => {
  const reading = lifecycleGraphFindings(DECLARED);
  t.diagnostic(
    `lifecycle-graph.2: states examined ${reading.examined} · transitions ${reading.transitions} · ` +
      `reachable ${reading.reachable} · declared traps ${Object.keys(STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS).join(", ") || "(none)"}`,
  );
  assert.deepEqual(reading.findings, []);
  // The declaration and the union cannot drift: `STARDEW_GAME_LIFECYCLE_STATES` is derived from
  // the same table this rule walked, so a state added to the union is examined by both gates.
  assert.deepEqual([...STARDEW_GAME_LIFECYCLE_STATES].sort(), Object.keys(STARDEW_GAME_LIFECYCLE_TRANSITIONS).sort());
});

/**
 * The falsifier. `0dce992a`'s lifecycle, expressed as the graph it really was: the launch
 * failure was a boolean latch, so the only state a failed launch reached had no successor,
 * and no state published `running` because the attested state did not exist.
 */
test("lifecycle-graph.3 (falsifier): the pre-unification shape is reported by name", (t) => {
  const planted = lifecycleGraphFindings(
    Object.freeze({
      graph: Object.freeze({
        inactive: Object.freeze(["reserving", "closing"]),
        reserving: Object.freeze(["staging", "failed", "closing"]),
        staging: Object.freeze(["staged", "failed", "closing"]),
        staged: Object.freeze(["launching_player_host", "closing"]),
        launching_player_host: Object.freeze(["awaiting_player_host_attestation", "staged", "failed", "closing"]),
        awaiting_player_host_attestation: Object.freeze(["failed", "closing"]),
        // `launchTerminal` was set from the two sites above and cleared by none: no edge leaves.
        failed: Object.freeze([]),
        closing: Object.freeze(["closed"]),
        closed: Object.freeze([]),
      }),
      initial: "inactive",
      targets: STARDEW_GAME_LIFECYCLE_TARGETS,
      shutdownStates: Object.freeze(["closing", "closed"]),
      // Nothing is declared: a latch is not a declared property with a reason.
      trapped: Object.freeze({}),
    }),
  );
  t.diagnostic(`lifecycle-graph.3: planted -> ${planted.findings.join(" | ")}`);
  assert.match(planted.findings[0]!, /^unreachable_target_state:player_host_attested /u);
  // The failed state's only exit was `closing`, which is why the out-degree-0 formulation of
  // this rule passed on that very commit. The reachability formulation catches it - and in
  // that tree it catches every state, because no state at all could reach a playable one.
  const trapped = planted.findings.filter((finding) => finding.startsWith("trapped_terminal_state:"));
  assert.ok(
    trapped.some((finding) => finding.startsWith("trapped_terminal_state:failed ")),
    "the latch is named",
  );
  assert.ok(
    trapped.some((finding) => finding.startsWith("trapped_terminal_state:awaiting_player_host_attestation ")),
    "and the state it overrode is named too",
  );
  assert.equal(
    trapped.length,
    6,
    `every non-shutdown state of that tree was a dead end, saw ${JSON.stringify(trapped)}`,
  );

  // The real graph in the same rule passes: the comparison is not simply always-red.
  assert.deepEqual(
    lifecycleGraphFindings(DECLARED).findings.filter((finding) => finding.includes("failed")),
    [],
  );
});

/**
 * The red proof on real history, and the acceptance count the unit was asked for.
 *
 * `lifecycle-graph.3` proves the RULE fires. This proves the tree the rule was written
 * against really had that shape, by reading the commit rather than restating it.
 */
test("lifecycle-graph.4: 0dce992a held the latch this graph replaced, and the tree now has one owner", (t) => {
  const readAtCommit = (path: string): string =>
    execFileSync("git", ["show", `${PRE_UNIFICATION_COMMIT}:${path}`], { cwd: REPOSITORY_ROOT, encoding: "utf8" });

  const before = readAtCommit(COORDINATOR_SOURCE);
  const latchedTrue = before.split("launchTerminal = true").length - 1;
  // The only `= false` in that file is the `let` initializer. Counting it would be wrong in the
  // other direction (it would suggest the latch could be cleared), so the declaration is removed
  // before counting: what remains is every REASSIGNMENT, and there are none.
  const reassignments = before
    .split("\n")
    .filter((line) => line.includes("launchTerminal") && !line.includes("let launchTerminal"))
    .join("\n");
  const latchedFalse = reassignments.split("launchTerminal = false").length - 1;
  assert.equal(latchedTrue, 2, "the commit set the latch from two sites");
  assert.equal(latchedFalse, 0, "and cleared it from none: that is the trap, read from the commit itself");
  assert.equal(before.split("let launchTerminal = false;").length - 1, 1, "the one assignment was its declaration");
  assert.equal(
    before.includes("player_host_attested"),
    false,
    "the attested state did not exist there, so `instance.status: running` was unproducible",
  );

  // The same two counts on this tree: one owner of the lifecycle state, and no latch left.
  const now = readFileSync(join(REPOSITORY_ROOT, COORDINATOR_SOURCE), "utf8");
  const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;
  assert.equal(count(now, /launchTerminal/gu), 0, "no latch survives in the coordinator");
  assert.equal(
    count(now, /activationState/gu),
    0,
    "the activation state string that a second reading stood beside is gone too",
  );
  assert.equal(count(now, /\blifecycleState\b/gu) > 0, true, "and the one state is the only lifecycle field left");
  t.diagnostic(`lifecycle-graph.4: 0dce992a launchTerminal=true x${latchedTrue}, =false x${latchedFalse}; now x0`);
});

/**
 * The projection is a VIEW of the one state: every declared state publishes exactly one
 * `instance.status` word through the real `game.state.read`, and `running` is produced by the
 * attested state alone.
 *
 * This is what makes `projectInstanceStatus` "read that one state": it cannot answer a word for
 * a state the graph does not declare, and it cannot answer `running` for anything but the
 * attested one.
 */
test("lifecycle-graph.5: every declared state publishes exactly one instance word, and only the attested one is running", async (t) => {
  const CONTEXT = Object.freeze({ csrfToken: "QWxhZGRpbjpvcGVuIHNlc2FtZQ", browserSessionExpiresAtMs: 100_000 });
  const profile = composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: ["game.state.read"],
    navigationItemIds: ["game"],
  });
  const facadeView: StardewRoleLifecycleView = Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({ state: "not_started", ownership: "none" }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  });
  const published: string[] = [];
  const runningFor: string[] = [];
  for (const state of STARDEW_GAME_LIFECYCLE_STATES) {
    const view = composeCoordinatorRoleLifecycleView(state, facadeView, false);
    const gameState = await createGameBrowserStateProvider(
      profile,
      Object.freeze({ readRoleLifecycleView: async () => view }),
      Object.freeze({
        readAttachmentView: () =>
          Object.freeze({ status: "none" as const, generation: 0, connectionStatus: "none" as const }),
      }),
      Object.freeze({
        readLaunchReadinessView: () =>
          Object.freeze(
            state === "launch_quarantined"
              ? { generation: 0, status: "failed" as const, playerHostExitCode: null }
              : state === "staged"
                ? { generation: 1, status: "ready" as const, playerHostExitCode: null }
                : { generation: 0, status: "none" as const, playerHostExitCode: null },
          ),
      }),
    ).readState(CONTEXT);
    const word = `${state}=>${gameState.game.instance.status}`;
    published.push(word);
    if (gameState.game.instance.status === "running") runningFor.push(state);
  }
  t.diagnostic(`lifecycle-graph.5: ${published.join(", ")}`);
  assert.equal(published.length, STARDEW_GAME_LIFECYCLE_STATES.length);
  assert.deepEqual(runningFor, ["player_host_attested"], "`running` is the attested state's word and no other state's");
});
