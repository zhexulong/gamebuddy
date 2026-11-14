/**
 * THE TEMPLATE in a `run-stardew-native-local-*.mjs` SMOKE RUNNER.
 *
 * WHY THIS FILE EXISTS (measured 2026-11-14). The 126th and 127th smoke runners were written by copying a sibling and
 * swapping the action's own text, so `tools/check-code-duplication.mjs` recorded five clone groups GROWING by one site
 * each when `fcc2c1b7` added `run-stardew-native-local-player-sweep-scythe-smoke.mjs`:
 *
 *   02a75fa47719  40t  19 -> 20 sites   the fixture-config refusal
 *   34af36fc0abf  56t   4 ->  5 sites   the blocked-report snapshot projection
 *   a349cc48b39c  40t   5 ->  6 sites   `pair.indexOf("=")` key=value evidence parsing
 *   b975019b3b1f  68t   3 ->  4 sites   the requestId mint inside `execute`
 *   e7992f0a75cc 207t   3 ->  4 sites   the `import.meta.main` bootstrap with connect-with-retry
 *
 * Those five groups are not the defect, they are the symptom: every runner also spends 150-200 lines on its own try/catch,
 * its own order of steps and its own exit code, which a clone detector cannot see because the words differ. So this file
 * does not export five helpers for a runner to call in its own order - it exports the LIFECYCLE, and a runner supplies a
 * definition of the six things that are actually about its action. A runner that still reads its own config, connects its
 * own client, mints its own request or prints its own result has not adopted it, and
 * `tools/check-native-local-runner-scaffold.mjs` says so by name.
 *
 * THE SIX STEPS THE TEMPLATE OWNS, in the order every copy performed them:
 *
 *   1. the fixture-config refusal           (`validateRunnerConfig`)
 *   2. observe-fresh + required capabilities (`observe`)
 *   3. the requestId mint and the execute    (`submit`)
 *   4. the terminal wait and its identity    (`settle`)
 *   5. the evidence parse and the stale reread (`evidence`, `reread`)
 *   6. the bootstrap, the print and the exit code (`runSmokeScenarioMain`)
 *
 * WHICH OF THE SIX A DEFINITION MAY SKIP. Two, and only by declaration.
 *
 *   1. the fixture-config refusal. Half the copies refused an invalid fixture config themselves and half never read one
 *      at all, and a template that refused on their behalf would change the behaviour of the half that did not - measured
 *      2026-11-14 on `craft_item`, which `run-native-action-slice.test.mjs` drives with `{}` and which blocked
 *      `native_local_craft_item_fixture_config_invalid` where the copy ran. So `refusesConfig` is a REQUIRED boolean and
 *      step 1 runs only when it is `true`. It is not a default: a default is what makes the template tighten for every
 *      future definition without anybody deciding to. `requiredActions` and `experimentalActions` are required exactly
 *      when it is `true`, because that is the only reader they have.
 *
 *   2. the NEGATIVE case after the positive one - a re-send against the post-run observation that the Mod must refuse,
 *      and a re-read that proves the refusal did not move the world. A definition declares either `negative` (the hook)
 *      or `negativeOmittedBecause` (the reason its action has no identity to re-send); declaring neither throws
 *      `native_local_scenario_definition_invalid:negative` at import, and the result publishes which one happened as
 *      `negative: "measured:<code>"` or `negative: "not_declared:<reason>"`.
 *
 * The other four steps cannot be skipped: a definition that omits `prepare`, `request`, `assertPostcondition` or
 * `successCode` fails the same way at import, before a live run can spend 40 seconds finding out.
 *
 * THE DEFINITION, and what each field is for:
 *
 *   action                 the catalog action under test; also the refusal prefix (`native_local_<action>_...`)
 *   fixtureScenario        the one `NativeLocalPlayerFixture.FixtureScenario` this gate arms
 *   refusesConfig          whether the copy this replaced refused an invalid fixture config before its first request
 *   requiredCapabilities   what the observation must advertise before anything is sent
 *   requiredActions        the actions the fixture's derived policy must not deny (only read when `refusesConfig`)
 *   experimentalActions    the actions the fixture may legitimately opt in (only read when `refusesConfig`)
 *   successCode            the terminal `reasonCode` the Mod's own success word is
 *   projection             which snapshot collections the blocked report publishes (`?? []` defaults)
 *   prepare({..})          action-specific work before the request -> `{ snapshot, plan }`
 *   describePlan(plan)     the facts the `planned` trace step records
 *   request(plan, snapshot) -> `{ args }` for the action under test
 *   assertPostcondition({..}) -> the action's own measured fields, spread into the passing result
 *   negative | negativeOmittedBecause   as above
 *
 * Every helper below is the duplicated text it replaces, quoted beside it, so the next reader can check the extraction
 * against the copies rather than against this comment.
 */
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  NativeSmokeHarnessError,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./host-test-module.mjs";

