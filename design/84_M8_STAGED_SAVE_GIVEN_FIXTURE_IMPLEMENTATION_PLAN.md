# M8 Staged-Save Given Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a transaction-owned, test-only staged-save fixture that can establish explicit M8 world Given facts while proving the canonical Stardew save is never written and preserving independent action authority and closure.

**Architecture:** The launcher creates a new, uniquely named staged slot by copying an approved canonical slot after a full slot-directory manifest. A named, action-specific fixture declaration may make a small, target-version-validated set of save changes to the staged slot only, such as player location/position, inventory, Mine progress, and source-backed Mine state needed for the declared Given. The normal one-action Portfolio profile then loads that staged slot; the game-thread action independently observes and revalidates its Given before its own native commit. The fixture has no bridge route, Agent input, receipt, evidence, execution, policy, or postcondition authority. Cleanup proves the canonical slot unchanged and removes only a staged root proven transaction-owned.

**Tech Stack:** Stardew Valley `1.6.15` build `24356`; SMAPI; target-bound C# Mod; Node.js ESM launcher/profile tooling; XML parsing; SHA-256 directory manifests; Node test runner.

**Spec:** `design/80_M8_ENTER_MINE_ACTION_IMPLEMENTATION_PLAN.md`, `design/81_M8_MINE_ENTRY_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, and `fixtures/stardew/portfolio-m8-elevator-contract.example.json`.

## Global Constraints

- This is validation infrastructure, not a published GameBuddy capability, bridge route, Host tool, Mod configuration surface, or Agent-selectable action.
- A fixture can establish only the explicitly declared **Given** for one named action-specific live transaction. It must not materialize that action's declared native transition, terminal result, receipt evidence, or fresh postcondition.
- The canonical slot is read-only to the transaction. Any byte or manifest mismatch before, during, or after a staged run fails closed; staged contents must never be copied back over canonical contents.
- The staged slot is a new exact transaction-owned root. Existing stage roots, unproven ownership, invalid/existing locks, root overlap, unreadable paths, or any reparse point in an examined ancestor fail closed.
- A fixture declaration is a closed schema, not a general XML-path patcher. It must list each permitted source-backed field/value and reject unknown fields, duplicate XML nodes, malformed values, fallback save files, or fields outside the allowed target-version save schema.
- Approved staged Given fields may include player location/position, inventory, Mine/world progress, and target-version-serialized Mine state when the named fixture declares and validates them. They do not grant raw warp, generic map editing, ladder generation, or arbitrary item/world mutation authority to an action, bridge caller, or Agent. The separately approved, closed `m8_ladder_given_v1` runtime setup in `design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md` is not staged-save authority: it alone may create one native ladder in the loaded transaction-owned validation world after the fixed floor-2 warp.
- Production action code, the Host, bridge requests, Mod config, and runners must not directly edit any save. The launcher-owned staged fixture is the only exception and is unavailable outside an explicitly armed validation transaction.
- The fixture cannot write or modify request IDs, execution IDs, idempotency records, scopes, policy, receipts, evidence, action results, postconditions, journals presented as action evidence, or native-correlation facts.
- The target version must load the staged slot normally. A preflight must freshly observe the requested Given in the live game; serialized setup alone never satisfies action admission or closure. For `m8_ladder_given_v1`, serialized progress is fixed to floor 2 and followed by the separate fixed, Mod-owned pre-binding native facility route in `design/87_M8_LADDER_NATIVE_FACILITY_GIVEN_IMPLEMENTATION_PLAN.md`; it internally selects one clear current-map tile, invokes one `MineShaft.createLadderDown`, and cannot receive a destination/pose/tile parameter or alter this fixture declaration's save authority.
- Each M8 action still runs in its own default-deny one-action profile, has its own typed request, game-thread authorization, native seam, terminal receipt, non-empty evidence, fresh same-execution postcondition, review, and one serial mutation gate.
- UI/menu automation, keyboard/mouse/XInput, visual/input injection, generic dispatch, raw native-call fallback, and canonical-save writes remain prohibited.

---

## Fixture declaration

Every future fixture is a versioned, named declaration checked by the launcher; no caller supplies an XML selector, slot path, coordinate, item ID, floor, or arbitrary value.

```ts
type M8StagedSaveFixtureDeclaration = Readonly<{
  fixtureId: "m8_ladder_given_v1" | "m8_elevator_floor_5_given_v1";
  actionId: "use_mine_ladder" | "select_mine_elevator_floor";
  target: Readonly<{
    gameVersion: "1.6.15.24356";
    assemblySha256: string;
  }>;
  stagedSlotSuffix: string;
  allowedGiven: Readonly<{
    player?: Readonly<{ location: string; tileX: number; tileY: number }>;
    inventory?: readonly Readonly<{ qualifiedItemId: string; stack: number }>;
    mine?: Readonly<{
      currentFloor: number;
      lowestMineLevel: number;
      lowestMineLevelForOrder: -1;
      serializedState: "target_version_named_fields_only";
    }>;
  }>;
}>;
```

The implementation may narrow this declaration after target-source and serialized-save inspection. It must never broaden it into free-form XML edits or caller-provided values. A declaration may establish a source-backed floor, player state, inventory, progress, or Mine state only when all of the following are true:

1. its governing M8 action plan declares the fact as Given rather than action result;
2. target-version source and a fixture test identify the exact serialized representation;
3. a loaded-game preflight observes the fact without sending the action request; and
4. the declaration cannot encode the action's terminal result, receipt, evidence, or postcondition.

## File Structure

- Create: `tools/lib/stardew-portfolio-staged-save-fixture.mjs` — isolated canonical/staged manifest, lock, copy, patch, verification, and ownership APIs; no action request code.
- Create: `tools/lib/stardew-portfolio-staged-save-fixture.test.mjs` — filesystem/XML rejection, canonical-integrity, and exact-diff contracts.
- Modify: `tools/launch-stardew-portfolio-m8-action-live.mjs` and tests — accept only a named fixture ID for the matching one-action live transaction, then load its staged slot.
- Modify: `tools/lib/stardew-portfolio-profile.mjs` and tests only to carry an already validated staged slot name into existing initial-native-load configuration; derive the closed `{ Enable: true }` Mod fixture gate only from the ladder singleton action, never from a caller option or action enablement expansion.
- Modify: `tools/run-stardew-portfolio-m8-ladder-action.mjs`, `tools/run-stardew-portfolio-m8-action.mjs`, and focused tests — require fresh live Given observations and record setup separately from action evidence.
- Modify: `fixtures/stardew/portfolio-m8-elevator-contract.example.json` — distinguish allowed staged Given setup from forbidden direct action save mutation and fixture-written action results.
- Modify: `design/80_M8_ENTER_MINE_ACTION_IMPLEMENTATION_PLAN.md`, `design/81_M8_MINE_ENTRY_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`, `design/83_M8_DIRECT_LADDER_AND_ELEVATOR_SEMANTICS_IMPLEMENTATION_PLAN.md`, and `design/86_M8_LADDER_FLOOR_2_NATIVE_GIVEN_IMPLEMENTATION_PLAN.md` — reference this fixture boundary without changing action contracts.

## Task 1: Freeze staged-slot transaction ownership

**Files:**
- Create: `tools/lib/stardew-portfolio-staged-save-fixture.mjs`
- Create: `tools/lib/stardew-portfolio-staged-save-fixture.test.mjs`

**Interfaces:**

```ts
export async function prepareM8StagedSaveFixture(input: Readonly<{
  canonicalSlotDirectory: string;
  stagingRoot: string;
  declaration: M8StagedSaveFixtureDeclaration;
  transactionId: string;
}>): Promise<Readonly<{
  stagedSlotDirectory: string;
  stagedSlotName: string;
  canonicalManifestSha256: string;
  stagedBaselineManifestSha256: string;
}>>;

