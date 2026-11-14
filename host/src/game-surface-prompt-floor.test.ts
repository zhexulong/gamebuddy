import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXPRESSION_ONLY_ACTION_IDS, STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { PLAN_ACTION_LIFECYCLES, planActionsFromRegistrations, planWorkDescription } from "./body-program-script.js";
import { composeFactBrief, FACT_BRIEF_BLOCKS } from "./fact-brief.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import {
  ADVERTISED,
  BUILDER_METHODS,
  GAME_SURFACE_PROMPT_FLOOR as READING,
  SURFACE,
} from "./game-surface-prompt-floor.test-support.js";
import { buildChatCompanionSystemPrompt } from "./identity-profile.js";
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
