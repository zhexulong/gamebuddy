// pan_ore live contract: production native client, bounded scope, revision-bound requests,
// exact receipt identity, terminal wait, and owned teardown come from the shared harness.
// Action-specific logic (pan-slot discovery, the site postcondition, the negative case)
// stays in this runner.
//
// The receipt is not the proof. `Pan.DoFunction` generates its result list into a local,
// so the two things this runner checks from the WORLD are the two the seam itself writes:
// the location's pan site is no longer the point that was panned, and the actor's own
// `TimesPanned` stat advanced by exactly one. The pan output is deliberately not asserted
// item by item: `addItemsByMenuIfNecessary` may open an ItemGrabMenu, and the receipt says
// so instead of hiding it.

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

const ACTION = "pan_ore";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute one native pan at the published site and prove the site moved. */
export async function runPanOreSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const site = choosePanSite(snapshot);
    const slot = choosePanSlot(snapshot);

    const requestId = `native_local_pan_ore_${Date.now()}`;
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot, x: site.x, y: site.y },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "pan_site",
      action: ACTION,
      slot,
      site: `${site.x},${site.y}`,
      receipt: summarizeReceipt(submitted),
    });

    // Either shape is legal: native work that resolves synchronously answers with an
    // immediate terminal instead of `accepted`. The terminal is what this contract asserts.
    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error(`pan_ore_terminal_identity_mismatch:${terminal.requestId}:${terminal.executionId}`);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "ore_panned")
      throw new Error(`pan_ore_failed:${terminal.state}/${terminal.reasonCode};${summarizeEvidence(terminal.evidence)}`);

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "slot", String(slot));
    assertEvidence(evidence, "tile", `${site.x},${site.y}`);
    // The pan acts on the location's own orePanPoint, and the receipt must say the site it
    // read is the site the caller named.
    assertEvidence(evidence, "site_before", `${site.x},${site.y}`);
    if (evidence.site_moved !== "true")
      throw new Error(`pan_ore_evidence_site_not_moved:before=${evidence.site_before};after=${evidence.site_after}`);
    // The stat the seam itself increments (`getPanItems`). A receipt that cannot show it
    // advanced by one is not evidence that the native call ran.
    if (Number(evidence.times_panned_after) !== Number(evidence.times_panned_before) + 1)
      throw new Error(
        `pan_ore_times_panned_not_advanced:before=${evidence.times_panned_before};after=${evidence.times_panned_after}`,
      );

    // The world change, re-read after the terminal: the tile the run panned is no longer
    // published as a pan site.
    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`pan_ore_stale_reread:${after.revision}:${terminal.revision}`);
    if (panSiteAt(after, site.x, site.y) != null)
      throw new Error(
        `pan_ore_world_unchanged:tile=${site.x},${site.y};panSites=${JSON.stringify(after.panSites ?? [])}`,
      );

    // Negative case. The site is consumed (a basic pan leaves `orePanPoint` at Point.Zero),
    // so resubmitting the SAME request must be REFUSED and the world must not move: a
    // second `ore_panned`, or a silent re-pan of a neighbouring tile, fails the run rather
    // than passing on a green receipt.
    const negativeRequestId = `native_local_pan_ore_consumed_${Date.now()}`;
    const negativeSubmitted = await executeFresh(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { slot, x: site.x, y: site.y },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "pan_consumed_site",
      action: ACTION,
      slot,
      site: `${site.x},${site.y}`,
      receipt: summarizeReceipt(negativeSubmitted),
    });
    const negativeTerminal = await waitForTerminal(receipts, negativeSubmitted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected")
      throw new Error(`pan_ore_consumed_site_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`);
    const REFUSALS = ["pan_site_not_available", "pan_site_changed", "pan_site_not_water"];
    if (!REFUSALS.includes(negativeTerminal.reasonCode))
      throw new Error(`pan_ore_consumed_site_unexpected_refusal:${negativeTerminal.reasonCode}`);

    const negativeEvidence = parseEvidence(negativeTerminal.evidence);
    if (negativeEvidence.times_panned_after != null)
      throw new Error(`pan_ore_refusal_carried_a_pan:${negativeEvidence.times_panned_after}`);

    const unchanged = await observeFresh(client);
    if (panSiteAt(unchanged, site.x, site.y) != null)
      throw new Error(`pan_ore_refusal_moved_world:tile=${site.x},${site.y}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "ore_panned",
      slot,
      site,
      evidence,
      negative: { reasonCode: negativeTerminal.reasonCode, panSites: (unchanged.panSites ?? []).length },
      receipt: summarizeReceipt(terminal),
      trace,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

/** The live ore-pan site the Mod publishes, or the named reason there is none. */
function choosePanSite(snapshot) {
  const sites = snapshot.panSites;
  if (sites == null || !Array.isArray(sites) || sites.length === 0)
    throw new Error(`pan_ore_no_site:location=${snapshot.location}`);
  const site = sites.find((entry) => Number.isInteger(entry?.x) && Number.isInteger(entry?.y));
  if (site == null) throw new Error(`pan_ore_site_projection_incomplete:${JSON.stringify(sites)}`);
  return site;
}

/** The one owned Pan, taken from the Mod's own tool-slot projection. */
function choosePanSlot(snapshot) {
  const slots = snapshot.toolSlots ?? [];
  const matches = slots.filter(
    (entry) => Number.isInteger(entry?.slot) && typeof entry.label === "string" && entry.label.endsWith("Pan"),
  );
  if (matches.length !== 1)
    throw new Error(
      `pan_ore_no_pan_slot:${matches.length ? "ambiguous" : "missing"};toolSlots=${JSON.stringify(slots)}`,
    );
  return matches[0].slot;
}

/** The published pan site at this tile, or null. Loose on purpose: an absent array and an
 * absent member both mean "not published", and the Mod serializes with WhenWritingNull. */
function panSiteAt(snapshot, x, y) {
  const sites = snapshot.panSites;
  if (sites == null || !Array.isArray(sites)) return null;
  return sites.find((entry) => entry?.x === x && entry?.y === y) ?? null;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`pan_ore_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function summarizeEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return detail.length > 0 ? detail : "no_evidence";
}

function parseEvidence(evidence) {
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

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runPanOreSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
