import assert from "node:assert/strict";
import test from "node:test";
import { evaluateToolsBoundaries, loadBaseline, runDepcruiseJson } from "./check-tools-boundaries.mjs";

test("blocks when zero modules are examined", () => {
  const result = evaluateToolsBoundaries({ modules: [], summary: { violations: [] } }, []);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "zero_modules_examined");
});

test("fails when a new generic-to-game warning or boundary error appears", () => {
  const baseline = [
    {
      rule: "generic-tools-must-not-depend-on-game-tools",
      severity: "warn",
      from: "tools/prelive.mjs",
      to: "tools/stardew-action-gate-descriptors.mjs",
    },
  ];
  const report = {
    modules: [{ source: "tools/prelive.mjs" }, { source: "tools/new-helper.mjs" }],
    summary: {
      violations: [
        {
          rule: { name: "generic-tools-must-not-depend-on-game-tools", severity: "warn" },
          from: "tools/prelive.mjs",
          to: "tools/stardew-action-gate-descriptors.mjs",
        },
        {
          rule: { name: "generic-tools-must-not-depend-on-game-tools", severity: "warn" },
          from: "tools/new-helper.mjs",
          to: "tools/lib/stardew-live-run.mjs",
        },
        {
          rule: { name: "tools-must-not-import-disposable-host-test-artifacts", severity: "error" },
          from: "tools/new-helper.mjs",
          to: "host/dist-test/protocol.js",
        },
      ],
    },
  };

  const result = evaluateToolsBoundaries(report, baseline);
  assert.equal(result.verdict, "failed");
  assert.equal(result.newViolations.length, 2);
  assert.equal(result.staleBaseline.length, 0);
});

test("fails when a baseline entry is resolved and becomes stale", () => {
  const baseline = [
    {
      rule: "no-tools-circular-dependencies",
      severity: "error",
      from: "tools/lib/a.mjs",
      to: "tools/lib/b.mjs",
    },
  ];
  const report = {
    modules: [{ source: "tools/lib/a.mjs" }],
    summary: { violations: [] },
  };

  const result = evaluateToolsBoundaries(report, baseline);
  assert.equal(result.verdict, "failed");
  assert.equal(result.staleBaseline.length, 1);
  assert.equal(result.staleBaseline[0].from, "tools/lib/a.mjs");
});

test("passes on the real repository baseline", () => {
  const probe = runDepcruiseJson();
  assert.equal(probe.ok, true, probe.reason ?? "depcruise should succeed");
  const baseline = loadBaseline();
  assert.equal(baseline.ok, true, "baseline file must exist");
  const result = evaluateToolsBoundaries(probe.report, baseline.entries);
  assert.equal(result.verdict, "passed");
  assert.ok(result.modulesExamined > 0);
});
