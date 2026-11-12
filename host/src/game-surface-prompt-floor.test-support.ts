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
       * drops every one of them from a plan surface.
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
    remeasured_2026_11_11_b:
      "The Game prompt SHRANK by exactly one conduct rule (-437 chars, 11,101 to 10,664): the rule that ordered a spoken remark to the partner before every action or planning tool (`Speak before you act ... Never run tools in total silence ...`). It was FORM by the doctrine this floor's own module states - how long a turn is and how many beats it carries - and the shipped card already governs that (`default-companion/card.json`: 「说话紧扣当下真实生活体验，收放自如，不啰嗦不客套」), so an unconditional 'always deliver a spoken remark first' overrode 收放自如 with its opposite. Measured consequence (round46b, 36 minutes over 2 in-game days): 93 prompt turns, 159 assistant messages, 132 bubbles, of which 90 were standalone speech with no tool call in the same message - one bubble every 16 seconds, 1.42 per turn, 1.91 per tool call. The CHARACTER columns are re-derived from the product's builder exactly: `systemChars` 10,664 and the conduct slice 6,831 (7,268 - 437), so its share is 6,831 / 10,664 = 0.6406, recorded as 0.641. The two deltas agree (-437 both) because the deleted text was inside the floor and nowhere else. `envelopeChars`/`envelopeBytes` follow the system string by its own delta (-437: the rule is ASCII, so JSON-escaped characters and UTF-8 bytes move together) with `tools` and `messages` unchanged, which is what makes that the whole envelope's delta. The TOKEN columns were NOT re-measured in this commit and are now stale by 437 characters as well as by everything `remeasured_2026_11_05` describes.",
  }),
  floor: Object.freeze({
    toolCount: 14,
    // Re-derived from the product's builder by the test itself: 10,829 at `remeasured_2026_11_12`, which is the
    // 2026-11-11 reading plus the 166 chars of the rewritten body-language rule (`remeasured_2026_11_12` states the
    // delta and the -1 that preceded it). The token column below is the 2026-11-05 MEASUREMENT, an under-count of a
    // shorter prompt that is no longer this one.
    systemChars: 10829,
    systemTokens: 5119,
    toolsTokens: 3552,
    // The recorded envelope plus this change's own JSON-escaped delta (+166): the tool array and the empty message
    // list are unchanged, so the system string is the whole of it. Not re-measured - see `remeasured_2026_11_12`.
    envelopeChars: 26125,
    // The same +166 in UTF-8 bytes: the rewritten rule is ASCII.
    envelopeBytes: 35434,
    envelopeTokens: 8787,
  }),
  conductBlock: Object.freeze({
    chars: 6997,
    tokens: 1227,
    // The measured slice over the measured prompt: 6,997 / 10,829. Recorded as the quotient, not as a share typed
    // separately from the two numbers it divides - the previous recording carried 0.655 against 7,268/11,101.
    charShareOfSystemPrompt: 0.6461,
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
    note: "The flat per-action tools are NOT in the request: runtime-core.internal.ts drops every adapter action tool when planActionSurface is declared, and the live Game materializer declares it. The 14-tool set above is the measurement of that, not an assumption - stardew_plan_work's description carries the builder method names instead.",
  }),
});

/**
 * The tool names the live Game surface MOUNTS: the recorded rows' own population.
 *
 * <p>
 * This is the set a Game prompt may name, and it is not `STARDEW_ACTION_TOOL_NAMES`: a plan surface drops every tool
 * the adapter publishes as an action (`runtime-core.internal.ts`, asserted structurally by
 * `game-surface-prompt-floor.test.ts`), so the per-action projection is a list of names the Agent is never handed.
 * Two gates resolved the prompt against that projection and stayed green while the conduct sent body language to
 * `stardew_express_emote`, which was not in the request at all (measured 2026-11-11, `round46b`).
 * </p>
 *
 * <p>
 * The population is the reading's rows because that is where the mounted set is recorded - measured off a real
 * materialized production session's own `agent.state.tools`, with the reading's freshness held by the floor test
 * (its `systemChars`, `toolCount` and the `planActionSurface` premise). A tool mounted later reaches these gates only
 * by being re-measured into the reading, which is the same rule every other column in that file follows.
 * </p>
 */
export const MOUNTED_GAME_SURFACE_TOOL_NAMES: readonly string[] = Object.freeze(
  GAME_SURFACE_PROMPT_FLOOR.rows.map((row) => row.name),
);
