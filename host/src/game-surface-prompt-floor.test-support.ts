/**
 * The recorded Game-surface prompt floor, as a module rather than a JSON file.
 *
 * <p>
 * It lives in `.test-support.ts` so it is compiled into the test artifact and excluded from the production
 * build: this is a reading, not product configuration. The numbers below were measured, not chosen - the
 * `method` block says how, per number - and the test that reads this file re-derives the parts it can: the
 * character columns from the product's own builder, and the plan-builder counts from the Mod's emitted surface.
 * The plan-builder counts are the one part not recorded at all: they are computed HERE, at read time, from the
 * artifact a live `hello_ack` publishes, through the Host's own plan admission.
 * </p>
 *
 * <p>
 * Measured 2026-10-31 by `scratch/pf-measure.mjs` (tool definitions off a real materialized production session
 * over an attested named-pipe bridge) and `scratch/pf-combined.mjs` (that set plus the two WorldBook tools a
 * seeded root adds, and the system prompt from the product's own builder), with Magic Context's own envelope
 * shape and tokenizer.
 * </p>
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { planActionsFromRegistrations } from "./body-program-script.js";
import type { ActionRegistration } from "./protocol.js";

type PromptFloorRow = Readonly<{
  name: string;
  descriptionChars: number;
  parametersChars: number;
  descriptionTokens: number;
  parametersTokens: number;
  totalTokens: number;
}>;

export type PromptFloorReading = Readonly<{
  schema: "gamebuddy-game-surface-prompt-floor/v1";
  surface: "game";
  method: Readonly<Record<string, string>>;
  floor: Readonly<{
    toolCount: number;
    systemChars: number;
    systemTokens: number;
    toolsTokens: number;
    envelopeChars: number;
    envelopeBytes: number;
    envelopeTokens: number;
  }>;
  conductBlock: Readonly<{
    chars: number;
    tokens: number;
    charShareOfSystemPrompt: number;
    tokenShareOfSystemPrompt: number;
  }>;
  denominator: readonly Readonly<{
    window: number;
    output: number;
    geometry: string;
    usableSoft: number;
    floorShare: number;
  }>[];
  comparison: Readonly<{
    chatSurfaceEnvelopeTokens: number;
    chatSurfaceToolCount: number;
    note: string;
  }>;
  rows: readonly PromptFloorRow[];
  planBuilder: Readonly<{
    flatPerActionToolsMounted: false;
    /**
     * The size of the plan-builder surface, split into the two populations it names and COMPUTED at read time.
     *
     * Until 2026-11-10 it was one `publishedActions` (95) beside a `plannableBuilderMethods` (92), both literals with
     * nothing comparing either to the catalog, and both wrong about the surface they described. They became gated
     * claims, and the surface then grew again inside two days - which is what a recorded count is: a disagreement
     * scheduled for the next added action. They are derived below from the artifact a live `hello_ack` publishes, so
     * there is no copy left to drift and no number here to edit.
     */
    claims: Readonly<{
      /**
       * The per-action tools the adapter publishes - the surface's executable actions, which
       * `action-registry-consistency.test.ts` holds set-equal to this file's mount blocks. `runtime-core.internal.ts`
       * drops every one of them from a plan surface except the actions the registry declares expression-only.
       */
      flatPerActionTools: number;
      /** The subset `stardew_plan_work` exposes as builder methods, by the product's own plan admission. */
      plannableBuilderMethods: number;
    }>;
    note: string;
  }>;
}>;

const ROOT = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("repository_root_not_found");
    directory = parent;
  }
})();

/** The Mod's emitted action surface: the artifact the attested-pipe fixture loads, at the same path. */
const SURFACE_ARTIFACT = join(
  ROOT,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);

type SurfaceAction = Readonly<{
  actionId: string;
  lifecycle: ActionRegistration["lifecycle"];
  kind: ActionRegistration["kind"];
  argumentSchema?: Readonly<Record<string, Readonly<{ type: string; enum?: readonly string[] }>>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
}>;

export const SURFACE = (
  JSON.parse(readFileSync(SURFACE_ARTIFACT, "utf8")) as Readonly<{ actions: readonly SurfaceAction[] }>
).actions;

