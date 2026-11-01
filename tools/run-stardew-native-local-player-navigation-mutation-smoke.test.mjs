import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runNavigationMutationSmoke } from "./run-stardew-native-local-player-navigation-mutation-smoke.mjs";

const CAPABILITIES = [
  "cancel_active_execution",
  "find_destination",
  "inspect_self",
  "inspect_world_map",
  "navigate_to_destination",
];

const MOD_SOURCE_ROOT = new URL("../integrations/stardew/", import.meta.url);

/** Directories under the Mod that hold no production source. */
const MOD_DIRECTORIES_WITHOUT_SOURCE = new Set(["tests", "bin", "obj"]);

/**
 * The index of the character that ends a C# literal that starts at `open`, or the source length.
 *
 * A literal-aware scan is what makes the stripped source below a faithful version of the file: a plain
 * `//.*` regex reads `"http://x"` as the start of a comment and then eats the rest of the line, so the
 * text an assertion reads is not the text the compiler sees.
 */
function literalEnd(source, open) {
  const quote = source[open];
  if (quote === "@" && source[open + 1] === '"') {
    // A verbatim string escapes a quote by doubling it and never ends at a backslash.
    for (let cursor = open + 2; cursor < source.length; cursor += 1) {
      if (source[cursor] !== '"') continue;
      if (source[cursor + 1] === '"') {
        cursor += 1;
        continue;
      }
      return cursor;
    }
    return source.length - 1;
  }
  for (let cursor = open + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor;
  }
  return source.length - 1;
}

/** The index just past a comment that starts at `open`, or the source length. */
function commentEnd(source, open) {
  if (source[open + 1] === "/") {
    const end = source.indexOf("\n", open);
    return end < 0 ? source.length : end;
  }
  const end = source.indexOf("*/", open + 2);
  return end < 0 ? source.length : end + 2;
}

function isLiteralStart(source, index) {
  const character = source[index];
  return character === '"' || character === "'" || (character === "@" && source[index + 1] === '"');
}

/** Comments removed, literals intact: a comment can no longer satisfy an assertion. */
function withoutComments(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = commentEnd(source, index);
      continue;
    }
    const end = isLiteralStart(source, index) ? literalEnd(source, index) + 1 : index + 1;
    result += source.slice(index, end);
    index = end;
  }
  return result;
}

async function readModSources() {
  const sources = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!MOD_DIRECTORIES_WITHOUT_SOURCE.has(entry.name)) await walk(new URL(`${entry.name}/`, directory));
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      const file = fileURLToPath(new URL(entry.name, directory));
      sources.push({ file, text: withoutComments(await readFile(file, "utf8")) });
    }
  };
  await walk(MOD_SOURCE_ROOT);
  return sources;
}

/** The index of the bracket that closes the one opened at `open`. */
function matchingBracket(text, open, left, right) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === left) depth += 1;
    else if (text[index] === right) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Every method body in the Mod, located by SIGNATURE SHAPE rather than by a hand-written name.
 *
 * The assertions below ask "which methods observe a delivery completion" and "which one drains
 * inbound requests"; answering that from the bodies is what keeps them true across a rename, which is
 * exactly what a name list cannot do.
 */
