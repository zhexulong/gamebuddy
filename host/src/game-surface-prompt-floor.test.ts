import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PLAN_ACTION_LIFECYCLES, planActionsFromRegistrations, planWorkDescription } from "./body-program-script.js";
import {
  ADVERTISED,
  BUILDER_METHODS,
  GAME_SURFACE_PROMPT_FLOOR as READING,
  SURFACE,
} from "./game-surface-prompt-floor.test-support.js";
import { buildChatCompanionSystemPrompt, buildGameCompanionSystemPrompt } from "./identity-profile.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";

/**
 * THE GAME SURFACE'S FIXED PROMPT FLOOR, RECORDED AND RE-DERIVED.
 *
 * <p>
 * The premise under test is the owner's: "the Game surface's tool definitions are too heavy". That is a claim
 * about a NUMBER - how much of the context window is spent before the player says anything - and the only
 * honest way to answer it is to measure the assembled request. Measuring `game-tools.ts`'s source size would
 * have been the wrong number: that file is mostly implementations, and none of the per-action tools it builds is
 * in the request at all (`planBuilder` below).
 * </p>
 *
 * <p>
 * The reading is `game-surface-prompt-floor.test-support.ts`. Its CHARACTER columns are re-derived here, from the
 * product's own builder; its tool and token columns were measured off a real materialized production session over an
 * attested named-pipe bridge (that session's own `agent.state.tools` is the tool population), using Magic Context's
 * own envelope shape and tokenizer. Its `method` block states, per column, how it was obtained. What this file adds
 * is that the reading cannot outlive the tree in silence:
 * </p>
 *
 * <ul>
 *   <li>the system-prompt floor is re-derived from the product's own builder, exactly;</li>
 *   <li>the conduct block is sliced out of the prompt it is sent in, not re-transcribed;</li>
 *   <li>the two STRUCTURAL premises the reading depends on are asserted, because either one changing would
 *       invalidate its conclusion without changing a single number in it.</li>
 * </ul>
 *
 * <p>
 * What this file cannot do is re-count tokens: ai-tokenizer is a dependency of the vendored Magic Context
 * plugin and is not resolvable from the Host package, so the token column is a recorded MEASUREMENT. The
 * character columns are the checks that do run, and the token figures the reading states are functions of them.
 * </p>
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, found by walking up to the directory that holds the Mod's contracts.
 *
 * A compiled test runs from `host/dist-test` or an ad-hoc staging tree, and a source-level run starts in
 * `host/src`; the marker is what makes the same walk work from either.
 */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(HERE);
const HOST_SOURCE = join(ROOT, "host", "src");

/** The locale a player's Game session runs under in the shipped configuration (measured 2026-10-31). */
const LOCALE = "zh-CN";

/**
 * The Game prompt exactly as `runtime-core.internal.ts` installs it, for a player who has set no own
 * addition: the reading covers the floor, and an addition is the player's to add on top of it.
 */
const GAME_PROMPT = buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);

/** The conduct block, anchored to its first and last rule rather than quoted in full. */
const CONDUCT_FIRST = "Speak to your partner, not about yourself, like a friend playing together.";
const CONDUCT_LAST = "Talk to your partner, never to a customer.";

function conductBlock(prompt: string): string {
  const start = prompt.indexOf(CONDUCT_FIRST);
  const lastAt = prompt.indexOf(CONDUCT_LAST);
  assert.notEqual(start, -1, "the conduct block's first rule is no longer in the Game prompt");
  assert.notEqual(lastAt, -1, "the conduct block's last rule is no longer in the Game prompt");
  const end = prompt.indexOf("\n", lastAt);
  return prompt.slice(start, end === -1 ? prompt.length : end);
}

test("the recorded Game system-prompt floor is what the product's builder still produces", () => {
  assert.equal(
    GAME_PROMPT.length,
    READING.floor.systemChars,
    `the Game system prompt is ${GAME_PROMPT.length} chars, the reading records ${READING.floor.systemChars}. ` +
      "Re-measure deliberately and re-record the reading in its own commit; do not edit the number to match the tree. " +
      "The reading's `method` block says how each column was obtained.",
  );
});

