// Stardew-local build-farm-building smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait and owned teardown all come
// from the shared harness. Action-specific logic (which published site, what the receipt must
// have observed, and the negative case) stays in this runner.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "build_farm_building";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * build_farm_building live contract.
 *
 * The receipt is not the proof. Five things are observed directly, and the first is the one
 * that makes the action worth having:
 *
 *   1. the site comes from the Mod's own `farmBuildingTargets` projection (`kind ===
 *      "build_site"`), never from this runner — the request names the tile and the opaque id
 *      discovery published for it;
 *   2. the world CHANGED: the same projection now publishes a `built` entry on exactly that
 *      tile carrying the requested building type and the id the receipt names. A `built`
 *      surface that is absent is `not_checked`, never a pass;
 *   3. the commission's SITE left discovery — a tile that now holds the building is not a
 *      place a building can go, so the published candidate must be gone;
 *   4. the receipt's own postcondition agrees with the world: money dropped by exactly the
 *      declared cost, each declared material left the inventory, and the construction days
 *      equal the building data's own `BuildDays`;
 *   5. RESUBMITTING THE SAME TARGET is refused by name and moves nothing. The tile now holds
 *      the building, so a second success there would be a second structure (or a silent
 *      no-op reported as success); the run fails rather than passing on a green receipt.
 *
 * The runner never chooses the site or the building type: both come from the projection.
 */
export async function runBuildFarmBuildingSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const target = chooseBuildSite(snapshot);

  const requestId = `native_local_build_farm_building_${Date.now()}`;
  const args = { buildingType: target.buildingType, x: target.x, y: target.y, expectedTargetId: target.targetId };
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({
    step: "build",
    action: ACTION,
    target: target.targetId,
    buildingType: target.buildingType,
    receipt: summarizeReceipt(accepted),
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("build_farm_building terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "farm_building_built")
    throw new Error(
      `build_farm_building did not place the structure: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const evidence = parseEvidence(terminal.evidence);
  const after = await observeFresh(client, { actionable: true });
  const sitesAfter = buildSites(after);
  const builtAfter = builtBuildings(after);

  const checks = assertBuildFarmBuildingPostconditions({ target, evidence, sitesAfter, builtAfter });
  trace.push({ step: "observed", sites: sitesAfter.length, built: builtAfter === null ? null : builtAfter.length, evidence, checks });

  // 5. the negative case: the stale target is refused by name and the world does not move.
  const staleRequestId = `native_local_build_farm_building_stale_${Date.now()}`;
  const stale = await executeFresh(client, {
    requestId: staleRequestId,
    idempotencyKey: `${staleRequestId}_idem`,
    action: ACTION,
    args,
    snapshot: after,
    timeoutMs: 30_000,
  });
  const staleTerminal = await waitForTerminal(receipts, stale, terminalTimeoutMs);
  trace.push({ step: "stale_target", receipt: summarizeReceipt(staleTerminal) });
  checks.staleTargetRefused =
    staleTerminal.state === "rejected" && staleTerminal.reasonCode === "build_farm_building_site_blocked";

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`build_farm_building live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "farm_building_built", trace, checks, evidence };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport:
 * the published projection before and after, and the receipt's evidence.
 *
 * `buildingPresentAtTile` is `not_checked` — not `true` — when the observation surface does not
 * carry the built entries at all, because "I could not look" and "the structure is not there"
 * must never read the same, and the caller treats `not_checked` as a failure.
 */
export function assertBuildFarmBuildingPostconditions({ target, evidence, sitesAfter, builtAfter }) {
  const observable = Array.isArray(builtAfter);
  const built = observable
    ? builtAfter.find((entry) => entry?.kind === "built" && entry.x === target.x && entry.y === target.y)
    : null;
  return {
    // The published fact changed: a tile that now holds the building is not a build site.
    siteNoLongerAdvertised: !sitesAfter.some((entry) => entry?.targetId === target.targetId),
    // The structure exists on the named tile, re-read from the world.
    buildingPresentAtTile: observable
      ? built != null && built.buildingType === target.buildingType
      : "not_checked",
    // And it is the very structure the receipt named.
    receiptNamesTheBuilding: observable
      ? built != null &&
        typeof evidence.building_id === "string" &&
        evidence.building_id.length > 0 &&
        built.buildingId === evidence.building_id
      : "not_checked",
    // Money and materials are part of the world change, so the debit is asserted, not assumed.
    moneyCharged:
      evidence.build_cost === String(target.buildCost) &&
      Number.isSafeInteger(Number(evidence.money_before)) &&
      Number.isSafeInteger(Number(evidence.money_after)) &&
      Number(evidence.money_after) === Number(evidence.money_before) - Number(evidence.build_cost),
    materialsConsumed:
      Number.isSafeInteger(Number(evidence.materials_before)) &&
      Number.isSafeInteger(Number(evidence.materials_after)) &&
      Number.isSafeInteger(Number(evidence.materials_required)) &&
      Number(evidence.materials_after) === Number(evidence.materials_before) - Number(evidence.materials_required),
    // Construction TIME is the building data's own BuildDays (0 for a magical build).
    constructionDaysMatch:
      evidence.build_days === String(target.buildDays) &&
      evidence.days_of_construction_left === String(target.buildDays),
  };
}

/** The commission site the fixture established, as discovery publishes it. */
function chooseBuildSite(snapshot) {
  const candidates = buildSites(snapshot);
  if (candidates.length === 0)
    throw new Error(`no farm-building site is advertised: ${JSON.stringify(snapshot?.farmBuildingTargets)}`);
  return candidates[0];
}

function buildSites(snapshot) {
  const targets = snapshot?.farmBuildingTargets;
  return Array.isArray(targets) ? targets.filter((entry) => entry?.kind === "build_site") : [];
}

/** The buildings the world now reports, or null when the surface does not carry them at all. */
function builtBuildings(snapshot) {
  const targets = snapshot?.farmBuildingTargets;
  return Array.isArray(targets) ? targets.filter((entry) => entry?.kind === "built") : null;
}

/** `key=value;key=value` — the Mod's evidence shape. */
function parseEvidence(evidence) {
  const text = typeof evidence === "string" ? evidence : (evidence?.detail ?? "");
  const values = {};
  for (const field of String(text).split(";")) {
    const at = field.indexOf("=");
    if (at <= 0) continue;
    values[field.slice(0, at)] = field.slice(at + 1);
  }
  return values;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runBuildFarmBuildingSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