function methodBodies(sources) {
  const methods = [];
  for (const { file, text } of sources) {
    for (const declaration of text.matchAll(/\b(?:private|internal|public|protected)\b[^\n;{}=]*?\b(\w+)\s*\(/g)) {
      const parametersOpen = declaration.index + declaration[0].length - 1;
      const parametersClose = matchingBracket(text, parametersOpen, "(", ")");
      if (parametersClose < 0) continue;
      const bodyOpen = text.indexOf("{", parametersClose);
      if (bodyOpen < 0) continue;
      const arrow = text.indexOf("=>", parametersClose);
      if (arrow >= 0 && arrow < bodyOpen) continue;
      const bodyClose = matchingBracket(text, bodyOpen, "{", "}");
      if (bodyClose < 0) continue;
      methods.push({ file, name: declaration[1], body: text.slice(bodyOpen, bodyClose + 1) });
    }
  }
  return methods;
}

/** Every `if (<condition>) { ... }` block in the Mod whose condition names one scenario literal. */
function scenarioGuardBlocks(sources, scenario) {
  const blocks = [];
  for (const { file, text } of sources) {
    for (const guard of text.matchAll(/\bif\s*\(/g)) {
      const open = guard.index + guard[0].length - 1;
      const close = matchingBracket(text, open, "(", ")");
      if (close < 0) continue;
      if (!text.slice(open + 1, close).includes(`"${scenario}"`)) continue;
      const bodyOpen = text.indexOf("{", close);
      if (bodyOpen < 0 || text.slice(close + 1, bodyOpen).trim().length > 0) continue;
      const bodyClose = matchingBracket(text, bodyOpen, "{", "}");
      if (bodyClose < 0) continue;
      blocks.push({ file, body: text.slice(bodyOpen, bodyClose + 1) });
    }
  }
  return blocks;
}

/**
 * Every stage the Mod emits, split into fixed literals and computed arguments.
 *
 * `MonitorNativeChatIngress` is the one seam a phase code can cross, so naming it is naming the
 * authority rather than pinning an implementation spelling.
 */
function emitStageEmissions(sources) {
  const literals = new Map();
  const dynamic = [];
  for (const { file, text } of sources) {
    for (const call of text.matchAll(/MonitorNativeChatIngress\(/g)) {
      const open = call.index + call[0].length - 1;
      const close = matchingBracket(text, open, "(", ")");
      if (close < 0) continue;
      const argument = text.slice(open + 1, close).trim();
      const literal = /^"([^"]*)"$/.exec(argument);
      if (literal) literals.set(literal[1], [...(literals.get(literal[1]) ?? []), { file, argument }]);
      else dynamic.push({ file, argument });
    }
  }
  return { literals, dynamic };
}

/** Methods that drain a bounded delivery-completion queue. Found by body, so a rename cannot hide one. */
function deliveryObserverMethods(sources) {
  return methodBodies(sources).filter((method) => /\bstate\.\w+\.(?:TryPeek|Observe)\(/.test(method.body));
}

/** Methods that take a new request off the inbound pipe. */
function inboundDrainMethods(sources) {
  return methodBodies(sources).filter((method) => method.body.includes(".TryDequeueInbound("));
}

/**
 * The passes that serve the bridge: methods that CALL an inbound drain.
 *
 * The drain itself is the mechanism, not a pass - asking the drain to observe completions before it
 * dequeues would be asking one method to do both jobs. The ordering invariant is about the caller that
 * decides what a tick does, and finding it through the call keeps it true when the caller is renamed.
 */
function bridgeServingMethods(sources, drains) {
  return methodBodies(sources).filter((method) =>
    drains.some((drain) => drain.name !== method.name && method.body.includes(`this.${drain.name}(`)),
  );
}

/**
 * A method body split where each `return;` ends one lane.
 *
 * "Lane" is the unit the ordering invariant is about: what a pass does before it yields, and what it
 * does after. A `return;` inside an early-exit gate ends the lane it sits in, which is exactly right -
 * nothing after it runs in that pass.
 */
function lanes(body) {
  const result = [];
  let start = 0;
  for (let index = body.indexOf("return;"); index >= 0; index = body.indexOf("return;", index + 1)) {
    result.push(body.slice(start, index));
    start = index + "return;".length;
  }
  result.push(body.slice(start));
  return result;
}

/**
 * One family's phase codes: each a fixed literal, emitted from exactly ONE place in the Mod.
 *
 * `required` is the published vocabulary a reader can grep for. The uniqueness half is computed from
 * every emission the Mod actually contains, so a code nobody listed still has to be emitted once.
 */
function assertPhaseCodes(sources, family, required) {
  const emissions = emitStageEmissions(sources);
  const familyLiterals = [...emissions.literals.keys()].filter((code) => code.startsWith(family));
  for (const code of required)
    assert.ok(familyLiterals.includes(code), `${code} is no longer emitted anywhere in the Mod`);
  for (const code of familyLiterals) {
    const sites = emissions.literals.get(code);
    assert.equal(
      sites.length,
      1,
      `${code} is emitted from ${sites.length} places (${sites.map((site) => site.file).join(", ")}); "exactly once" is what makes a phase code countable`,
    );
  }
  const computed = emissions.dynamic.filter((site) => site.argument.includes(family));
  assert.deepEqual(
    computed.map((site) => `${site.file}:${site.argument}`),
    [],
    "a phase code built from a value carries content across the diagnosis boundary; these codes are fixed",
  );
  // The delivery observers are where a response's fate is decided, so they must not log free text
  // beside the fixed codes - an id or a message body there would be the content-free boundary broken.
  const observers = deliveryObserverMethods(sources);
  assert.ok(observers.length > 0, "no method observes a bounded delivery queue any more");
  for (const observer of observers)
    assert.doesNotMatch(
      observer.body,
      /Monitor\.Log\(/,
      `${observer.name} emits a delivery phase code and also logs free text`,
    );
}

function config(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "navigation_mutation_v1",
      NavigationMutationTargetLabel: "game-derived-target",
    },
    ActionPolicyVersion: 0,
    EnabledActions: ["inspect_world_map", "find_destination", "navigate_to_destination"],
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function snapshot(location, revision, capabilities = CAPABILITIES) {
  return { revision, location, tile: { x: 1, y: 2 }, actionable: true, activeExecution: null, capabilities };
}

function fake({
  terminalState = "succeeded",
  terminalReason = "navigation_completed",
  evidence,
  decoy = false,
  duplicateTerminal = false,
  omitTerminal = false,
  freshLocation = "game-derived-target",
} = {}) {
  let location = "Farm";
  let revision = 4;
  const calls = [];
  const receipts = [];
  const client = {
    state: { snapshot: snapshot(location, revision), latestReceipt: null },
    observe: async () => {
      const value = snapshot(location, revision);
      client.state.snapshot = value;
      calls.push(["observe", location]);
      return value;
    },
    navigationRead: async ({ operation, args }) => {
      calls.push([operation, args]);
      if (operation === "inspect_world_map")
        return {
          status: "succeeded",
          reason: "world_map_observed",
          entries: [
            { label: location, destination: { kind: "label", label: location, ref: null } },
            { label: "game-derived-target", destination: { kind: "label", label: "game-derived-target", ref: null } },
          ],
        };
      assert.ok(args.query === "game-derived-target" || args.query === "game-deriv", `unexpected query ${args.query}`);
      if (args.query === "game-deriv") {
        // Semantic recall: the prefix query must surface the target among the
        // fuzzy candidates (the live gate proves the managed index recall).
        return {
          status: "candidates",
          reason: "fuzzy_match",
          candidates: [
            {
              label: "game-derived-target",
              contextLabel: null,
              destination: { kind: "ref", label: null, ref: "dr1_AAAAAAAAAAAAAAAAAAAAAA" },
              unlockState: "unknown",
            },
          ],
        };
      }
      return {
        status: "resolved",
        destination: { kind: "label", label: "game-derived-target", ref: null },
      };
    },
    execute: async (request) => {
      calls.push(["execute", request]);
      // The execution contract shape omits the read-result ref field.
      assert.deepEqual(request.args.destination, { kind: "label", label: "game-derived-target" });
      const accepted = {
        requestId: request.requestId,
        executionId: "execution-navigation",
        state: "accepted",
        reasonCode: "accepted",
        revision: 5,
      };
      if (decoy)
        receipts.push({ ...accepted, requestId: "decoy-request", state: "succeeded", reasonCode: terminalReason });
      location = freshLocation;
      revision = 5;
      const terminal = {
        ...accepted,
        state: terminalState,
        reasonCode: terminalReason,
        evidence: evidence ?? {
          detail: "destination=game-derived-target;location=game-derived-target;arrived=true;postcondition=true",
        },
      };
      if (!omitTerminal) receipts.push(terminal);
      if (duplicateTerminal) receipts.push({ ...terminal });
      client.state.latestReceipt = terminal;
      return accepted;
    },
  };
  return { client, receipts, calls };
}

test("producer facts flow through one typed mutation, exact correlation, and a fresh game-derived verifier", async () => {
  const harness = fake();
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
    terminalTimeoutMs: 50,
    postconditionTimeoutMs: 50,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.mutationCount, 1);
  assert.equal(harness.calls.filter(([kind]) => kind === "execute").length, 1);
  assert.deepEqual(
    harness.calls.map(([kind]) => kind),
    ["observe", "inspect_world_map", "find_destination", "find_destination", "execute", "observe", "find_destination"],
  );
  assert.equal(result.before.hasLocation, true);
  assert.equal(result.after.hasLocation, true);
  assert.equal(result.correlationVerified, true);
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.postconditionVerified, true);
  assert.equal(result.traceCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /Farm|game-derived-target|request-|execution-|arrived=true/);
});

test("localized destination label binds to receipt destination while fresh canonical location binds separately", async () => {
  const harness = fake({
    freshLocation: "CanonicalTargetIdentity",
    evidence: {
      detail: "destination=game-derived-target;location=CanonicalTargetIdentity;arrived=true;postcondition=true",
    },
  });
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
    terminalTimeoutMs: 50,
    postconditionTimeoutMs: 50,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.after.hasLocation, true);
  assert.doesNotMatch(JSON.stringify(result), /CanonicalTargetIdentity|game-derived-target/);
});