/** The topology every native-local smoke run reports, spelled once. */
export const NATIVE_LOCAL_TOPOLOGY = "native_local_player_fixture";

/** The window every copy of `execute` passed to `executeFresh`, and the harness's published watchdog caps it. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The game creates its named pipe asynchronously after launch, so a first connect legitimately fails with ENOENT. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * `pair.indexOf("=")` evidence parsing, verbatim from the six copies that spell it
 * (`a349cc48b39c`; e.g. `run-stardew-native-local-player-enter-exit-warp-action-smoke.mjs:220`):
 *
 *     function parseEvidence(evidence) {
 *       const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
 *       if (detail.length === 0) throw new Error("native_local_evidence_empty");
 *       return Object.fromEntries(
 *         detail
 *           .split(";")
 *           .map((pair) => {
 *             const index = pair.indexOf("=");
 *             return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
 *           })
 *           .filter(Boolean),
 *       );
 *     }
 *
 * `index > 0` is the rule that matters and is kept as it was: a leading `=` produces a pair with no name, which is a
 * malformed detail rather than a field called "".
 */
export function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

/**
 * The blocked report's snapshot projection, from the copies that spell it by hand (`34af36fc0abf`; e.g.
 * `run-stardew-native-local-player-break-resource-clump-smoke.mjs:200`):
 *
 *     ? {
 *         revision: lastSnapshot.revision,
 *         location: lastSnapshot.location,
 *         tile: lastSnapshot.tile,
 *         capabilities: lastSnapshot.capabilities,
 *         currentTool: lastSnapshot.currentTool ?? null,
 *         currentToolSlot: lastSnapshot.currentToolSlot ?? null,
 *         debrisTargets: lastSnapshot.debrisTargets ?? [],
 *         toolSlots: lastSnapshot.toolSlots ?? [],
 *       }
 *     : null,
 *
 * The four base fields are every copy's; `collections` are the `?? []` rows and `scalars` the `?? null` ones. The
 * defaults are the point: a snapshot that does not publish a family must report an empty family, never `undefined` in a
 * JSON line a reader diffs by eye.
 */
export function projectSnapshotForBlockedReport(snapshot, { collections = [], scalars = [] } = {}) {
  const projection = {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    capabilities: snapshot.capabilities,
  };
  for (const name of scalars) projection[name] = snapshot[name] ?? null;
  for (const name of collections) projection[name] = snapshot[name] ?? [];
  return projection;
}

/**
 * The fixture-config refusal, from the group `02a75fa47719` grew (`run-stardew-native-local-player-clear-hoedirt-smoke.mjs:169`,
 * `run-stardew-native-local-player-sweep-scythe-smoke.mjs:211`, and seventeen more):
 *
 *     const fixture = value?.NativeLocalPlayerFixture;
 *     if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO)
 *       throw new Error("native_local_<action>_fixture_config_invalid");
 *     if (
 *       value.Portfolio?.Enable === true ||
 *       value.HostAutomation?.Enable === true ||
 *       value.HostFarmhandProvisioning?.Enable === true ||
 *       value.FarmhandProvisioner?.Enable === true
 *     )
 *       throw new Error("native_local_<action>_action_policy_invalid");
 *
 * The two refusal codes keep the spelling the majority of the nineteen copies use; one copy abbreviated the second to
 * `_policy_invalid`, which is the kind of drift a shared refusal cannot express and therefore cannot keep making.
 */