/**
 * The surface rebuilt into the registrations a live `hello_ack` advertises, which is the shape the Host's own plan
 * admission takes from the wire. `familyId` is the one field the artifact does not publish; the plan builder groups by
 * it and every count here is of ids, so a single placeholder family carries every action.
 */
export const ADVERTISED: readonly ActionRegistration[] = SURFACE.map((action) =>
  Object.freeze({
    actionId: action.actionId,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle,
    kind: action.kind,
    ...(action.argumentSchema === undefined
      ? {}
      : {
          descriptor: {
            argumentSchema: action.argumentSchema,
            outputFacts: action.outputFacts ?? {},
            ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
          },
        }),
  }),
);

/** Every action the adapter can build a per-action tool for: the population a plan surface drops. */
const FLAT_TOOLS = SURFACE.filter((action) => action.kind === "execution").map((action) => action.actionId);
/** The builder methods the product derives from the surface, through its own admission test. */
export const BUILDER_METHODS = planActionsFromRegistrations(ADVERTISED).map((action) => action.actionId);

export const GAME_SURFACE_PROMPT_FLOOR: PromptFloorReading = Object.freeze({
  schema: "gamebuddy-game-surface-prompt-floor/v1",
  surface: "game",
  method: Object.freeze({
    envelope:
      "vendor/magic-context/packages/pi-plugin/src/pi-lkg-fit-envelope.ts:66 measures JSON.stringify({system, tools, messages: []}); this reading uses that exact shape.",
    tokens:
      "ai-tokenizer with the claude encoding, resolved the way vendor/magic-context/packages/plugin/src/hooks/magic-context/read-session-formatting.ts resolves it. This is the count Magic Context's estimateTokens returns.",
    tools:
      "Read off a real materialized production session: createHostGameRuntimeMaterializer().materializeEnter(...) over an attested Windows named-pipe bridge whose hello_ack publishes integrations/stardew/action-development/contracts/generated/action-surface.v1.json, with session.agent.state.tools as the population. BODY_PROGRAM_MOUNT reported mounted=true, so this is the plan-builder surface a live Farmhand gets.",
    system:
      "buildGameCompanionSystemPrompt(DEFAULT_COMPANION_PRESET.profile, 'zh-CN'), the builder runtime-core.internal.ts installs, over the shipped card.",
    combination:
      "The pipe run and the shipped card are measured separately and combined: a fresh runtime root carries no identity profile, so the materialized session falls back to DEFAULT_IDENTITY_PROFILE. Each half is real; only the pairing is assembled.",
    worldbookTools:
      "A fresh root has no worldbook.json, so the pipe run mounts none. createWorldBookTools over DEFAULT_COMPANION_PRESET.worldBook supplies the two tools a seeded root adds.",
    remeasured_2026_11_05:
      "Negative prompt examples and quotes were removed in favor of affirmative target framing across card.json and identity-profile.ts. The CHARACTER columns below were re-derived from the product's builder exactly; the TOKEN columns were NOT re-measured, because that needs the whole materialized-session instrumentation above and the claude-encoding count this lane could reproduce differs from the reading's. `envelopeChars`/`envelopeBytes` moved by the exact character count delta.",
    remeasured_2026_11_08:
      "The Game prompt grew from 10,886 to 13,411 chars, and NONE of it is tool text: the builder renders no tool definition, and the conduct block - the only place the floor names a tool - is still 6,194 chars. The growth is the card's own authored text plus one Host line: its performance directive (characterVoice) +2,181, its persona and examples +237, and the Host floor's language line +107. The two card halves arrived in 63f0dcde (already stale at HEAD, +993) and in this tree's re-authored card (+1,425); the language line is this tree's identity-profile.ts. The CHARACTER columns are re-derived from the product's builder exactly; `envelopeChars`/`envelopeBytes` moved by the JSON-escaped system string's own delta (+2,594 chars, +6,846 bytes), which is the exact envelope delta because `tools` and `messages` are unchanged. The TOKEN columns are carried UNCHANGED and are now a substantial under-count: the ai-tokenizer in this tree counts the previously recorded 10,886-char prompt at 6,480, so the vocabulary behind the recorded 5,119 is not reproducible here at all, and no token number in this file describes the current prompt.",
    remeasured_2026_11_09:
      "The Game prompt grew from 13,411 to 13,781 chars (+370) and the conduct slice from 6,194 to 6,631 (+437), so at least one line also left the prompt: both deltas are recorded as measured, not reconciled. One source is isolated exactly - the language directive grew +92, measured by substituting zh-CN into both spellings. The remainder is card prose from 796f701a (the campfire line) and 7761b039 (the management-panel card), neither isolated line by line here. Envelope and token columns were NOT re-measured in this commit.",
    planBuilderCounts:
      "Not a recording at all: this module computes both counts at read time, from integrations/stardew/action-development/contracts/generated/action-surface.v1.json (the artifact the live hello_ack publishes) - its executable actions for `flatPerActionTools`, and the Host's own plan admission (`body-program-script.ts` `planActionsFromRegistrations`) over the same actions for `plannableBuilderMethods`. The pair was 95/92 as literals until 2026-11-10, by which time the artifact published 101 executable actions of which 95 were plannable; the gate that replaced them recorded 101/95, and the surface grew to 102/96 within two days. A count beside the thing it counts is a second spelling, so there is no count here to re-record: it follows the artifact.",
    remeasured_2026_11_10:
      "The Game prompt SHRANK from 13,781 to 10,452 chars (-3,329) in f94d31c6 (2026-11-10 02:22), which cut the card's `characterVoice.text` from ~4,025 to 575 source chars and did not re-record this reading. The CHARACTER columns are re-derived here from the product's own builder exactly: `systemChars` 10,452, and the conduct slice is UNCHANGED at 6,631 chars (its numerator proves it - the block is Host floor text, not card prose), so its share is 6,631 / 10,452 = 0.6344, against the previously recorded 6,631 / 13,781 = 0.4812. The TOKEN and ENVELOPE columns were NOT re-measured in this commit and remain the irreproducible under-counts `remeasured_2026_11_05` describes; they are now additionally stale by the card's cut, and the `systemTokens` recorded here describes a prompt 3,329 chars longer than the one that ships.",
    remeasured_2026_11_10_b:
      "The Game prompt GREW by exactly one conduct rule (+559 chars, 10,452 to 11,011): the paragraph naming the four delivery blocks (`<player-note>` <world-state> <world-facts> <execution-result>) and stating that a machine block is not the player speaking. It is 558 chars of text plus the newline the conduct joins it with, and the conduct slice grew by the same 559 (6,631 to 7,190), which is what proves the growth is inside the floor and not in card prose: 7,190 / 11,011 = 0.6530. `envelopeChars`/`envelopeBytes` moved by the JSON-escaped system string's own delta (+560 chars: 558 prose + the newline, escaped as two; +559 bytes, the paragraph is ASCII), which is the whole envelope's delta because `tools` and `messages` are unchanged. The TOKEN columns are carried UNCHANGED and are now a larger under-count still: they describe a prompt 3,889 chars shorter than the one that ships.",
    remeasured_2026_11_11:
      "The delivery-block rule stopped being prose with a number in it: its count and its member names are now read from `FACT_BRIEF_BLOCKS`, so a fifth block (`<in-flight>`, added 2026-11-11) is named in the sentence instead of the prompt saying four while the batch carried five. Measured by the test against the product's builder: `systemChars` 11,101 (10,452 + the 559-char rule of 2026-11-10 + 90 from this rewrite) and the conduct slice 7,268 (6,631 + 559 + 78). The two deltas differ by 12 chars and are recorded AS MEASURED, not reconciled: the previous entry asserted the conduct grew by exactly the same 559 as the prompt, which was arithmetic rather than a second reading. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (+90, ASCII, no new escapes). The TOKEN columns are again carried unchanged and are now a larger under-count still.",
    remeasured_2026_11_12:
      "The body-language conduct rule was rewritten, so every column that counts it moved. `systemChars` 10829 and the conduct slice 6997 (+166 both, the rule grew by exactly that much and it is ASCII: the JSON-escaped delta and the UTF-8 byte delta are both 166). The share is re-derived as 6997 / 10829 = 0.6461. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (+166: 25959 -> 26125, 35268 -> 35434) and were NOT re-measured, because that needs the whole materialized-session instrumentation. THE PRE-EXISTING -1 IS RECORDED HERE RATHER THAN ABSORBED SILENTLY: before this change the tree's builder produced 10663 against the recorded 10664, while the conduct slice measured exactly 6831 both times - so that character was never in the conduct block and is not this change's. It is the card/persona side, and the envelope columns above inherit it. The TOKEN columns are again carried unchanged and remain the under-count `remeasured_2026_11_05` describes.",
    remeasured_2026_11_12_b:
      "The body-language rule gained the argument its route requires, so every column that counts it moved again. `systemChars` 11032 and the conduct slice 7200 - both +203, and the two deltas AGREE here because the edit is inside the one rule and nowhere else (the rule grew by exactly that much, ASCII, so the JSON-escaped delta and the UTF-8 byte delta are both 203). The share is re-derived as 7200 / 11032 = 0.6526. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (+203: 26125 -> 26328, 35434 -> 35637) and were NOT re-measured, because that needs the whole materialized-session instrumentation; the recorded -1 from `remeasured_2026_11_12` is inherited unchanged. The added text is what the plan description cannot state - the closed-set argument `express_emote` takes and where its words are printed - and it carries no frequency: nothing in the floor makes an emote owed. The TOKEN columns are again carried unchanged and remain the under-count `remeasured_2026_11_05` describes.",
    remeasured_2026_11_11_b:
      "The Game prompt SHRANK by exactly one conduct rule (-437 chars, 11,101 to 10,664): the rule that ordered a spoken remark to the partner before every action or planning tool (`Speak before you act ... Never run tools in total silence ...`). It was FORM by the doctrine this floor's own module states - how long a turn is and how many beats it carries - and the shipped card already governs that (`default-companion/card.json`: 「说话紧扣当下真实生活体验，收放自如，不啰嗦不客套」), so an unconditional 'always deliver a spoken remark first' overrode 收放自如 with its opposite. Measured consequence (round46b, 36 minutes over 2 in-game days): 93 prompt turns, 159 assistant messages, 132 bubbles, of which 90 were standalone speech with no tool call in the same message - one bubble every 16 seconds, 1.42 per turn, 1.91 per tool call. The CHARACTER columns are re-derived from the product's builder exactly: `systemChars` 10,664 and the conduct slice 6,831 (7,268 - 437), so its share is 6,831 / 10,664 = 0.6406, recorded as 0.641. The two deltas agree (-437 both) because the deleted text was inside the floor and nowhere else. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (-437: the rule is ASCII, so JSON-escaped characters and UTF-8 bytes move together) with `tools` and `messages` unchanged, which is what makes that the whole envelope's delta. The TOKEN columns were NOT re-measured in this commit and are now stale by 437 characters as well as by everything `remeasured_2026_11_05` describes.",
    remeasured_2026_11_13:
      "The body-language conduct rule was rewritten to name the two MOUNTED tools instead of a plan step, so every column that counts it moved. `systemChars` 11096 and the conduct slice 7264 (+64 both, and the two deltas AGREE because the edit is inside the one rule and nowhere else; the added and removed text is ASCII, so the JSON-escaped delta and the UTF-8 byte delta are both 64). The share is re-derived as 7264 / 11096 = 0.6546. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (+64: 26328 -> 26392, 35637 -> 35701) and were NOT re-measured, because that needs the whole materialized-session instrumentation; the recorded -1 from `remeasured_2026_11_12` is inherited unchanged. THE TOOL COLUMNS ARE NOW AN UNDER-COUNT BY TWO TOOLS: the same change mounts `stardew_express_emote` and `stardew_face_direction` beside the plan builder (`EXPRESSION_ONLY_ACTION_IDS`), so the measured surface carries 16 tools where `toolCount`/`rows` record the 14 a plan-builder-only session carried - `14 -> 16`, and the two added definitions' tokens and characters are not in `toolsTokens` or the envelope columns. `action-route-gate.test.ts` reads the assembled set and proves the two are mounted; re-measuring this reading is a separate commit with the materialized-session instrumentation. The TOKEN columns are again carried unchanged and remain the under-count `remeasured_2026_11_05` describes.",
    remeasured_2026_11_14:
      "The `<player-note>` block is GONE, so the delivery-block rule no longer names five blocks. The player's words are now the head of the turn, verbatim and outside every block (`fact-brief.ts#composeFactBrief`), and the rule says so positionally instead of naming a block that holds them - the block, its two labels and the attribution rule that filled them (`player-note.ts`) were deleted with it. Measured by the test against the product's builder: `systemChars` 11,102 and the conduct slice 7,270 - both +6, and the two deltas AGREE because the edit is inside the one rule and nowhere else (the removed gloss and the rewritten sentence are both ASCII, so the JSON-escaped delta and the UTF-8 byte delta are both 6). The share is re-derived as 7,270 / 11,102 = 0.6548. `not_derived` from the builder: `envelopeChars` and `envelopeBytes`, whose tool array comes from a materialized session - they follow the system string by its own delta (+6: 26,392 -> 26,398, 35,701 -> 35,707) under the convention `remeasured_2026_11_05` states, and the recorded -1 from `remeasured_2026_11_12` and the two-tool under-count from `remeasured_2026_11_13` are inherited unchanged. The TOKEN columns are again carried unchanged.",
    remeasured_2026_11_15:
      "WHEN she speaks left the floor for the preset, so four conduct clauses went with it: rule 3's tail ('say it as you begin a stretch of work, then work quietly until you are done'), rule 5's ', and stop', rule 7's ', so say one thing per reply and stop when it has been said', and rule 8's opening 'One utterance per reply.' The preset already states every one of them (`amber-deepseek-v4.1.json`: `说清就停`, `连续劳作专注干活`, `单条回复…8~30 字`), which is what makes this a deletion of duplicates rather than a loss; `host/src/conversational-stance-gate.test.ts` is what keeps them from returning to this floor. Measured by the test against the product's builder: `systemChars` 10,934 and the conduct slice 7,102 - both -168, and the two deltas AGREE because the edit is inside the conduct block and nowhere else; the removed text is ASCII, so the JSON-escaped delta and the UTF-8 byte delta are both -168. The share is re-derived as 7,102 / 10,934 = 0.6495. `not_derived` from the builder: `envelopeChars`/`envelopeBytes` follow the system string by its own delta (26,398 -> 26,230, 35,707 -> 35,539) under `remeasured_2026_11_05`'s convention, and the recorded -1 and the two-tool under-count are inherited unchanged. NOT IN THIS READING'S COLUMNS: the plan tool's description lost the same kind of clause ('so end your turn and speak to the player' -> 'so end your turn'), 24 chars that no column here counts - the tool rows are the 2026-10-31 materialized-session measurement and already an under-count. The TOKEN columns are again carried unchanged.",
    remeasured_2026_11_21:
      "The delivery-block rule stopped asserting a premise the delivery contradicts, and the grounding rule stopped commanding speech on every turn, so every column that counts them moved. Measured 2026-11-21 (`round56`, 32 delivered batches): 29 began with `<world-state>` and 3 with the partner's own words, because `composeFactBrief` can emit only those two heads - so 'A turn's message opens with your partner's own words ... answer what your partner said at the top of the message' was false on 90% of the turns that ran. The rule now states both shapes (`fact-brief`'s two heads) and says of the no-speech one only that there is nobody at the top to answer, so nothing about WHEN she speaks enters the floor. `tangible_specifics`'s 'Say what is happening right in front of you and deliver your first reaction' became 'When you speak, say what is happening right in front of you: your first reaction, never a summary of the situation' - an unconditional speech command is the same false premise wearing an imperative. Measured by the test against the product's builder: `systemChars` 10,923 and the conduct slice 7,420, and the two deltas AGREE against HEAD (+271 both) because both edits are inside the conduct block and nowhere else; the added and removed text is ASCII, so the JSON-escaped delta and the UTF-8 byte delta are both +271. THE +271 IS NOT THE WHOLE DELTA FROM THE LAST RECORDING, and the rest is RECORDED HERE RATHER THAN ABSORBED SILENTLY: at HEAD (9b71de46) this tree's builder already produced `systemChars` 10,652 against the recorded 10,934 -282, and a conduct slice of 7,149 against the recorded 7,102 +47, which is a card/persona-side loss of 329 chars and a conduct gain of 47 that no entry above names. The share is re-derived from the CURRENT pair, as 7,420 / 10,923 = 0.6793, not from the recorded pair: the previous entry's 0.6495 divided two numbers that no longer describe either side. `not_derived` from the builder: `envelopeChars`/`envelopeBytes` follow the system string by this change's own delta (+271: 26,230 -> 26,501, 35,539 -> 35,810) under `remeasured_2026_11_05`'s convention; the inherited -282 and -1 are NOT in those two numbers, so both are now under-counts of a prompt 283 chars longer than the one that ships, and the two-tool under-count from `remeasured_2026_11_13` is inherited unchanged. The TOKEN columns are again carried unchanged and are a larger under-count still.",
    remeasured_2026_11_16:
      "The bubble's size stopped being a soft target and became a stated deletion, so every column that counts that rule moved. Measured 2026-11-16 on `round62`'s own session (the live runner's log: 90 turns carried text, 70 delivered a bubble): 18 turns were cut at the ceiling and 533 characters - 26 whole sentences - were deleted before the player saw them, while the rule said 'about 80 characters'. The rule now names the ceiling and says anything past it is deleted before the partner sees it, because the turn lane has no second commit to carry the tail (`native-companion-content.ts` `deliverTurn`, one `onFinalText` per turn). Measured by the test against the product's builder: `systemChars` 7,345 and the conduct slice 5,059 - both +218, and the two deltas AGREE because the edit is inside the one rule and nowhere else (the added and removed text is ASCII, so the JSON-escaped delta and the UTF-8 byte delta are both 218). The share is re-derived from that pair as 5,059 / 7,345 = 0.6888. THE +218 IS NOT THE WHOLE DELTA FROM THE LAST RECORDING, and the rest is RECORDED HERE RATHER THAN ABSORBED SILENTLY: at HEAD (eef33b64) this tree's builder already produced `systemChars` 7,127 against the recorded 8,392 -1,265, and a conduct slice of 4,841 against the recorded 4,882 -41, so 1,224 characters of the difference are outside the conduct block (card/persona side) and 41 are inside it, and no entry above names either. `not_derived` from the builder: `envelopeChars`/`envelopeBytes` follow the system string by its own delta (+218: 23,963 -> 24,181, 33,132 -> 33,350) under `remeasured_2026_11_05`'s convention, and they inherit the -1,265 rather than carrying it away. The TOKEN columns are carried unchanged and remain the under-count `remeasured_2026_11_05` describes.",
    remeasured_2026_11_22:
      "The Game prompt floor stopped governing speech, so nine rules left the composed block and three of the remaining ones lost the clause that governed it. Measured against the product's builder by the test: `systemChars` 8,392 and the conduct slice 4,882 - both -2,538, and the two deltas AGREE because the edit is inside the conduct block and nowhere else. THE DISAGREEMENT IS NAMED RATHER THAN ABSORBED: at HEAD this tree's builder produced 10,930, not the recorded 10,923, so 7 characters of the difference belong to a pre-existing gap outside the conduct block (the conduct slice at HEAD was exactly the recorded 7,420), and `systemChars` above now describes the prompt the tree produces while that 7 is recorded here. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (-2,538 chars, -2,678 UTF-8 bytes, MEASURED on the two texts because the removed rules carried Chinese, so the byte delta is not the character delta); they were not re-measured against a materialized session, because that needs the whole session instrumentation this lane does not carry. NOT IN THIS READING'S COLUMNS, and the point of the change: the rules that said when, whether or how much she speaks are gone from the floor - six deleted because the card's own directive already states them (先接住人 / 不报进度 / 遇上卡路只说眼前障碍 / 不当对讲机, all readable in the assembled prompt as `characterVoice`), one moved to `amber-game.json` (decide-yourself with its concrete-question boundary), and three reworded to state only what the surface does (the delivery blocks' two shapes without 'so answer them', the markdown ban without 'one spoken line', the body-language rule's two tool names and bracket ban without 'call one when your body would say it'). `host/src/conversational-stance-gate.test.ts` now reads every rule these two tables declare (`rules examined 19 · govern speech 0`). The TOKEN columns are again carried unchanged and remain the under-count `remeasured_2026_11_05` describes.",
  }),
  floor: Object.freeze({
    // The plan-builder-only measurement: 14 tools. The surface a Game session is handed now carries 16, because the two
    // actions the registry declares expression-only keep their own tools beside the plan builder - see
    // `remeasured_2026_11_13`, which records that this column is an under-count of the surface rather than a second
    // reading of it.
    toolCount: 14,
    // Re-derived from the product's builder by the test itself: 7,345 at `remeasured_2026_11_16` (7,127 at HEAD plus
    // this change's own +218). The token column below is the 2026-11-05 MEASUREMENT, an under-count of a shorter prompt
    // that is no longer this one.
    systemChars: 7345,
    systemTokens: 5119,
    toolsTokens: 3552,
    // The recorded envelope plus this change's own JSON-escaped delta (+218): the tool array and the empty message list
    // are unchanged, so the system string is the whole of it. Not re-measured - see `remeasured_2026_11_16`, which also
    // records the pre-existing -1,265 this number does not carry.
    envelopeChars: 24181,
    // The same rule in UTF-8 bytes: 33,132 + 218, the added and removed text being ASCII.
    envelopeBytes: 33350,
    envelopeTokens: 8787,
  }),
  conductBlock: Object.freeze({
    chars: 5059,
    tokens: 1227,
    // The measured slice over the measured prompt: 5,059 / 7,345. Recorded as the quotient, not as a share typed
    // separately from the two numbers it divides - an earlier recording carried 0.655 against 7,268/11,101.
    charShareOfSystemPrompt: 0.6888,
    tokenShareOfSystemPrompt: 0.24,
  }),
  denominator: Object.freeze([
    Object.freeze({ window: 32768, output: 8192, geometry: "shared_upfront", usableSoft: 24576, floorShare: 0.3575 }),
    Object.freeze({ window: 32768, output: 4096, geometry: "shared_upfront", usableSoft: 28672, floorShare: 0.3065 }),
    Object.freeze({ window: 65536, output: 8192, geometry: "shared_upfront", usableSoft: 57344, floorShare: 0.1532 }),
    Object.freeze({ window: 131072, output: 8192, geometry: "shared_upfront", usableSoft: 122880, floorShare: 0.0715 }),
    Object.freeze({ window: 32768, output: 8192, geometry: "separate", usableSoft: 32768, floorShare: 0.2682 }),
  ]),
  comparison: Object.freeze({
    chatSurfaceEnvelopeTokens: 4099,
    chatSurfaceToolCount: 0,
    note: "runtime-core.internal.ts gives the Chat surface no tool group at all, so its floor is its system prompt alone. The Game floor is more than twice the Chat floor, and 3,620 of the difference are tool definitions.",
  }),
  rows: Object.freeze([
    Object.freeze({
      name: "stardew_plan_work",
      descriptionChars: 2160,
      parametersChars: 2896,
      descriptionTokens: 661,
      parametersTokens: 696,
      totalTokens: 1357,
    }),
    Object.freeze({
      name: "stardew_submit_action_program",
      descriptionChars: 2058,
      parametersChars: 1885,
      descriptionTokens: 493,
      parametersTokens: 501,
      totalTokens: 994,
    }),
    Object.freeze({
      name: "stardew_plan_shape",
      descriptionChars: 954,
      parametersChars: 386,
      descriptionTokens: 216,
      parametersTokens: 95,
      totalTokens: 311,
    }),
    Object.freeze({
      name: "stardew_read_scene",
      descriptionChars: 466,
      parametersChars: 62,
      descriptionTokens: 101,
      parametersTokens: 14,
      totalTokens: 115,
    }),
    Object.freeze({
      name: "stardew_stop_action",
      descriptionChars: 505,
      parametersChars: 33,
      descriptionTokens: 99,
      parametersTokens: 9,
      totalTokens: 108,
    }),
    Object.freeze({
      name: "companion_worldbook_query",
      descriptionChars: 138,
      parametersChars: 146,
      descriptionTokens: 27,
      parametersTokens: 40,
      totalTokens: 67,
    }),
    Object.freeze({
      name: "stardew_observe",
      descriptionChars: 272,
      parametersChars: 33,
      descriptionTokens: 50,
      parametersTokens: 9,
      totalTokens: 59,
    }),
    Object.freeze({
      name: "stardew_inspect_world_map",
      descriptionChars: 72,
      parametersChars: 176,
      descriptionTokens: 12,
      parametersTokens: 46,
      totalTokens: 58,
    }),
    Object.freeze({
      name: "stardew_find_destination",
      descriptionChars: 112,
      parametersChars: 138,
      descriptionTokens: 18,
      parametersTokens: 33,
      totalTokens: 51,
    }),
    Object.freeze({
      name: "companion_worldbook_catalog",
      descriptionChars: 151,
      parametersChars: 88,
      descriptionTokens: 27,
      parametersTokens: 23,
      totalTokens: 50,
    }),
    Object.freeze({
      name: "stardew_execution_status",
      descriptionChars: 215,
      parametersChars: 33,
      descriptionTokens: 40,
      parametersTokens: 9,
      totalTokens: 49,
    }),
    Object.freeze({
      name: "stardew_search_interactions",
      descriptionChars: 116,
      parametersChars: 109,
      descriptionTokens: 17,
      parametersTokens: 27,
      totalTokens: 44,
    }),
    Object.freeze({
      name: "stardew_interaction_catalog",
      descriptionChars: 118,
      parametersChars: 33,
      descriptionTokens: 21,
      parametersTokens: 9,
      totalTokens: 30,
    }),
    Object.freeze({
      name: "companion_status",
      descriptionChars: 68,
      parametersChars: 33,
      descriptionTokens: 12,
      parametersTokens: 9,
      totalTokens: 21,
    }),
  ]),
  planBuilder: Object.freeze({
    flatPerActionToolsMounted: false,
    claims: Object.freeze({
      flatPerActionTools: FLAT_TOOLS.length,
      plannableBuilderMethods: BUILDER_METHODS.length,
    }),
    note: "The flat per-action tools are NOT in the request, with one derived exception: an action the plan vocabulary does not carry keeps its own tool (`action-registry.ts` `keepsOwnToolOnPlanSurface`) - the expression pair, because a gesture is one step by nature, and the seven `experimental` actions the Host admits, because the Mod refuses them as Body Program nodes. The 14-tool set above is the measurement of the plan-builder-only surface, not an assumption - `stardew_plan_work`'s description carries the builder method names instead, and `MOUNTED_GAME_SURFACE_TOOL_NAMES` below adds every tool-only action's tool from that declaration.",
  }),
});

