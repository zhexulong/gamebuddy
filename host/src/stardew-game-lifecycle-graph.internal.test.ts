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
 *
 * `lifecycle-graph.6` and `lifecycle-graph.8` are the two gates over the COORDINATOR rather than
 * over the table: the first reads every `transition("...")` call site out of the source, the second
 * every site that treats the launched Player Host as up. Both have their population read from the
 * code, so a site added tomorrow is examined without anyone remembering this file.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  STARDEW_GAME_LIFECYCLE_INITIAL_STATE,
  STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
  STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS,
  STARDEW_GAME_LIFECYCLE_STATES,
  STARDEW_GAME_LIFECYCLE_TARGETS,
  STARDEW_GAME_LIFECYCLE_TRANSITIONS,
  STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS,
  isGameLifecyclePlayerHostUp,
} from "./games/stardew/lifecycle/stardew-game-lifecycle-state.internal.js";
import { composeCoordinatorRoleLifecycleView } from "./games/stardew/lifecycle/stardew-role-lifecycle-projection.internal.js";
import { createGameBrowserStateProvider } from "./game-browser/game-browser-state-provider.js";
import { composeGameProfile } from "./game-browser-contract/index.js";
import type { StardewRoleLifecycleView } from "./stardew-role-lifecycle-facade.js";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The commit whose tree the coordinator's lifecycle was four readings rather than one. */
const PRE_UNIFICATION_COMMIT = "0dce992a";
const COORDINATOR_SOURCE = "host/src/stardew-production-lifecycle-coordinator.internal.ts";

type LifecycleGraph = Readonly<Record<string, readonly string[]>>;

type Target = Readonly<{ state: string; published: string }>;

/** One `transition("...")` call site in the coordinator, with the declaration it sits in. */
type TransitionSite = Readonly<{ site: string; target: string; line: number; inErrorPath: boolean }>;

/** Every state reachable from `from` by the graph's own edges. */
function reachableStates(graph: LifecycleGraph, from: string): ReadonlySet<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const state = queue.shift()!;
    for (const next of graph[state] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

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

  const reachable = reachableStates(input.graph, input.initial);
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
    const onward = reachableStates(input.graph, state);
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

/**
 * Every `transition("...")` call site in the coordinator, with the `const` declaration it sits in
 * and whether it sits inside an error path.
 *
 * The population of this gate is the code, not a list beside it: a call site added tomorrow is
 * examined without anyone remembering this file, and the declaration name is what the site table is
 * looked up by.
 */
export function readTransitionSites(source: string): readonly TransitionSite[] {
  const sites: TransitionSite[] = [];
  const errorPaths = catchBlockLineRanges(source);
  const lines = source.split("\n");
  let site = "(module)";
  for (let index = 0; index < lines.length; index += 1) {
    const enclosing = /^ {2}const (\w+) =/u.exec(lines[index]!);
    // The transition function's own declaration is not a site: a call inside it would be the
    // refusal path, not an edge the topology takes.
    if (enclosing !== null && enclosing[1] !== "transition") site = enclosing[1]!;
    const line = index + 1;
    const inErrorPath = errorPaths.some((range) => line >= range.from && line <= range.to);
    for (const match of lines[index]!.matchAll(/\btransition\("(\w+)"\)/gu)) {
      sites.push(Object.freeze({ site, target: match[1]!, line, inErrorPath }));
    }
  }
  return Object.freeze(sites);
}

/**
 * The line ranges of a source's `catch` blocks, found by brace matching from the keyword.
 *
 * Only a line that BEGINS with `catch` (or `} catch`) opens one: the coordinator's own prose says
 * "the launch's catch then sees the SAME error", and a scan that took that sentence for code would
 * report the transitions below it as error-path sites that nothing declared.
 */
function catchBlockLineRanges(source: string): readonly Readonly<{ from: number; to: number }>[] {
  const lines = source.split("\n");
  const ranges: Array<Readonly<{ from: number; to: number }>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:\}\s*)?catch\b/u.test(lines[index]!.trim())) continue;
    // The `}` that closes the guarded block, when the keyword shares its line, is not this
    // block's own brace.
    const opening = lines[index]!.indexOf("catch");
    let depth = 0;
    let opened = false;
    let end = index;
    for (; end < lines.length; end += 1) {
      const body = end === index ? lines[end]!.slice(opening) : lines[end]!;
      for (const character of body) {
        if (character === "{") {
          depth += 1;
          opened = true;
        } else if (character === "}") depth -= 1;
      }
      if (opened && depth <= 0) break;
    }
    ranges.push(Object.freeze({ from: index + 1, to: Math.min(end + 1, lines.length) }));
  }
  return Object.freeze(ranges);
}

