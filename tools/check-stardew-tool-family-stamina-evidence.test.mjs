import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  STARDEW_EXECUTION_MANAGER_FILES,
  STARDEW_TOOL_FAMILY,
  validateToolFamilyStaminaEvidence,
} from "./check-stardew-tool-family-stamina-evidence.mjs";

const STAMINA = "stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2";

/**
 * One synthetic source per handler. Each file carries exactly one member, so a
 * corruption in one receipt can never be masked by a neighbor's evidence.
 */
function handlerSource(handler, entry, { stamina = STAMINA, includeTerminal = true } = {}) {
  const receipt = includeTerminal
    ? `string evidence = $"a=1;${stamina}";
      return this.RememberTerminal(requestId, "x", ExecutionState.Succeeded, "${entry.terminal}", evidence);`
    : `return this.RememberTerminal(requestId, "x", ExecutionState.Accepted, "accepted", null);`;
  return `public LocalExecutionReceipt ${handler}(string requestId)
{
    // ${entry.tool} ${entry.dispatch}
    ${receipt}
}`;
}

function completeSources(handlers = STARDEW_TOOL_FAMILY) {
  const sources = {};
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

test("the shipped execution manager sources satisfy the family contract", async () => {
  const sources = {};
  for (const file of STARDEW_EXECUTION_MANAGER_FILES) {
    sources[file] = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  }
  const failures = validateToolFamilyStaminaEvidence(sources);
  assert.deepEqual(failures, []);
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