test("the conduct block is the measured slice of the prompt, and its share is still the recorded one", () => {
  const conduct = conductBlock(GAME_PROMPT);
  assert.equal(
    conduct.length,
    READING.conductBlock.chars,
    `the conduct block is ${conduct.length} chars, the reading records ${READING.conductBlock.chars}`,
  );
  const share = conduct.length / GAME_PROMPT.length;
  assert.ok(
    Math.abs(share - READING.conductBlock.charShareOfSystemPrompt) < 0.01,
    `the conduct block is ${(share * 100).toFixed(1)}% of the system prompt by characters, the reading records ` +
      `${(READING.conductBlock.charShareOfSystemPrompt * 100).toFixed(1)}%`,
  );
  // The reading's share must be its own two measured slices divided, never a percentage typed beside them: a share
  // that drifts from its own numbers still looks plausible, and nothing above would notice. The previous recording
  // carried exactly that defect (0.5619 against 6,194/10,886 = 0.5690) through every green run.
  const derivedFromReading = READING.conductBlock.chars / READING.floor.systemChars;
  assert.ok(
    Math.abs(derivedFromReading - READING.conductBlock.charShareOfSystemPrompt) < 0.0005,
    `the reading's share ${READING.conductBlock.charShareOfSystemPrompt} is not its own slices' quotient: ` +
      `${READING.conductBlock.chars}/${READING.floor.systemChars} = ${derivedFromReading.toFixed(4)}`,
  );
});

test("the Chat surface still mounts zero tools, so the recorded comparison stays a comparison", () => {
  // The reading's point is that the Game floor is heavy RELATIVE to Chat. `runtime-core.internal.ts` gives the
  // Chat surface no tool group at all (`PERMITTED_TOOL_CLASSES.chat` is host status only, and Chat composes
  // none), so Chat's floor is its system prompt alone. If Chat ever mounts a tool, the recorded comparison stops
  // meaning what it says - and nothing else here would notice, because the number would still be the number.
  assert.equal(
    READING.comparison.chatSurfaceToolCount,
    0,
    "the reading records a Chat surface with no tools; if that changed, re-measure the comparison",
  );
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
  assert.ok(chatPrompt.length > 0, "the Chat surface's prompt must still build, or the comparison has no other half");
  assert.ok(
    chatPrompt.length < GAME_PROMPT.length,
    "the Game prompt carries the conduct block Chat does not; if this inverts, the reading's comparison is stale",
  );
});

test("the reading's premise about the plan builder still holds: the flat per-action tools are not mounted", () => {
  // The question "are the per-action schemas in the request?" is architectural, not numeric: the live Game
  // materializer declares `planActionSurface`, and `runtime-core.internal.ts` then drops every tool the adapter
  // publishes as an action. Both halves are asserted, so the reading's `flatPerActionToolsMounted: false`
  // cannot quietly become false while its token totals stay plausible.
  assert.equal(READING.planBuilder.flatPerActionToolsMounted, false);

  const materializerSource = readFileSync(
    join(
      HOST_SOURCE,
      "continuity-semantic-game-runtime-materializer",
      "continuity-semantic-game-runtime-materializer.ts",
    ),
    "utf8",
  );
  assert.match(
    materializerSource,
    /planActionSurface: true as const/u,
    "the live Game materializer no longer declares the plan action surface, so the adapter's per-action tools would be mounted again",
  );

  const runtimeSource = readFileSync(join(HOST_SOURCE, "runtime-core.internal.ts"), "utf8");
  assert.match(
    runtimeSource,
    /planActionSurface\s*\n?\s*\?[\s\S]{0,200}?actionIdForToolName\(tool\.name\) === null/u,
    "runtime-core no longer filters adapter action tools out of a plan-builder surface, so the flat per-action tools are back in the request",
  );
});

/** The description the Game prompt hands the model for `stardew_plan_work`, built from the surface exactly as the mount does. */
const PLAN_WORK_DESCRIPTION = planWorkDescription(planActionsFromRegistrations(ADVERTISED));

