import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  WORK_BRIEF_SCHEMA,
  checkWorkBrief,
  checkWorkBriefOwnership,
  compareWorkBriefDiff,
  createIncompleteWorkBriefHandoff,
  parseGitDiffPaths,
  validateFrozenWorkBrief,
} from "../src/work-brief.mjs";

const BASE_COMMIT = "a".repeat(40);
const WRONG_BASE_COMMIT = "b".repeat(40);
const brief = {
  schema: WORK_BRIEF_SCHEMA,
  gameId: "stardew",
  actionId: "equip_tool",
  baseCommit: BASE_COMMIT,
  contractVersion: 1,
  status: "frozen",
  effect: "mutation",
  claimScope: "Equip one policy-permitted tool through the game-owned action contract.",
  ownedPaths: ["integrations/stardew/action-development/**"],
  sharedHubs: [],
  requiredPortfolioEntries: ["equip-tool-contract-check", "package-deterministic-tests"],
  checks: ["pnpm test"],
  liveAuthorized: false,
};

function observation(overrides = {}) {
  return {
    baseCommit: BASE_COMMIT,
    changedPaths: ["integrations/stardew/action-development/src/portfolio.mjs"],
    completedChecks: ["pnpm test"],
    portfolioEntries: ["equip-tool-contract-check", "package-deterministic-tests"],
    ...overrides,
  };
}

test("accepts only a complete frozen work brief with exact identity and base", () => {
  const validated = validateFrozenWorkBrief(brief, {
    expectedGameId: "stardew",
    expectedActionId: "equip_tool",
    expectedBaseCommit: BASE_COMMIT,
  });
  assert.equal(validated.actionId, "equip_tool");
  assert.equal(validated.baseCommit, BASE_COMMIT);
  assert.deepEqual(validated.requiredPortfolioEntries, ["equip-tool-contract-check", "package-deterministic-tests"]);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.ownedPaths));
});

test("rejects drafts, unknown keys, identity drift, missing required content, and authorization drift", () => {
  assert.throws(() => validateFrozenWorkBrief({ ...brief, status: "draft" }), /not_frozen/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, unexpected: true }), /invalid_shape/);
  assert.throws(() => validateFrozenWorkBrief(brief, { expectedActionId: "enter_mine" }), /action_mismatch/);
  assert.throws(() => validateFrozenWorkBrief(brief, { expectedBaseCommit: WRONG_BASE_COMMIT }), /base_commit_mismatch/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, ownedPaths: [] }), /missing_required_content/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, requiredPortfolioEntries: ["entry", "ENTRY"] }), /invalid_required_portfolio_entries_duplicate/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, checks: ["pnpm test", "PNPM TEST"] }), /invalid_checks_duplicate/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, liveAuthorized: "false" }), /invalid_live_authorization/);
});

test("admits only explicitly owned paths and separately reports shared hubs", () => {
  const guarded = {
    ...brief,
    ownedPaths: ["integrations/stardew/action-development/**", "packages/game-action-devkit/src/work-brief.mjs"],
    sharedHubs: ["pnpm-workspace.yaml"],
  };
  assert.deepEqual(checkWorkBriefOwnership(guarded, [
    "integrations/stardew/action-development/src/portfolio.mjs",
    "pnpm-workspace.yaml",
  ]), {
    ownedPaths: ["integrations/stardew/action-development/src/portfolio.mjs"],
    sharedHubPaths: ["pnpm-workspace.yaml"],
  });
  assert.throws(() => checkWorkBriefOwnership(guarded, ["host/src/main.ts"]), /changed_path_unowned/);
  assert.throws(() => checkWorkBriefOwnership({ ...brief, ownedPaths: ["../escape"] }, []), /invalid_owned_paths/);
  assert.throws(() => checkWorkBriefOwnership(guarded, ["../escape"]), /invalid_changed_paths/);
  assert.throws(() => checkWorkBriefOwnership(guarded, new Proxy([], {})), /invalid_changed_paths/);
});

test("compares a clean supplied Git diff against the exact base and required checks", () => {
  const result = compareWorkBriefDiff(brief, observation({
    diff: "M\tintegrations/stardew/action-development/src/portfolio.mjs\n",
    changedPaths: undefined,
  }));
  assert.deepEqual(result.ownedPaths, ["integrations/stardew/action-development/src/portfolio.mjs"]);
  assert.deepEqual(result.sharedHubPaths, []);
  assert.equal(result.baseCommit, BASE_COMMIT);
  assert.equal(result.status, "accepted");
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(parseGitDiffPaths("M\tintegrations/stardew/action-development/src/portfolio.mjs\n"), [
    "integrations/stardew/action-development/src/portfolio.mjs",
  ]);
  assert.deepEqual(parseGitDiffPaths("diff --git a/integrations/stardew/action-development/src/portfolio.mjs b/integrations/stardew/action-development/src/portfolio.mjs\n--- a/integrations/stardew/action-development/src/portfolio.mjs\n+++ b/integrations/stardew/action-development/src/portfolio.mjs\n"), [
    "integrations/stardew/action-development/src/portfolio.mjs",
  ]);
});

test("parses rename metadata and Git name-status rename records without changing path names", () => {
  assert.deepEqual(parseGitDiffPaths("similarity index 100%\nrename from old farm name.txt\nrename to new farm name.txt\n"), [
    "old farm name.txt",
    "new farm name.txt",
  ]);
  assert.deepEqual(parseGitDiffPaths("R100\told farm name.txt\tnew farm name.txt\n"), [
    "old farm name.txt",
    "new farm name.txt",
  ]);
  const nul = String.fromCharCode(0);
  assert.deepEqual(parseGitDiffPaths(`R100${nul}a/old farm name.txt${nul}b/new farm name.txt${nul}`), [
    "a/old farm name.txt",
    "b/new farm name.txt",
  ]);
});