/**
 * The gate over "every state a transition site can run in is declared".
 *
 *   a_transition_target_no_state_declares:<to>               the code transitions into a state no
 *                                                            declared edge arrives at, so the graph
 *                                                            cannot describe a state the lifecycle
 *                                                            really enters.
 *   a_transition_site_without_declared_states:<site>-><to>    a site whose from-states the code's
 *                                                            own flow does not state - it sits in
 *                                                            an error path, or it returns to the
 *                                                            initial state - is attributed by
 *                                                            nothing, so nothing was checked.
 *   a_state_the_topology_transitions_from_is_not_declared:<from>-><to>
 *                                                            a site can run in <from> and no edge
 *                                                            declares that transition.
 *   a_transition_site_no_longer_transitions:<site>-><to>      the table attributes a site that no
 *                                                            longer performs that transition: the
 *                                                            entry has expired.
 */
export function lifecycleSiteTransitionFindings(
  input: Readonly<{
    graph: LifecycleGraph;
    sites: readonly TransitionSite[];
    siteTransitions: readonly Readonly<{ site: string; target: string; from: readonly string[] }>[];
    trapped: Readonly<Record<string, string>>;
  }>,
): Readonly<{ findings: readonly string[]; edges: number; transitions: number; errorPaths: number }> {
  const findings: string[] = [];
  const states = Object.keys(input.graph);
  const edges = states.reduce((count, state) => count + (input.graph[state] ?? []).length, 0);
  const declared = (from: string, to: string): boolean => (input.graph[from] ?? []).includes(to);
  const arrivesAt = (to: string): boolean => states.some((state) => declared(state, to));

  for (const site of input.sites) {
    if (arrivesAt(site.target)) continue;
    findings.push(
      `a_transition_target_no_state_declares:${site.target} ${site.site} (line ${site.line}) transitions into it, ` +
        "and no declared state has an edge to it",
    );
  }

  const attribution = (
    site: TransitionSite,
  ): Readonly<{ site: string; target: string; from: readonly string[] }> | undefined =>
    input.siteTransitions.find((entry) => entry.site === site.site && entry.target === site.target);

  for (const site of input.sites) {
    // A linear site states its own from-state on the line above it. These shapes do not: an error
    // path runs at whatever state the guarded body reached, a return to the initial state is a
    // hand-back the flow above it does not describe, and the transition into a state with no egress
    // lives in a helper whose callers are the ones that know where they were.
    const why =
      site.target === STARDEW_GAME_LIFECYCLE_INITIAL_STATE
        ? `returns to ${STARDEW_GAME_LIFECYCLE_INITIAL_STATE}`
        : input.trapped[site.target] === undefined
          ? undefined
          : `enters ${site.target}, which has no egress`;
    const needsAttribution = site.inErrorPath || why !== undefined;
    if (!needsAttribution) continue;
    const entry = attribution(site);
    if (entry === undefined) {
      findings.push(
        `a_transition_site_without_declared_states:${site.site}->${site.target} (line ${site.line}) ` +
          (site.inErrorPath ? "sits in an error path" : why!) +
          ", so the states it can run in are not on the line: declare them in " +
          "STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS",
      );
      continue;
    }
    if (entry.from.length === 0)
      findings.push(
        `a_transition_site_without_declared_states:${site.site}->${site.target} (line ${site.line}) states none of the ` +
          "states it can run in",
      );
    for (const from of entry.from) {
      if (declared(from, site.target)) continue;
      findings.push(
        `a_state_the_topology_transitions_from_is_not_declared:${from}->${site.target} ${site.site} (line ${site.line}) ` +
          `runs in ${from}, so ${site.target} has to be declared from it`,
      );
    }
  }

  for (const entry of input.siteTransitions) {
    if (input.sites.some((site) => site.site === entry.site && site.target === entry.target)) continue;
    findings.push(
      `a_transition_site_no_longer_transitions:${entry.site}->${entry.target} is attributed from-states but no ` +
        "longer performs that transition",
    );
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    edges,
    transitions: input.sites.length,
    errorPaths: input.sites.filter((site) => site.inErrorPath).length,
  });
}

/**
 * The gate over "every reachable state has a declared exit".
 *
 * An EXIT here is an edge into the running lifecycle: `closing`/`closed` are the deliberate
 * shutdown, which is where a quit goes rather than a way out of a state. A reachable state with
 * no such edge is a state the topology can enter and never leave, and it must either declare one
 * or be named in `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS` with the fact that would have to
 * change - by name, never by silence.
 *
 *   a_reachable_state_has_no_declared_exit:<state>    entered, and only the shutdown leaves it.
 *   a_declared_trap_has_an_exit:<state>              an exemption whose state has since gained the
 *                                                    egress it was excused from.
 *   a_declared_transition_is_unreachable:<state>     every edge of this state is a claim no path
 *                                                    from the initial state can take.
 */
