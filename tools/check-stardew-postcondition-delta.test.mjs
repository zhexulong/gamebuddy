#!/usr/bin/env node
/**
 * Falsifiers for `tools/check-stardew-postcondition-delta.mjs`.
 *
 * red-proof: inject deleting the `_after` slot from a write handler that still prints `_before` ->
 * `postcondition_delta_half:<action>:<member>`, naming the member the author forgot (test "deleting the after slot names
 * the half with the member the author forgot", tools/check-stardew-postcondition-delta.test.mjs)
 * red-proof: inject replacing a member read on the after side with a constant -> `postcondition_delta_not_measured`,
 * because a slot that claims to be a reading but carries a literal is worse than an absent one (test "a constant, or a
 * local assigned from nothing, is not a reading and the gate says which", tools/check-stardew-postcondition-delta.test.mjs)
 * red-proof: inject a write action whose handler reads neither side -> `postcondition_delta_absent` (test "a write action
 * whose after side is a captured local is named, not passed", tools/check-stardew-postcondition-delta.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  auditPostconditionDeltas,
  evidenceDeltaSlots,
  findPostconditionDeltas,
  formatCounts,
  handlerBodies,
  hostContractReadings,
  readHostCompletionContracts,
  readModFiles,
  readPostconditionDeltaBaseline,
  resolveAfterReading,
} from "./check-stardew-postcondition-delta.mjs";

const SURFACE = {
  actions: [
    writeAction("recolor", "placed_object_recolored"),
    writeAction("equip_hat", "wearable_equipped"),
    writeAction("walk_about", "native_action_postcondition"),
  ],
};

function writeAction(actionId, postcondition) {
  return { actionId, effect: "write", lifecycle: "published", postcondition: { name: postcondition } };
}

const HANDLERS = new Map([
  [
    "recolor",
    {
      request: "RequestRecolor",
      bodies: [
        {
          name: "RequestRecolor",
          path: "integrations/stardew/handler.cs",
          text:
            "Color before = chest.playerChoiceColor.Value;\nchest.playerChoiceColor.Value = expected;\n" +
            'Color after = chest.playerChoiceColor.Value;\nstring evidence = $"color_before={FormatColor(before)};' +
            'color_after={FormatColor(after)}";',
        },
      ],
    },
  ],
  [
    "equip_hat",
    {
      request: "RequestEquipHat",
      bodies: [
        {
          name: "RequestEquipHat",
          path: "integrations/stardew/handler.cs",
          text:
            'Item? after = piece.heldItem;\nstring evidence = "occupant_before={Describe(before)};' +
            'occupant_after={Describe(after)}";',
        },
      ],
    },
  ],
]);

const NO_CONTRACTS = new Map();

test("the delta shape: a member measured on both sides of the native call is a reading", () => {
  const slots = evidenceDeltaSlots(
    "color_before={FormatColor(before)};color_after={FormatColor(after)};mutex_locked_after={true}",
  );
  assert.deepEqual(slots.pairs, ["color"]);
  assert.deepEqual(slots.halves, []);
});

test("a `_before` with no `_after` is a half; an `_after` alone is a state observation, not half a delta", () => {
  const slots = evidenceDeltaSlots("money_before={fare};menu_open_after={open}");
  assert.deepEqual(slots.pairs, []);
  assert.deepEqual(slots.halves, ["money"]);
});

test("an `expected`/`actual` assertion is the other shape the receipt carries, and the member is in the slot", () => {
  const slots = evidenceDeltaSlots("expected={directionInt};actual={actor.FacingDirection}");
  assert.equal(slots.assertions.get("").actual, "actor.FacingDirection");
});

test("the after side is a reading when it is dereferenced in place", () => {
  assert.deepEqual(resolveAfterReading("piece.currentRotation.Value", ""), {
    live: true,
    because: "read in place: piece.currentRotation.Value",
  });
});

test("the after side is a reading when the local it prints was assigned from a member", () => {
  const reading = resolveAfterReading("after", "Color after = chest.playerChoiceColor.Value;");
  assert.equal(reading.live, true);
  assert.equal(reading.because, "after = chest.playerChoiceColor.Value");
});

test("the after side is a reading when the local came through a guard", () => {
  const reading = resolveAfterReading('(fishTypeAfter ?? "none")', "string fishTypeAfter = fish.ItemId;");
  assert.equal(reading.live, true);
});

test("a constant, or a local assigned from nothing, is not a reading and the gate says which", () => {
  assert.equal(resolveAfterReading("true", "").because, "a literal");
  assert.equal(
    resolveAfterReading("after", "bool after = false;").because,
    "after is assigned from false, which reads no member",
  );
  assert.equal(resolveAfterReading("after", "").because, "after is never assigned in the handler");
});

test("a write action whose handler reads the member twice passes, naming the reading", () => {
  const result = findPostconditionDeltas({ surface: SURFACE, handlers: HANDLERS, contracts: NO_CONTRACTS });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.withDelta.map((entry) => entry.actionId),
    ["recolor", "equip_hat"],
  );
  assert.equal(result.withDelta[0].evidence[0].because, "after = chest.playerChoiceColor.Value");
});

test("a write action whose after side is a captured local is named, not passed", () => {
  const handlers = new Map(HANDLERS);
  const patched = structuredClone(HANDLERS.get("recolor"));
  patched.bodies[0].text = patched.bodies[0].text.replace("Color after = chest.playerChoiceColor.Value;", "");
  handlers.set("recolor", patched);
  const result = findPostconditionDeltas({ surface: SURFACE, handlers, contracts: NO_CONTRACTS });
  assert.ok(
    result.findings.some((finding) =>
      finding.startsWith("postcondition_delta_not_measured:recolor:color_before/color_after="),
    ),
    result.findings.join("\n"),
  );
});

test("deleting the after slot names the half with the member the author forgot", () => {
  const handlers = new Map(HANDLERS);
  const patched = structuredClone(HANDLERS.get("recolor"));
  patched.bodies[0].text = patched.bodies[0].text.replace("color_after={FormatColor(after)}", "");
  handlers.set("recolor", patched);
  const result = findPostconditionDeltas({ surface: SURFACE, handlers, contracts: NO_CONTRACTS });
  assert.ok(
    result.findings.some((finding) => finding.startsWith("postcondition_delta_half:recolor:color_before has no")),
    result.findings.join("\n"),
  );
});

test("a half whose member is not the declared fact is listed as context and does not fail", () => {
  const handlers = new Map(HANDLERS);
  const patched = structuredClone(HANDLERS.get("recolor"));
  patched.bodies[0].text += ";tiptoe_before={tiptoe}";
  handlers.set("recolor", patched);
  const result = findPostconditionDeltas({ surface: SURFACE, handlers, contracts: NO_CONTRACTS });
  assert.deepEqual(result.findings, []);
  assert.equal(result.contextHalves.length, 1);
});

test("a header that declares no member (the generic name) is outside the population, never silently dropped", () => {
  const result = findPostconditionDeltas({ surface: SURFACE, handlers: HANDLERS, contracts: NO_CONTRACTS });
  assert.equal(result.undeclared, 1);
  assert.equal(result.declaredCount, 2);
  assert.equal(result.totalWrite, 3);
  assert.equal(formatCounts(result).includes("1 carry the generic name"), true);
});

test("the declared-but-unavailable reason is counted, not a failure - and only with a reason", () => {
  const handlers = new Map([
    [
      "recolor",
      {
        request: "RequestRecolor",
        bodies: [
          {
            name: "RequestRecolor",
            path: "integrations/stardew/handler.cs",
            text: 'string evidence = $"postcondition_delta_unavailable:playerChoiceColor:the chest owns no colour slot";',
          },
        ],
      },
    ],
    ["equip_hat", HANDLERS.get("equip_hat")],
  ]);
  const result = findPostconditionDeltas({ surface: SURFACE, handlers, contracts: NO_CONTRACTS });
  assert.equal(result.unavailable.length, 1);
  assert.deepEqual(result.unavailable[0].reasons, ["playerChoiceColor:the chest owns no colour slot"]);
});

test("a handler the gate cannot find is unbacked, which is louder than absent", () => {
  const handlers = new Map([["equip_hat", HANDLERS.get("equip_hat")]]);
  const result = findPostconditionDeltas({ surface: SURFACE, handlers, contracts: NO_CONTRACTS });
  assert.ok(result.findings.includes("postcondition_delta_unbacked:recolor:declared=placed_object_recolored"));
});

test("the Host contract is the receipt schema for its actions: a pair there is a reading", () => {
  const contracts = new Map([
    [
      "recolor",
      { actionId: "recolor", predicate: "hasRecolorCompletionEvidence", keys: ["color_before", "color_after"] },
    ],
  ]);
  const nd = findPostconditionDeltas({
    surface: SURFACE,
    handlers: new Map([["equip_hat", HANDLERS.get("equip_hat")]]),
    contracts,
  });
  assert.deepEqual(
    nd.withDelta.map((entry) => entry.actionId),
    ["recolor", "equip_hat"],
  );
  assert.ok(nd.withDelta[0].pairs.includes("color_before/color_after@host"));
});

test("a Host contract that demands a before and never the other side is the same half, on the Host", () => {
  const contracts = new Map([
    ["recolor", { actionId: "recolor", predicate: "hasRecolorCompletionEvidence", keys: ["color_before"] }],
  ]);
  const result = findPostconditionDeltas({
    surface: SURFACE,
    handlers: new Map([["equip_hat", HANDLERS.get("equip_hat")]]),
    contracts,
  });
  assert.ok(
    result.findings.some((finding) =>
      finding.startsWith("postcondition_delta_half:recolor:color_before has no color_after"),
    ),
    result.findings.join("\n"),
  );
});

test("hostContractReadings splits pairs, halves and assertions out of a key list", () => {
  const readings = hostContractReadings({
    actionId: "x",
    predicate: null,
    keys: ["color_before", "color_after", "money_before", "expected", "actual"],
  });
  assert.deepEqual(readings.pairs, ["color"]);
  assert.deepEqual(readings.halves, ["money"]);
  assert.deepEqual(readings.assertions, ["expected/actual"]);
});

test("the Host table is parsed per row, and a key named only in a comment does not count", () => {
  const text = [
    "export const STARDEW_COMPLETION_CONTRACTS = Object.freeze({",
    "  recolor: (claim) => {",
    "    // Evidence literal: color_before;color_after from the handler",
    '    return exactEvidence(claim.detail, ["location", "color_before", "color_after"]);',
    "  },",
    "  equip_hat: (claim) => {",
    "    return hasEquipHatCompletionEvidence(claim.detail);",
    "  },",
    '} satisfies Record<ExecutionRequest["action"], CompletionContract>);',
    "function hasEquipHatCompletionEvidence(detail: string): boolean {",
    '  const expectedKeys = ["hat_before", "hat_after"];',
    "  return expectedKeys.every((key) => key in detail);",
    "}",
  ].join("\n");
  const { contracts, findings } = readHostCompletionContracts(text);
  assert.deepEqual(contracts.get("recolor").keys, ["color_after", "color_before", "location"]);
  assert.deepEqual(contracts.get("equip_hat").keys, ["hat_after", "hat_before"]);
  assert.deepEqual(findings, []);
});

test("a completion predicate nothing calls is a contract no execution path enforces", () => {
  const text = [
    "export const STARDEW_COMPLETION_CONTRACTS = Object.freeze({",
    '  recolor: (claim) => claim.reasonCode === "recolored" && exactEvidence(claim.detail, ["color_before", "color_after"]),',
    '} satisfies Record<ExecutionRequest["action"], CompletionContract>);',
    "function hasOrphanCompletionEvidence(detail: string): boolean {",
    '  return exactEvidence(detail, ["orb_before", "orb_after"]);',
    "}",
  ].join("\n");
  const { findings } = readHostCompletionContracts(text);
  assert.ok(findings.includes("postcondition_delta_host_predicate_unwired:hasOrphanCompletionEvidence"));
});

test("the baseline record is read fail-closed: malformed, another schema, duplicates, or no reason", () => {
  assert.equal(readPostconditionDeltaBaseline("not json").problem, "postcondition_delta_baseline_malformed");
  assert.equal(
    readPostconditionDeltaBaseline(JSON.stringify({ schema: "other", reason: "x".repeat(60), entries: [] })).problem,
    "postcondition_delta_baseline_schema_mismatch",
  );
  assert.equal(
    readPostconditionDeltaBaseline(
      JSON.stringify({
        schema: "gamebuddy-stardew-postcondition-delta-baseline/v1",
        reason: "x".repeat(60),
        entries: ["a", "a"],
      }),
    ).problem,
    "postcondition_delta_baseline_duplicates",
  );
  assert.equal(
    readPostconditionDeltaBaseline(
      JSON.stringify({ schema: "gamebuddy-stardew-postcondition-delta-baseline/v1", reason: "too short", entries: [] }),
    ).problem,
    "postcondition_delta_baseline_unreasoned",
  );
});

test("a recorded action passes, and its entry expires the moment the action gains a reading", () => {
  const bare = new Map(HANDLERS);
  const stripped = structuredClone(HANDLERS.get("recolor"));
  stripped.bodies[0].text = 'string evidence = $"color_before={0}";';
  bare.set("recolor", stripped);
  const baseline = { entries: ["recolor"], reason: "r".repeat(60) };
  const recorded = findPostconditionDeltas({ surface: SURFACE, handlers: bare, contracts: NO_CONTRACTS, baseline });
  assert.deepEqual(recorded.findings, []);
  assert.equal(recorded.debt.length, 2, "the half and the absence of any reading are two findings, both recorded");
  const fixed = findPostconditionDeltas({ surface: SURFACE, handlers: HANDLERS, contracts: NO_CONTRACTS, baseline });
  assert.deepEqual(fixed.findings, ["stale_postcondition_delta_debt:recolor"], "out of debt means the entry must go");
  assert.equal(fixed.debt.length, 0);
});

test("a recorded action that gains the reading WHILE another member is still a half keeps its entry", () => {
  const both = new Map(HANDLERS);
  const patched = structuredClone(HANDLERS.get("recolor"));
  patched.bodies[0].text += ";color_depth_before={depthBefore}";
  both.set("recolor", patched);
  const result = findPostconditionDeltas({
    surface: SURFACE,
    handlers: both,
    contracts: NO_CONTRACTS,
    baseline: { entries: ["recolor"], reason: "r".repeat(60) },
  });
  assert.deepEqual(result.findings, []);
  assert.ok(result.debt.some((line) => line.startsWith("postcondition_delta_half:recolor:color_depth_before")));
});

test("a baseline entry for an action the surface no longer declares is stale, not silently dropped", () => {
  const result = findPostconditionDeltas({
    surface: SURFACE,
    handlers: HANDLERS,
    contracts: NO_CONTRACTS,
    baseline: { entries: ["gone_action"], reason: "r".repeat(60) },
  });
  assert.deepEqual(result.findings, ["postcondition_delta_debt_unknown_declaration:gone_action"]);
});

test("a surface that declares no postcondition measured nothing, and says so", () => {
  const result = findPostconditionDeltas({
    surface: { actions: [{ actionId: "a", effect: "read", postcondition: { name: "x" } }] },
    handlers: new Map(),
    contracts: NO_CONTRACTS,
  });
  assert.equal(result.totalWrite, 0);
  assert.ok(result.findings.includes("postcondition_delta_population_empty"));
});

test("the real tree passes, and the population is every write action the catalog shows", () => {
  const result = auditPostconditionDeltas();
  assert.deepEqual(result.findings, []);
  assert.equal(result.totalWrite + 0, result.totalWrite);
  assert.equal(result.checked, result.declaredCount);
  assert.ok(result.totalWrite > result.declaredCount, "the generic-name actions are counted, not hidden");
  const line = formatCounts(result);
  assert.match(line, /^checked \d+ of \d+ write actions/u);
  assert.match(line, /with delta \d+, declared-but-unavailable \d+/u);
});

test("the real tree's strongest deltas are read off the Mod handler, with the line that asserts them", () => {
  const result = auditPostconditionDeltas();
  const byAction = new Map(result.withDelta.map((entry) => [entry.actionId, entry]));
  const rotation = byAction.get("rotate_furniture");
  assert.ok(rotation.pairs.includes("rotation_before/rotation_after"), rotation.pairs.join(","));
  assert.match(rotation.where, /farmhandexecutioncontroller\.furnituredecorationactions\.cs/u);
  const color = byAction.get("color_placed_object");
  assert.equal(color.evidence[0].key, "color");
  assert.equal(color.evidence[0].because, "after = chest.playerChoiceColor.Value");
  const minecart = byAction.get("ride_minecart");
  assert.ok(minecart.pairs.includes("expected/actual@host"), minecart.pairs.join(","));
});

test("the real tree's remembered debt is the shape it names, so a reader can see what is left", () => {
  const result = auditPostconditionDeltas();
  assert.ok(result.debt.length > 0, "the recorded debt must be reported, not silently forgiven");
  assert.ok(
    result.debt.every(
      (line) => line.startsWith("postcondition_delta_absent:") || line.startsWith("postcondition_delta_half:"),
    ),
    result.debt.join("\n"),
  );
});

test("driving the REAL recolour handler: removing its after slot makes the gate name color_placed_object", () => {
  const files = readModFiles();
  const request = "RequestLocalColorPlacedObject";
  const bodies = handlerBodies({ files, request });
  assert.ok(bodies !== null, "the handler must be locatable, or this red proof proves nothing");
  const joined = bodies.map((body) => body.text).join("\n");
  assert.match(joined, /color_after=\{FormatColor\(after\)\}/u);
  const broken = files.map((file) => ({
    path: file.path,
    text: file.text.replace("color_after={FormatColor(after)}", ""),
  }));
  const patched = handlerBodies({ files: broken, request });
  const surface = { actions: [writeAction("color_placed_object", "placed_object_recolored")] };
  const result = findPostconditionDeltas({
    surface,
    handlers: new Map([["color_placed_object", { request, bodies: patched }]]),
    contracts: NO_CONTRACTS,
  });
  assert.ok(
    result.findings.some((finding) =>
      finding.startsWith("postcondition_delta_half:color_placed_object:color_before has no color_after"),
    ),
    result.findings.join("\n"),
  );
});

test("driving the REAL recolour handler: a copy taken before the native call is not a postcondition", () => {
  const files = readModFiles();
  const request = "RequestLocalColorPlacedObject";
  const broken = files.map((file) => ({
    path: file.path,
    text: file.text
      .replace("Color after = chest.playerChoiceColor.Value;", "Color after = before;")
      .replace("color_after={FormatColor(after)}", "color_after={FormatColor(before)}"),
  }));
  const bodies = handlerBodies({ files: broken, request });
  const result = findPostconditionDeltas({
    surface: { actions: [writeAction("color_placed_object", "placed_object_recolored")] },
    handlers: new Map([["color_placed_object", { request, bodies }]]),
    contracts: NO_CONTRACTS,
  });
  assert.ok(
    result.findings.some((finding) => finding.startsWith("postcondition_delta_not_measured:color_placed_object")),
    result.findings.join("\n"),
  );
});
