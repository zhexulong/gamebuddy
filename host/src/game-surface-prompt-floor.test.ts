import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXPRESSION_ONLY_ACTION_IDS, STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { PLAN_ACTION_LIFECYCLES, planActionsFromRegistrations, planWorkDescription } from "./body-program-script.js";
import { composeFactBrief, FACT_BRIEF_BLOCKS } from "./fact-brief.js";
import {
  buildGameCompanionSystemPrompt,
  GAME_SURFACE_INPUT_HEADER,
  gameSurfaceInputHeader,
} from "./game-surface-prompt-floor.js";
import { composeGameEnvironmentFacts } from "./game-world-vocabulary.js";
import {
  ADVERTISED,
  BUILDER_METHODS,
  GAME_SURFACE_PROMPT_FLOOR as READING,
  SURFACE,
} from "./game-surface-prompt-floor.test-support.js";
import { buildChatCompanionSystemPrompt } from "./companion-prompt-assembly.js";
import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import { MAX_COMPANION_PRESENTATION_TEXT_CHARS } from "./companion-presentation-transport.js";
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
 * The surface block, read out of the assembled prompt rather than from the module that composes it.
 *
 * The block's own text is the authority - `gameSurfaceInputHeader(locale)` is what the builder installs, and
 * `GAME_SURFACE_INPUT_HEADER` is that function's own zh-CN value - so slicing the prompt at that exact string proves the
 * prompt carries it whole, in the locale the session runs under.
 */
