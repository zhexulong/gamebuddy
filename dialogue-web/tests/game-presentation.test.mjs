import assert from "node:assert/strict";
import test from "node:test";
import { messages } from "../src/i18n.ts";
import {
  authorityLabel,
  capabilitiesLabel,
  compatibilityLabel,
  connectionLabel,
  installationDiscoveryFailureState,
  installationDiscoveryState,
  installationStateLabel,
  instanceLabel,
  outcomeLabel,
} from "../src/game-presentation.ts";

/**
 * The frozen `game_browser_api/v1` unions, restated here on purpose: this test
 * is the guard that every state the Host can publish still has a player outcome
 * in both shipped locales. A new union member added to the client without a
 * catalog entry fails here rather than reaching a player as a raw enum
 * (design/104 §10).
 */
const CONNECTION_STATUSES = [
  "none",
  "discovering",
  "launch_pending",
  "attach_pending",
  "compatibility_warning",
  "awaiting_confirmation",
  "connecting",
  "connected_idle",
  "active",
  "stopping",
  "reconnecting",
  "syncing",
  "stopped",
  "failed",
  "disconnected",
];
const INSTANCE_STATUSES = ["none", "detected", "launching", "running", "stopped", "crashed"];
const COMPATIBILITY_STATUSES = ["unchecked", "compatible", "incompatible", "warning"];
const ACTION_AUTHORITIES = ["unavailable", "active", "paused"];
const OUTCOMES = ["none", "succeeded", "failed", "cancelled"];
const INSTALLATION_STATES = [
  "not_configured",
  "loading",
  "candidates",
  "confirming",
  "retrying",
  "cancelled",
  "source-unavailable",
  "no-candidates",
  "result-unavailable",
  "expired",
  "error",
];

const locales = ["en", "zh-CN"];

test("every typed game fact renders a localized player outcome, never the raw enum", () => {
  for (const locale of locales) {
    const labels = messages(locale);
    for (const status of CONNECTION_STATUSES) {
      const value = connectionLabel(labels, status);
      assert.ok(typeof value === "string" && value.length > 0, `${locale} connection ${status} is empty`);
      assert.notEqual(value, status, `${locale} connection ${status} is rendered raw`);
      assert.ok(!value.includes("_"), `${locale} connection ${status} still reads like an enum`);
    }
    for (const status of INSTANCE_STATUSES) {
      const value = instanceLabel(labels, { status, gameTitle: null, generation: 0 });
      assert.notEqual(value, status, `${locale} instance ${status} is rendered raw`);
      assert.ok(!value.includes("_"), `${locale} instance ${status} still reads like an enum`);
    }
    // A published title is content, not a label: it passes through untouched.
    assert.equal(instanceLabel(labels, { status: "running", gameTitle: "Stardew Valley", generation: 1 }), "Stardew Valley");
    for (const status of COMPATIBILITY_STATUSES) {
      const value = compatibilityLabel(labels, { status, message: null });
      assert.notEqual(value, status, `${locale} compatibility ${status} is rendered raw`);
    }
    // The Host's own compatibility sentence wins over the generic state word.
    assert.equal(compatibilityLabel(labels, { status: "warning", message: "Untested version" }), "Untested version");
    for (const authority of ACTION_AUTHORITIES) {
      const value = authorityLabel(labels, authority);
      assert.notEqual(value, authority, `${locale} actionAuthority ${authority} is rendered raw`);
    }
    for (const outcome of OUTCOMES) {
      const value = outcomeLabel(labels, outcome);
      assert.notEqual(value, outcome, `${locale} latestOutcome ${outcome} is rendered raw`);
    }
    for (const state of INSTALLATION_STATES) {
      const value = installationStateLabel(labels, state);
      assert.ok(typeof value === "string" && value.length > 0, `${locale} installation ${state} is empty`);
      assert.notEqual(value, state, `${locale} installation ${state} is rendered raw`);
    }
  }
});

