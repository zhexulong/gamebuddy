import assert from "node:assert/strict";
import test from "node:test";
import { checkWorkBriefOwnership, validateFrozenWorkBrief } from "../src/work-brief.mjs";

const brief = {
  schema: "gamebuddy-action-work-brief/v1", gameId: "stardew", actionId: "equip_tool", contractVersion: 1,
  status: "frozen", effect: "mutation", claimScope: "Equip one policy-permitted tool through the game-owned action contract.",
  ownedPaths: ["integrations/stardew/action-development/**"], sharedHubs: [], checks: ["pnpm test"],
};

test("accepts only a complete frozen work brief with exact identity", () => {
  const validated = validateFrozenWorkBrief(brief, { expectedGameId: "stardew", expectedActionId: "equip_tool" });
  assert.deepEqual(validated.actionId, "equip_tool");
  assert.ok(Object.isFrozen(validated));
});

test("rejects drafts, unknown keys, identity drift, and incomplete ownership/check content", () => {
  assert.throws(() => validateFrozenWorkBrief({ ...brief, status: "draft" }), /not_frozen/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, unexpected: true }), /invalid_shape/);
  assert.throws(() => validateFrozenWorkBrief(brief, { expectedActionId: "enter_mine" }), /action_mismatch/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, ownedPaths: [] }), /missing_required_content/);
  assert.throws(() => validateFrozenWorkBrief({ ...brief, checks: ["pnpm test", "PNPM TEST"] }), /invalid_checks_duplicate/);
});

test("admits only explicitly owned paths and separately reports shared hubs", () => {
  const guarded = { ...brief, ownedPaths: ["integrations/stardew/action-development/**", "packages/game-action-devkit/src/work-brief.mjs"], sharedHubs: ["pnpm-workspace.yaml"] };
  assert.deepEqual(checkWorkBriefOwnership(guarded, ["integrations/stardew/action-development/src/portfolio.mjs", "pnpm-workspace.yaml"]), {
    ownedPaths: ["integrations/stardew/action-development/src/portfolio.mjs"],
    sharedHubPaths: ["pnpm-workspace.yaml"],
  });
  assert.throws(() => checkWorkBriefOwnership(guarded, ["host/src/main.ts"]), /changed_path_unowned/);
  assert.throws(() => checkWorkBriefOwnership({ ...brief, ownedPaths: ["../escape"] }, []), /invalid_owned_paths/);
  assert.throws(() => checkWorkBriefOwnership(guarded, ["../escape"]), /invalid_changed_paths/);
  assert.throws(() => checkWorkBriefOwnership(guarded, new Proxy([], {})), /invalid_changed_paths/);
});

test("rejects accessors, hidden or symbol fields, and unbounded list content", () => {
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
});