function surfaceBlock(prompt: string): string {
  const at = prompt.indexOf(GAME_SURFACE_INPUT_HEADER);
  assert.notEqual(at, -1, "the surface header is no longer in the Game prompt as the builder composes it");
  return prompt.slice(at, at + GAME_SURFACE_INPUT_HEADER.length);
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
  const conduct = surfaceBlock(GAME_PROMPT);
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
  // The reading's point was that the Game floor was heavy RELATIVE to Chat, and that 3,620 tokens of the difference were
  // tool definitions. The PROSE half of that is now a 283-character header (2026-11-24), so what is left of the gap is the
  // tools - which is the half this test still holds: `runtime-core.internal.ts` gives the Chat surface no tool group at
  // all, so Chat's floor is its system prompt alone. If Chat ever mounts a tool, the comparison stops meaning what it
  // says, and nothing else here would notice because the number would still be the number.
  assert.equal(
    READING.comparison.chatSurfaceToolCount,
    0,
    "the reading records a Chat surface with no tools; if that changed, re-measure the comparison",
  );
  const chatPrompt = buildChatCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, LOCALE);
  assert.ok(chatPrompt.length > 0, "the Chat surface's prompt must still build, or the comparison has no other half");
  // The Game prompt's prose is no longer the reason the two differ, so the length ordering is recorded rather than
  // asserted: what this test protects is that Chat has no tools to compare with and that both prompts build.
  process.stdout.write(
    `\nsurface prompts: game ${String(GAME_PROMPT.length)} chars · chat ${String(chatPrompt.length)} chars · ` +
      `the Game block is ${String(GAME_SURFACE_INPUT_HEADER.length)} of the game prompt\n`,
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
 * THE BODY-LANGUAGE ROUTE MOVED FROM THE FLOOR TO THE TWO TOOL DESCRIPTIONS, AND THIS HOLDS IT THERE.
 *
 * <p>
 * The floor carried `body_language_is_native` until 2026-11-24. Its ROUTING half - `stardew_express_emote` and
 * `stardew_face_direction` are one step by nature, mounted on their own, and not steps inside `stardew_plan_work` -
 * belongs beside the call, which is the tool description (`game-tools.ts` `DECLARED_ACTION_TOOL_PRESENTATION`); its
 * "write no bracketed stage direction" half measured dead (round78: 13 of 25 turns that carried text still ended in a
 * bracketed line) and left for the persona and the renderer rather than staying as a failed English rule.
 * </p>
 *
 * <p>
 * The POPULATION is the two actions the registry declares expression-only (`EXPRESSION_ONLY_ACTION_IDS`), and the text is
 * read out of `game-tools.ts`'s own presentation table, which is where the mount takes it (`createStardewActionTools`).
 * The ARGUMENT is read from the Mod's emitted descriptor (`SURFACE`), so an action that grows a second argument joins
 * this gate without an edit. Nothing here counts calls: no run is failed for not using a gesture.
 * </p>
 */
function presentationOf(source: string, actionId: string): string {
  const at = source.indexOf(`  ${actionId}: Object.freeze({`);
  assert.notEqual(at, -1, `game-tools.ts declares no presentation for ${actionId}, so its tool mounts with no words`);
  const end = source.indexOf("\n  }),", at);
  assert.notEqual(end, -1, `the ${actionId} presentation is not closed where this reader expects it`);
  return source.slice(at, end);
}

test("the two expression tools' own descriptions carry the route the floor used to teach", () => {
  const presentationSource = readFileSync(join(HOST_SOURCE, "game-tools.ts"), "utf8");
  for (const actionId of EXPRESSION_ONLY_ACTION_IDS) {
    const words = presentationOf(presentationSource, actionId);
    const action = SURFACE.find((candidate) => candidate.actionId === actionId);
    assert.ok(action !== undefined, `the Mod publishes ${actionId}, or the declaration exempts nothing`);
    const declared = Object.keys(action.argumentSchema ?? {});
    assert.ok(declared.length > 0, `blocked: ${action.actionId} declares no argument, so this gate examines nothing`);
    for (const argument of declared)
      assert.ok(
        words.includes(`\`${argument}\``),
        `${actionId}'s description never names its \`${argument}\` argument, so the one call it shows is refused as invalid_args`,
      );
    assert.match(
      words,
      /NOT a step inside `stardew_plan_work`/u,
      `${actionId}'s description does not say it is not a plan step, so the route the floor stopped teaching has no owner`,
    );
    assert.ok(
      STARDEW_ACTION_TOOL_NAMES[actionId].length > 0,
      `${actionId} has no mounted tool name, so nothing carries these words to the model`,
    );
  }
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
    snapshot: { snapshot: DELIVERY_WORLD, revision: 1205, ageTurns: 0, ageMs: 0, contentAgeMs: 0 },
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

  const sentences = surfaceBlock(GAME_PROMPT)
    .split(/(?<=[.!?。！？])\s*/u)
    .filter((piece) => piece.trim() !== "");
  assert.ok(
    sentences.length > 0,
    "blocked: the conduct block split into no sentences, so 'no conduct sentence makes this claim' is a statement about " +
      "nothing",
  );
  const found = headClaims(surfaceBlock(GAME_PROMPT));
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
 * THE DELIVERY LOSES NOTHING BELOW THE TRANSPORT, AND THE FLOOR NEVER STATES A CEILING SHE COULD BUDGET BY.
 *
 * <p>
 * MEASURED 2026-11-16 on `round62`'s own session (90 turns that carried text, 70 that delivered a bubble): **18 turns were
 * cut, 533 characters and 26 whole sentences deleted before the player saw them** - and the rule that asked for it said
 * "about 80 characters". The 80 was neither surface it described. The presentation transport carries 4,000 characters
 * (`integrations/stardew/BridgeSession.cs` `MaximumPresentationTextLength`), the bubble draws two lines of 448 px - about
 * 34 CJK glyphs - and clamps itself with a visible `…` (`CompanionBubble.cs`), and the chat line beside it keeps the whole
 * text for scroll-back, which is what `ModEntry.cs` calls "the authority for the receipt". A compliant 79-character line
 * already ended in `…` on screen, so the cut deleted speech from the surface that survives and never protected the one
 * that clamps.
 * </p>
 *
 * <p>
 * Both halves are held here, because either one alone is the old defect wearing the other's clothes:
 * </p>
 *
 * <ul>
 *   <li>`speech_cut_below_the_transport:<turn>` - a turn whose speech and sound fit what the wire carries was cut
 *     anyway. The population is DERIVED from the transport's own declaration and delivered through the product's own
 *     observer with the surface's own pacing, so a smaller budget anywhere in the chain fails this line by the turn it
 *     cut rather than by a number typed here.</li>
 *   <li>`cut_turn_is_unnamed:<turn>` - a turn past the transport was cut and the record did not name the loss. The
 *     bubble's `truncatedChars` / `sentencesDropped` is what `companion-loop.ts` prints and hands to the run's own
 *     account, so a cut that is not counted is a deletion nobody can see.</li>
 *   <li>`floor_states_a_bubble_ceiling:<sentence>` - the assembled prompt still gives her a size to budget by. The reader
 *     is proved live on the verbatim sentence this unit deleted and on a rewording nobody wrote, because a detector that
 *     only ever reads the prompt cannot tell "clean" from "blind".</li>
 * </ul>
 */

const TRANSPORT_CEILING = MAX_COMPANION_PRESENTATION_TEXT_CHARS;

/** The turn every examined delivery is made for: the reaction sound is seeded by it, so the ceiling derivation needs it. */
const CEILING_TURN_ID = "player_source_transport_ceiling";

/**
 * The measured `round46b` turn: three messages and 92 characters of speech inside ONE prompt turn - and the turn the
 * 80-character ceiling cut in half. Here it is the population's "a real turn" half, at the lengths a live run wrote.
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
 * The turns examined, derived from the transport's ceiling rather than chosen.
 *
 * The sound is the head of the bubble and is spent from the same count (`deliverTurn`), so the last speech length that
 * arrives whole is the ceiling minus the sound - read from the authority that picks the sound, never typed here. The four
 * single-sentence lengths sit ON that boundary (inside it, on it, one past it, and the ceiling), and the recorded turns are
 * what a live run actually wrote: the 92-character `round46b` turn and prefixes of it. There is deliberately no TWICE-the
 * ceiling shape: the text layer has its own 16,384-BYTE bound (`MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES`), and 8,000 CJK
 * characters are 24,000 bytes, which is suppressed as `undrawable_text` before any cut here is reached - a different named
 * fact, and not this gate's.
 */
function ceilingTurnShapes(): readonly CeilingTurnShape[] {
  const sound = selectReactionSound(CEILING_TURN_ID, "zh-CN", GAME_DELIVERY_PACING.reaction!);
  assert.notEqual(
    sound,
    null,
    "blocked: this turn has no reaction vocabulary, so the bubble's head cannot be measured",
  );
  const wholeSpeech = TRANSPORT_CEILING - (sound!.length + 1);
  const lengths = Object.freeze([wholeSpeech - 1, wholeSpeech, wholeSpeech + 1, TRANSPORT_CEILING]);
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
  const delivery = observer.deliverTurn();
  await observer.close();
  // A turn with speech must have delivered; the caller's own assertion below says so, and the named withholding is what it
  // would be failing on if it ever did not.
  return Object.freeze({
    pieces: Object.freeze(pieces),
    bubble: delivery.delivered === 1 ? delivery.bubble : null,
    ...(delivery.delivered === 0 ? { withheld: delivery.reason } : {}),
  });
}

/**
 * Every sentence of the assembled prompt that gives the bubble a SIZE, joined.
 *
 * The population is the prompt the model is handed, not the rule's source, so the reader cannot agree with a module that
 * the prompt does not carry. A sentence joins when it names the bubble and states a number: that is a ceiling she could
 * budget by, which is the defect this reader exists to keep out.
 */
function bubbleCeilingStatements(prompt: string): readonly string[] {
  return bubbleCeilingSentences(surfaceBlock(prompt));
}

/** The same reading over any text: the reader's own red proof needs it, and so does every sentence of the prompt. */
function bubbleCeilingSentences(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?。！？])\s*/u)
    .filter((sentence) => /\bbubble\b/iu.test(sentence) && /\b\d+\b/u.test(sentence));
}

