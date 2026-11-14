#!/usr/bin/env node
/**
 * The falsifiers for `tools/check-stardew-lifecycle-pins.mjs`.
 *
 * Every case below is a reading the gate must be able to get RIGHT in both directions: the pin it names, the rule it
 * leaves alone, the declaration it accepts, and the population it refuses to pass over. The one that matters most is
 * `a literal pin of one action's rung is named`: it is the class both Core failures of 2026-11-14 belonged to, and it
 * is red on the shape that shipped twice that day.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  baselineCounts,
  baselineFrom,
  DEFINITIONS_PATH,
  evaluateLifecyclePins,
  findLifecyclePins,
  PIN_MARKER,
  readBaseline,
  readLifecyclePins,
  readLifecycleRungs,
  TESTS_ROOT,
} from "./check-stardew-lifecycle-pins.mjs";
import { readStardewActionIds } from "./lib/stardew-published-action-registry.mjs";

const GATE = fileURLToPath(new URL("./check-stardew-lifecycle-pins.mjs", import.meta.url));

const RUNGS = readLifecycleRungs(readFileSync(DEFINITIONS_PATH, "utf8"));
const ACTION_IDS = readStardewActionIds({ registrationsPath: DEFINITIONS_PATH });

/** One synthetic test file classified against the REAL catalog vocabulary. */
function classify(body, file = "SyntheticActionTests.cs") {
  return findLifecyclePins({ file, source: body, actionIds: ACTION_IDS, rungs: RUNGS });
}

function codesOf(findings) {
  return findings.map((finding) => finding.code);
}