test("rejects wrong base, unowned paths, and missing required checks", () => {
  assert.throws(() => compareWorkBriefDiff(brief, observation({ baseCommit: WRONG_BASE_COMMIT })), /base_commit_mismatch/);
  assert.throws(() => compareWorkBriefDiff(brief, observation({ changedPaths: ["host/src/main.ts"] })), /changed_path_unowned/);
  assert.throws(() => compareWorkBriefDiff(brief, observation({ completedChecks: [] })), /missing_required_checks/);
});

test("rejects case-fold collisions instead of treating them as owned", () => {
  assert.throws(() => checkWorkBriefOwnership(brief, ["INTEGRATIONS/stardew/action-development/src/portfolio.mjs"]), /changed_path_case_collision/);
  assert.throws(() => checkWorkBriefOwnership(brief, [
    "integrations/stardew/action-development/src/portfolio.mjs",
    "INTEGRATIONS/stardew/action-development/src/portfolio.mjs",
  ]), /invalid_changed_paths_case_collision/);
  assert.throws(() => validateFrozenWorkBrief({
    ...brief,
    ownedPaths: ["Packages/Devkit/**", "packages/devkit/src/work-brief.mjs"],
  }), /path_boundary_overlap/);
});

test("rejects live execution without explicit brief authorization", () => {
  assert.throws(() => compareWorkBriefDiff(brief, observation({ stage: "live" })), /live_unauthorized/);
  const authorized = { ...brief, liveAuthorized: true };
  assert.equal(compareWorkBriefDiff(authorized, observation({ stage: "live" })).stage, "live");
});

test("accepts an injected observer and passes only bounded identity context", async () => {
  let context;
  const result = await checkWorkBrief(brief, {
    gitObserver: async (input) => {
      context = input;
      return observation();
    },
    timeoutMs: 500,
  });
  assert.deepEqual(context, { gameId: "stardew", actionId: "equip_tool", baseCommit: BASE_COMMIT });
  assert.equal(result.status, "accepted");
});

test("emits a structured timeout/failure handoff without raw process errors", async () => {
  const timedOut = await checkWorkBrief(brief, {
    gitObserver: () => new Promise(() => {}),
    timeoutMs: 10,
    stage: "check",
  });
  assert.deepEqual(timedOut, {
    schema: "gamebuddy-action-work-brief-handoff/v1",
    status: "incomplete",
    verdict: "uncertain",
    reasonCode: "timeout",
    timedOut: true,
    gameId: "stardew",
    actionId: "equip_tool",
    baseCommit: BASE_COMMIT,
    stage: "check",
    ownedPaths: [],
    sharedHubPaths: [],
    requiredChecks: ["pnpm test"],
    completedChecks: [],
  });
  assert.equal(Object.hasOwn(timedOut, "error"), false);

  const failure = await checkWorkBrief(brief, {
    gitObserver: async () => { throw new Error("SECRET_RAW_PROCESS_ERROR"); },
    timeoutMs: 500,
  });
  assert.equal(failure.status, "incomplete");
  assert.equal(failure.reasonCode, "observer_failure");
  assert.doesNotMatch(JSON.stringify(failure), /SECRET_RAW_PROCESS_ERROR/);

  const direct = createIncompleteWorkBriefHandoff(brief, { reasonCode: "check_failure", stage: "preflight" });
  assert.equal(direct.reasonCode, "check_failure");
  assert.equal(Object.hasOwn(direct, "error"), false);
});

test("rejects accessors, hidden or symbol fields, unsafe paths, and unbounded list content", () => {
  const accessor = { ...brief };
  Object.defineProperty(accessor, "status", { enumerable: true, get: () => "frozen" });
  assert.throws(() => validateFrozenWorkBrief(accessor), /invalid_shape/);
  const hidden = { ...brief };
  Object.defineProperty(hidden, "hidden", { value: true });
  assert.throws(() => validateFrozenWorkBrief(hidden), /invalid_shape/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, [Symbol("hidden")]: true }), /invalid_shape/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, ownedPaths: ["x".repeat(513)] }), /invalid_owned_paths/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, checks: Array.from({ length: 65 }, (_, index) => `check-${index}`) }), /invalid_checks/);
  const proxy = new Proxy({ ...brief }, { get: (target, key, receiver) => key === "status" ? "frozen" : Reflect.get(target, key, receiver) });
  assert.throws(() => validateFrozenWorkBrief(proxy), /invalid_shape/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, checks: new Proxy(["pnpm test"], {}) }), /invalid_checks/);
  const { proxy: revoked, revoke } = Proxy.revocable({ ...brief }, {});
  revoke();
  assert.throws(() => validateFrozenWorkBrief(revoked), /invalid_shape/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, baseCommit: "A".repeat(40) }), /invalid_base_commit/);
});

test("schema declares the frozen brief fields and rejects extension by contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/game-action-work-brief.v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$id, "https://gamebuddy.local/game-action-devkit/schemas/game-action-work-brief.v1.schema.json");
  for (const field of ["baseCommit", "gameId", "actionId", "ownedPaths", "sharedHubs", "requiredPortfolioEntries", "checks", "liveAuthorized"]) {
    assert.ok(schema.required.includes(field));
  }
  assert.equal(schema.additionalProperties, false);
});
