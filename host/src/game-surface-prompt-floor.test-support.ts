/**
 * The recorded Game-surface prompt floor, as a module rather than a JSON file.
 *
 * <p>
 * It lives in `.test-support.ts` so it is compiled into the test artifact and excluded from the production
 * build: this is a reading, not product configuration. The numbers below were measured, not chosen - the
 * `method` block says how, per number, and the test that reads this file re-derives the parts it can.
 * </p>
 *
 * <p>
 * Measured 2026-10-31 by `scratch/pf-measure.mjs` (tool definitions off a real materialized production session
 * over an attested named-pipe bridge) and `scratch/pf-combined.mjs` (that set plus the two WorldBook tools a
 * seeded root adds, and the system prompt from the product's own builder), with Magic Context's own envelope
 * shape and tokenizer.
 * </p>
 */
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
    publishedActions: number;
    plannableBuilderMethods: number;
    note: string;
  }>;
}>;

export const GAME_SURFACE_PROMPT_FLOOR: PromptFloorReading = Object.freeze({
  schema: "gamebuddy-game-surface-prompt-floor/v1",
  surface: "game",
  method: Object.freeze({
    envelope:
      "vendor/magic-context/packages/pi-plugin/src/pi-lkg-fit-envelope.ts:66 measures JSON.stringify({system, tools, messages: []}); this reading uses that exact shape.",
    tokens:
      "ai-tokenizer with the claude encoding, resolved the way vendor/magic-context/packages/plugin/src/hooks/magic-context/read-session-formatting.ts resolves it. This is the count Magic Context's estimateTokens returns.",
    tools:
      "Read off a real materialized production session: createHostGameRuntimeMaterializer().materializeEnter(...) over an attested Windows named-pipe bridge whose hello_ack publishes integrations/stardew/action-development/contracts/generated/action-surface.v1.json (95 actions), with session.agent.state.tools as the population. BODY_PROGRAM_MOUNT reported mounted=true, so this is the plan-builder surface a live Farmhand gets.",
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
  }),
  floor: Object.freeze({
    toolCount: 14,
    // Re-derived 2026-11-08 from the product's builder by the test itself. The prompt grew 2,525 chars since the
    // 2026-11-05 reading: the card's performance directive +2,181, its persona and examples +237, and the Host floor's
    // language line +107. The `remeasured_2026_11_08` method entry attributes it line by line. The token column below
    // is the older MEASUREMENT and is now an under-count of a shorter prompt (see that entry).
    systemChars: 13411,
    systemTokens: 5119,
    toolsTokens: 3552,
    // 23,152 + 2,594: the JSON-escaped system string's own delta, which is the whole envelope's delta because the
    // tool array and the empty message list are unchanged. The extra 69 characters over the raw 2,525 are the added
    // newlines, which JSON escapes as two characters each.
    envelopeChars: 25746,
    // 28,210 + 6,846: the same delta in UTF-8 bytes, measured rather than derived from the character count, because
    // most of what was added is three bytes per character.
    envelopeBytes: 35056,
    envelopeTokens: 8787,
  }),
  conductBlock: Object.freeze({
    chars: 6194,
    tokens: 1227,
    // The measured slice over the measured prompt: 6,194 / 13,411. Recorded as the quotient, not as a share typed
    // separately from the two numbers it divides - the previous recording carried 0.5619 against 6,194/10,886 = 0.5690.
    charShareOfSystemPrompt: 0.4619,
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
    publishedActions: 95,
    plannableBuilderMethods: 92,
    note: "The 95 flat per-action tools are NOT in the request: runtime-core.internal.ts drops every adapter action tool when planActionSurface is declared, and the live Game materializer declares it. The 14-tool set above is the measurement of that, not an assumption - stardew_plan_work's description carries the 92 builder method names instead.",
  }),
});
