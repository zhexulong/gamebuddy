import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXPRESSION_ONLY_ACTION_IDS, STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { PLAN_ACTION_LIFECYCLES, planActionsFromRegistrations, planWorkDescription } from "./body-program-script.js";
import { composeFactBrief, FACT_BRIEF_BLOCKS } from "./fact-brief.js";
import { buildGameCompanionSystemPrompt, GAME_SURFACE_INTERACTION_CONDUCT } from "./game-surface-prompt-floor.js";
import { composeGameEnvironmentFacts } from "./game-world-vocabulary.js";
import {
  ADVERTISED,
  BUILDER_METHODS,
  GAME_SURFACE_PROMPT_FLOOR as READING,
  SURFACE,
} from "./game-surface-prompt-floor.test-support.js";
import { buildChatCompanionSystemPrompt } from "./companion-prompt-assembly.js";
import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import {
  attachNativeCompanionContent,
  NATIVE_BUBBLE_DELIVERY_UNIT,
  NATIVE_BUBBLE_SCAFFOLDING,
  NATIVE_BUBBLE_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
  type NativeCompanionTurnBubble,
} from "./native-companion-content.js";
import type { Snapshot } from "./protocol.js";
import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";
import { readSourceShape } from "./test-support/source-shape.test-support.js";

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

/**
 * The conduct block, read out of the assembled prompt rather than from the module that composes it.
 *
 * The block's own text is the authority - `GAME_SURFACE_INTERACTION_CONDUCT` is what the builder installs - so slicing
 * the prompt at that exact string proves the prompt carries it whole. It used to be anchored on the first and last
 * rule's prose, which is a second spelling that went stale the moment the first rule was deleted.
 */