test("decoy request/execution correlation fails closed", async () => {
  const harness = fake({ decoy: true });
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
    terminalTimeoutMs: 50,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.stage, "execute");
  assert.equal(result.reasonCode, "navigation_mutation_decoy_receipt_observed");
});

test("blocked result identifies the last content-free smoke stage", async () => {
  const harness = fake();
  harness.client.observe = async () => {
    throw new Error("bridge_response_timeout");
  };
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config());
  assert.equal(result.state, "blocked");
  assert.equal(result.stage, "observe_before");
  assert.equal(result.reasonCode, "bridge_response_timeout");
  assert.equal(
    harness.calls.some(([kind]) => kind === "execute"),
    false,
  );
});

test("failed, empty-evidence, and stale completion outcomes fail closed", async (t) => {
  await t.test("failed terminal", async () => {
    const harness = fake({ terminalState: "failed", terminalReason: "navigation_failed" });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
      terminalTimeoutMs: 50,
    });
    assert.match(result.reasonCode, /^navigation_mutation_terminal_failed:failed:/);
  });
  await t.test("empty evidence", async () => {
    const harness = fake({ evidence: null });
    harness.client.execute = async (request) => {
      const accepted = {
        requestId: request.requestId,
        executionId: "execution-navigation",
        state: "accepted",
        reasonCode: "accepted",
        revision: 5,
      };
      harness.receipts.push({ ...accepted, state: "succeeded", reasonCode: "navigation_completed", evidence: null });
      return accepted;
    };
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
      terminalTimeoutMs: 50,
    });
    assert.equal(result.reasonCode, "navigation_mutation_evidence_empty");
  });
  await t.test("missing terminal outcome", async () => {
    const harness = fake({ omitTerminal: true });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
      terminalTimeoutMs: 5,
    });
    assert.equal(result.reasonCode, "native_terminal_receipt_missing_or_stale");
  });
  await t.test("multiple correlated terminal outcomes", async () => {
    const harness = fake({ duplicateTerminal: true });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
      terminalTimeoutMs: 50,
    });
    assert.equal(result.reasonCode, "navigation_mutation_terminal_receipt_count_invalid");
  });
  await t.test("stale or mismatched fresh postcondition", async () => {
    const harness = fake({ freshLocation: "Farm" });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
      terminalTimeoutMs: 50,
    });
    assert.equal(result.reasonCode, "navigation_mutation_fresh_location_mismatch");
  });
  await t.test("receipt destination does not match the selected label", async () => {
    const harness = fake({
      evidence: { detail: "destination=other-label;location=game-derived-target;arrived=true;postcondition=true" },
    });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
      terminalTimeoutMs: 50,
    });
    assert.equal(result.reasonCode, "navigation_mutation_evidence_destination_mismatch");
  });
  await t.test("non-isolated capability", async () => {
    const harness = fake();
    harness.client.observe = async () => snapshot("Farm", 4, CAPABILITIES.slice(1));
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config());
    assert.match(result.reasonCode, /native_required_capability_missing/);
  });
  await t.test("non-isolated topology", async () => {
    const harness = fake();
    const result = await runNavigationMutationSmoke(
      harness.client,
      harness.receipts,
      config({ Portfolio: { Enable: true } }),
    );
    assert.equal(result.reasonCode, "native_local_fixture_topology_not_isolated");
  });
});

