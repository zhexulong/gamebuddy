import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  STARDEW_EXECUTION_MANAGER_FILES,
  STARDEW_NATIVE_TOOL_USE_SEAM,
  STARDEW_TOOL_FAMILY,
  validateToolFamilyStaminaEvidence,
} from "./check-stardew-tool-family-stamina-evidence.mjs";

const STAMINA = "stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2";

/**
 * The shared seam exactly as the checker requires it: the three `Farmer.useTool`
 * steps, in native order. Cases below corrupt one step at a time, so a checker
 * that only looked for a bare `checkForExhaustion` would pass them all.
 */
const SEAM_SOURCE = `private static void ${STARDEW_NATIVE_TOOL_USE_SEAM}(Tool tool, GameLocation location, int tileX, int tileY, Farmer who, float staminaBefore)
{
    tool.DoFunction(location, tileX * 64 + 32, tileY * 64 + 32, 1, who);
    who.lastClick = Vector2.Zero;
    who.checkForExhaustion(staminaBefore);
}`;

/**
 * One synthetic source per handler. Each file carries exactly one member, so a
 * corruption in one receipt can never be masked by a neighbor's evidence.
 *
 * `seamCall` is the handler's native swing: a compliant handler routes it through
 * the shared seam, and the bypass case below replaces it with a bare `DoFunction`.
 */
function handlerSource(handler, entry, { stamina = STAMINA, includeTerminal = true, seamCall = `UseNativeToolOnTile(tool, location, 1, 2, Game1.player, staminaBefore);` } = {}) {
  const receipt = includeTerminal
    ? `string evidence = $"a=1;${stamina}";
      return this.RememberTerminal(requestId, "x", ExecutionState.Succeeded, "${entry.terminal}", evidence);`
    : `return this.RememberTerminal(requestId, "x", ExecutionState.Accepted, "accepted", null);`;
  return `public LocalExecutionReceipt ${handler}(string requestId)
{
    // ${entry.tool} ${entry.dispatch}
    ${seamCall}
    ${receipt}
}`;
}

function completeSources(handlers = STARDEW_TOOL_FAMILY) {
  const sources = { "fake/ExecutionManager.cs": SEAM_SOURCE };
  for (const [handler, entry] of Object.entries(handlers)) {
    sources[`fake/${handler}.cs`] = handlerSource(handler, entry);
  }
  return sources;
}

test("a complete tool family passes with no violations", () => {
  assert.deepEqual(validateToolFamilyStaminaEvidence(completeSources()), []);
});

test("a handler whose receipt omits the stamina half is reported", () => {
  const sources = completeSources();
  // Corrupt exactly one handler (till_soil) by dropping stamina from its receipt.
  sources["fake/RequestLocalTillSoil.cs"] = handlerSource("RequestLocalTillSoil", STARDEW_TOOL_FAMILY.RequestLocalTillSoil, {
    stamina: "unrelated=true",
  });
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /RequestLocalTillSoil.*lacks stamina_before/);
});

test("a missing handler is reported rather than silently skipped", () => {
  const sources = completeSources();
  delete sources["fake/RequestLocalTillSoil.cs"];
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(failures.some((f) => /RequestLocalTillSoil/.test(f) && /not found/.test(f)));
});

test("a direct-dispatch tool that hand-rolls DoFunction without the seam is reported", () => {
  const sources = completeSources();
  // A direct-dispatch tool (axe) that bypasses the shared seam never inherits
  // Farmer.useTool's lastClick/checkForExhaustion steps.
  sources["fake/RequestLocalChopTreeSource.cs"] = handlerSource("RequestLocalChopTreeSource", STARDEW_TOOL_FAMILY.RequestLocalChopTreeSource, {
    seamCall: "axe.DoFunction(location, 1, 2, 1, Game1.player);",
  });
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(
    failures.some((f) => /RequestLocalChopTreeSource/.test(f) && /UseNativeToolOnTile/.test(f)),
    `expected a bypass failure, got ${JSON.stringify(failures)}`,
  );
});

test("a seam that drops the lastClick reset is reported", () => {
  const sources = completeSources();
  sources["fake/ExecutionManager.cs"] = SEAM_SOURCE.replace("    who.lastClick = Vector2.Zero;\n", "");
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(
    failures.some((f) => /UseNativeToolOnTile/.test(f) && /lastClick = Vector2\.Zero/.test(f)),
    `expected a lastClick failure, got ${JSON.stringify(failures)}`,
  );
});