export function lifecycleDeclaredExitFindings(
  input: Readonly<{
    graph: LifecycleGraph;
    initial: string;
    shutdownStates: readonly string[];
    trapped: Readonly<Record<string, string>>;
  }>,
): Readonly<{ findings: readonly string[]; states: number; reachable: number; noExit: readonly string[] }> {
  const findings: string[] = [];
  const states = Object.keys(input.graph);
  const reachable = reachableStates(input.graph, input.initial);
  const noExit: string[] = [];
  const liveExit = (state: string): readonly string[] =>
    (input.graph[state] ?? []).filter((next) => !input.shutdownStates.includes(next));

  for (const state of [...reachable].sort()) {
    if (input.shutdownStates.includes(state)) continue;
    if (liveExit(state).length > 0) {
      if (input.trapped[state] !== undefined)
        findings.push(
          `a_declared_trap_has_an_exit:${state} is declared as having no egress and now reaches ` +
            `${liveExit(state).join(", ")}: remove the exemption`,
        );
      continue;
    }
    noExit.push(state);
    if (input.trapped[state] !== undefined) continue;
    findings.push(
      `a_reachable_state_has_no_declared_exit:${state} is reachable and its only successors are ` +
        `${JSON.stringify(input.graph[state] ?? [])}: declare an edge into the running lifecycle, or declare in ` +
        "STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS why the only exit is process death",
    );
  }
  for (const [state, reason] of Object.entries(input.trapped)) {
    if (!states.includes(state))
      findings.push(`a_declared_trap_has_an_exit:${state} declares a reason but is no longer a state`);
    else if (!reachable.has(state))
      findings.push(`a_declared_trap_has_an_exit:${state} declares a reason but is unreachable`);
    else if (reason.trim().length === 0) findings.push(`a_declared_trap_has_an_exit:${state} declares an empty reason`);
  }
  for (const state of states) {
    if (reachable.has(state) || (input.graph[state] ?? []).length === 0) continue;
    findings.push(
      `a_declared_transition_is_unreachable:${state} declares ${JSON.stringify(input.graph[state] ?? [])} and no path ` +
        `from ${input.initial} reaches it`,
    );
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    states: states.length,
    reachable: reachable.size,
    noExit: Object.freeze(noExit),
  });
}

/** The declared graph with the hand-back edges removed: the shape this unit found. */
export function withoutReturnEdges(graph: LifecycleGraph): LifecycleGraph {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(graph).map(([state, successors]) => [
        state,
        Object.freeze(
          successors.filter(
            (next) =>
              !(next === STARDEW_GAME_LIFECYCLE_INITIAL_STATE && state !== STARDEW_GAME_LIFECYCLE_INITIAL_STATE),
          ),
        ),
      ]),
    ),
  );
}

/** The declared graph with ONE edge removed, so a falsifier can name the state that loses it. */
export function withoutEdge(graph: LifecycleGraph, from: string, to: string): LifecycleGraph {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(graph).map(([state, successors]) => [
        state,
        Object.freeze(state === from ? successors.filter((next) => next !== to) : [...successors]),
      ]),
    ),
  );
}

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
        readAttachmentCabinView: () => null,
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

/**
 * The gate for "settle an ended attempt and be ready for the next one", and for every error path
 * that has a state to leave behind.
 *
 * The topology this protects is real functionality: an attempt that ended is handed back, and the
 * next press prepares a new one while the settled attempt stays closed. What it needs from the graph
 * is the edge that says so. A graph in which `player_host_attested` can only reach `closing` cannot
 * express "settled", so the code's own hand-back is refused at runtime by name - which is exactly
 * what this unit found: `stardew_lifecycle_transition_undeclared:player_host_attested->inactive`.
 *
 * Its first version read only the sites that RETURN to the initial state, and that population was
 * the defect it could not see: `runActivation`'s catch answers a failure from `staged`, and nothing
 * required that edge to exist. So the population is now every `transition(...)` site whose
 * from-states the flow does not state - a catch block, or a hand-back - and each one is attributed
 * in `STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS` before its edges are checked.
 */
/** The coordinator's own source: the population of both coordinator gates. */
function readCoordinatorSource(): string {
  return readFileSync(join(REPOSITORY_ROOT, COORDINATOR_SOURCE), "utf8");
}