export function validateRunnerConfig(value, { action, fixtureScenario, requiredActions, experimentalActions }) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== fixtureScenario)
    throw new Error(`native_local_${action}_fixture_config_invalid`);
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error(`native_local_${action}_action_policy_invalid`);
  validateNativeLocalFixturePolicy(value, { requiredActions, experimentalActions });
}

/**
 * The requestId mint, from `b975019b3b1f` (`run-stardew-native-local-player-break-resource-clump-smoke.mjs:368`):
 *
 *     if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
 *     const requestId = `native_local_break_resource_clump_${phase}_${Date.now()}_${trace.length}`;
 *     const receipt = await executeFresh(client, {
 *       requestId,
 *       idempotencyKey: `${requestId}_idem`,
 *       action,
 *       args,
 *       snapshot,
 *       timeoutMs: 30_000,
 *     });
 *     trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
 *     return receipt;
 *
 * `trace.length` is in the id because two phases in one run would otherwise mint the same millisecond's request; the
 * idempotency key is derived from the requestId rather than written twice.
 */
export function mintRequestId(prefix, phase, trace) {
  return `${prefix}_${phase}_${Date.now()}_${trace.length}`;
}

/** One traced execution: the guard, the mint, the envelope, the trace row. */
async function submit(client, trace, prefix, phase, action, args, snapshot, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = mintRequestId(prefix, phase, trace);
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

/**
 * Connect-with-retry, from `e7992f0a75cc` (`run-stardew-native-local-player-open-geode-smoke.mjs:228` and three more):
 *
 *     async function connectWithRetry(config, timeoutMs) {
 *       const deadline = Date.now() + timeoutMs;
 *       let lastError;
 *       while (Date.now() < deadline) {
 *         try {
 *           return await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
 *         } catch (error) {
 *           lastError = error;
 *           if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
 *           await delay(250);
 *         }
 *       }
 *       throw lastError ?? new Error("native_local_bridge_connect_timeout");
 *     }
 */
export async function connectWithRetry(config, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

/**
 * The navigation wait a `prepare` step needs, from the three copies that spell it
 * (`run-stardew-native-local-player-break-resource-clump-smoke.mjs:345`,
 * `run-stardew-native-local-player-clear-debris-smoke.mjs:303`, and the sweep-scythe runner this template was extracted
 * from):
 *
 *     async function waitForNavigationTerminal(client, receipts, accepted, predicate, timeoutMs) {
 *       let terminal;
 *       try {
 *         terminal = await waitForTerminal(receipts, accepted, timeoutMs);
 *       } catch (error) {
 *         if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
 *         throw error;
 *       }
 *       if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
 *       snapshot = await waitForFreshSnapshot(client, { minRevision: terminal.revision, timeoutMs, requireActionable: true, check: predicate });
 *       return { receipt: terminal, snapshot };
 *     }
 *
 * The harness's own timeout codes are mapped back to the runner's navigation vocabulary, so a caller's bounded
 * fixture-approach fallback keeps its decision surface instead of learning a second set of error names.
 */
export async function waitForNavigationTerminal(client, receipts, accepted, predicate, timeoutMs) {
  let terminal;
  try {
    terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  } catch (error) {
    if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
    throw error;
  }
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  let snapshot;
  try {
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs,
      requireActionable: true,
      check: predicate,
    });
  } catch (error) {
    if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
    throw error;
  }
  return { receipt: terminal, snapshot };
}

/** A definition that would fail at live time is refused at import time, naming the field. */
function requireField(definition, field, kind) {
  const value = definition[field];
  const ok =
    kind === "function"
      ? typeof value === "function"
      : kind === "string"
        ? typeof value === "string" && value.length > 0
        : kind === "boolean"
          ? typeof value === "boolean"
          : value !== undefined;
  if (!ok) throw new Error(`native_local_scenario_definition_invalid:${field}`);
  return value;
}