test("source constraints forbid hardcoded destination, direct warp, and fixture world mutation", async () => {
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-navigation-mutation-smoke.mjs", import.meta.url),
    "utf8",
  );
  // The runner half is about CALL SHAPES, so it stays on the runner and names no private method: a
  // destination may only come from the world map, and the mutation must be the one typed execute.
  assert.match(
    runner,
    /inspect_world_map[\s\S]*NavigationMutationTargetLabel[\s\S]*find_destination[\s\S]*executeFresh[\s\S]*waitForTerminal[\s\S]*waitForFreshSnapshot/,
  );
  assert.doesNotMatch(
    runner,
    /warpFarmer|client\.travel|move_to_tile|destination:\s*\{\s*kind:\s*"label",\s*label:\s*"/,
  );

  // The Mod half is about the fixture's own preparation, and it is found by the SCENARIO LITERAL
  // rather than by `ModEntry.cs`: the branch moved to `ModEntry.Fixtures.cs` when that file was split,
  // and the previous assertion kept reading the old file, so it silently stopped covering anything.
  const sources = await readModSources();
  const blocks = scenarioGuardBlocks(sources, "navigation_mutation_v1");
  assert.ok(blocks.length > 0, "no fixture branch selects navigation_mutation_v1 any more");
  for (const block of blocks) {
    assert.doesNotMatch(
      block.body,
      /warpFarmer|Game1\.warp|terrainFeatures|objects\.|player\.Items|Position\s*=/,
      `${block.file}: the navigation-mutation fixture mutates the world, which it may never do`,
    );
  }
  const branch = blocks.map((block) => block.body).join("\n");
  assert.match(branch, /DerivedDestinationSet\.TryCreateCurrent/);
  assert.match(branch, /Game1NavigationWorldSource/);
  assert.match(branch, /NavigationRoutePlanner/);
  assert.match(branch, /NavigationMutationTargetLabel\s*=\s*selected\.CanonicalLabel/);
  assert.match(branch, /Helper\.WriteConfig/);
});