test("lifecycle-graph.6: every state a transition site can run in is declared from where it runs", (t) => {
  const sites = readTransitionSites(readCoordinatorSource());
  const reading = lifecycleSiteTransitionFindings({
    graph: STARDEW_GAME_LIFECYCLE_TRANSITIONS,
    sites,
    siteTransitions: STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS,
    trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
  });
  t.diagnostic(
    `lifecycle-graph.6: edges examined ${reading.edges} · transition sites ${reading.transitions} · ` +
      `in an error path ${reading.errorPaths} · undeclared ${reading.findings.length}`,
  );
  // Fail on zero: a scan that found no transition site was never looking at the coordinator, and a
  // scan that found no error path is not the population this gate was widened for.
  assert.ok(reading.edges > 0, "the declared graph has edges to examine");
  assert.ok(reading.transitions > 0, "the coordinator has transition call sites to read");
  assert.ok(reading.errorPaths > 0, "and some of them answer a failure from inside a catch block");
  assert.ok(
    sites.some((site) => site.target === STARDEW_GAME_LIFECYCLE_INITIAL_STATE),
    "and at least one of them returns to the initial state, which is the shape this gate exists for",
  );
  assert.deepEqual(reading.findings, []);

  // The falsifier, on the graph as it was before the hand-back was declared: the edges are removed
  // from the DECLARED graph rather than restated, so this cannot drift from what the graph says.
  const before = lifecycleSiteTransitionFindings({
    graph: withoutReturnEdges(STARDEW_GAME_LIFECYCLE_TRANSITIONS),
    sites,
    siteTransitions: STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS,
    trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
  });
  t.diagnostic(`lifecycle-graph.6 (falsifier: hand-back): ${before.findings.join(" | ")}`);
  assert.ok(
    before.findings.some((finding) =>
      finding.startsWith("a_state_the_topology_transitions_from_is_not_declared:player_host_attested->inactive "),
    ),
    `the settled-and-ready hand-back is named, saw ${JSON.stringify(before.findings)}`,
  );
  assert.ok(
    before.findings.some((finding) => finding.includes(" settleEndedAttempt (line ")),
    "and the call site that performs it is named too",
  );

  // The second falsifier, on the edge an error path needs: removed from the declared graph, so the
  // finding has to come from the table's claim about `runActivation` rather than from a restatement.
  const withoutFailureEdge = lifecycleSiteTransitionFindings({
    graph: withoutEdge(STARDEW_GAME_LIFECYCLE_TRANSITIONS, "staged", "activation_failed"),
    sites,
    siteTransitions: STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS,
    trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
  });
  t.diagnostic(`lifecycle-graph.6 (falsifier: error path): ${withoutFailureEdge.findings.join(" | ")}`);
  assert.ok(
    withoutFailureEdge.findings.some((finding) =>
      finding.startsWith("a_state_the_topology_transitions_from_is_not_declared:staged->activation_failed "),
    ),
    `the failure an activation can meet after staging is named, saw ${JSON.stringify(withoutFailureEdge.findings)}`,
  );
  assert.ok(
    withoutFailureEdge.findings.some((finding) => finding.includes(" runActivation (line ")),
    "and the catch block that takes it is named too",
  );

  // The third falsifier, on the quarantine: a terminal reached from a HELPER, removed from the
  // declared graph. This is the member that hid behind a catch for a whole merge - the create's
  // re-attestation threw the undeclared-transition refusal and its own failure path ate it.
  const withoutQuarantineEdge = lifecycleSiteTransitionFindings({
    graph: withoutEdge(STARDEW_GAME_LIFECYCLE_TRANSITIONS, "player_host_attested", "launch_quarantined"),
    sites,
    siteTransitions: STARDEW_GAME_LIFECYCLE_SITE_TRANSITIONS,
    trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
  });
  t.diagnostic(`lifecycle-graph.6 (falsifier: quarantine helper): ${withoutQuarantineEdge.findings.join(" | ")}`);
  assert.ok(
    withoutQuarantineEdge.findings.some((finding) =>
      finding.startsWith(
        "a_state_the_topology_transitions_from_is_not_declared:player_host_attested->launch_quarantined ",
      ),
    ),
    `the quarantine an attested owner can still reach is named, saw ${JSON.stringify(withoutQuarantineEdge.findings)}`,
  );
  assert.ok(
    withoutQuarantineEdge.findings.some((finding) => finding.includes(" failPlayerHostAttempt (line ")),
    "and the helper that takes it is named, not only the state pair",
  );
});

/**
 * The other half of the same invariant: a reachable state that only the shutdown leaves is a state
 * the player cannot come back from, and it must either declare an exit into the running lifecycle or
 * be declared by name in `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`.
 *
 * On the graph this unit found, `player_host_attested` had `closing` alone - the attested state, the
 * one that publishes `running`, and no way back to a lifecycle that can run again. It has a second
 * live exit now (the quarantine an unattestable owner reaches), so the falsifier below no longer
 * names it: the state it names is `activation_failed`, whose only live exit really is the hand-back
 * this edge set exists for. `failed`'s "deliberately no exit" comment is the other kind of fact, and
 * this gate honours it as a decision: it passes because the state is named there, and fails the
 * moment the naming goes stale.
 */
