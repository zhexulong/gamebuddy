import assert from "node:assert/strict";
import test from "node:test";

import { runPanOreSmoke } from "./run-stardew-native-local-player-pan-ore-smoke.mjs";

const ACTION = "pan_ore";
const SITE = { x: 20, y: 30 };
const PAN_SLOT = 3;

/** The Mod's own projections: one live site and one owned, held Pan. */
function snapshotWith({ revision, panSites = [SITE], toolSlots = [{ slot: PAN_SLOT, label: "(T)Pan" }] }) {
  return {
    revision,
    location: "Farm",
    tile: { x: 19, y: 30 },
    actionable: true,
    activeExecution: null,
    capabilities: ["cancel_active_execution", "inspect_self", ACTION],
    toolSlots,
    panSites,
  };
}

function successEvidence({ siteBefore = SITE, siteAfter = { x: 0, y: 0 }, timesBefore = 4, timesAfter = 5 } = {}) {
  const siteMoved = siteAfter.x !== siteBefore.x || siteAfter.y !== siteBefore.y;
  return {
    detail:
      `slot=${PAN_SLOT};tool=(T)Pan;tile=${SITE.x},${SITE.y};location=Farm;` +
      `site_before=${siteBefore.x},${siteBefore.y};site_after=${siteAfter.x},${siteAfter.y};site_moved=${siteMoved};` +
      `times_panned_before=${timesBefore};times_panned_after=${timesAfter};pan_output_overflow=false;` +
      `inventory_slots_before=2;inventory_slots_after=2;inventory_units_before=2;inventory_units_after=6`,
  };
}

/**
 * The receipt is minted from the live projection, and the site only clears when the request
 * named the site the world actually holds -- which is the rule under test.
 */
function makeClient({ panSites = [SITE] } = {}) {
  const receipts = [];
  const client = {
    state: { snapshot: snapshotWith({ revision: 1, panSites }) },
    observe: async () => client.state.snapshot,
    execute: async (request) => {
      const live = client.state.snapshot.panSites[0] ?? null;
      const accepted = {
        requestId: request.requestId,
        executionId: live ? "pan-ore-execution" : "pan-ore-refused",
        state: "accepted",
        reasonCode: "accepted",
        revision: client.state.snapshot.revision,
      };
      const terminal = live
        ? {
            requestId: request.requestId,
            executionId: accepted.executionId,
            state: "succeeded",
            reasonCode: "ore_panned",
            revision: client.state.snapshot.revision + 1,
            evidence: successEvidence({ siteBefore: live }),
          }
        : {
            requestId: request.requestId,
            executionId: accepted.executionId,
            state: "rejected",
            reasonCode: "pan_site_not_available",
            revision: client.state.snapshot.revision + 1,
            evidence: { detail: `location=Farm;ore_pan_point=0,0;tile=${SITE.x},${SITE.y}` },
          };
      if (live) {
        client.state.snapshot = snapshotWith({ revision: terminal.revision, panSites: [] });
      }
      receipts.push(terminal);
      return accepted;
    },
  };
  return { client, receipts };
}

const run = (options) => {
  const session = makeClient(options);
  return {
    ...session,
    result: () => runPanOreSmoke(session.client, session.receipts, {}, { terminalTimeoutMs: 1_000 }),
  };
};

test("pan_ore: the site clears in the world and the stat the seam increments advanced", async () => {
  const session = run();
  const result = await session.result();
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "ore_panned");
  assert.equal(result.slot, PAN_SLOT);
  assert.equal(result.evidence.times_panned_after, "5");
  assert.equal(result.negative.reasonCode, "pan_site_not_available");
  assert.equal(result.negative.panSites, 0);
});

test("pan_ore: a pan whose TimesPanned did not advance fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "succeeded") terminal.evidence = successEvidence({ timesAfter: 4 });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_times_panned_not_advanced/);
});

test("pan_ore: a receipt that does not report the site moving fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "succeeded") terminal.evidence = successEvidence({ siteAfter: SITE });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_evidence_site_not_moved/);
});

test("pan_ore: a receipt that claims success while the site is still live fails the run", async () => {
  // The receipt is green, but the world still publishes the panned site. A green receipt is
  // not evidence, so this must not pass.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    session.client.state.snapshot = snapshotWith({ revision: session.client.state.snapshot.revision, panSites: [SITE] });
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_world_unchanged/);
});

test("pan_ore: the consumed site is refused, and a refusal that re-published it fails the run", async () => {
  const honest = run();
  const honestResult = await honest.result();
  assert.equal(honestResult.state, "passed");

  const moved = run();
  const original = moved.client.execute;
  moved.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = moved.receipts.at(-1);
    if (terminal.state === "rejected") {
      moved.client.state.snapshot = snapshotWith({ revision: terminal.revision, panSites: [SITE] });
    }
    return accepted;
  };
  const movedResult = await moved.result();
  assert.equal(movedResult.state, "blocked");
  assert.match(movedResult.reasonCode, /pan_ore_refusal_moved_world/);
});

test("pan_ore: a second pan on the consumed site must not report a second success", async () => {
  // A forged success on the consumed site is the failure this pins: a probabilistic action
  // must not become a second `ore_panned` just because a receipt said so.
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "rejected") {
      terminal.state = "succeeded";
      terminal.reasonCode = "ore_panned";
    }
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_consumed_site_not_refused/);
});

test("pan_ore: a refusal that carried a pan fact fails the run", async () => {
  const session = run();
  const original = session.client.execute;
  session.client.execute = async (request) => {
    const accepted = await original(request);
    const terminal = session.receipts.at(-1);
    if (terminal.state === "rejected") terminal.evidence = { detail: `tile=${SITE.x},${SITE.y};times_panned_after=5` };
    return accepted;
  };
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_refusal_carried_a_pan/);
});

test("pan_ore: no owned Pan is not the declared Given", async () => {
  const session = run();
  session.client.state.snapshot = snapshotWith({ revision: 1, toolSlots: [{ slot: 4, label: "(T)Hoe" }] });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_no_pan_slot/);
});

test("pan_ore: no live site is not the declared Given", async () => {
  const session = run({ panSites: [] });
  const result = await session.result();
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /pan_ore_no_site/);
});