/**
 * The tool names the live Game surface MOUNTS: the recorded rows' own population plus every action the plan cannot carry.
 *
 * <p>
 * The recorded rows are the plan-builder surface a measured production session carried, and they are not
 * `STARDEW_ACTION_TOOL_NAMES`: a plan surface drops the flat tools of every action its plan vocabulary carries
 * (`runtime-core.internal.ts`, asserted structurally by `game-surface-prompt-floor.test.ts`), so that projection is a list
 * of names the Agent is never handed. Two gates resolved the prompt against the projection and stayed green while the
 * conduct sent body language to `stardew_express_emote`, which was not in the request at all (measured 2026-11-11,
 * `round46b`).
 * </p>
 *
 * <p>
 * THE EXCEPTION IS DERIVED, not recorded: the actions the plan vocabulary does not carry keep their own tool
 * (`action-registry.ts` `keepsOwnToolOnPlanSurface` is the one declaration the mount filter and this reading both ask), so
 * their names join the mounted set from that derivation and from `STARDEW_ACTION_TOOL_NAMES`. That is the expression pair
 * AND the seven `experimental` actions the Host's admission publishes - measured 2026-11-14, when the mount filter kept
 * only the expression exception and those seven had no route at all. An action declared tomorrow reaches every gate here
 * without an edit to this file.
 * </p>
 */
export const MOUNTED_GAME_SURFACE_TOOL_NAMES: readonly string[] = Object.freeze([
  ...GAME_SURFACE_PROMPT_FLOOR.rows.map((row) => row.name),
  ...SURFACE.filter((action) => action.kind === "execution" && !BUILDER_METHODS.includes(action.actionId)).map(
    (action) => STARDEW_ACTION_TOOL_NAMES[action.actionId as keyof typeof STARDEW_ACTION_TOOL_NAMES],
  ),
]);