test("lifecycle-graph.7: every reachable state has a declared exit into the running lifecycle", (t) => {
  const reading = lifecycleDeclaredExitFindings({
    graph: STARDEW_GAME_LIFECYCLE_TRANSITIONS,
    initial: STARDEW_GAME_LIFECYCLE_INITIAL_STATE,
    shutdownStates: STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
    trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
  });
  t.diagnostic(
    `lifecycle-graph.7: states examined ${reading.states} · reachable ${reading.reachable} · ` +
      `no exit into the running lifecycle ${reading.noExit.join(", ") || "(none)"} · ` +
      `declared by name ${Object.keys(STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS).join(", ") || "(none)"}`,
  );
  assert.ok(reading.states > 0 && reading.reachable > 1, "the walk examined a graph that is not empty");
  assert.deepEqual(reading.findings, []);

  // The falsifier, on the graph as it was before the hand-back was declared.
  const before = lifecycleDeclaredExitFindings({
    graph: withoutReturnEdges(STARDEW_GAME_LIFECYCLE_TRANSITIONS),
    initial: STARDEW_GAME_LIFECYCLE_INITIAL_STATE,
    shutdownStates: STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
    trapped: STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS as Readonly<Record<string, string>>,
  });
  t.diagnostic(`lifecycle-graph.7 (falsifier): ${before.findings.join(" | ")}`);
  assert.ok(
    before.findings.some((finding) => finding.startsWith("a_reachable_state_has_no_declared_exit:activation_failed ")),
    `the state the hand-back is the only way out of is named, saw ${JSON.stringify(before.findings)}`,
  );
  // And it is still a real removal, not a narrower graph: the same falsifier leaves the quarantine
  // excused by its declaration and by nothing else.
  assert.deepEqual(before.noExit, ["activation_failed", "launch_quarantined"]);

  // And an undeclared dead end is refused too - the planted shape is one state with no successor.
  const planted = lifecycleDeclaredExitFindings({
    graph: Object.freeze({ inactive: Object.freeze(["reserving"]), reserving: Object.freeze([]) }),
    initial: "inactive",
    shutdownStates: STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
    trapped: Object.freeze({}),
  });
  assert.deepEqual(
    planted.findings.map((finding) => finding.split(" ")[0]),
    ["a_reachable_state_has_no_declared_exit:reserving"],
    "a reachable state with no successor and no declaration is refused by name",
  );
});

/**
 * Every non-test TypeScript source the Host ships, so the population of the gate below is the code
 * rather than the files somebody remembered to list.
 */
function readHostSourceFiles(): readonly Readonly<{ path: string; source: string }>[] {
  const root = join(REPOSITORY_ROOT, "host", "src");
  const files: Array<Readonly<{ path: string; source: string }>> = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
    const path = join(entry.parentPath, entry.name);
    files.push(
      Object.freeze({
        path: path.slice(REPOSITORY_ROOT.length + 1).replaceAll("\\", "/"),
        source: readFileSync(path, "utf8"),
      }),
    );
  }
  return Object.freeze(files);
}

/** One site that treats the launched Player Host as up, and whether its declaration answers an exit. */
type PlayerHostUpRead = Readonly<{ file: string; site: string; line: number; answersExit: boolean }>;

/**
 * Every site that asks whether the Player Host is up, with the `const` declaration it sits in and
 * whether that declaration answers the recorded exit.
 *
 * The declaration is the unit, not the line: the exit is answered BEFORE the read it guards
 * (`if (recordPlayerHostExit() !== null) throw ...`), so a line-local rule would see only the
 * second half of the guard. The predicate's own declaration is skipped - it is the authority that
 * answers the question, not a site that asks it.
 */