test("observe diagnosis uses fixed content-free phase codes", async () => {
  assertPhaseCodes(await readModSources(), "navigation_observe_", [
    "navigation_observe_dequeued",
    "navigation_observe_response_created",
    "navigation_observe_response_queued",
    "navigation_observe_response_enqueue_failed",
    "navigation_observe_response_missing",
    "navigation_observe_response_flushed",
    "navigation_observe_response_write_failed",
    "navigation_observe_response_flush_unconfirmed",
    "navigation_observe_response_delivery_untracked",
  ]);
});

test("execution boundary diagnosis uses fixed content-free phase codes", async () => {
  assertPhaseCodes(await readModSources(), "navigation_execution_", [
    "navigation_execution_dequeued",
    "navigation_execution_parse_rejected",
    "navigation_execution_response_created",
    // `navigation_execution_response_missing` was this slot's predecessor. `e01fb968` replaced it with
    // `held_for_body`: a request the Mod is HOLDING has no answer yet and must not be reported as a
    // missing response, so the old name would now assert a lie about the branch it labels.
    "navigation_execution_held_for_body",
    "navigation_execution_response_queued",
    "navigation_execution_response_enqueue_failed",
    "navigation_execution_response_flushed",
    "navigation_execution_response_write_failed",
    "navigation_execution_response_flush_unconfirmed",
    "navigation_execution_response_delivery_untracked",
  ]);
});

test("a tick polls every delivery completion before it drains new bridge requests", async () => {
  // The property the old `HandleObserve`/`ObserveNavigationPipeDeliveries` name list was reaching for:
  // a pass that answers a request must first settle the completions of the answers it already queued.
  // It is a CROSS-METHOD ordering fact, so it is asserted over method bodies found by what they do -
  // no private name is written here, and a rename cannot make it vacuous.
  //
  // Read it as a positive obligation, not as "every method": the Mod has two pumps (the fixture lane and
  // the formal/co-op lane) and each must serve completions first. A pass with no drain in it is not a
  // counter-example - there is no request ordering in it to get wrong.
  const sources = await readModSources();
  const observers = deliveryObserverMethods(sources);
  const drains = inboundDrainMethods(sources);
  const passes = bridgeServingMethods(sources, drains);
  assert.ok(observers.length > 0, "no method observes a bounded delivery queue any more");
  assert.ok(drains.length > 0, "no method drains the inbound bridge pipe any more");
  assert.ok(passes.length > 0, "no method serves the bridge any more");
  for (const pass of passes) {
    for (const lane of lanes(pass.body)) {
      // The lane ends where it first serves the pipe: that is the moment a new request can be answered.
      const first = drains
        .map((drain) => ({ name: drain.name, at: lane.indexOf(`this.${drain.name}(`) }))
        .filter((drain) => drain.at >= 0)
        .sort((left, right) => left.at - right.at)[0];
      if (!first) continue;
      const before = lane.slice(0, first.at);
      const observed = observers.filter((observer) => before.includes(`this.${observer.name}(`));
      assert.deepEqual(
        observed.map((observer) => observer.name).sort(),
        observers.map((observer) => observer.name).sort(),
        `${pass.name} drains a request before it observes these completions: ${observers
          .map((observer) => observer.name)
          .filter((name) => !observed.some((entry) => entry.name === name))
          .join(", ")}`,
      );
    }
  }
});