test("the delivery never cuts below the transport, and a cut past it is named on the bubble's own record", async () => {
  const shapes = ceilingTurnShapes();
  assert.ok(shapes.length > 0, "blocked: no turn shape was derived, so the population is empty");
  const examined: {
    id: string;
    speech: readonly string[];
    pieces: readonly string[];
    bubble: NativeCompanionTurnBubble | null;
  }[] = [];
  for (const shape of shapes) examined.push({ ...shape, ...(await deliveredCeilingTurn(shape.speech)) });

  const sound = selectReactionSound(CEILING_TURN_ID, "zh-CN", GAME_DELIVERY_PACING.reaction!);
  assert.notEqual(sound, null);
  const wholeSpeech = TRANSPORT_CEILING - (sound!.length + 1);
  const fits = (turn: { speech: readonly string[] }): boolean => turn.speech.join(" ").length <= wholeSpeech;

  const findings: string[] = [];
  let whole = 0;
  let cut = 0;
  for (const turn of examined) {
    assert.notEqual(turn.bubble, null, `${turn.id}: a turn with speech has a bubble`);
    assert.deepEqual(
      turn.pieces.slice(1),
      [],
      `${turn.id}: one bubble per turn is the surface's contract, and these are past the first`,
    );
    const delivered = turn.pieces[0]!;
    if (fits(turn)) {
      whole += 1;
      const speech = turn.speech.join(" ");
      if (delivered !== `${sound!} ${speech}`)
        findings.push(`speech_cut_below_the_transport:${turn.id}:${String(delivered.length)}:${String(speech.length)}`);
      if (turn.bubble!.truncatedChars !== 0 || turn.bubble!.sentencesDropped !== 0)
        findings.push(
          `speech_cut_below_the_transport:${turn.id}:${String(turn.bubble!.truncatedChars)}:${String(turn.bubble!.sentencesDropped)}`,
        );
      continue;
    }
    cut += 1;
    // Past the transport there is a real loss - the wire would refuse the request outright - and the whole of what the
    // caller can act on is that it is COUNTED, at the ceiling the wire actually carries.
    if (turn.bubble!.truncatedChars <= 0) findings.push(`cut_turn_is_unnamed:${turn.id}:${String(delivered.length)}`);
    if (delivered.length !== TRANSPORT_CEILING)
      findings.push(`cut_is_not_the_transport_ceiling:${turn.id}:${String(delivered.length)}`);
  }

  // THE READER IS PROVEN LIVE: the sentence this unit deleted, and a rewording nobody wrote, both have to be read.
  const deletedRule =
    "One bubble holds 80 characters and cannot be retracted once it is shown, and the sound that opens it is spent from " +
    "that same count. Anything you say past the bubble's ceiling is deleted before your partner sees it: the tail does " +
    "not arrive as a second bubble, and it does not arrive later either.";
  assert.ok(
    bubbleCeilingSentences(deletedRule).length > 0,
    "the verbatim text of the rule this unit deleted is not read as a ceiling statement, so the reader is blind",
  );
  assert.ok(
    bubbleCeilingSentences("One bubble holds 120 characters, and anything past the bubble is deleted.").length > 0,
    "a reworded ceiling must be read too, or this reader only detects the sentence it was written against",
  );
  assert.deepEqual(
    bubbleCeilingSentences("The bubble draws plain prose, so no markdown heading or list reaches it."),
    [],
    "a sentence about what the bubble draws states no size, so it must not be read as a ceiling",
  );
  const stated = bubbleCeilingStatements(GAME_PROMPT);
  for (const sentence of stated) findings.push(`floor_states_a_bubble_ceiling:${sentence}`);

  process.stdout.write(
    `\nspeech bound: turns examined ${String(examined.length)} · whole ${String(whole)} · cut ${String(cut)} · ` +
      `named ${String(cut)} · the wire carries ${String(TRANSPORT_CEILING)} · the floor states a bubble size: ` +
      `${stated.length === 0 ? "none" : String(stated.length)}\n`,
  );
  assert.ok(
    whole > 0 && cut > 0,
    "blocked: the derived population never crossed the ceiling, so nothing was exercised",
  );
  assert.deepEqual(
    findings,
    [],
    "a turn below the transport is delivered whole and a turn past it is counted (`native-companion-content.ts` " +
      "`deliverTurn`), and the prompt states no size she could budget by (`game-surface-prompt-floor.ts`).",
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
    snapshot: { snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0, contentAgeMs: 0 },
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
  assert.deepEqual(
    missingFrom(delivery),
    [],
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

/**
 * ONE RULE LEFT ON 2026-11-19, AND IT MOVED ONE LAYER OUT RATHER THAN INTO THE PERSONA.
 *
 * <p>
 * `SLEEPING_IS_AN_ACTION` said the day ends by calling `builder.sleep()` with no arguments from inside the farmhouse,
 * because a run spent a night announcing goodnight beside a body that never moved (2026-10-28, run
 * game-1793210285549). The measurement was right and the owner was wrong: what she lacked was the CALL, and the tool that
 * mounts the call declares it. `stardew_plan_work`'s description (`body-program-script.ts` `planWorkDescription`) states
 * that `sleep()` takes no arguments and that the day passes only from inside her own farmhouse or cabin, answering
 * `not_home` outdoors - a precondition is read at the moment of the call, which is the only moment it can change one.
 * </p>
 *
 * <p>
 * WHAT THIS TEST OWNS IS THE HALF THE TOOL'S DESCRIPTION CANNOT SEE: the floor may not take the claim back. The detector
 * is the claim's VOCABULARY rather than its sentence (`builder.sleep()`, `not_home`), so a rewording that says it again is
 * red on the day it lands, and the deleted text is carried VERBATIM as proof the detector fires. Where the sentence now
 * lives is asserted by name in `body-program-script.test.ts`.
 * </p>
 */
const DAY_END_CLAIM = Object.freeze({
  id: "sleeping_is_an_action",
  /** The claim's own vocabulary: the call it teaches, and the answer an outdoor attempt gets. */
  reads: /builder\.sleep\(\)|`not_home`/u,
  /** The rule this floor carried until 2026-11-19, VERBATIM: proof that `reads` fires on what produced it. */
  was: "The day ends by going to bed and sleeping: in stardew_plan_work, call builder.sleep() (with no arguments) after entering the farmhouse. A spoken goodnight alone leaves the day exactly where it was.",
  nowStatedBy: "`stardew_plan_work`'s `sleep()` description (`body-program-script.ts` `planWorkDescription`)",
});

test("the surface block states no day-end precondition, because the plan tool's `sleep()` description does", () => {
  const lines = GAME_SURFACE_INPUT_HEADER.split("\n");
  assert.ok(lines.length > 0, "blocked: the surface block is empty, so nothing was examined");
  assert.deepEqual(
    lines
      .filter((line) => DAY_END_CLAIM.reads.test(line))
      .map((line) => `day_end_claim_restated_in_the_floor:${DAY_END_CLAIM.id}:${line.slice(0, 60)}`),
    [],
    `the surface block states the day's end again, and it is now ${DAY_END_CLAIM.nowStatedBy}'s - a second spelling is ` +
      `the one that goes stale. lines examined ${String(lines.length)}`,
  );
  // The detector's own red: the deleted rule VERBATIM must fire on it, or its silence above means nothing.
  assert.match(DAY_END_CLAIM.was, DAY_END_CLAIM.reads, `day_end_claim_detector_is_dead:${DAY_END_CLAIM.id}`);
  // The assembled prompt, because the preset and the card are read by her too - a rule that drifts into either is the same
  // second spelling, and nothing else here would see it.
  assert.doesNotMatch(GAME_PROMPT, DAY_END_CLAIM.reads, "the assembled Game prompt states the day's end again");
});

/**
 * TWO CLAIMS LEFT THIS FLOOR ON 2026-11-23, AND THE PROPERTY IS WHERE THEY LIVE RATHER THAN THAT THEY EXIST.
 *
 * <p>
 * `one_utterance_per_reply` banned markdown, lists and 首先/其次/最后; `observed_only` said she may state only what the game
 * reported and never invent a villager's reaction. The ruling splits them the same way: the first is a reply's LAYOUT and
 * the second is who she is, and neither is a fact about what a block means - so both are the persona's
 * (`assets/tavern/presets/amber-game.json`, the `main` entry every Game session mounts), and the floor states neither. The
 * second the preset already carried one noun narrower ({{user}}'s reactions are his), so it was widened in that same
 * clause instead of being added beside its own narrower copy.
 * </p>
 *
 * <p>
 * WHY THIS IS A GATE AND NOT A DELETION: a rule removed from a table is invisible, and the next lane that measures a
 * markdown-shaped failure will reach for the floor again. So each claim is READ - one reader per claim, run over two
 * populations: every line the surface block installs (derived from `GAME_SURFACE_INPUT_HEADER`) and the
 * persona layer's own `main` text (read from the shipped file, never re-typed here). The assertion is "exactly the
 * persona layer states it", which goes red when the floor takes it back, when the preset loses it, and when both state it.
 * </p>
 */
const PERSONA_PRESET = "amber-game.json";

/** One entry of a shipped preset, read from the file a session mounts rather than re-typed here. */
function presetEntry(file: string, identifier: string): string {
  const document = JSON.parse(readFileSync(join(ROOT, "assets", "tavern", "presets", file), "utf8")) as {
    prompts?: readonly { identifier?: string; content?: string }[];
  };
  for (const prompt of document.prompts ?? []) if (prompt.identifier === identifier) return prompt.content ?? "";
  throw new Error(`${file} has no ${identifier} entry`);
}

/** One claim that changed owner: what it is about, how it is read, and the rule that used to state it. */
type PersonaClaim = Readonly<{
  id: string;
  claim: string;
  /** The claim's own vocabulary, in both languages it has been stated in. A shape, not a sentence. */
  reads: RegExp;
  /** The rule this floor carried until 2026-11-23, VERBATIM: proof that `reads` fires on what produced it. */
  was: string;
}>;

const PERSONA_CLAIMS: readonly PersonaClaim[] = Object.freeze([
  Object.freeze({
    id: "one_utterance_per_reply",
    claim: "how a reply is laid out",
    reads: /markdown|headings?\b|bullet|block quote|\bbold\b|首先|其次|最后|排版/u,
    was:
      "No markdown headings, lists, bold or block quotes, and no 首先, 其次, 最后 or 总结: the bubble draws plain prose, so " +
      "structure in it reads as a document where a person was talking.",
  }),
  Object.freeze({
    id: "observed_only",
    claim: "what she may assert about a villager's reaction",
    reads:
      /hallucinat|never claim|\binvent|\bmake up\b|\bNPC'?s\b|\bsmiled\b|\bbeamed\b|\bdelighted\b|谁笑了|别替人家编|没真的看到/u,
    was:
      "Only state what you actually observed in the game. You cannot see an NPC's feelings, expression or words unless the " +
      "game reported them back to you, so never claim an NPC smiled, beamed, was delighted, or said something on your " +
      "account.",
  }),
]);

/** Every line the surface block installs, as the model reads it: one sentence group per line, derived and never listed. */
const SURFACE_LINES: readonly string[] = Object.freeze(GAME_SURFACE_INPUT_HEADER.split("\n"));

test("the claims the surface block stopped making are stated by the persona layer, and by no line it still installs", () => {
  const persona = presetEntry(PERSONA_PRESET, "main");
  const findings: string[] = [];
  for (const claim of PERSONA_CLAIMS) {
    for (const line of SURFACE_LINES)
      if (claim.reads.test(line))
        findings.push(
          `floor_states_the_claim:${claim.id}: the line "${line.slice(0, 60)}" states ${claim.claim}, which is the ` +
            `persona's now - delete it here rather than teaching this gate to tolerate it`,
        );
    if (!claim.reads.test(persona))
      findings.push(
        `persona_layer_has_lost_the_claim:${claim.id}: ${claim.claim} is stated by no layer, so the move was a loss`,
      );
  }
  process.stdout.write(
    `\npersona claims: ${String(PERSONA_CLAIMS.length)} · surface lines read ${String(SURFACE_LINES.length)} · ` +
      `findings ${String(findings.length)}\n`,
  );
  assert.deepEqual(findings, []);

  // And the clause that absorbed the second one is stated ONCE: the preset's ownership sentence was widened to the
  // village, never duplicated beside the player-only half it replaced.
  assert.equal(
    [...persona.matchAll(/只说你自己的/gu)].length,
    1,
    "the ownership clause is stated once - widened to the whole village - and not a second time beside itself",
  );
  // WHAT THE FLOOR STILL SAYS ABOUT A REPLY'S SHAPE: nothing, and that is now the whole of it. The box it is spoken into
  // left on 2026-11-24 with the 80 that described no surface at all (the transport carries 4,000, the bubble clamps its own
  // two lines with `…`), so neither a size nor a deletion past it is stated here - `game-surface-prompt-floor.test.ts`
  // holds the delivery and the prompt together on that point.
  assert.doesNotMatch(GAME_PROMPT, /One bubble holds \d+ characters/u);
  assert.doesNotMatch(GAME_PROMPT, /No markdown headings/u);
  assert.doesNotMatch(GAME_PROMPT, /Only state what you actually observed/u);
});

/**
 * The falsifier: the same readers, turned red on purpose. Each fires on the rule that WAS in the floor and on a rewording
 * nobody has written, and says nothing about the preset's own `jailbreak` entry - a negative control INSIDE the same
 * document, so neither reader is answering "yes" to everything it is shown.
 */
test("the persona readers turn red on the rules the floor lost, and stay silent on a cell that states neither", () => {
  for (const claim of PERSONA_CLAIMS)
    assert.match(
      claim.was,
      claim.reads,
      `${claim.id}'s reader does not fire on the rule this floor carried, so its silence on the floor proves nothing`,
    );
  assert.match(
    "When you answer, use no bullet points and no headings.",
    PERSONA_CLAIMS[0]!.reads,
    "the class, not the instance: a rewording nobody wrote is still a layout claim",
  );
  assert.match(
    "She says what the game showed her; she never invents how a villager felt.",
    PERSONA_CLAIMS[1]!.reads,
    "the class, not the instance: a rewording nobody wrote is still a claim about someone else's reaction",
  );
  const jailbreak = presetEntry(PERSONA_PRESET, "jailbreak");
  for (const claim of PERSONA_CLAIMS)
    assert.doesNotMatch(
      jailbreak,
      claim.reads,
      `${claim.id}'s reader fires on a preset cell that does not state it, so it cannot tell the layers apart`,
    );
});

/**
 * A RULE THE PROMPT STATES HAS AN OWNER - the gate that replaced the class table.
 *
 * <p>
 * The old gate counted rules and asked each one for a class and an exit. That was the right shape while the surface block
 * WAS a rule list; now that it is a header, counting rules would count nothing, and the property worth holding is the one
 * the deletions were made for: a sentence in this block that states BEHAVIOUR has an owner somewhere else, or a recorded
 * reason it cannot move there yet. A future "add a rule here" then fails at the moment it lands, naming the sentence.
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED FROM THE PROMPT, not from a list: every sentence of the surface block as the builder installs
 * it (`surfaceBlock(GAME_PROMPT)`), so a line added tomorrow joins without an edit here. The READING classifies each
 * sentence as SYNTAX (it names what the message is - the blocks, where speech sits) or BEHAVIOUR (it tells her to do
 * something), and a behaviour sentence is explained by one of the two ledgers below, each entry naming the owner and how
 * this gate recognises the sentence. Two ledgers, because they are two different facts and the print says which:
 * </p>
 *
 * <ul>
 *   <li>`ENFORCED_ELSEWHERE` - another layer states and enforces the same claim, so this sentence could be deleted without
 *     losing it.</li>
 *   <li>`CANNOT_BE_MOVED` - no other layer can carry it yet, with the surface change that would end that. It is DEBT, not
 *     a pass: it prints under its own count and is never added to the enforced one.</li>
 * </ul>
 *
 * <p>
 * THE FAILING CONDITION is `behaviour - enforced - cannotBeMoved > 0`: a sentence that states behaviour and is in neither
 * ledger. A recorded entry that stops matching a sentence is a finding too (`rule_owner_record_stale`), because a ledger
 * that outlives its sentence is an exemption over nothing.
 * </p>
 */

/**
 * A sentence states behaviour when it tells her to do something: a prohibition, a modal, or a Chinese imperative.
 *
 * A verb alone is not enough - the syntax line says "the words are your partner's" and that is a statement about the
 * message, not an order - so the marker is the imperative itself.
 */
const STATES_BEHAVIOUR =
  /(?:\b(?:never|do not|don't|must|always|only|say|says|speak|write|call|answer|tell|talk|translate|keep)\b)|(?:不要|别|不准|务必|记得|说的时候|翻成|说成|用词|只拿|只用|只填)/iu;

/** One sentence of the surface block, and the layer that owns the claim it states. */
type SurfaceSentenceOwner = Readonly<{
  id: string;
  /** The claim's own vocabulary, so a rewording that states it again joins the same entry. */
  reads: RegExp;
  /** Who states and enforces it - for `CANNOT_BE_MOVED`, the change that would give it a home. */
  owner: string;
}>;

/**
 * Sentences another layer states and enforces. Empty today, and that is the reading: every rule this module carried went
 * to the layer that already owned it, so nothing in the header is a duplicate of an enforceable claim.
 */
const ENFORCED_ELSEWHERE: readonly SurfaceSentenceOwner[] = Object.freeze([]);

/**
 * Sentences no other layer can carry yet. Each is debt with the change that ends it, and the gate prints the count
 * rather than folding it into `enforced-elsewhere`.
 *
 * EMPTY SINCE 2026-11-19, and that is the reading rather than an omission: the last entry was the line ordering her to
 * translate a refusal's reason code, and it left the day the renderers translated it - `fact-brief.ts` states the step in
 * `RECEIPT_STATE_ZH` and appends the instruction `stardew-action-remedy.ts` owes that code, with the code and its evidence
 * on the block's address line. Its owner record was deleted with the sentence, which is what this gate requires: a record
 * that outlives its sentence is an exemption over nothing.
 */
const CANNOT_BE_MOVED: readonly SurfaceSentenceOwner[] = Object.freeze([]);

/** The recorded pair before this unit: the assembled Game prompt and the surface block, as `remeasured_2026_11_24` took them. */
const BEFORE_THIS_UNIT = Object.freeze({ systemChars: 5_553, surfaceChars: 3_226 });

test("a_rule_the_prompt_states_has_an_owner: no sentence of the surface block states behaviour without one", () => {
  const block = surfaceBlock(GAME_PROMPT);
  const sentences = block
    .split(/(?<=[.!?。！？])\s*/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  assert.ok(
    sentences.length > 0,
    "blocked: the surface block split into no sentence, so 'no sentence states behaviour without an owner' is a statement " +
      "about nothing",
  );

  const syntax = sentences.filter((sentence) => !STATES_BEHAVIOUR.test(sentence));
  const behaviour = sentences.filter((sentence) => STATES_BEHAVIOUR.test(sentence));
  const enforced = behaviour.filter((sentence) => ENFORCED_ELSEWHERE.some((entry) => entry.reads.test(sentence)));
  const unmovable = behaviour.filter((sentence) => CANNOT_BE_MOVED.some((entry) => entry.reads.test(sentence)));
  const unnamed = behaviour.filter(
    (sentence) => !enforced.includes(sentence) && !unmovable.includes(sentence),
  );
  const stale = [...ENFORCED_ELSEWHERE, ...CANNOT_BE_MOVED].filter(
    (entry) => !sentences.some((sentence) => entry.reads.test(sentence)),
  );

  // THE READER IS PROVEN LIVE IN BOTH DIRECTIONS: it must fire on the sentences this unit deleted and stay silent on the
  // syntax it kept, or a green verdict here would be a statement about a detector nobody checked.
  assert.ok(
    STATES_BEHAVIOUR.test("When a stretch of work ends, speak from your immediate bodily sensation."),
    "blocked: the behaviour reader does not fire on a rule the old floor carried, so its silence proves nothing",
  );
  assert.ok(
    STATES_BEHAVIOUR.test("Write no bracketed stage direction at all."),
    "blocked: the behaviour reader does not fire on the second rule the old floor carried",
  );
  assert.ok(
    !STATES_BEHAVIOUR.test("This message is the machine's report, in three blocks."),
    "the behaviour reader flags a sentence that names the message's syntax",
  );

  process.stdout.write(
    `\na_rule_the_prompt_states_has_an_owner: sentences examined ${String(sentences.length)} · syntax ${String(syntax.length)} · ` +
      `behaviour ${String(behaviour.length)} · enforced-elsewhere ${String(enforced.length)} · ` +
      `cannot-be-moved ${String(unmovable.length)}\n`,
  );
  for (const entry of CANNOT_BE_MOVED)
    process.stdout.write(`  cannot-be-moved ${entry.id}: ${entry.owner.slice(0, 120)}…\n`);

  assert.deepEqual(
    stale.map((entry) => `rule_owner_record_stale:${entry.id}`),
    [],
    "an owner record matches no sentence of the surface block: delete it with the sentence it described",
  );
  assert.deepEqual(
    unnamed.map((sentence) => `a_rule_the_prompt_states_has_an_owner:${sentence.slice(0, 80)}`),
    [],
    "this sentence states behaviour and no layer owns it: move it to the layer that does (a tool description, the card, " +
      "the delivery), or record it as `cannot-be-moved` with the surface change that would end it",
  );
});

test("the surface block's share of the Game prompt is printed, before and after this unit", () => {
  const share = GAME_SURFACE_INPUT_HEADER.length / GAME_PROMPT.length;
  process.stdout.write(
    `\ngame prompt characters: before ${String(BEFORE_THIS_UNIT.systemChars)} · after ${String(GAME_PROMPT.length)} · ` +
      `surface block before ${String(BEFORE_THIS_UNIT.surfaceChars)} · after ${String(GAME_SURFACE_INPUT_HEADER.length)} · ` +
      `the block is now ${(share * 100).toFixed(1)}% of the prompt\n`,
  );
  assert.ok(
    GAME_SURFACE_INPUT_HEADER.length < BEFORE_THIS_UNIT.surfaceChars,
    "the surface block grew: this unit replaced a rule list with a header, and a header larger than the list it replaced " +
      "is the list coming back",
  );
  assert.ok(share < 0.15, `the surface block is ${(share * 100).toFixed(1)}% of the prompt, which is a rule list's share`);
  // The block is in the run's locale, and the English half exists because `locale` is a runtime fact on both surfaces.
  const english = gameSurfaceInputHeader("en-US");
  assert.notEqual(english, GAME_SURFACE_INPUT_HEADER, "the header renders in the run's own locale, not in one language");
  assert.doesNotMatch(GAME_SURFACE_INPUT_HEADER, /[A-Za-z]{4,} [A-Za-z]{4,} [A-Za-z]{4,} [A-Za-z]{4,}/u);
});