function conductBlock(prompt: string): string {
  const at = prompt.indexOf(GAME_SURFACE_INTERACTION_CONDUCT);
  assert.notEqual(at, -1, "the conduct block is no longer in the Game prompt as the builder composes it");
  return prompt.slice(at, at + GAME_SURFACE_INTERACTION_CONDUCT.length);
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
  // cannot quietly become false while its token totals stay plausible. The single exception is also structural: the
  // filter keeps the tools of the actions the registry declares expression-only, so the drop rule cannot grow a second
  // escape hatch without failing here. `action-route-gate.test.ts` holds the same property from the assembled set.
  assert.equal(READING.planBuilder.flatPerActionToolsMounted, false);

  const { shape: materializerShape } = readSourceShape(
    join(
      HOST_SOURCE,
      "continuity-semantic-game-runtime-materializer",
      "continuity-semantic-game-runtime-materializer.ts",
    ),
  );
  assert.match(
    materializerShape,
    /planActionSurface: true as const/u,
    "the live Game materializer no longer declares the plan action surface, so the adapter's per-action tools would be mounted again",
  );

  const { shape: runtimeShape } = readSourceShape(join(HOST_SOURCE, "runtime-core.internal.ts"));
  // The mount rule, as the formatter leaves it: the whole decision in one collapsed clause.
  const mountRule = runtimeShape.slice(
    runtimeShape.indexOf("const actionToolsToMount"),
    runtimeShape.indexOf("const integrationToolGroups"),
  );
  assert.ok(
    mountRule.length > 0,
    "blocked: runtime-core's plan-surface mount rule is not where this gate reads it, so nothing below was examined",
  );
  assert.match(
    mountRule,
    /planActionSurface \? integrationToolSet\.actions\.filter\(\(tool\) => keepsOwnToolOnPlanSurface\(integrationModule\?\.actionIdForToolName\(tool\.name\)/u,
    "runtime-core no longer filters adapter action tools out of a plan-builder surface, or it keeps them by a rule of its own",
  );
  // The rule may not be restated one layer up either: the surface keeps a tool when the plan CANNOT carry its action,
  // which is the plan vocabulary's own answer. Measured 2026-11-14: this filter read `isExpressionOnlyAction` alone, so the
  // seven `experimental` actions the Host admits were dropped here and excluded from the plan - zero routes, and nothing in
  // the companion's context said they existed. `action-route-gate.test.ts` holds the same property from the assembled set.
  assert.match(
    runtimeShape,
    /planActionIds[\s\S]{0,200}?planActionsFromRegistrations\(/u,
    "the mount filter no longer asks the plan vocabulary which actions it carries, so it is deciding visibility itself",
  );
  assert.doesNotMatch(
    runtimeShape,
    /isExpressionOnlyAction/u,
    "runtime-core decides expression for itself instead of asking the plan vocabulary, so it has grown a second escape hatch",
  );
});

/** The description the Game prompt hands the model for `stardew_plan_work`, built from the surface exactly as the mount does. */
const PLAN_WORK_DESCRIPTION = planWorkDescription(planActionsFromRegistrations(ADVERTISED));

/** The description names the action as a builder method (`id(`), and not merely as a substring of a longer id. */
function namesBuilderMethod(actionId: string): boolean {
  return new RegExp(`(^|[\\s:,])${actionId}(\\(|[\\s,]|$)`, "u").test(PLAN_WORK_DESCRIPTION);
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
  // left at all once the flat tools are dropped. Two stated reasons exist and they are different questions - the
  // `experimental` lifecycle, which the plan form does not publish, and the expression declaration, whose actions reach
  // the actor through their own mounted tool instead. Anything else is named, so a widened argument-type filter cannot
  // silently withdraw an action.
  const plannableLifecycles = new Set(PLAN_ACTION_LIFECYCLES);
  const expressionOnly = new Set<string>(EXPRESSION_ONLY_ACTION_IDS);
  const wrongfullyExcluded = SURFACE.filter(
    (action) =>
      action.kind === "execution" &&
      plannableLifecycles.has(action.lifecycle) &&
      !expressionOnly.has(action.actionId) &&
      !BUILDER_METHODS.includes(action.actionId),
  ).map((action) => `${action.actionId} (${action.lifecycle})`);
  assert.deepEqual(
    wrongfullyExcluded,
    [],
    `the Mod publishes these actions as playable steps but the plan builder exposes no method for them, so on a plan ` +
      `surface they are unreachable: ${wrongfullyExcluded.join(", ")}`,
  );
  // And the declaration is not a licence to hide a plan step: an action declared expression-only must really be absent
  // from the builder, or the model would be handed two spellings of the same gesture.
  assert.deepEqual(
    SURFACE.filter((action) => expressionOnly.has(action.actionId) && BUILDER_METHODS.includes(action.actionId)).map(
      (action) => `expression_action_is_a_plan_step:${action.actionId}`,
    ),
    [],
    "an action the registry declares expression-only is still a builder method, so it has two routes",
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

/**
 * The body-language rule names the route the surface really mounts, the argument that route takes, and the route it
 * must NOT teach.
 *
 * <p>
 * Three measured defects sit behind this, one turn each. `round46b` (2026-11-11): the rule sent body language to
 * `stardew_express_emote`, a per-action tool a plan surface dropped, so it named a route the Agent was never handed -
 * `action-registry-consistency.test.ts` holds that half against the mounted set. `round47` (2026-11-12, 64 assistant
 * turns): the rule named a plan step instead and the run still submitted zero emotes out of 188 planned nodes, because a
 * gesture is one step by nature and the plan is where work goes. The surface now mounts the two expression tools
 * (`EXPRESSION_ONLY_ACTION_IDS`) and the plan no longer admits them.
 * </p>
 *
 * <p>
 * The ARGUMENT is read from the Mod's own descriptor (`SURFACE`, the emitted action surface), not typed here: an action
 * that grows a second argument joins this gate without an edit, and a rule that names an argument the action does not
 * declare is refused by name. What is asserted about the shape is only that the rule states it - never a frequency,
 * because nothing guarantees an emote and no run is failed for not using one.
 * </p>
 */
test("the body-language rule names the mounted tools and the argument each declares, and no longer teaches a plan step", () => {
  const rule = conductBlock(GAME_PROMPT)
    .split("\n")
    .find((line) => line.includes("Body language has its own tool"));
  assert.ok(rule !== undefined, "the Game prompt must still carry a body-language rule to hold");
  assert.doesNotMatch(
    rule,
    /Body language is an action in the plan|express_emote raises|never a tool of its own/u,
    "the rule still teaches the old plan-step route for a gesture",
  );
  for (const actionId of EXPRESSION_ONLY_ACTION_IDS) {
    const toolName = STARDEW_ACTION_TOOL_NAMES[actionId];
    assert.ok(
      rule.includes(toolName),
      `the rule must name ${toolName}, the tool a Game session mounts for this action`,
    );
    const action = SURFACE.find((candidate) => candidate.actionId === actionId);
    assert.ok(action !== undefined, `the Mod publishes ${actionId}, or the declaration exempts nothing`);
    const declared = Object.keys(action.argumentSchema ?? {});
    assert.ok(declared.length > 0, `blocked: ${action.actionId} declares no argument, so this gate examines nothing`);
    for (const argument of declared)
      assert.ok(
        rule.includes(`\`${argument}\``),
        `the rule teaches ${action.actionId} without naming its \`${argument}\` argument, so the one call it shows is refused as invalid_args`,
      );
  }
  // The route NOT to teach, and the reason this test exists: the plan builder is named nowhere near body language, and
  // the action ids are not printed as builder methods either.
  assert.doesNotMatch(
    rule,
    /stardew_plan_shape/u,
    "the plan form does not admit these two actions, so it cannot be where their words are read",
  );
  for (const actionId of EXPRESSION_ONLY_ACTION_IDS)
    assert.ok(
      !new RegExp(`builder\\.${actionId}\\(`, "u").test(rule),
      `the rule still shows builder.${actionId}(...), a call the compiler now refuses as plan_script_unknown_action`,
    );
});

/**
 * THE FLOOR'S CLAIMS ABOUT THE SHAPE OF A DELIVERY, CHECKED AGAINST A DELIVERY.
 *
 * <p>
 * Measured 2026-11-21 (`round56`, 32 delivered batches): 29 began with `<world-state>` and 3 with the partner's own
 * words. `composeFactBrief` can emit only those two heads - the player's text when they typed this turn, and otherwise
 * `<world-state>`, the one block every batch carries - so the floor's "A turn's message opens with your partner's own
 * words, exactly as they said them ... answer what your partner said at the top of the message" was a FALSE PREMISE
 * stated as fact on 90% of the turns that ran, and an instruction to answer something that was not there.
 * </p>
 *
 * <p>
 * TWO POPULATIONS, and neither is a list someone typed for this test. THE CLAIMS are the sentences of the assembled
 * conduct block that name the head of the message, read out of the prompt the product builds, so a rule added tomorrow
 * that speaks about the message's opening joins this gate without an edit here. THE DELIVERIES are composed by
 * `composeFactBrief` itself - the one function that decides where the player's words sit - rather than compared against a
 * second, hand-written description of the format. A claim that names the partner's words as what the head holds is
 * contradicted by every delivery carrying no player text, and the finding names both the claim and the delivery that
 * falsified it: `floor_asserts_a_premise_the_delivery_contradicts:<claim>:<shape>`.
 * </p>
 *
 * <p>
 * WHAT IT IS NOT. It does not forbid the floor to describe the head - the two-shape statement the rule now carries is
 * what makes the surface legible, and a gate that only forbade would be satisfied by deleting the paragraph and leaving
 * the model to guess. It forbids the UNCONDITIONAL form, which is the form that has no true instance.
 * </p>
 */

/** A claim about the head of the message that is true only of a batch that carried player text. */
const HEAD_CLAIMS = Object.freeze([
  Object.freeze({
    id: "message_opens_with_partner_words",
    pattern: /\b(?:open|begin|start)s? with (?:your|the) partner's (?:own )?words\b/iu,
  }),
  Object.freeze({
    id: "answer_the_partner_at_the_top",
    pattern: /\bwhat (?:your|the) partner said at the top\b/iu,
  }),
]);

/**
 * Every sentence of a conduct block that says what the head of the message holds, with the claims it states.
 *
 * Exported to nothing and read by two tests - the gate and its falsifier - so the falsifier turns red on the SAME
 * sentence reader the gate uses, not on a second detector written to be easy to redden.
 */
function headClaims(conduct: string): readonly Readonly<{ sentence: string; claims: readonly string[] }>[] {
  const found: { sentence: string; claims: readonly string[] }[] = [];
  for (const piece of conduct.split(/(?<=[.!?。！？])\s*/u)) {
    const sentence = piece.trim();
    const claims = HEAD_CLAIMS.filter((claim) => claim.pattern.test(sentence)).map((claim) => claim.id);
    if (claims.length > 0) found.push(Object.freeze({ sentence, claims: Object.freeze(claims) }));
  }
  return Object.freeze(found);
}

/** A world reading, as `<world-state>` states it: the snapshot the Mod publishes, never a Host projection. */
const DELIVERY_WORLD = Object.freeze({
  revision: 1205,
  location: "Farm",
  tile: { x: 64, y: 15 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "rain",
  currentTool: "(T)Hoe",
  currentToolSlot: 0,
  toolSlots: [],
  inventoryItemFacts: [],
  cropTargets: [],
  harvestTargets: [],
}) as unknown as Snapshot;

/**
 * The deliveries examined, DERIVED FROM THE ONE BOOLEAN THE HEAD DEPENDS ON.
 *
 * `composeFactBrief` puts `playerSpeech` first and `<world-state>` second, and `<world-state>` is always non-empty, so
 * the head of a message is decided by exactly one thing: did the batch carry player text. Both values of that boolean are
 * composed here; nothing about where the words sit is written down twice.
 */
const DELIVERY_SHAPES = Object.freeze([
  Object.freeze({
    id: "player_spoke",
    inputs: [
      Object.freeze({
        source: "player_text" as const,
        inputId: "floor_claim_input",
        text: "找片水，钓条鱼回来",
        locale: "zh-CN",
        timestampMs: 1,
      }),
    ],
  }),
  Object.freeze({ id: "nobody_spoke", inputs: Object.freeze([]) }),
]);

/** One composed delivery, with the head the producer gave it. */
function composedDelivery(
  index: number,
): Readonly<{ id: string; text: string; opensWith: string; blocks: readonly string[] }> {
  const shape = DELIVERY_SHAPES[index];
  assert.ok(shape !== undefined, "blocked: the delivery population is empty, so no shape was examined");
  const text = composeFactBrief({
    inputs: shape.inputs,
    snapshot: { snapshot: DELIVERY_WORLD, revision: 1205, ageTurns: 0, ageMs: 0 },
    events: [],
    locale: "zh-CN",
  });
  const head = text.match(/^<([a-z-]+)>$/mu)?.[1];
  return Object.freeze({
    id: shape.id,
    text,
    // The head is the first block's name, or - when the player typed - nothing at all, because speech is unlabelled.
    opensWith: head === undefined || !text.startsWith(`<${head}>`) ? "partner_words" : head,
    blocks: Object.freeze([...text.matchAll(/^<([a-z-]+)>$/gmu)].map((match) => match[1] ?? "")),
  });
}

const DELIVERIES = Object.freeze(DELIVERY_SHAPES.map((_, index) => composedDelivery(index)));

test("no conduct sentence claims a delivery opens with words a delivery can do without", () => {
  const spoken = DELIVERIES.find((delivery) => delivery.opensWith === "partner_words");
  const silent = DELIVERIES.find((delivery) => delivery.opensWith !== "partner_words");
  assert.ok(
    spoken !== undefined,
    "blocked: no composed delivery opens with the partner's words, so the claim this " +
      "gate is about was never checked on the shape that satisfies it",
  );
  assert.ok(
    silent !== undefined,
    "blocked: no composed delivery omits the partner's words, so the contradiction this " +
      "gate exists for cannot occur and a green verdict would be a statement about nothing",
  );
  // The floor's own statement of the surface: only <world-state> arrives every turn. Asserted from the producer, not
  // restated from the sentence, so a block that became optional moves the sentence and fails here.
  for (const delivery of DELIVERIES) {
    const order = delivery.blocks.filter(
      (name, index, names) => FACT_BRIEF_BLOCKS.indexOf(name as never) >= 0 && names.indexOf(name) === index,
    );
    assert.ok(
      delivery.blocks.includes("world-state"),
      `the ${delivery.id} delivery carries no <world-state>, so "only <world-state> arrives every turn" is false`,
    );
    assert.deepEqual(
      order,
      [...order].sort(
        (left, right) => FACT_BRIEF_BLOCKS.indexOf(left as never) - FACT_BRIEF_BLOCKS.indexOf(right as never),
      ),
      `the ${delivery.id} delivery states its blocks out of the order the floor names them in: ${order.join(", ")}`,
    );
  }

  const sentences = conductBlock(GAME_PROMPT)
    .split(/(?<=[.!?。！？])\s*/u)
    .filter((piece) => piece.trim() !== "");
  assert.ok(
    sentences.length > 0,
    "blocked: the conduct block split into no sentences, so 'no conduct sentence makes this claim' is a statement about " +
      "nothing",
  );
  const found = headClaims(conductBlock(GAME_PROMPT));
  // THE DETECTOR IS PROVEN LIVE INSIDE THIS TEST, because the population it reports is allowed to be zero: zero claims is
  // the state this gate wants, and "0 findings" from a detector that never matched anything is indistinguishable from it.
  const live = HEAD_CLAIMS.filter((claim) =>
    claim.pattern.test("A turn's message opens with your partner's own words."),
  );
  assert.ok(
    live.length > 0,
    "blocked: the claim reader did not fire on the sentence round56 measured, so its zero is a blind detector",
  );
  process.stdout.write(
    `\nhead claims examined ${String(found.length)} in ${String(sentences.length)} conduct sentences, over ` +
      `${String(DELIVERIES.length)} deliveries (${DELIVERIES.map((delivery) => `${delivery.id} opens with ${delivery.opensWith}`).join(", ")}); ` +
      `detector live on ${live.map((claim) => claim.id).join(", ")}\n`,
  );
  const findings: string[] = [];
  for (const claim of found)
    for (const delivery of DELIVERIES) {
      if (delivery.opensWith === "partner_words") continue;
      for (const id of claim.claims)
        findings.push(`floor_asserts_a_premise_the_delivery_contradicts:${id}:${delivery.id} :: ${claim.sentence}`);
    }
  assert.deepEqual(
    findings,
    [],
    "a conduct sentence says the message opens with the partner's words, and the producer emits a delivery whose head " +
      "is <world-state> instead: state the shape the surface really has, or a turn with nobody speaking is told to " +
      "answer words that are not there",
  );
});

/**
 * The falsifier: the same sentence reader, on the sentences this gate was written for and on one nobody has written.
 *
 * Without it the gate above could be green because its detector never matched anything - the failure mode that let the
 * original sentence ship. Each case below is a sentence that names the partner's words as the head, and each must map
 * to at least one claim.
 */
test("the head-claim reader turns red on the sentence that proved the defect, and on one nobody wrote", () => {
  const claimsOf = (sentence: string): readonly string[] => headClaims(sentence).flatMap((claim) => claim.claims);
  assert.deepEqual(
    claimsOf(
      "A turn's message opens with your partner's own words, exactly as they said them, and then the machine's report " +
        "follows as prose in 4 blocks.",
    ),
    ["message_opens_with_partner_words"],
    "the sentence measured on round56 is the instance: it must be a claim this gate reads",
  );
  assert.deepEqual(
    claimsOf(
      "Every block is written by the machine, never by your partner: read them as reports from the world, and answer what your partner said at the top of the message.",
    ),
    ["answer_the_partner_at_the_top"],
    "the instruction to answer the top is the second half of the same false premise",
  );
  assert.deepEqual(
    claimsOf("A turn's message begins with the partner's own words every time."),
    ["message_opens_with_partner_words"],
    "a sentence nobody has written - the class, not the instance",
  );
  assert.deepEqual(
    headClaims(
      "When they typed something their words come first, and when they said nothing the message opens with <world-state> instead.",
    ),
    [],
    "and the shape the floor now states is not a finding: a gate that flagged it would force the paragraph back out of the prompt",
  );
});

/**
 * A TURN THAT SAYS MORE THAN ONE BUBBLE IS CUT, AND THE CUT REACHES HER OR IT IS SILENT.
 *
 * <p>
 * MEASURED 2026-11-16 on `round62`'s own session (the live runner's log, 90 turns that carried text, 70 that delivered a
 * bubble): **18 turns were cut, 533 characters and 26 whole sentences deleted before the player saw them**. Nothing said
 * so. The delivery measured the loss (`truncatedChars`, `sentencesDropped`), the turn loop printed it to stderr - which
 * neither the model nor the player reads - and the floor told her a bubble holds "about 80 characters", a soft target,
 * while the surface deletes. An under-statement is worse than a warning, because she budgets by it.
 * </p>
 *
 * <p>
 * WHY THE TAIL CANNOT SIMPLY BE DELIVERED. The bubble's unit is the prompt turn and its only channel is `onFinalText`,
 * one commit per turn (`native-companion-content.ts` `deliverTurn`); there is no mid-turn channel on this surface, and a
 * second commit per turn is the running commentary the turn unit was introduced to remove. So the tail has nowhere to
 * go, and what the surface owes her is the STATEMENT that it is deleted.
 * </p>
 *
 * <p>
 * The gate's population is DERIVED: every turn of the family below is delivered through the product's own observer with
 * the surface's own pacing, and a turn joins the population when the delivery says it was cut. The property is the
 * join: each cut turn either reached the player whole (as a continuation, which no game turn does today) or the model
 * was told, at the SAME ceiling the delivery applied, that the excess is deleted. The ceiling on both sides is
 * `GAME_DELIVERY_PACING.lengthBudget`, so a budget change moves the delivery and the sentence together or this fails.
 * </p>
 */

const BUBBLE_BUDGET = GAME_DELIVERY_PACING.lengthBudget;

/** The turn every examined delivery is made for: the reaction sound is seeded by it, so the ceiling derivation needs it. */
const CEILING_TURN_ID = "player_source_bubble_ceiling";

/**
 * The measured `round46b` turn, verbatim: three messages and 89 characters of speech inside ONE prompt turn.
 *
 * `native-companion-turn-delivery.test.ts` pins this same speech as the shape one bubble cannot hold; here it is the
 * population's sentence-boundary half, beside the lengths derived from the ceiling below.
 */
const MEASURED_SPEECH = Object.freeze([
  "三格宽二十格长，种子还差五十八颗——先去把地方看明白，再盘算钱够不够跑一趟镇上。",
  "先从屋里出去，站到门口才能量出那条长垄的边。",
  "门前这片草和石头还横着呢，等脚踩上去才知道要从哪头下手。",
]);

/** One sentence of exactly `length` characters: the shape with no sentence boundary for the cut to stop at. */
function sentenceOfLength(length: number): string {
  return `${"这".repeat(Math.max(1, length - 1))}。`;
}

/** One turn examined: an id naming the shape, and the paragraphs the model wrote inside that single turn. */
type CeilingTurnShape = Readonly<{ id: string; speech: readonly string[] }>;

/**
 * The turns examined, derived from the ceiling the delivery cuts at rather than chosen.
 *
 * The sound is the head of the bubble and is spent from the same count (`deliverTurn`), so the character at which her
 * own speech starts being deleted is the ceiling minus the sound - read from the authority that picks the sound, never
 * typed here. The four single-sentence lengths sit ON that boundary (inside it, on it, one past it, and double, which
 * is the length a live turn reached when it lost 84 characters on `round62`).
 */
function ceilingTurnShapes(): readonly CeilingTurnShape[] {
  assert.ok(BUBBLE_BUDGET !== null, "blocked: the Game surface declares no bubble ceiling, so no tail can be deleted");
  const sound = selectReactionSound(CEILING_TURN_ID, "zh-CN", GAME_DELIVERY_PACING.reaction!);
  assert.notEqual(
    sound,
    null,
    "blocked: this turn has no reaction vocabulary, so the bubble's head cannot be measured",
  );
  const speechCeiling = BUBBLE_BUDGET.maxChars - (sound!.length + 1);
  const lengths = Object.freeze([speechCeiling - 1, speechCeiling, speechCeiling + 1, BUBBLE_BUDGET.maxChars * 2]);
  return Object.freeze([
    ...lengths.map((length) =>
      Object.freeze({ id: `one_sentence_of_${String(length)}`, speech: Object.freeze([sentenceOfLength(length)]) }),
    ),
    ...[1, 2, 3].map((count) =>
      Object.freeze({
        id: `measured_turn_${String(count)}_sentences`,
        speech: Object.freeze(MEASURED_SPEECH.slice(0, count)),
      }),
    ),
  ]);
}

/** One turn's delivery through the real observer: the bubble lane's sinks, the surface's pacing, its one `onFinalText`. */
async function deliveredCeilingTurn(
  speech: readonly string[],
): Promise<Readonly<{ pieces: readonly string[]; bubble: NativeCompanionTurnBubble | null }>> {
  const listeners = new Set<(event: NativeCompanionContentEvent) => void>();
  const pieces: string[] = [];
  const observer = attachNativeCompanionContent(
    {
      subscribe(listener: (event: NativeCompanionContentEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    {
      onPreviewDelta: () => undefined,
      onFinalText: (value) => {
        pieces.push(value);
      },
      onRejected: (reason) => assert.fail(`the examined turn was refused instead of delivered: ${reason}`),
    },
    {
      stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,
      scaffolding: NATIVE_BUBBLE_SCAFFOLDING,
      deliveryUnit: NATIVE_BUBBLE_DELIVERY_UNIT,
      pacing: GAME_DELIVERY_PACING,
      turn: { id: CEILING_TURN_ID, locale: "zh-CN" },
    },
  );
  observer.open();
  observer.openPreviews();
  for (const [index, part] of speech.entries()) {
    const snapshot = { role: "assistant", content: [], stopReason: "pending" };
    const emit = (event: NativeCompanionContentEvent): void => {
      for (const listener of [...listeners]) listener(event);
    };
    emit({ type: "message_start", message: snapshot });
    emit({
      type: "message_update",
      message: snapshot,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
    });
    emit({
      type: "message_update",
      message: snapshot,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: part, partial: snapshot },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: part }],
        stopReason: index === speech.length - 1 ? "stop" : "toolUse",
      },
    });
  }
  const bubble = observer.deliverTurn();
  await observer.close();
  return Object.freeze({ pieces: Object.freeze(pieces), bubble });
}

/**
 * The sentences of the conduct that state the bubble's size, joined: the statement the model reads about its ceiling.
 *
 * The population is the assembled prompt, not the rule's source, so deleting the rule empties this and the gate fails
 * instead of passing on a constant. Every sentence that names the bubble joins, because the ceiling and what happens
 * past it are one statement that may be written over two sentences.
 */
function bubbleSizeStatement(prompt: string): string {
  return conductBlock(prompt)
    .split(/(?<=[.!?。！？])\s*/u)
    .filter((sentence) => /\bbubble\b/iu.test(sentence))
    .join(" ");
}

/**
 * A deletion, bound to what lies past a stated size - a KIND, never a phrasing.
 *
 * The two halves must meet inside one sentence: a verb that puts text out of reach, and the excess it applies to. A
 * sentence that only names a size says nothing about what happens past it, which is exactly the under-statement this
 * gate exists for.
 */
const DELETES_THE_EXCESS =
  /\b(?:delet(?:e|es|ed|ing)|cut|cuts|cutting|drop(?:s|ped)?|discard(?:s|ed)?|remove(?:s|d)?|never (?:arrives|reaches|delivers?))\b[^.!?]{0,120}?\b(?:past|beyond|over|rest|tail|excess)\b|\b(?:past|beyond|over|rest|tail|excess)\b[^.!?]{0,120}?\b(?:delet(?:e|es|ed|ing)|cut|cuts|cutting|dropped|discarded|removed)\b/iu;

/**
 * The ceiling a statement says is DELETED, or `null` when it states a size and not what happens past it.
 *
 * The number is read from the statement itself and compared to the ceiling the delivery applied, so the two can never
 * disagree in silence; a statement carrying two different sizes names no single ceiling and is refused rather than
 * resolved by whichever number came first.
 */
function statedDeletionCeiling(statement: string): number | null {
  if (!DELETES_THE_EXCESS.test(statement)) return null;
  const sizes = [...new Set([...statement.matchAll(/\b\d+\b/gu)].map((match) => Number(match[0])))];
  return sizes.length === 1 ? sizes[0]! : null;
}

test("a turn the bubble cuts is never silent: the ceiling that deletes its tail is stated, and it is the delivery's own", async () => {
  assert.ok(
    BUBBLE_BUDGET !== null,
    "blocked: the Game surface declares no bubble ceiling, so nothing here was examined",
  );
  const shapes = ceilingTurnShapes();
  assert.ok(shapes.length > 0, "blocked: no turn shape was derived, so the population is empty");
  const examined: {
    id: string;
    speech: readonly string[];
    pieces: readonly string[];
    bubble: NativeCompanionTurnBubble | null;
  }[] = [];
  for (const shape of shapes) examined.push({ ...shape, ...(await deliveredCeilingTurn(shape.speech)) });
  const statement = bubbleSizeStatement(GAME_PROMPT);
  assert.ok(statement.length > 0, "blocked: the Game prompt states no bubble size, so no ceiling was read");
  const stated = statedDeletionCeiling(statement);

  const cut = examined.filter(
    (turn) => turn.bubble !== null && (turn.bubble.truncatedChars > 0 || turn.bubble.sentencesDropped > 0),
  );
  assert.ok(
    cut.length > 0,
    "blocked: no examined turn was cut, so 'a cut turn is never silent' was never exercised - the family must cross " +
      `the ${String(BUBBLE_BUDGET.maxChars)}-character ceiling`,
  );

  // THE READER IS PROVEN LIVE, because a detector that never fires reports the same zero as a floor that never lies.
  assert.equal(
    statedDeletionCeiling("One bubble holds about 80 characters and cannot be retracted once it is shown."),
    null,
    "the sentence this gate was written for states a size and no deletion, so it must read as no statement of the loss",
  );
  assert.equal(
    statedDeletionCeiling("One bubble holds 120 characters. Anything past 120 is deleted before your partner sees it."),
    120,
    "an honest statement of a different ceiling must be read as that ceiling, or the number is not being read at all",
  );
  assert.equal(
    statedDeletionCeiling("One bubble holds 80 characters, and anything past it is deleted at 120."),
    null,
    "a statement naming two sizes names no ceiling, and resolving it by position would compare the wrong number",
  );

  const squeeze = (text: string): string => text.replace(/\s+/gu, "");
  const findings: string[] = [];
  for (const turn of cut) {
    // The other way a cut turn is not silent: the tail reached the player as a continuation. No game turn takes this
    // branch today - `onFinalText` is the surface's only channel - so the model's statement is what holds the gate up.
    const reachedThePlayer =
      turn.pieces.length > 1 && squeeze(turn.pieces.join(" ")).includes(squeeze(turn.speech.join(" ")));
    const reachedTheModel = stated === BUBBLE_BUDGET.maxChars;
    if (!reachedThePlayer && !reachedTheModel)
      findings.push(
        `speech_truncated_without_telling_anyone:${turn.id}:${String(turn.bubble!.truncatedChars)} ` +
          `(${String(turn.bubble!.sentencesDropped)} sentences)`,
      );
  }
  process.stdout.write(
    `\nspeech truncation: turns examined ${String(examined.length)} · truncated ${String(cut.length)} · ` +
      `silently truncated ${String(findings.length)} · the model is told the ceiling ${String(stated ?? "not at all")} · ` +
      `the delivery cuts at ${String(BUBBLE_BUDGET.maxChars)}\n`,
  );
  assert.deepEqual(
    findings,
    [],
    "a turn's speech was deleted at the bubble's ceiling and the model was told only a size, not that the tail is " +
      "deleted: she budgets by a soft number while the surface removes the excess. State the deletion in the conduct " +
      "sentence that states the ceiling (`game-surface-prompt-floor.ts` `one_bubble_of_size`).",
  );
});

/**
 * THE TWO RULES THE FLOOR DELETED, AND THE FACT EACH ONE LEFT WITH THE DELIVERY.
 *
 * <p>
 * Both rules were measured on a live run and both were deleted because the surface had since grown the fact they stated,
 * every turn, from the Mod's own reading: `HOUSE_HAS_NO_KITCHEN` (measured 2026-11-05, day 2 at 18:00 in the starter
 * farmhouse: "六点了，锅里没东西可下，我烧壶水泡点茶对付一口算了" in a house with neither a kitchen nor a stove) and
 * `LIVE_STATE_GROUNDING` (the clock, the weather, the map, her stamina, the tool in her hand and the crops still waiting
 * for water).
 * </p>
 *
 * <p>
 * A RULE IS ONLY REDUNDANT IF THE FACT STILL REACHES HER, so this gate holds both halves and fails in both directions:
 * </p>
 *
 * <ul>
 *   <li>`delivered_fact_missing:<snapshot>:<fact>` - the delivery stopped printing a fact the deleted rule stated. The
 *     population is the producer's own list: every fact `composeGameEnvironmentFacts` renders for the examined house must
 *     appear in the `<world-state>` block `composeFactBrief` composes for that same house. Nothing here is typed from the
 *     rule, so a formatter that loses the fact fails here without anyone editing this test.</li>
 *   <li>`fact_restated_while_delivered:<rule>` - the prompt states the rule again. The detector is proved live on the
 *     verbatim text that was deleted and on a rewording nobody wrote, because a negative that only ever reads the
 *     prompt cannot tell "clean" from "blind".</li>
 * </ul>
 *
 * <p>
 * THE KITCHEN'S POLARITY IS CHECKED BECAUSE THE FACT IS A YES OR A NO, not a line that merely exists: a delivery that
 * always answered 厨房: 有 would satisfy every containment check above and be wrong in the room this rule was written for.
 * `formatKitchen` answers from the Mod's own `cookingStationTargets` scan of the current map, which is published only
 * while `cook_recipe` is advertised - the one hole the audit of this deletion names, and the falsifier below measures it
 * rather than assuming it away.
 * </p>
 */

/**
 * The number of facts the live line rendered the day the two rules were deleted - clock, date, weather, location, tile,
 * kitchen, held tool, unwatered crops, stamina - as the floor of the population below.
 */
const GROUNDING_FACT_FLOOR = 9;

/** One house as the Mod publishes it: the starter farmhouse, and the same house after its kitchen upgrade. */
const HOUSES = Object.freeze([
  Object.freeze({ id: "starter_house", cookingStationTargets: Object.freeze([]), kitchen: "厨房: 无" }),
  Object.freeze({
    id: "upgraded_house",
    cookingStationTargets: Object.freeze([
      Object.freeze({
        targetId: "kitchen_tile_3_4",
        location: "FarmHouse",
        x: 3,
        y: 4,
        stationKind: "kitchen" as const,
      }),
    ]),
    kitchen: "厨房: 有",
  }),
]);

/** The starter house's own reading, indoors, with whatever the cooking-station family published this turn. */
function houseWorld(cookingStationTargets: Snapshot["cookingStationTargets"]): Snapshot {
  return { ...DELIVERY_WORLD, location: "FarmHouse", cookingStationTargets } as unknown as Snapshot;
}

/** One composed delivery for a world reading, through the producer that decides what a turn's message holds. */
function deliveryFor(world: Snapshot): string {
  return composeFactBrief({
    inputs: [],
    snapshot: { snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0 },
    events: [],
    locale: "zh-CN",
  });
}

/**
 * The rules the floor no longer carries, with the fact that carries each one now and the rewrite that would bring the
 * rule back. `text` is the deleted rule VERBATIM: it is what proves the detector fires, and it is history rather than a
 * second spelling of anything the product still says.
 */
const DELETED_RULES = Object.freeze([
  Object.freeze({
    id: "live_state_grounding",
    text:
      "Ground every utterance in the live game state (<runtime-environment>): time, weather, location, stamina, held " +
      "tool, and unwatered crops. Never hallucinate chores or conditions that contradict reality.",
    carriedBy: "the `<world-state>` paragraph, which is `formatGameEnvironmentFacts` over the Mod's own reading",
    restated: /\bstamina\b|\bunwatered crops\b|\bweather\b/iu,
  }),
  Object.freeze({
    id: "house_has_no_kitchen",
    text:
      "The house you share is what this save says it is, not what a farmhouse usually has: the starting house is one " +
      "room, and a kitchen with a stove appears only once the house has been upgraded.",
    carriedBy: "`厨房: 有` / `厨房: 无` in that same paragraph",
    restated: /\bkitchen\b|\bstove\b|\bcook, brew\b/iu,
  }),
]);

test("the facts the deleted rules stated reach her every turn, and the floor states none of them again", () => {
  const findings: string[] = [];
  for (const house of HOUSES) {
    const world = houseWorld(house.cookingStationTargets);
    const delivery = deliveryFor(world);
    // The population is the producer's own rendering of this house, one fact per fact it prints.
    const facts = composeGameEnvironmentFacts(world, true);
    assert.ok(
      facts.length >= GROUNDING_FACT_FLOOR,
      `blocked: the live line renders ${String(facts.length)} facts for ${house.id}, and the two deleted rules stood ` +
        `for ${String(GROUNDING_FACT_FLOOR)}: a shrunken line would make "the fact still reaches her" pass on nothing`,
    );
    for (const fact of facts)
      if (!delivery.includes(fact.text)) findings.push(`delivered_fact_missing:${house.id}:${fact.text}`);
    if (!delivery.includes(house.kitchen)) findings.push(`delivered_fact_missing:${house.id}:${house.kitchen}`);
  }
  const conduct = GAME_PROMPT;
  for (const rule of DELETED_RULES) {
    const still = rule.restated.exec(conduct);
    if (still !== null)
      findings.push(
        `fact_restated_while_delivered:${rule.id}: the prompt still says "${still[0]}", which ${rule.carriedBy} ` +
          "states on every turn",
      );
  }
  process.stdout.write(
    `\ndeleted rules: ${String(DELETED_RULES.length)} · houses examined ${String(HOUSES.length)} · ` +
      `facts delivered ${String(composeGameEnvironmentFacts(houseWorld(HOUSES[0]!.cookingStationTargets), true).length)} · ` +
      `findings ${String(findings.length)}\n`,
  );
  assert.deepEqual(findings, []);
});

/**
 * The falsifier: the same two checks, turned red on purpose - the fact the delivery loses, and the rule the floor says
 * again. Without it the gate above is green both when the fact survives and when its detector never looked.
 */
test("the deletion guard turns red in both directions: a fact the delivery lost, and a rule the floor said again", () => {
  const world = houseWorld(HOUSES[0]!.cookingStationTargets);
  const delivery = deliveryFor(world);
  const facts = composeGameEnvironmentFacts(world, true);

  const missingFrom = (text: string): readonly string[] =>
    facts.filter((fact) => !text.includes(fact.text)).map((fact) => fact.text);

  // Direction one, on a REAL reading: with the cooking-station family unpublished the line goes silent about the room,
  // which is the hole this deletion hands to the book rather than hiding.
  const unpublished = houseWorld(undefined);
  assert.deepEqual(
    composeGameEnvironmentFacts(unpublished, true)
      .filter((fact) => fact.text.startsWith("厨房"))
      .map((f) => f.text),
    [],
    "the kitchen fact is supposed to be silent when the Mod publishes no cooking stations",
  );
  const silent = deliveryFor(unpublished);
  assert.ok(
    missingFrom(silent).length > 0,
    "a delivery with no kitchen fact must be a finding, or the gate cannot see the fact disappear",
  );
  // And the real delivery is the control: it misses nothing, so the unpublished reading above is what a lost fact looks
  // like rather than what this gate always sees.
  assert.equal(
    missingFrom(delivery).length,
    0,
    "blocked: the delivery this falsifier mutates already misses facts, so it cannot show what a missing fact looks like",
  );

  // Direction two, on the deleted text VERBATIM and on a rewording nobody has written.
  for (const rule of DELETED_RULES)
    assert.match(
      rule.text,
      rule.restated,
      `${rule.id}'s detector does not fire on the rule that was deleted, so its silence on the prompt means nothing`,
    );
  assert.match("Never cook in a room without a stove.", DELETED_RULES[1]!.restated, "the class, not the instance");
});