export function readPlayerHostUpReads(source: string, file: string): readonly PlayerHostUpRead[] {
  const lines = source.split("\n");
  const declarations: Array<{ site: string; from: number; to: number }> = [];
  for (const [index, line] of lines.entries()) {
    const enclosing = /^ {2}const (\w+) =/u.exec(line);
    if (enclosing === null) continue;
    const previous = declarations.at(-1);
    if (previous !== undefined) previous.to = index;
    declarations.push({ site: enclosing[1]!, from: index, to: lines.length });
  }
  const reads: PlayerHostUpRead[] = [];
  for (const [index, line] of lines.entries()) {
    if (!/\bisGameLifecyclePlayerHostUp\s*\(/u.test(line)) continue;
    if (/\bfunction\s+isGameLifecyclePlayerHostUp\b/u.test(line)) continue;
    const declaration = declarations.find((candidate) => index >= candidate.from && index < candidate.to);
    const body = declaration === undefined ? line : lines.slice(declaration.from, declaration.to).join("\n");
    reads.push(
      Object.freeze({
        file,
        site: declaration?.site ?? "(module)",
        line: index + 1,
        answersExit: /\brecordPlayerHostExit\s*\(/u.test(body),
      }),
    );
  }
  return Object.freeze(reads);
}

/**
 * The gate over "a state that advertises `running` never coexists with a fact that says the Player
 * Host has exited".
 *
 * The two halves are one property. The read half: a site that treats the Player Host as up asks the
 * world a question, and the lifecycle state cannot answer it once the Guardian has reported that
 * process ended - so the exit has to be answered first, by name. The vocabulary half: every state
 * that publishes `running` has to be a state those reads treat as up, or the product advertises a
 * game no reader can reach.
 *
 *   a_player_host_up_read_without_the_exit_answer:<file>:<line> <site>
 *       a read of the up-state that does not answer the recorded exit.
 *   a_running_state_is_not_a_player_host_up_state:<state>
 *       a state publishing `running` that no reader treats as a Player Host to ask.
 */
export function playerHostExitAnswerFindings(
  input: Readonly<{
    targets: readonly Target[];
    upStates: readonly string[];
    reads: readonly PlayerHostUpRead[];
  }>,
): Readonly<{ findings: readonly string[]; runningStates: number; upReads: number; answering: number }> {
  const findings: string[] = [];
  for (const target of input.targets) {
    if (input.upStates.includes(target.state)) continue;
    findings.push(
      `a_running_state_is_not_a_player_host_up_state:${target.state} advertises ${target.published}, and no reader ` +
        "treats that state as a Player Host to ask",
    );
  }
  for (const read of input.reads) {
    if (read.answersExit) continue;
    findings.push(
      `a_player_host_up_read_without_the_exit_answer:${read.file}:${read.line} ${read.site} treats the Player Host as up, ` +
        "and the state that advertises `running` coexists with a reported exit until the read answers " +
        "recordPlayerHostExit() first",
    );
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    runningStates: input.targets.length,
    upReads: input.reads.length,
    answering: input.reads.filter((read) => read.answersExit).length,
  });
}

/**
 * The one line that answers a reported exit ahead of a read, as the coordinator writes it. The
 * falsifier below removes exactly this from the real source, and asserts the removal changed
 * something: if the guard is reworded, the falsifier fails on that rather than passing silently.
 */
const EXIT_ANSWER_REMOVAL =
  /if \(recordPlayerHostExit\(\) !== null\) throw new Error\(PLAYER_HOST_EXITED_REFUSAL\);\n/u;

/**
 * The gate: a state that advertises `running` must not coexist with a fact that says the host has
 * exited.
 *
 * What it replaces: the cabin read asked `isGameLifecyclePlayerHostUp(state)` and nothing else, so
 * after the Guardian reported the game process ended the lifecycle stayed `player_host_attested` -
 * the state that advertises `running` - and the read went to a process that was gone. The browser
 * answered `state_unavailable`, which is "this Host does not know", for a game the Host had been
 * told had ended. `main` carried the exit answer at that one read and the merge lost it; the gate is
 * what makes the loss impossible to repeat at this site or any other.
 */
test("lifecycle-graph.8: no reader treats the Player Host as up without answering a reported exit", (t) => {
  const upStates = STARDEW_GAME_LIFECYCLE_STATES.filter((state) => isGameLifecyclePlayerHostUp(state));
  const reads = readHostSourceFiles().flatMap((file) => readPlayerHostUpReads(file.source, file.path));
  const reading = playerHostExitAnswerFindings({ targets: STARDEW_GAME_LIFECYCLE_TARGETS, upStates, reads });
  t.diagnostic(
    `lifecycle-graph.8: advertising \`running\` ${STARDEW_GAME_LIFECYCLE_TARGETS.map((target) => target.state).join(", ")} · ` +
      `up-states ${upStates.join(", ")} · sites that ask ${reading.upReads} · answering the exit ${reading.answering}`,
  );
  // Fail on zero: an empty population agrees with itself.
  assert.ok(reading.runningStates > 0, "some state advertises `running`, or this gate protects nothing");
  assert.ok(upStates.length > 0, "and the lifecycle has a state a reader can treat as up");
  assert.ok(reading.upReads > 0, "the source has a site that asks whether the Player Host is up");
  assert.deepEqual(reading.findings, []);

  // The falsifier: the real coordinator with the exit answer removed from the declaration that
  // gives it, so the sites it answers for are the ones named.
  const source = readCoordinatorSource();
  const withoutAnswer = source.replace(EXIT_ANSWER_REMOVAL, "");
  assert.notEqual(
    withoutAnswer,
    source,
    "the exit answer this falsifier removes is still written the way it is expected",
  );
  const broken = playerHostExitAnswerFindings({
    targets: STARDEW_GAME_LIFECYCLE_TARGETS,
    upStates,
    reads: readPlayerHostUpReads(withoutAnswer, COORDINATOR_SOURCE),
  });
  t.diagnostic(`lifecycle-graph.8 (falsifier: exit answer removed): ${broken.findings.join(" | ")}`);
  assert.ok(
    broken.findings.some((finding) => finding.startsWith("a_player_host_up_read_without_the_exit_answer:")),
    `the site that no longer answers the exit is named, saw ${JSON.stringify(broken.findings)}`,
  );

  // And the vocabulary half, on a planted target: a state advertising `running` that no reader
  // treats as up is the same coexistence from the other side.
  const planted = playerHostExitAnswerFindings({
    targets: [{ state: "staged", published: "game.instance.status: running" }],
    upStates,
    reads: [],
  });
  assert.deepEqual(
    planted.findings.map((finding) => finding.split(" ")[0]),
    ["a_running_state_is_not_a_player_host_up_state:staged"],
  );
});

/**
 * The coordinator's source with comment text blanked out, every other character and every line
 * break kept where it was.
 *
 * The scans below look for calls, and a call is not a call when it is prose: this file's own
 * comments say things like "close() retains the exact owner" and "the launch's catch then sees the
 * SAME error", and a scan that read those as code would report a swallowed refusal at a comment and
 * an error path that does not exist.
 */
function stripComments(source: string): string {
  const characters = [...source];
  let mode: "code" | "line" | "block" | "string" = "code";
  let quote = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    if (mode === "line") {
      if (character === "\n") mode = "code";
      else characters[index] = " ";
      continue;
    }
    if (mode === "block") {
      if (character === "*" && next === "/") {
        characters[index] = " ";
        characters[index + 1] = " ";
        index += 1;
        mode = "code";
      } else if (character !== "\n") characters[index] = " ";
      continue;
    }
    if (mode === "string") {
      if (character === "\\") index += 1;
      else if (character === quote) mode = "code";
      continue;
    }
    if (character === "/" && next === "/") {
      mode = "line";
      characters[index] = " ";
      continue;
    }
    if (character === "/" && next === "*") {
      mode = "block";
      characters[index] = " ";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      mode = "string";
      quote = character;
    }
  }
  return characters.join("");
}