/** A tree of synthetic test files, read end to end so the declaration and marker paths are exercised too. */
function withTree(files, run) {
  const directory = mkdtempSync(path.join(tmpdir(), "stardew-lifecycle-pins-"));
  try {
    mkdirSync(path.join(directory, "GameBuddy.Stardew.Core.Tests"), { recursive: true });
    for (const [name, body] of Object.entries(files))
      writeFileSync(path.join(directory, "GameBuddy.Stardew.Core.Tests", name), body);
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The gate's own report line for one file, without a baseline and without a tree. */
function findingFor(body) {
  const classified = classify(body);
  return codesOf(evaluateLifecyclePins({ reading: { pins: classified.pins, findings: [] }, recorded: new Map() }));
}

const PINNED_ROW = `
using FluentAssertions;
namespace GameBuddy.Stardew.Core.Tests;

public sealed class ScytheActionTests
{
    [Fact]
    public void Registered()
    {
        FarmhandActionRegistration reg = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "cut_weeds");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
    }
}
`;

test("a literal pin of one action's rung is named, with the action and the rung", () => {
  assert.deepEqual(findingFor(PINNED_ROW), [
    "lifecycle_literal_pinned_in_a_test:SyntheticActionTests.cs:cut_weeds:LiveVerified",
  ]);
});

test("the deriving form a fixed pin becomes is not a pin", () => {
  const derived = `
    ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions())
        .Should().Contain("cut_weeds", "a promoted action is on the Agent surface with no opt-in");
  `;
  assert.deepEqual(findingFor(derived), []);
});

test("a lifecycle RULE over a derived set is not a pin", () => {
  const rules = `
    FarmhandActionCatalog.Registrations
        .Where(entry => entry.Lifecycle == FarmhandActionLifecycle.Experimental)
        .Select(entry => entry.ActionId)
        .Should().BeEquivalentTo(experimentalIds);
    registration.Lifecycle.Should().BeOneOf(
        new[] { FarmhandActionLifecycle.Published, FarmhandActionLifecycle.LiveVerified },
        "a program node may only name a published or live-verified action");
    services.AddScoped(provider => provider.GetRequiredService<Store>());
  `;
  assert.deepEqual(
    findLifecyclePins({
      file: "Rules.cs",
      source: rules,
      actionIds: ACTION_IDS,
      rungs: RUNGS,
    }).pins,
    [],
  );
});

test("another enum's Lifecycle is not this population", () => {
  const other = `
    private static readonly ServiceDescriptor Descriptor =
        new(typeof(Store), typeof(Store), ServiceLifetime.Scoped);
    options.AddSingleton(new Microsoft.Extensions.DependencyInjection.ServiceDescriptor(typeof(Store), typeof(Store), ServiceLifetime.Singleton));
    store.Lifecycle.Should().Be(StoreLifecycle.Open);
  `;
  // `StoreLifecycle.Open` is not a FarmhandActionLifecycle member; `ServiceLifetime` is a different enum entirely.
  assert.deepEqual(findingFor(other), []);
});

test("a declaration with a stated reason is accepted AND printed", () => {
  withTree(
    {
      "FixtureActionTests.cs": `
public sealed class FixtureActionTests
{
    [Fact]
    public void Registered()
    {
        FarmhandActionRegistration reg = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "cut_weeds");
        // lifecycle-pin: this fixture must stay Experimental so the opt-in path has a rung to opt into
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
    }
}
`,
    },
    (directory) => {
      const reading = readLifecyclePins({ testsRoot: directory });
      assert.deepEqual(codesOf(evaluateLifecyclePins({ reading, recorded: new Map() })), []);
      assert.equal(reading.pins.length, 1, "the pin is still counted, so the declaration is visible in the population");
      assert.equal(reading.declarations.length, 1);
      assert.match(reading.declarations[0].reason, /opt-in path/u);
    },
  );
});

test("a declaration without a reason is a finding, not an exemption", () => {
  withTree(
    {
      "FixtureActionTests.cs": `
public sealed class FixtureActionTests
{
    [Fact]
    public void Registered()
    {
        FarmhandActionRegistration reg = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "cut_weeds");
        ${PIN_MARKER} needed
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
    }
}
`,
    },
    (directory) => {
      const codes = codesOf(readLifecyclePins({ testsRoot: directory }).findings);
      assert.equal(codes.length, 1);
      assert.match(
        codes[0],
        /^lifecycle_pin_marker_has_no_reason:GameBuddy\.Stardew\.Core\.Tests\/FixtureActionTests\.cs:\d+$/u,
      );
    },
  );
});

test("a declaration three lines above a pin does not excuse it", () => {
  withTree(
    {
      "FixtureActionTests.cs": `
public sealed class FixtureActionTests
{
    [Fact]
    public void Registered()
    {
        FarmhandActionRegistration reg = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "cut_weeds");
        ${PIN_MARKER} this reason is long enough to be accepted if it were beside the pin

        reg.Should().NotBeNull();
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
    }
}
`,
    },
    (directory) => {
      const reading = readLifecyclePins({ testsRoot: directory });
      assert.deepEqual(codesOf(evaluateLifecyclePins({ reading, recorded: new Map() })), [
        "lifecycle_literal_pinned_in_a_test:GameBuddy.Stardew.Core.Tests/FixtureActionTests.cs:cut_weeds:Experimental",
      ]);
    },
  );
});

test("a pin the reader cannot attribute is named rather than dropped", () => {
  const loop = `
    [Fact]
    public void EveryLaneActionIsVerified()
    {
        foreach (FarmhandActionRegistration registration in LaneActions)
            registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
    }
  `;
  const classified = findLifecyclePins({
    file: "TwoActions.cs",
    source: loop,
    actionIds: ACTION_IDS,
    rungs: RUNGS,
  });
  assert.equal(classified.pins.length, 1);
  assert.equal(classified.pins[0].actionId, "unattributed");
  assert.deepEqual(codesOf(evaluateLifecyclePins({ reading: { ...classified, findings: [] }, recorded: new Map() })), [
    "lifecycle_literal_pinned_in_a_test:TwoActions.cs:unattributed:LiveVerified",
  ]);
});

test("the ratchet turns both ways: an unrecorded pin is red, and a paid entry must be deleted", () => {
  const reading = { pins: classify(PINNED_ROW).pins, findings: [] };
  const recorded = new Map([
    ["SyntheticActionTests.cs:cut_weeds:LiveVerified", 1],
    ["SyntheticActionTests.cs:gone_action:Published", 1],
  ]);
  assert.deepEqual(codesOf(evaluateLifecyclePins({ reading, recorded })), [
    "lifecycle_pin_baseline_entry_stale:SyntheticActionTests.cs:gone_action:Published",
  ]);
});

test("the baseline is keyed by content, so a pin moved down a file is the same pin", () => {
  const moved = PINNED_ROW.replace(
    "    [Fact]",
    Array.from({ length: 20 }, (_, index) => `    // filler ${index}`).join("\n") + "\n    [Fact]",
  );
  const before = classify(PINNED_ROW);
  const after = classify(moved);
  const recorded = baselineCounts(baselineFrom({ pins: before.pins }).entries);
  assert.equal(before.pins[0].line === after.pins[0].line, false, "the line moved, so a line-keyed record would drift");
  assert.deepEqual(codesOf(evaluateLifecyclePins({ reading: { ...after, findings: [] }, recorded })), []);
});

test("the rung population is the enum declaration, so a new rung is in scope", () => {
  const rungs = readLifecycleRungs(
    "public enum FarmhandActionLifecycle { Published, LiveVerified, Experimental, Retired }",
  );
  assert.deepEqual(rungs, ["Published", "LiveVerified", "Experimental", "Retired"]);
  assert.throws(() => readLifecycleRungs("public enum SomethingElse { A }"), /no_lifecycle_enum/u);
});

test("a run over no test file is a blocked reading, never a pass", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "stardew-lifecycle-pins-empty-"));
  try {
    const run = () => execFileSync(process.execPath, [GATE, "--tests-root", empty], { encoding: "utf8" });
    assert.throws(run, (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /stardew_lifecycle_pins_no_population/u);
      return true;
    });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the real tests tree holds no pin outside the recorded debt", () => {
  const reading = readLifecyclePins();
  assert.ok(reading.filesExamined > 0, "a reading over zero test files would agree with itself");

  const entries = readBaseline(BASELINE_PATH);
  const findings = evaluateLifecyclePins({ reading, recorded: baselineCounts(entries) });
  assert.deepEqual(
    codesOf(findings),
    [],
    "a pin that is not in the baseline must be derived, and a paid entry deleted",
  );

  for (const file of ["BreakResourceClumpRegistrationTests.cs", "OpenGeodeWireContractTests.cs"])
    assert.deepEqual(
      reading.pins.filter((pin) => pin.file.endsWith(file)).map((pin) => pin.file),
      [],
      `${file} derives its action's reach from the policy engine; a rung literal there is the pin this gate exists for`,
    );
});

test("the tree the gate reads is the Mod test tree, not one project", () => {
  assert.match(TESTS_ROOT.replaceAll("\\", "/"), /integrations\/stardew\/tests$/u);
  const projects = new Set(
    readLifecyclePins()
      .pins.map((pin) => pin.file.split("/")[0])
      .filter((project) => project.endsWith(".Tests")),
  );
  assert.ok(projects.size >= 2, `one project's reading says nothing about the others; saw ${[...projects].join(", ")}`);
});