export async function verifyM8CanonicalSaveUnchanged(input: Readonly<{
  canonicalSlotDirectory: string;
  expectedManifestSha256: string;
}>): Promise<void>;

export async function disposeM8StagedSaveFixture(input: Readonly<{
  stagedSlotDirectory: string;
  transactionId: string;
}>): Promise<void>;
```

- [ ] **Step 1: Write the failing transaction tests**

Create temporary canonical slot directories and assert that `prepareM8StagedSaveFixture` rejects an existing/invalid lock, existing stage root, root overlap, unreadable/reparse-point paths, missing manifest entries, duplicate manifest paths, unknown files, a fallback save variant, and a transaction ID that does not own the stage root.

```js
await assert.rejects(
  prepareM8StagedSaveFixture({
    canonicalSlotDirectory,
    stagingRoot: canonicalSlotDirectory,
    declaration,
    transactionId: "tx-1",
  }),
  /overlap/i,
);
```

- [ ] **Step 2: Run the transaction test to verify red state**

Run:

```bash
node --test tools/lib/stardew-portfolio-staged-save-fixture.test.mjs
```

Expected: FAIL because no staged-save fixture API exists.

- [ ] **Step 3: Implement exact copy and ownership proof**

Create a complete sorted manifest of `relativePath + SHA-256` for the canonical slot, reject unsafe paths, copy it into one new transaction-owned stage root, and write an exclusive transaction journal containing only non-secret ownership and manifest facts. Rename the staged main XML so its basename, directory name, and `InitialNativeLoad.ObservedSaveSlot` agree. Do not create, edit, or restore a canonical file.

- [ ] **Step 4: Verify canonical integrity and cleanup ownership**

Implement canonical-manifest verification before copy, before launch, after launch, and before cleanup. `disposeM8StagedSaveFixture` may remove only the exact root whose journal matches `transactionId`; otherwise it preserves the root and fails closed. Add tests proving that cleanup never removes canonical or an unrelated stage root.

- [ ] **Step 5: Run focused fixture tests**

Run:

```bash
node --test tools/lib/stardew-portfolio-staged-save-fixture.test.mjs
```

Expected: PASS.

## Task 2: Implement closed-schema Given patches

**Files:**
- Modify: `tools/lib/stardew-portfolio-staged-save-fixture.mjs`
- Modify: `tools/lib/stardew-portfolio-staged-save-fixture.test.mjs`
- Verify: target-version decompiled save/load source under `ref/external/StardewValleyDecompiled/`

**Interfaces:**

```ts
export async function applyM8StagedSaveGiven(input: Readonly<{
  stagedSlotDirectory: string;
  declaration: M8StagedSaveFixtureDeclaration;
}>): Promise<Readonly<{
  changedPaths: readonly string[];
  allowedXmlTextChanges: readonly string[];
}>>;
```

- [ ] **Step 1: Add failing XML and manifest-diff tests**

Construct minimal target-shaped save samples and assert rejection for non-`SaveGame` roots, slot/`uniqueIDForThisGame` mismatch, duplicate/missing/non-integer Mine fields, unsupported declaration fields, unapproved baseline values, `mine_lowestLevelReachedForOrder != -1`, missing/null `mine_permanentMineChanges`, fallback files, or a patch that changes any byte outside the declared XML text nodes.

```js
await assert.rejects(
  applyM8StagedSaveGiven({ stagedSlotDirectory, declaration: badOrderOverride }),
  /LowestMineLevelForOrder/i,
);
```

- [ ] **Step 2: Run the patch test to verify red state**

Run:

```bash
node --test tools/lib/stardew-portfolio-staged-save-fixture.test.mjs
```

Expected: FAIL because the patch implementation is absent.

- [ ] **Step 3: Implement only declaration-owned target-version fields**

Parse the staged main XML with a structure-preserving approach suitable for exact allowed-node verification. Permit changes only to fields explicitly owned by the named declaration. For the fixed floor-5 elevator facility Given, require `mine_lowestLevelReached` to be a declared valid baseline, change it to `10` so runtime checkpoint `10` is both unlocked and distinct from the fixture's current floor `5`, retain `mine_lowestLevelReachedForOrder == -1`, and preserve all non-owned serialized Mine data byte-for-byte. The fixture does not select or materialize that runtime checkpoint. Add player, inventory, or serialized Mine-state changes only after the declaration, source inspection, and exact-diff test define them.

- [ ] **Step 4: Reparse and prove exact changes**

After writing, reparse the staged XML, validate every declared value, compare complete staged manifests, and verify that only the explicitly listed main-XML text changes differ. Keep `SaveGameInfo`, fallback variants, receipt/evidence paths, and all unowned files byte-identical or absent as required.

- [ ] **Step 5: Run focused patch tests**

Run:

```bash
node --test tools/lib/stardew-portfolio-staged-save-fixture.test.mjs
```

Expected: PASS.

## Task 3: Connect staging to existing one-action launchers

**Files:**
- Modify: `tools/launch-stardew-portfolio-m8-action-live.mjs`
- Modify: `tools/launch-stardew-portfolio-m8-action-live.test.mjs`
- Modify: `tools/lib/stardew-portfolio-profile.mjs`
- Modify: `tools/lib/stardew-portfolio-profile.test.mjs`

**Interfaces:**
- Launcher accepts one fixed `fixtureId` selected by its local action-specific run configuration; it does not parse an Agent, Host, bridge, or command-line patch payload.
- Existing action allowlists remain single-action and default-deny.
- Launcher passes only the verified staged slot name to existing initial-native-load configuration.

- [ ] **Step 1: Add failing launcher/profile tests**

Assert that ladder and elevator accept only their matching named fixture declaration; reject unknown/mismatched fixture IDs, an attempt to change enabled actions, arbitrary save paths, caller-supplied XML paths, caller-supplied field values, or any profile that enables more than its current one action.

- [ ] **Step 2: Run launcher/profile tests to verify red state**

Run the existing focused test commands for `tools/launch-stardew-portfolio-m8-action-live.test.mjs` and `tools/lib/stardew-portfolio-profile.test.mjs`.

Expected: FAIL until staged-slot integration is present.

- [ ] **Step 3: Integrate only transaction-owned staged slot input**

Prepare the stage, apply its named Given fixture, verify canonical integrity, then deploy the existing action-specific profile pointing at the staged slot. Keep profile action selection unchanged. On any launch, process, restore, or integrity failure, do not launch or do not send an action request; retain recoverable staged diagnostics and fail closed.

- [ ] **Step 4: Run focused launcher/profile tests**

Run the same focused commands. Expected: PASS.

## Task 4: Require live-Given preflight and preserve independent closure

**Files:**
- Modify: `tools/run-stardew-portfolio-m8-ladder-action.mjs`
- Modify: `tools/run-stardew-portfolio-m8-ladder-action.test.mjs`
- Modify: `tools/run-stardew-portfolio-m8-action.mjs`
- Modify: `tools/run-stardew-portfolio-m8-action.test.mjs`

**Interfaces:**
- Preflight records a redacted setup result separately from action evidence.
- It sends no `mine_ladder_request` or `mine_elevator_request`.
- Action evidence begins only at the typed request and ends at that action's terminal receipt plus fresh postcondition.

- [ ] **Step 1: Add failing runner tests**

Assert that a successful staged setup with no fresh live `MineShaft`/facility observation blocks preflight, emits no action request, and cannot populate action receipt/evidence fields. Assert that a successful fixture journal cannot satisfy `succeeded`, `mine_ladder_floor_used`, or `mine_elevator_floor_selected`.

- [ ] **Step 2: Run focused runner tests to verify red state**

Run:

```bash
node --test tools/run-stardew-portfolio-m8-ladder-action.test.mjs tools/run-stardew-portfolio-m8-action.test.mjs
```

Expected: FAIL until setup/action evidence separation is represented.

- [ ] **Step 3: Implement redacted setup separation**

Record only fixture ID, target build identity, stage ownership status, canonical-integrity result, and fresh Given observation outcome in the setup journal. Do not publish an item list, player coordinates, raw XML, save content, scope, token, execution ID, or native correlation. Require the live adapter/coordinator probe to observe the real ladder/elevator facility and action-specific bounds before a mutation request is allowed.

- [ ] **Step 4: Run focused runner tests**

Run the same Node command. Expected: PASS.

## Task 5: Integrate, review, and gate serial live closure

**Files:**
- Verify: final fixtures, launchers, runners, action tests, and target-bound release artifacts.

- [ ] **Step 1: Run complete offline gates**

Run serially:

```bash
dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore
dotnet run --project integrations/stardew/tests/PortfolioTerminalDeliveryCore.Contract.csproj -c Release --no-build
pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.portfolio.json
node --test tools/lib/stardew-portfolio-staged-save-fixture.test.mjs tools/run-stardew-portfolio-m8-ladder-action.test.mjs tools/run-stardew-portfolio-m8-action.test.mjs tools/run-stardew-portfolio-m8-mine-route-action.test.mjs tools/stardew-portfolio-m8-ladder-source-realization.test.mjs tools/stardew-portfolio-m8-elevator-source-realization.test.mjs
git diff --check -- <declared M8 fixture and action paths>
```

Expected: all pass with no warnings, errors, or whitespace errors in the declared paths.

- [ ] **Step 2: Run one independent review of the final staged-fixture and action diff**

Reject the batch if it adds a public capability or caller-provided patch authority; writes canonical saves; changes profile action allowlists; uses fixture data as action evidence; skips fresh live Given observation; lets the fixture mint action results; permits input/UI injection or arbitrary native fallback; or weakens each action's receipt/postcondition/uncertain semantics.

- [ ] **Step 3: Confirm clean state before every runtime gate**

Verify no active fixture transaction lock, no deployed profile, no running Stardew/SMAPI process, and no unmanaged staged root. Any discrepancy blocks the gate.

- [ ] **Step 4: Run serial action-specific preflight and one mutation per action**

For ladder and elevator separately: create a fresh stage, run the named fixture, launch only the matching one-action profile with `--preflight`, confirm fresh live Given with no action request, verify cleanup, then run one unique action worker only after another clean-state check. Require that action's own succeeded receipt, non-empty evidence, fresh same-execution floor postcondition, canonical-integrity proof, and owned-stage cleanup. Never reuse a stage or receipt across actions.

## Self-Review

- **Spec coverage:** The plan makes staged-save preparation explicit and isolated, preserves canonical and action authority, permits only named Given facts, requires target-version live observation, and keeps action closures independent.
- **Placeholder scan:** No implementation step delegates an unspecified patch; every patch is declaration-owned, source-backed, and protected by an exact-diff test.
- **Type consistency:** Fixture declarations are named closed values; launcher integration consumes only a declaration and verified staged slot; action runners consume only live bridge facts.

## Execution Handoff

Plan complete and saved to `design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md`. Execute it now using the `subagent-driven-development` skill: one writer for shared transaction/launcher files, independent review after integration, and no preflight or live mutation before Task 5 passes.