test("the two shipped locales are both really translated", () => {
  const en = messages("en");
  const zh = messages("zh-CN");
  for (const status of CONNECTION_STATUSES) {
    assert.notEqual(connectionLabel(zh, status), connectionLabel(en, status), `connection ${status} is not translated`);
  }
  for (const status of INSTANCE_STATUSES) {
    assert.notEqual(instanceLabel(zh, { status, gameTitle: null, generation: 0 }), instanceLabel(en, { status, gameTitle: null, generation: 0 }), `instance ${status} is not translated`);
  }
  for (const status of COMPATIBILITY_STATUSES) {
    assert.notEqual(compatibilityLabel(zh, { status, message: null }), compatibilityLabel(en, { status, message: null }), `compatibility ${status} is not translated`);
  }
  for (const authority of ACTION_AUTHORITIES) {
    assert.notEqual(authorityLabel(zh, authority), authorityLabel(en, authority), `authority ${authority} is not translated`);
  }
  for (const outcome of OUTCOMES) {
    assert.notEqual(outcomeLabel(zh, outcome), outcomeLabel(en, outcome), `outcome ${outcome} is not translated`);
  }
  for (const state of INSTALLATION_STATES) {
    assert.notEqual(installationStateLabel(zh, state), installationStateLabel(en, state), `installation ${state} is not translated`);
  }
});

/**
 * The player sentence follows the Host's own answer, not the candidate count.
 *
 * Measured defect: on a machine where Stardew Valley IS installed, the Host's discovery
 * replied with no candidate and diagnostics naming the sources it could not read
 * (`registry-unavailable` + `source-unavailable`), and the panel read that as "No Stardew
 * Valley installation was found." - a statement about the player's machine that the Host
 * never made. A rejected read had a second version of the same fault: a thrown code this
 * build does not know collapsed into "The installation search failed."
 */
test("the installation sentence follows the transport's own answer", () => {
  // A reply that carries a candidate is a candidate whatever else it reported.
  assert.equal(installationDiscoveryState(1, []), "candidates");
  assert.equal(installationDiscoveryState(1, ["registry-unavailable"]), "candidates");
  // A scan that could not read a source says so, from the Host's own diagnostics.
  for (const diagnostic of ["source-unavailable", "registry-unavailable", "vdf-unreadable", "vdf-malformed", "invalid-app-manifest"])
    assert.equal(installationDiscoveryState(0, [diagnostic]), "source-unavailable", diagnostic);
  assert.equal(installationDiscoveryState(0, ["registry-unavailable", "invalid-app-manifest"]), "source-unavailable");
  assert.equal(installationDiscoveryState(0, ["source-unavailable", "no-candidates"]), "source-unavailable");
  // A scan that read everything and found nothing says exactly that.
  assert.equal(installationDiscoveryState(0, ["no-candidates"]), "no-candidates");
  assert.equal(installationDiscoveryState(0, []), "no-candidates");
  // A rejected read: the two codes that mean the scan itself could not run, the one that
  // means the Host refused to produce the result, and every code this build cannot name.
  assert.equal(installationDiscoveryFailureState("game_unavailable"), "source-unavailable");
  assert.equal(installationDiscoveryFailureState("source_unavailable"), "source-unavailable");
  assert.equal(installationDiscoveryFailureState("state_unavailable"), "error");
  for (const code of ["unauthorized", "not_found", "malformed_request", "closed", "invalid_stardew_installation_discovery", "network_error", null])
    assert.equal(installationDiscoveryFailureState(code), "result-unavailable", String(code));
});

test("the four discovery outcomes are four different sentences", () => {
  for (const locale of locales) {
    const labels = messages(locale);
    const sentences = ["source-unavailable", "no-candidates", "result-unavailable", "error"].map(
      (state) => installationStateLabel(labels, state),
    );
    assert.equal(new Set(sentences).size, sentences.length, `${locale} collapses two discovery outcomes into one sentence`);
  }
});

test("the capability summary says how many capabilities are published, or says it published none", () => {
  const en = messages("en");
  assert.equal(capabilitiesLabel(en, { available: true, count: 7 }), "7 available");
  assert.equal(capabilitiesLabel(en, { available: false, count: 0 }), en.gameCapabilitiesUnavailable);
  assert.equal(capabilitiesLabel(messages("zh-CN"), { available: true, count: 7 }), "7 项可用");
});