/** One `const NAME = ...` declaration of the coordinator, as the call graph below is derived from. */
type Declaration = Readonly<{ name: string; body: string; from: number; to: number }>;

function readDeclarations(source: string): readonly Declaration[] {
  const lines = source.split("\n");
  const ranges: Array<{ name: string; from: number; to: number }> = [];
  for (const [index, line] of lines.entries()) {
    const enclosing = /^ {2}const (\w+) =/u.exec(line);
    if (enclosing === null) continue;
    const previous = ranges.at(-1);
    if (previous !== undefined) previous.to = index;
    ranges.push({ name: enclosing[1]!, from: index, to: lines.length });
  }
  return Object.freeze(
    ranges.map((range) =>
      Object.freeze({
        name: range.name,
        from: range.from + 1,
        to: range.to,
        body: lines.slice(range.from, range.to).join("\n"),
      }),
    ),
  );
}

/** The local declarations a body calls: `name(`, never `object.name(` and never `function name(`. */
function calledDeclarations(body: string, known: ReadonlySet<string>): readonly string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/(?<![\w.$])([A-Za-z_]\w*)\s*\(/gu)) if (known.has(match[1]!)) names.add(match[1]!);
  return Object.freeze([...names]);
}

/** The transitions each declaration can cause, its callees' included. */
function refusingTransitions(declarations: readonly Declaration[]): ReadonlyMap<string, ReadonlySet<string>> {
  const known = new Set(declarations.map((declaration) => declaration.name));
  const own = new Map(
    declarations.map((declaration) => [
      declaration.name,
      new Set([...declaration.body.matchAll(/\btransition\("(\w+)"\)/gu)].map((match) => match[1]!)),
    ]),
  );
  const calls = new Map(
    declarations.map((declaration) => [
      declaration.name,
      calledDeclarations(declaration.body, known).filter((name) => name !== "transition"),
    ]),
  );
  const resolved = new Map<string, ReadonlySet<string>>();
  const resolve = (name: string, seen: ReadonlySet<string> = new Set()): ReadonlySet<string> => {
    const memo = resolved.get(name);
    if (memo !== undefined) return memo;
    if (seen.has(name)) return new Set<string>();
    const next = new Set(seen).add(name);
    const transitions = new Set(own.get(name) ?? []);
    for (const called of calls.get(name) ?? [])
      for (const transition of resolve(called, next)) transitions.add(transition);
    resolved.set(name, transitions);
    return transitions;
  };
  for (const declaration of declarations) resolve(declaration.name);
  return resolved;
}