/** The description names the action as a builder method, and not merely as a substring of a longer id. */
function namesBuilderMethod(actionId: string): boolean {
  return new RegExp(`(^|[\\s:,])${actionId}([\\s,]|$)`, "u").test(PLAN_WORK_DESCRIPTION);
}

test("every action the surface admits to a plan is a builder method the prompt names", () => {
  // The property behind the two counts: the vocabulary the model is handed is generated per admitted action, so an
  // action that became plannable without a method (or a method without a name in the description) is capability the
  // player cannot reach - and it is named here, one id at a time, rather than summed into a total.
  const unnamed = BUILDER_METHODS.filter((actionId) => !namesBuilderMethod(actionId));
  assert.deepEqual(
    unnamed,
    [],
    `these actions are plannable on the Mod's surface but stardew_plan_work's description names no builder method ` +
      `for them, so the model cannot call them: ${unnamed.join(", ")}`,
  );
  // The other side of the same property: a surface action the plan form does not admit is a capability with no route
  // left at all once the flat tools are dropped. The one stated reason is the `experimental` lifecycle, which the plan
  // form does not publish; anything else is named, so a widened argument-type filter cannot silently withdraw an action.
  const plannableLifecycles = new Set(PLAN_ACTION_LIFECYCLES);
  const wrongfullyExcluded = SURFACE.filter(
    (action) =>
      action.kind === "execution" &&
      plannableLifecycles.has(action.lifecycle) &&
      !BUILDER_METHODS.includes(action.actionId),
  ).map((action) => `${action.actionId} (${action.lifecycle})`);
  assert.deepEqual(
    wrongfullyExcluded,
    [],
    `the Mod publishes these actions as playable steps but the plan builder exposes no method for them, so on a plan ` +
      `surface they are unreachable: ${wrongfullyExcluded.join(", ")}`,
  );
});

test("every recorded tool row is the size the reading says, and the rows are the mounted set", () => {
  // The rows are the population: the materialized session's own `agent.state.tools`. This asserts the table's
  // internal consistency, which is what a later reduction is compared against.
  assert.equal(
    READING.rows.length,
    READING.floor.toolCount,
    `the reading records ${READING.floor.toolCount} tools but lists ${READING.rows.length} rows`,
  );
  for (const row of READING.rows) {
    assert.ok(row.descriptionChars > 0, `${row.name} is recorded with an empty description`);
    assert.ok(row.parametersChars > 0, `${row.name} is recorded with an empty parameter schema`);
    assert.equal(
      row.totalTokens,
      row.descriptionTokens + row.parametersTokens,
      `${row.name}'s recorded total is not the sum of its two parts`,
    );
  }
  // The two plan tools carry the action vocabulary in prose; if a future change moved that vocabulary back into
  // per-action schemas, the total would move and this ordering is the cheap tripwire that says where to look.
  const heaviest = [...READING.rows].sort((left, right) => right.totalTokens - left.totalTokens)[0];
  assert.equal(
    heaviest?.name,
    "stardew_plan_work",
    "the plan builder was the heaviest tool; a different leader means the weight moved and the reading needs re-measuring",
  );
});

test("the recorded denominator is the geometry function's own arithmetic, not a copied number", () => {
  // `usableSoft` is what a turn actually has. For a 32,768-window shared_upfront model the reserve is the
  // catalog output, and the ratio the report quotes has to be the ratio of the recorded floor to that.
  const primary = READING.denominator.find((item) => item.window === 32768 && item.output === 8192);
  assert.ok(primary, "the reading must record the 32,768-window case it is quoted against");
  assert.equal(primary.usableSoft, 32768 - 8192, "shared_upfront usableSoft is window minus the output reserve");
  const share = READING.floor.envelopeTokens / primary.usableSoft;
  assert.ok(
    Math.abs(share - primary.floorShare) < 0.005,
    `the recorded floor is ${(share * 100).toFixed(1)}% of usableSoft, but the reading states ${(primary.floorShare * 100).toFixed(1)}%`,
  );
});