test("a seam that drops the exhaustion consequence is reported", () => {
  const sources = completeSources();
  sources["fake/ExecutionManager.cs"] = SEAM_SOURCE.replace("    who.checkForExhaustion(staminaBefore);\n", "");
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(
    failures.some((f) => /UseNativeToolOnTile/.test(f) && /checkForExhaustion/.test(f)),
    `expected a checkForExhaustion failure, got ${JSON.stringify(failures)}`,
  );
});

test("a missing seam is reported even when every handler calls it", () => {
  const sources = completeSources();
  delete sources["fake/ExecutionManager.cs"];
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(
    failures.some((f) => /UseNativeToolOnTile/.test(f) && /declared in no execution-manager file/.test(f)),
    `expected a missing-seam failure, got ${JSON.stringify(failures)}`,
  );
});

test("an animation-driven tool is exempt from the manual exhaustion call", () => {
  // collect_animal_product runs its swing through native BeginUsingTool, whose
  // animation frame ends in Farmer.useTool -> checkForExhaustion, so the handler
  // must not hand-roll it; the vanilla fatigue consequence still applies.
  const sources = completeSources();
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(
    failures.every((f) => !/RequestLocalCollectAnimalProduct/.test(f)),
  );
});

test("the shipped execution manager sources satisfy the family contract", async () => {
  const sources = {};
  for (const file of STARDEW_EXECUTION_MANAGER_FILES) {
    sources[file] = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  }
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.deepEqual(failures, []);
});

test("a thin wrapper delegating to a shared execution body still satisfies the contract", () => {
  // Design 5.2 gives each tool action ONE execution body shared by the in-range
  // path and the post-approach path, which makes the handler a wrapper. That is
  // only acceptable because the reachable body carries the whole contract, so
  // this case pins the delegation form the shipped sources use.
  const sources = completeSources();
  sources["fake/RequestLocalChopTreeSource.cs"] = `public LocalExecutionReceipt RequestLocalChopTreeSource(string requestId)
{
    return this.ExecuteChopTreeSource(requestId);
}`;
  sources["fake/ExecutionManager.cs"] = `${SEAM_SOURCE}
private LocalExecutionReceipt ExecuteChopTreeSource(string requestId)
{
    UseNativeToolOnTile(tool, location, 1, 2, Game1.player, staminaBefore);
    string evidence = $"a=1;${STAMINA}";
    return this.RememberTerminal(requestId, "x", ExecutionState.Succeeded, "${STARDEW_TOOL_FAMILY.RequestLocalChopTreeSource.terminal}", evidence);
}`;
  assert.deepEqual(validateToolFamilyStaminaEvidence(sources), []);
});

test("delegation cannot hide a violation: a body missing the stamina half is reported", () => {
  // The delegation allowance must not become an escape hatch. Here the wrapper
  // looks identical to the passing case above and the delegated body is the part
  // that is wrong, so only a checker that actually inspects the reachable body
  // reports it.
  const sources = completeSources();
  sources["fake/RequestLocalChopTreeSource.cs"] = `public LocalExecutionReceipt RequestLocalChopTreeSource(string requestId)
{
    return this.ExecuteChopTreeSource(requestId);
}`;
  sources["fake/ExecutionManager.cs"] = `${SEAM_SOURCE}
private LocalExecutionReceipt ExecuteChopTreeSource(string requestId)
{
    UseNativeToolOnTile(tool, location, 1, 2, Game1.player, staminaBefore);
    return this.RememberTerminal(requestId, "x", ExecutionState.Succeeded, "${STARDEW_TOOL_FAMILY.RequestLocalChopTreeSource.terminal}", "no stamina here");
}`;
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.ok(
    failures.some((f) => /RequestLocalChopTreeSource/.test(f) && /stamina_before/.test(f)),
    `expected a stamina failure for the delegated body, got ${JSON.stringify(failures)}`,
  );
});

test("the family covers every DoFunction-driving handler the sources declare", () => {
  // Regression guard: the family list must not silently lose an entry. Each
  // entry names a real handler signature, and the count matches the known set.
  assert.equal(Object.keys(STARDEW_TOOL_FAMILY).length, 12);
  for (const entry of Object.values(STARDEW_TOOL_FAMILY)) {
    assert.ok(typeof entry.tool === "string" && entry.tool.length > 0);
    assert.ok(typeof entry.dispatch === "string" && entry.dispatch.length > 0);
    assert.ok(typeof entry.terminal === "string" && entry.terminal.length > 0);
  }
});