/**
 * The gate over "a catch that can receive a transition refusal does not swallow it".
 *
 * The defect this exists for: `createGameSession` re-attests an attested owner, the attestation
 * threw `stardew_lifecycle_transition_undeclared:player_host_attested->launch_quarantined` because
 * the merged graph did not declare that edge, and the create's own failure path turned it into
 * `{ status: "unavailable" }` - leaving the lifecycle where it was and the surface advertising a
 * game the Host had just failed to attest. A refusal a catch can eat is a diagnostic that names
 * nothing by the time anyone reads it.
 *
 *   an_undeclared_transition_is_swallowed_by_a_catch:<site>:<line>
 *       a catch block calls a declaration whose body (its callees' included) transitions, and the
 *       block does not re-throw. A refusal on a deliberate-shutdown edge is not counted: a close
 *       that could not finish leaves the lifecycle where it was and the close path reports it, so
 *       nothing about the running game is hidden.
 */
export function lifecycleSwallowedRefusalFindings(
  input: Readonly<{ source: string; shutdownStates: readonly string[] }>,
): Readonly<{ findings: readonly string[]; catches: number; canThrow: number; swallowed: number }> {
  const source = stripComments(input.source);
  const lines = source.split("\n");
  const declarations = readDeclarations(source);
  const known = new Set(declarations.map((declaration) => declaration.name));
  const reach = refusingTransitions(declarations);
  const siteOf = (line: number): string =>
    declarations.find((declaration) => line >= declaration.from && line <= declaration.to)?.name ?? "(module)";

  const findings: string[] = [];
  let canThrow = 0;
  let swallowed = 0;
  const catches = catchBlockLineRanges(source);
  for (const block of catches) {
    const body = lines.slice(block.from - 1, block.to).join("\n");
    const rethrows = /\bthrow\b/u.test(body);
    for (const name of calledDeclarations(body, known)) {
      if (name === "transition") continue;
      const reaching = [...(reach.get(name) ?? [])].filter((target) => !input.shutdownStates.includes(target));
      if (reaching.length === 0) continue;
      canThrow += 1;
      if (rethrows) continue;
      swallowed += 1;
      findings.push(
        `an_undeclared_transition_is_swallowed_by_a_catch:${siteOf(block.from)}:${block.from} calls ${name}, which can ` +
          `refuse the transition into ${reaching.join(", ")}, and the catch does not re-throw`,
      );
    }
  }
  return Object.freeze({
    findings: Object.freeze(findings),
    catches: catches.length,
    canThrow,
    swallowed,
  });
}

/**
 * And the guard over the other half of the same property: a refusal a `catch` can receive is only
 * dangerous when nothing names it on the way out.
 *
 * The property is per CALL SITE, not per file, because the shape that hid for a whole merge was a
 * call inside a catch that looked harmless: `failPlayerHostAttempt` quarantines, the catch that
 * called it re-threw, and the swallow happened one frame up. So what this reads is the pair - which
 * catch blocks can receive a refusal at all, and which of them say nothing about it.
 */
test("lifecycle-graph.9: a catch that can receive a transition refusal re-throws it", (t) => {
  const reading = lifecycleSwallowedRefusalFindings({
    source: readCoordinatorSource(),
    shutdownStates: STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
  });
  t.diagnostic(
    `lifecycle-graph.9: catches examined ${reading.catches} · can throw ${reading.canThrow} · swallowed ${reading.swallowed}`,
  );
  // Fail on zero: a scan that found no catch, or none that can receive a refusal, examined nothing.
  assert.ok(reading.catches > 0, "the coordinator has catch blocks to examine");
  assert.ok(reading.canThrow > 0, "and some of them call a declaration that can refuse a transition");
  assert.deepEqual(reading.findings, []);

  // The falsifier on the real source: the attestation's catch is the one that quarantines and then
  // re-throws, so removing that re-throw is a real injected violation at a real site.
  const source = readCoordinatorSource();
  const withoutRethrow = source.replace(
    /throw new Error\("stardew_player_host_attestation_failed", \{ cause: error \}\);\n/u,
    "\n",
  );
  assert.notEqual(
    withoutRethrow,
    source,
    "the re-throw this falsifier removes is still written the way it is expected",
  );
  const broken = lifecycleSwallowedRefusalFindings({
    source: withoutRethrow,
    shutdownStates: STARDEW_GAME_LIFECYCLE_SHUTDOWN_STATES,
  });
  t.diagnostic(`lifecycle-graph.9 (falsifier): ${broken.findings.join(" | ")}`);
  assert.ok(
    broken.findings.some((finding) =>
      finding.startsWith("an_undeclared_transition_is_swallowed_by_a_catch:correlatePlayerHostAttestation:"),
    ),
    `the catch that swallowed the quarantine refusal is named, saw ${JSON.stringify(broken.findings)}`,
  );
});