function requireList(definition, field) {
  const value = definition[field];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`native_local_scenario_definition_invalid:${field}`);
  return Object.freeze([...value]);
}

/**
 * Turn a definition into the runner the harness calls.
 *
 * The returned `run(client, receipts, config, options)` keeps the call shape every runner already has (`live-action.mjs`
 * reads the exported function's own parameter names to choose between `(client, receipts, config)` and
 * `(client, config)`), and returns the same `{ state, reasonCode, ... }` object a passing live gate is judged on.
 */
export function defineSmokeScenario(definition) {
  const action = requireField(definition, "action", "string");
  const fixtureScenario = requireField(definition, "fixtureScenario", "string");
  const successCode = requireField(definition, "successCode", "string");
  const requiredCapabilities = requireList(definition, "requiredCapabilities");
  const refusesConfig = requireField(definition, "refusesConfig", "boolean");
  const requiredActions = refusesConfig ? requireList(definition, "requiredActions") : Object.freeze([]);
  const experimentalActions = refusesConfig ? requireList(definition, "experimentalActions") : Object.freeze([]);
  const prepare = requireField(definition, "prepare", "function");
  const request = requireField(definition, "request", "function");
  const assertPostcondition = requireField(definition, "assertPostcondition", "function");
  const negative = definition.negative ?? null;
  const omitted = definition.negativeOmittedBecause ?? null;
  if (negative === null && !(typeof omitted === "string" && omitted.length > 0))
    throw new Error("native_local_scenario_definition_invalid:negative");
  if (negative !== null && (typeof negative.args !== "function" || typeof negative.unchanged !== "function"))
    throw new Error("native_local_scenario_definition_invalid:negative_hooks");
  const projection = Object.freeze({
    collections: Object.freeze([...(definition.projection?.collections ?? [])]),
    scalars: Object.freeze([...(definition.projection?.scalars ?? [])]),
  });
  const prefix = `native_local_${action}`;

  async function run(client, receipts, config, options = {}) {
    const {
      terminalTimeoutMs = 5_000,
      postconditionTimeoutMs = 5_000,
      requestTimeoutMs = REQUEST_TIMEOUT_MS,
    } = options;
    const trace = [];
    const startedAt = Date.now();
    let lastSnapshot = null;
    try {
      if (refusesConfig)
        validateRunnerConfig(config, { action, fixtureScenario, requiredActions, experimentalActions });

      let snapshot = await observeFresh(client, { actionable: true });
      lastSnapshot = snapshot;
      assertRequiredCapabilities(snapshot, requiredCapabilities);

      const prepared = await prepare({
        client,
        receipts,
        config,
        trace,
        snapshot,
        options,
        execute: (phase, requested, args, at) =>
          submit(client, trace, prefix, phase, requested, args, at, requestTimeoutMs),
      });
      snapshot = prepared.snapshot;
      lastSnapshot = snapshot;
      const plan = prepared.plan;
      trace.push({
        phase: "planned",
        ...(typeof definition.describePlan === "function" ? definition.describePlan(plan) : {}),
      });

      // The request is re-read against the post-arrival observation: a walk takes ticks, and the snapshot that justified
      // the plan is not the one the request may be sent against. `prepare` hands back the snapshot it revalidated on.
      const args = request(plan, snapshot).args;
      const accepted = await submit(client, trace, prefix, "action", action, args, snapshot, requestTimeoutMs);

      const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
      if (terminal.executionId !== accepted.executionId || terminal.requestId !== accepted.requestId)
        throw new Error(`${action}_terminal_identity_mismatch`);
      if (terminal.state !== "succeeded" || terminal.reasonCode !== successCode)
        throw new Error(`${action}_terminal:${terminal.state}:${terminal.reasonCode}`);

      const evidence = parseEvidence(terminal.evidence);
      const after = await waitForFreshSnapshot(client, {
        minRevision: terminal.revision,
        timeoutMs: postconditionTimeoutMs,
        requireActionable: true,
      });
      lastSnapshot = after;
      assertRequiredCapabilities(after, requiredCapabilities);
      // THE STALE REREAD. The wait above loops until the observation reaches the terminal's revision, so this is the
      // assertion that the loop actually delivered one rather than the check that makes it: a client answering with an
      // older snapshot forever would otherwise be read as a postcondition.
      if (after.revision < terminal.revision)
        throw new Error(`${action}_stale_reread:${after.revision}:${terminal.revision}`);

      const measured = await assertPostcondition({
        client,
        receipts,
        evidence,
        terminal,
        before: snapshot,
        after,
        plan,
        trace,
      });

      const negativeArm =
        negative === null
          ? `not_declared:${omitted}`
          : await submitNegative({
              client,
              receipts,
              trace,
              prefix,
              action,
              args: negative.args(plan, after),
              after,
              negative,
              terminalTimeoutMs,
              requestTimeoutMs,
            });

      return {
        state: "passed",
        topology: NATIVE_LOCAL_TOPOLOGY,
        reasonCode: successCode,
        ...measured,
        negative: negativeArm,
        receipt: summarizeReceipt(terminal),
        evidence,
        trace,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        state: "blocked",
        topology: NATIVE_LOCAL_TOPOLOGY,
        reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
        latestReceipt: summarizeReceipt(client.state?.latestReceipt),
        trace,
        lastSnapshot: lastSnapshot ? projectSnapshotForBlockedReport(lastSnapshot, projection) : null,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return Object.freeze({ action, fixtureScenario, successCode, requiredCapabilities, run });
}

/**
 * The negative arm: the same action re-sent against the post-run world must be REFUSED, and the world must not move.
 *
 * The copies spell this out per action (`run-stardew-native-local-player-accept-daily-quest-smoke.mjs:93-119`: a second
 * `executeFresh`, `stale_not_refused`, then `stale_moved_world` and `stale_readvertised` on the settled observation).
 * Here it is one path with the action's own three answers - the args to re-send, which refusal codes count, and what
 * "the world did not move" means for that action.
 */
async function submitNegative({
  client,
  receipts,
  trace,
  prefix,
  action,
  args,
  after,
  negative,
  terminalTimeoutMs,
  requestTimeoutMs,
}) {
  const submitted = await submit(client, trace, prefix, "negative", action, args, after, requestTimeoutMs);
  const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
  trace.push({ phase: "negative_stale_re_send", action, args, receipt: summarizeReceipt(terminal) });
  const refusedBy = negative.refusedCodes ?? null;
  const refused = terminal.state === "rejected" && (refusedBy === null || refusedBy.includes(terminal.reasonCode));
  if (!refused) throw new Error(`${action}_negative_not_refused:${terminal.state}/${terminal.reasonCode}`);
  const settled = await observeFresh(client);
  const drift = negative.unchanged({ before: after, after: settled });
  if (drift != null) throw new Error(`${action}_negative_moved_world:${drift}`);
  return `measured:${terminal.reasonCode}`;
}

/**
 * The `import.meta.main` bootstrap, from `e7992f0a75cc` (`run-stardew-native-local-player-break-resource-clump-smoke.mjs:216`):
 *
 *     if (import.meta.main) {
 *       const config = await readNativeClientConfig();
 *       const session = await connectWithRetry(config, 15_000);
 *       try {
 *         const result = await runBreakResourceClumpSmoke(session.client, session.receipts, config);
 *         if (result.state === "passed") console.log(JSON.stringify(result));
 *         else console.error(JSON.stringify(result));
 *         if (result.state !== "passed") process.exitCode = 2;
 *       } finally {
 *         session.close();
 *       }
 *     }
 *
 * A runner keeps ONE line for this - `if (import.meta.main) await runSmokeScenarioMain(scenario)` - because the harness's
 * own entry gate requires each registered runner's source to declare an entry point, and a runner that cannot be started
 * exits 0 while doing nothing, which the batch reads as PASS.
 */
export async function runSmokeScenarioMain(scenario, { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  const config = await readNativeClientConfig();
  const session = await connectWithRetry(config, connectTimeoutMs);
  try {
    const result = await scenario.run(session.client, session.receipts, config);
    if (result.state === "passed") console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
