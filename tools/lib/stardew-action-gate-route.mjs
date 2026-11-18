/**
 * WHERE A PUBLISHED ACTION'S LIVE GATE LIVES, resolved in one place.
 *
 * The gate table used to hold one fact per action - a runner filename in `tools/` - so "this action has a live gate"
 * and "this file exists" were the same statement. Deleting the runner deleted the gate, and the three gates that read
 * the table went ENOENT: quitting a runner was impossible, which is why 126 hand-written files had nowhere to go.
 *
 * A row now resolves to ONE of two routes:
 *
 *   contract  `contracts/smoke/<actionId>.json` - the `stardew-action-smoke-contract/v1` assertions, run by the one
 *             slice driver (`tools/run-native-action-slice.mjs`). The contract STATES what the action must do, in
 *             JSON, so it outlives any particular runner.
 *   runner    `tools/<runner>` - the per-action shared-harness smoke runner, for actions whose assertions are still
 *             code because nobody has written their contract yet.
 *
 * Both routes answer with the SAME evidence record (see `gateEvidence`), built from the gate row rather than from the
 * artifact, so `action`, `scenario` and `terminalReasonCode` cannot differ by route: a promoted action's evidence does
 * not depend on which route produced it, and only `route`/`gate`/`executes` - the three facts that ARE the route -
 * change.
 *
 * This resolver grants no capability, changes no lifecycle, and publishes no success claim. It answers two questions:
 * which artifact is the action's gate, and how is that artifact run.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "../stardew-action-gate-descriptors.mjs";
import { SMOKE_CONTRACT_SCHEMA } from "./stardew-action-smoke-contract.mjs";
import { GATE_EXEMPT_PUBLISHED_ACTIONS } from "./stardew-published-action-registry.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The record both routes answer with. Declared here so the two routes cannot spell it twice. */
export const GATE_ROUTE_EVIDENCE_SCHEMA = "stardew-action-gate-evidence/v1";

/** The two route kinds. `null` (no route at all) is the third answer, and it is the coverage gate's finding. */
export const CONTRACT_ROUTE = "contract";
export const RUNNER_ROUTE = "runner";

/** The directory whose `<actionId>.json` is a live gate, and the driver that runs one. */
export const SMOKE_CONTRACT_DIRECTORY = "contracts/smoke";
export const SLICE_DRIVER = "tools/run-native-action-slice.mjs";

const TOOLS_DIRECTORY = "tools";
const ACTION_ID = /^[a-z][a-z0-9_]{1,127}$/u;

/** Where a contract-route action's contract is, from the action id alone. */
export function smokeContractPath(action) {
  return `${SMOKE_CONTRACT_DIRECTORY}/${action}.json`;
}

/**
 * The runner a gate row names, or `null` when its route is its contract.
 *
 * The three gates read this instead of `row.runner` so a contract row does not have to carry a filename it no longer
 * has, and so "runners the table names" has one spelling.
 */
export function namedRunner(row) {
  return row.gateRoute === CONTRACT_ROUTE ? null : row.runner;
}

function refusal(code, action, detail = null) {
  return Object.freeze({ code, action, detail });
}

/**
 * The evidence record. ONE builder for both routes, and every field it takes comes from the gate row except the
 * three that are the route itself - so a route difference can never move `action`, `scenario` or
 * `terminalReasonCode`.
 */
function gateEvidence({ action, route, gate, executes, scenario, terminalReasonCode }) {
  return Object.freeze({
    schema: GATE_ROUTE_EVIDENCE_SCHEMA,
    action,
    route,
    gate,
    executes,
    scenario,
    terminalReasonCode,
  });
}

function resolved({ source, action, route, gate, executes, scenario, terminalReasonCode, contract = null }) {
  return Object.freeze({
    source,
    action,
    route,
    gate,
    executes,
    problem: null,
    contract,
    evidence: gateEvidence({ action, route, gate, executes, scenario, terminalReasonCode }),
  });
}

function refused({ source, action, route, gate, problem }) {
  return Object.freeze({ source, action, route, gate, executes: null, problem, contract: null, evidence: null });
}

function readContract(path, root) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return { absent: true };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    return { unreadable: String(error?.message ?? error).slice(0, 200) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return { unreadable: "not a JSON object" };
  return { parsed };
}

/**
 * The contract route: the row says its gate is `contracts/smoke/<actionId>.json`, so that file must exist, declare the
 * SAME action, and - when it states a success word - agree with the row's. A row pointing at a contract that is not
 * there is refused by name here rather than ENOENT inside a gate.
 */
function contractRoute(row, root) {
  const action = row.actionId;
  const gate = smokeContractPath(action);
  const base = { source: "published", action, route: CONTRACT_ROUTE, gate };
  const read = readContract(gate, root);
  if (read.absent === true)
    return refused({ ...base, problem: refusal("stardew_action_gate_contract_absent", action, gate) });
  if (read.unreadable !== undefined)
    return refused({
      ...base,
      problem: refusal("stardew_action_gate_contract_unreadable", action, `${gate}: ${read.unreadable}`),
    });
  const contract = read.parsed;
  if (contract.schema !== SMOKE_CONTRACT_SCHEMA)
    return refused({
      ...base,
      problem: refusal(
        "stardew_action_gate_contract_schema",
        action,
        `${gate}: ${String(contract.schema)} is not ${SMOKE_CONTRACT_SCHEMA}`,
      ),
    });
  if (contract.action !== action)
    return refused({
      ...base,
      problem: refusal("stardew_action_gate_contract_action", action, `${gate} declares ${String(contract.action)}`),
    });
  // Two records for one fact: the row's terminal and the contract's own success word. They are allowed to differ only
  // by absence, never by value, or the gate table and the contract judge the same run differently.
  if (
    contract.expectedReasonCode !== undefined &&
    contract.expectedReasonCode !== null &&
    contract.expectedReasonCode !== row.terminalReasonCode
  )
    return refused({
      ...base,
      problem: refusal(
        "stardew_action_gate_contract_terminal",
        action,
        `${gate} expects ${String(contract.expectedReasonCode)}, the gate row says ${String(row.terminalReasonCode)}`,
      ),
    });
  return resolved({
    ...base,
    executes: SLICE_DRIVER,
    scenario: row.fixtureScenario,
    terminalReasonCode: row.terminalReasonCode,
    contract,
  });
}

function runnerRoute({ source, action, runner, scenario, terminalReasonCode, root }) {
  const gate = `${TOOLS_DIRECTORY}/${runner}`;
  const base = { source, action, route: RUNNER_ROUTE, gate };
  if (!existsSync(resolve(root, gate)))
    return refused({ ...base, problem: refusal("stardew_action_gate_runner_absent", action, gate) });
  return resolved({ ...base, executes: gate, scenario, terminalReasonCode });
}

/**
 * Resolve one action's live gate.
 *
 * Answers, in this order: a published gate row (contract route when the row declares it, else the runner it names), an
 * experimental action's runner, a gate-exempt published action's runner, and finally NO ROUTE - which is a named
 * refusal carrying the action, not an empty answer a caller could mistake for a pass.
 *
 * `gates`, `experimental`, `exemptions` and `root` are injectable so the route rules can be exercised against a
 * synthetic table instead of only against today's 103 rows.
 */
export function resolveStardewActionGateRoute(action, options = {}) {
  const {
    root = ROOT,
    gates = STARDEW_PUBLISHED_ACTION_GATES,
    experimental = STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
    exemptions = GATE_EXEMPT_PUBLISHED_ACTIONS,
  } = options;
  if (typeof action !== "string" || !ACTION_ID.test(action))
    throw new Error(`stardew_action_gate_route_invalid_action_id:${String(action)}`);
  const row = gates.find((candidate) => candidate.actionId === action);
  if (row !== undefined)
    return row.gateRoute === CONTRACT_ROUTE
      ? contractRoute(row, root)
      : runnerRoute({
          source: "published",
          action,
          runner: row.runner,
          scenario: row.fixtureScenario,
          terminalReasonCode: row.terminalReasonCode,
          root,
        });
  const experimentalRunner = experimental[action];
  if (experimentalRunner !== undefined)
    return runnerRoute({
      source: "experimental",
      action,
      runner: experimentalRunner,
      scenario: null,
      terminalReasonCode: null,
      root,
    });
  const exemption = exemptions.find((candidate) => candidate.actionId === action);
  if (exemption !== undefined)
    return runnerRoute({
      source: "exemption",
      action,
      runner: exemption.runner,
      scenario: null,
      terminalReasonCode: exemption.terminalReasonCode,
      root,
    });
  return refused({
    source: null,
    action,
    route: null,
    gate: null,
    problem: refusal("stardew_action_gate_route_absent", action),
  });
}

/**
 * Resolve MANY actions at once, in the order given, keeping the refusals.
 *
 * The gates that read the whole table need "every action, with its problem", not the first throw: a run that stops at
 * the first missing artifact names one action and hides the other six.
 */
export function resolveStardewActionGateRoutes(actions, options = {}) {
  return Object.freeze(actions.map((action) => resolveStardewActionGateRoute(action, options)));
}

/** The refusals, each named as `<action>: <code> <detail>` so a failing gate says which action broke and how. */
export function describeGateRouteProblems(routes) {
  return routes
    .filter((route) => route.problem !== null)
    .map(
      (route) =>
        `${route.action}: ${route.problem.code}${route.problem.detail === null ? "" : ` ${route.problem.detail}`}`,
    );
}
