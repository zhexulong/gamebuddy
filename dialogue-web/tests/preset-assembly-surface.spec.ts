/**
 * The read-only preset surface: what the player actually sees about the preset they imported.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md` §2.1, §2.5, §4) rules that a preset is imported
 * once and read from then on, so the surface has no editor. That makes it a surface whose whole job is to SHOW
 * four facts, and a fact that is only counted ("2 markers unfilled") or only implied by an empty region is a fact
 * the player cannot act on. This journey therefore asserts each one by name, in the window the player has:
 *
 *  1. the entry switch - the total, and the disabled entries listed rather than hidden;
 *  2. every marker with no content source, named individually;
 *  3. every macro this product will not evaluate, named beside its own code
 *     (`macro_not_implemented:<name>` / `macro_unknown:<name>`);
 *  4. depth injection - the count, the depths, and the blocks that land there;
 *  5. sampling in force - the value each sampler key is actually sent as, with the layer that decided it.
 *
 * The fixture is the assembly's own output, not a hand-written copy of it: `presetAssemblySurface` is imported from
 * the Host and driven with a realistic SillyTavern preset, and the stub serves exactly what it produced. A field
 * that drifts between the producer and the browser's mirror therefore fails here instead of agreeing with itself.
 *
 * The negative half is the one a "show everything" surface gets wrong: an entry that IS enabled must never be
 * rendered as a switched-off one, a marker that IS filled must never appear in the unfilled list, a macro this
 * product implements must never be reported as one it cannot evaluate, and - the one this file exists for now - a
 * key a model or a thinking level decided must never be shown at the value the preset wrote. The last one is the
 * false green design §5 names: the panel would look right while the request carried something else.
 */
import { type PresetSamplingRowV1, presetAssemblySurface } from "../../host/src/preset-assembly-surface.ts";
import { PRESET_SAMPLING_KEYS, presetSamplingParams } from "../../host/src/tavern/preset-sampling.ts";
import { messages } from "../src/i18n";
import { validatePresetAssemblyRead } from "../src/preset-assembly-surface";
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

/**
 * A realistic chat-completion preset: SillyTavern's own `Default.json` order with the two things a modern preset is
 * actually worth - markers whose content this product supplies, and entries inside the transcript by depth.
 *
 * `nsfwPrompt` is switched off in the order rather than deleted, which is what a real preset does, and
 * `jailbreak` keeps its authored post-history text (A4 §3.2: the card overrides it only when the card wrote one).
 */
const PRESET_DOCUMENT = {
  name: "Chat completion - depth aware",
  description: "A preset with markers, a post-history tail and two depth injections.",
  temperature: 0.9,
  top_p: 1,
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      enabled: true,
      role: "system",
      content: "Write {{char}}'s next reply in this scene. {{char}} never speaks for {{user}}.",
    },
    {
      identifier: "worldInfoBefore",
      name: "World Info (before)",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    {
      identifier: "charDescription",
      name: "Character Description",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    {
      identifier: "charPersonality",
      name: "Character Personality",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    { identifier: "scenario", name: "Scenario", marker: true, enabled: true, role: "system", content: "" },
    {
      identifier: "dialogueExamples",
      name: "Dialogue Examples",
      marker: true,
      enabled: true,
      role: "system",
      content: "",
    },
    { identifier: "chatHistory", name: "Chat History", marker: true, enabled: true, role: "system", content: "" },
    {
      identifier: "jailbreak",
      name: "Jailbreak",
      enabled: true,
      role: "system",
      content: "Stay in {{char}}'s voice after the transcript.",
    },
    {
      identifier: "directorNote",
      name: "Director note",
      enabled: true,
      role: "system",
      content: "Keep the pacing slow. {{random::dusk::evening::late night}}",
      injection_position: 1,
      injection_depth: 4,
      injection_order: 100,
    },
    {
      identifier: "styleGuard",
      name: "Style guard",
      enabled: true,
      role: "system",
      content: "No purple prose.",
      injection_position: 1,
      injection_depth: 0,
      injection_order: 100,
    },
    {
      identifier: "nsfwPrompt",
      name: "Alternate tone",
      enabled: false,
      role: "system",
      content: "{{if {{getvar::allowed}}}}A different register for this scene.{{/if}}",
    },
    {
      identifier: "spellingProbe",
      name: "Typo the author shipped",
      enabled: true,
      role: "system",
      content: "Call {{characteristic}} by name when it matters.",
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "charPersonality", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "dialogueExamples", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "directorNote", enabled: true },
        { identifier: "styleGuard", enabled: true },
        { identifier: "nsfwPrompt", enabled: false },
        { identifier: "spellingProbe", enabled: true },
      ],
    },
  ],
};

/**
 * The assembly's own sources, as the Host would hand them over for this companion: the card's three fields are
 * supplied, so those three markers are filled - and the world book slots are NOT, because no book is bound to this
 * conversation.
 */
const ASSEMBLY_MARKERS = {
  charDescription: "Mira tends the greenhouse at the edge of Pelican Town.",
  charPersonality: "Patient, dry, easily amused.",
  scenario: "A late-summer evening in the valley.",
};

/**
 * The runtime's own facts for the sampling reading, as the Host will have them when it serves this readout: the
 * composed model the adapter sends (the preset's values already written into it by `withPresetSampling`, plus this
 * model's own `frequency_penalty` default) and the thinking level the session reports.
 *
 * `high` overrides `temperature`, which is the case §5 exists for: the value the preset wrote (0.9) is not the value
 * the request carries (0.2). `top_p` stays the preset's, and the five keys no layer sets stay unset.
 */
const SAMPLING_RUNTIME = {
  model: {
    samplingParams: { temperature: 0.9, top_p: 1, frequency_penalty: 0.1 },
    samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
  },
  thinkingLevel: "high",
};

const SURFACE = presetAssemblySurface({
  presetId: "chat-completion-depth-aware",
  name: "Chat completion - depth aware",
  revision: 3,
  document: PRESET_DOCUMENT,
  sampling: SAMPLING_RUNTIME,
  macros: {
    char: "Mira",
    user: "the player",
    description: ASSEMBLY_MARKERS.charDescription,
    personality: ASSEMBLY_MARKERS.charPersonality,
    scenario: ASSEMBLY_MARKERS.scenario,
    persona: "A neighbour with a spare hour.",
    itemId: "assembly",
  },
  markers: ASSEMBLY_MARKERS,
});

/**
 * The sampler rows this fixture's surface publishes, or a failure naming the absence.
 *
 * The fifth answer has two shapes: rows, or the named reason there are none. This fixture always supplies the composed
 * model, so an absence here is the fixture losing the runtime's facts rather than a case to skip.
 */
const SURFACE_SAMPLING_ROWS: readonly PresetSamplingRowV1[] = (() => {
  const reading = SURFACE.sampling;
  if ("unavailable" in reading)
    throw new Error(`the fixture must carry sampler rows; it carries ${JSON.stringify(reading)}`);
  return reading;
})();

/** The composed root the shell reads; every management surface needs the same four reads to mount. */
const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken,
    browserSession: { expiresAtMs },
    game: {
      prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
      instance: { status: "none", gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      actionAuthority: "unavailable",
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: { available: false, count: 0 },
      latestOutcome: "none",
    },
  },
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Every route this mount reads, with the preset readout being the producer's own output. */
async function stubPresetSurface(
  page: Page,
  presets: readonly unknown[],
  activePreset?: unknown,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/presets", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, presets, ...(activePreset === undefined ? {} : { activePreset }) })),
  );
}

/** What the surface renders for one reading, read as the browser laid it out. */
type RenderedFacts = Readonly<{
  entriesLine: string;
  disabled: readonly string[];
  unfilled: readonly string[];
  macros: readonly string[];
  depthLine: string;
  blocks: readonly string[];
  regionScrollTop: number | null;
  windowHeight: number;
  /** The four readouts, each with where it landed, so "visible" is a rect rather than an opinion. */
  rects: readonly Readonly<{ readout: string; top: number; bottom: number }>[];
}>;

/**
 * Everything the panel shows, read from the DOM the player is looking at.
 *
 * The readout selectors are the panel's own frozen test ids (`data-preset-*`), and a readout that is missing is a
 * throw naming it rather than an empty list: "the unfilled list is absent" and "the unfilled list is empty" are two
 * different findings and only one of them is the truth about this preset.
 */
async function readRendered(page: Page): Promise<RenderedFacts> {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="presets-surface"]');
    if (surface === null) throw new Error("the preset surface is not mounted");
    const text = (node: Element | null, what: string): string => {
      if (node === null) throw new Error(`the panel renders no ${what}`);
      return (node.textContent ?? "").trim();
    };
    const list = (selector: string, attribute: string, what: string): readonly string[] => {
      const nodes = surface.querySelectorAll<HTMLElement>(`${selector} [${attribute}]`);
      if (nodes.length === 0 && surface.querySelector(selector) === null)
        throw new Error(`the panel renders no ${what} list`);
      return [...nodes].map((node) => node.getAttribute(attribute) ?? "");
    };
    const content = surface.querySelector<HTMLElement>(".surface-content");
    const rectOf = (selector: string, readout: string) => {
      const node = surface.querySelector<HTMLElement>(selector);
      if (node === null) throw new Error(`the panel renders no ${readout}`);
      const rect = node.getBoundingClientRect();
      return { readout, top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
    };
    const blockNodes = [...surface.querySelectorAll<HTMLElement>("[data-preset-depth-blocks] [data-preset-depth-block]")];
    return {
      entriesLine: text(surface.querySelector("[data-preset-entries]"), "entries line"),
      disabled: list("[data-preset-disabled]", "data-preset-disabled-entry", "disabled"),
      unfilled: list("[data-preset-unfilled]", "data-preset-marker", "unfilled marker"),
      macros: list("[data-preset-macros]", "data-preset-macro", "macro"),
      depthLine: text(surface.querySelector("[data-preset-depth-line]"), "depth line"),
      blocks: blockNodes.map((node) => (node.textContent ?? "").trim()),
      regionScrollTop: content === null ? null : content.scrollTop,
      windowHeight: window.innerHeight,
      rects: [
        rectOf("[data-preset-entries]", "entries"),
        rectOf("[data-preset-disabled]", "disabled list"),
        rectOf("[data-preset-unfilled]", "unfilled list"),
        rectOf("[data-preset-macros]", "macro list"),
        rectOf("[data-preset-depth-line]", "depth line"),
      ],
    };
  });
}

/** The ordered identifiers of one rendered list, with the reading that made it. */
function expectNamed(actual: readonly string[], expected: readonly string[], what: string): void {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  expect(
    [...actual].sort(),
    `the ${what} the player is shown is not the one the assembly named: missing ${JSON.stringify(missing)}, ` +
      `unexpected ${JSON.stringify(extra)} (surface ${JSON.stringify([...expected].sort())})`,
  ).toEqual([...expected].sort());
}

/**
 * What the panel must READ at any window: the four headline facts, in the player's words.
 *
 * Derived from the producer's own output and the catalogue's own sentences rather than written out, so a fixture
 * that changes its preset cannot leave this expectation behind - and so the two viewport journeys below assert the
 * same readings instead of each carrying their own copy of them.
 */
function expectedReadout(): Readonly<{
  entriesLine: string;
  unfilled: readonly string[];
  macros: readonly string[];
  depthLine: string;
}> {
  const catalogue = messages("en");
  return {
    entriesLine: catalogue.presetEntriesLine
      .replace("{{total}}", String(SURFACE.entries.total))
      .replace("{{enabled}}", String(SURFACE.entries.enabled))
      .replace("{{disabled}}", String(SURFACE.entries.disabled)),
    unfilled: [...SURFACE.unfilledMarkers],
    macros: SURFACE.macros.map((macro) => macro.code),
    depthLine: catalogue.presetDepthLine
      .replace("{{count}}", String(SURFACE.depth.count))
      .replace("{{depths}}", SURFACE.depth.depths.join(", ")),
  };
}

/**
 * One viewport's reading: mount the panel, keep the fixture honest, and assert the per-item detail.
 *
 * The headline facts - the entries line, the marker names, the macro codes, the depth line and where each readout
 * sits - are asserted by the journey that opened this window, because they are the claim its title makes.
 */
async function expectPresetReadout(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>,
): Promise<RenderedFacts> {
  await page.setViewportSize(viewport);
  await stubPresetSurface(page, [SURFACE]);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
  await expect(page.getByTestId("presets-surface")).toBeVisible();
  await expect(page.getByTestId("presets-surface").getByRole("heading", { name: SURFACE.name ?? "" })).toBeVisible();

  const rendered = await readRendered(page);
  console.log(`[preset-surface ${viewport.width}x${viewport.height}] ${JSON.stringify(rendered)}`);

  // 1. The switch is observable: the disabled entries are listed by name, not hidden.
  expect(SURFACE.entries.disabled, "the fixture really carries a switched-off entry").toBeGreaterThan(0);
  expectNamed(rendered.disabled, SURFACE.disabledEntries, "switched-off entries");
  for (const identifier of SURFACE.disabledEntries)
    await expect(page.locator(`[data-preset-disabled-entry="${identifier}"]`), `"${identifier}" is listed as switched off`).toBeVisible();

  // 2. Every marker with no content source carries its own line, named as the marker it is.
  expect(SURFACE.unfilledMarkers.length, "the fixture really leaves a marker unfilled").toBeGreaterThan(0);
  for (const marker of SURFACE.unfilledMarkers) {
    await expect(page.locator(`[data-preset-marker="${marker}"]`), `the unfilled marker "${marker}" is named`).toBeVisible();
    await expect(page.locator(`[data-preset-marker="${marker}"]`)).toHaveText(marker);
  }

  // 3. Every macro this product cannot evaluate is named beside its own code.
  expect(SURFACE.macros.length, "the fixture really spells a macro this product cannot evaluate").toBeGreaterThan(0);
  for (const macro of SURFACE.macros)
    await expect(
      page.locator(`[data-preset-macro="${macro.code}"] code`),
      `"${macro.name}" is reported with its code ${macro.code}`,
    ).toHaveText(macro.code);

  // 4. Depth injection names the blocks that land there, so its count is not the only reading.
  expect(SURFACE.depth.count, "the fixture really injects at a depth").toBeGreaterThan(0);
  expectNamed(
    rendered.blocks.map((block) => block.replace(/ · \d+$/u, "")),
    SURFACE.depth.blocks.map((block) => block.identifier),
    "depth blocks",
  );

  // The negative half: what the assembly FILLED must never be shown as a gap.
  for (const marker of Object.keys(ASSEMBLY_MARKERS)) {
    expect(
      rendered.unfilled,
      `"${marker}" has a content source, so it must not appear among the markers with none`,
    ).not.toContain(marker);
    await expect(page.locator(`[data-preset-marker="${marker}"]`), `"${marker}" is filled, so it is not listed as unfilled`).toHaveCount(0);
  }
  for (const identifier of ["main", "jailbreak", "directorNote"]) {
    expect(rendered.disabled, `"${identifier}" is enabled, so it must not appear as switched off`).not.toContain(identifier);
    await expect(page.locator(`[data-preset-disabled-entry="${identifier}"]`), `"${identifier}" is switched on`).toHaveCount(0);
  }
  for (const implemented of ["char", "user", "random"]) {
    expect(
      rendered.macros.some((code) => code.endsWith(`:${implemented}`)),
      `{{${implemented}}} is implemented, so it must not be reported as a macro this product cannot evaluate`,
    ).toBe(false);
  }

  // 5. Sampling: the value each sampler key is really sent as, and the layer that decided it. The preset writes
  // `temperature: 0.9` while the thinking level decides 0.2, so a row that echoed the preset's own value would be
  // exactly the false green §5 names. Measured last, because revealing these rows scrolls the region.
  const authored = presetSamplingParams(PRESET_DOCUMENT);
  const authoredByKey: ReadonlyMap<string, number | undefined> = new Map(
    PRESET_SAMPLING_KEYS.map((key) => [key, authored[key]] as const),
  );
  expect(
    SURFACE_SAMPLING_ROWS.map((row) => row.key),
    "the producer emits a row for every sampling key, in the allow-list's own order",
  ).toEqual([...PRESET_SAMPLING_KEYS]);
  const presetRow = SURFACE_SAMPLING_ROWS.find((row) => row.source === "preset");
  const levelRow = SURFACE_SAMPLING_ROWS.find((row) => row.source === "thinking-level");
  const unsetRow = SURFACE_SAMPLING_ROWS.find((row) => row.source === "unset");
  if (presetRow === undefined || levelRow === undefined || unsetRow === undefined)
    throw new Error(
      `the fixture must carry a preset, a thinking-level and an unset row; it carries ${JSON.stringify(SURFACE_SAMPLING_ROWS)}`,
    );
  const overridden = authoredByKey.get(levelRow.key);
  expect(overridden, `the fixture really writes ${levelRow.key}`).not.toBeUndefined();
  expect(levelRow.value, `the fixture really changes ${levelRow.key} at this level`).not.toBe(overridden);

  const samplingList = page.locator("[data-preset-sampling]");
  await samplingList.scrollIntoViewIfNeeded();
  const renderedKeys = await samplingList
    .locator("[data-preset-sampling-row]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-preset-sampling-row") ?? ""));
  expect(
    [...renderedKeys].sort(),
    "the panel renders a row for every sampling key - an unset key that loses its row reads as no such setting",
  ).toEqual(SURFACE_SAMPLING_ROWS.map((row) => row.key).sort());

  const samplingRow = (key: string) => page.locator(`[data-preset-sampling-row="${key}"]`);
  await expect(samplingRow(presetRow.key), `the ${presetRow.source}-sourced row is visible`).toBeVisible();
  await expect(samplingRow(presetRow.key), `the preset-sourced ${presetRow.key} shows (preset)`).toHaveText(
    `${presetRow.key} = ${presetRow.value} (preset)`,
  );
  await expect(samplingRow(levelRow.key), `the ${levelRow.source}-sourced row is visible`).toBeVisible();
  await expect(
    samplingRow(levelRow.key),
    `the thinking level decided ${levelRow.key}, so the row shows the level's value and says so`,
  ).toHaveText(`${levelRow.key} = ${levelRow.value} (thinking-level)`);
  await expect(samplingRow(unsetRow.key), `the unset row for ${unsetRow.key} is present`).toBeVisible();
  await expect(samplingRow(unsetRow.key), `an unset key says so instead of disappearing`).toHaveText(
    `${unsetRow.key} = \u2014 (unset)`,
  );

  // The negative half: for every key the model or the thinking level decided, the value the preset wrote is
  // nowhere in that row. This is the reading §5 exists for - the panel must not describe a request nobody sends.
  for (const row of SURFACE_SAMPLING_ROWS) {
    if (row.source !== "thinking-level" && row.source !== "model") continue;
    const written = authoredByKey.get(row.key);
    if (written === undefined) continue;
    const shown = await samplingRow(row.key).innerText();
    expect(
      shown,
      `"${row.key}" is decided by ${row.source}, so the panel must not show the preset's written ${written}`,
    ).not.toContain(`= ${written} (`);
  }

  return rendered;
}

/**
 * A preset with nothing to report says so in words, on all four counts.
 *
 * Silence is the reading this surface exists to rule out: an empty list under "Markers with no content source"
 * and an absent list look the same to a player, and only one of them means "every marker is filled". Each of the
 * four facts therefore carries its own sentence when it has nothing to say.
 */
test("a preset with nothing to report says so on all four counts", async ({ page }) => {
  const catalogue = messages("en");
  const clean = presetAssemblySurface({
    presetId: "clean",
    name: "A preset with nothing to report",
    revision: 1,
    document: {
      name: "Clean",
      prompts: [
        { identifier: "main", enabled: true, role: "system", content: "Write {{char}}'s next reply." },
        { identifier: "worldInfoBefore", marker: true, enabled: true, role: "system", content: "" },
        { identifier: "charDescription", marker: true, enabled: true, role: "system", content: "" },
        { identifier: "chatHistory", marker: true, enabled: true, role: "system", content: "" },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "worldInfoBefore", enabled: true },
            { identifier: "charDescription", enabled: true },
            { identifier: "chatHistory", enabled: true },
          ],
        },
      ],
    },
    macros: {
      char: "Mira",
      user: "the player",
      description: "Mira tends the greenhouse.",
      personality: "Dry.",
      scenario: "An evening.",
      persona: "A neighbour.",
      itemId: "clean",
    },
    markers: { worldInfoBefore: "A bound world book.", charDescription: "Mira tends the greenhouse." },
    sampling: { model: {}, thinkingLevel: "off" },
  });
  expect(clean.disabledEntries, "the fixture really has no switched-off entry").toEqual([]);
  expect(clean.unfilledMarkers, "the fixture really fills every marker").toEqual([]);
  expect(clean.macros, "the fixture really spells no unusable macro").toEqual([]);
  expect(clean.depth.count, "the fixture really injects at no depth").toBe(0);

  await stubPresetSurface(page, [clean]);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
  const surface = page.getByTestId("presets-surface");
  await expect(surface.locator("[data-preset-disabled-none]")).toHaveText(catalogue.presetDisabledNone);
  await expect(surface.locator("[data-preset-unfilled-none]")).toHaveText(catalogue.presetUnfilledNone);
  await expect(surface.locator("[data-preset-macros-none]")).toHaveText(catalogue.presetMacrosNone);
  await expect(surface.locator("[data-preset-depth-none]")).toHaveText(catalogue.presetDepthNone);
  await expect(surface.locator("[data-preset-marker]"), "no marker is listed as unfilled").toHaveCount(0);
  await expect(surface.locator("[data-preset-depth-blocks]"), "no depth block is listed").toHaveCount(0);
});

test("the preset surface names the entry switch, the unfilled markers, the unusable macros, the depths and the sampling in force at 400x800", async ({
  page,
}) => {
  const rendered = await expectPresetReadout(page, { width: 400, height: 800 });
  const expected = expectedReadout();
  // The switch as the player reads it: the total, how many entries are on, and how many are off.
  expect(rendered.entriesLine, "the entries line does not state the assembly's own split").toBe(expected.entriesLine);
  // The markers with no content source, by the name each is listed under.
  expect(rendered.unfilled, "the panel lists other markers than the assembly left without a content source").toEqual([
    ...expected.unfilled,
  ]);
  // The macros this product will not evaluate, by the code the reader has to search for.
  expect(rendered.macros, "the panel lists other macro codes than the assembly refused").toEqual([...expected.macros]);
  // Depth injection as one line: the count and the depths it names.
  expect(rendered.depthLine, "the depth line does not state the assembly's own count and depths").toBe(
    expected.depthLine,
  );
  // Where they sit: every readout inside the 400x800 window, with the region at the top of its own scroll.
  expect(rendered.regionScrollTop, "the region is at its top when this is measured").toBe(0);
  for (const rect of rendered.rects)
    expect(
      rect.top >= 0 && rect.bottom <= rendered.windowHeight,
      `the ${rect.readout} is outside the 400x800 window: it reads top ${rect.top}, bottom ${rect.bottom}, ` +
        `window ${rendered.windowHeight} px`,
    ).toBe(true);
});

test("the same five facts are named at 1440x900", async ({ page }) => {
  const rendered = await expectPresetReadout(page, { width: 1440, height: 900 });
  const expected = expectedReadout();
  // The same five facts, at the wide window: the panel states them in the same words rather than widening them into
  // a summary, so a player on a desktop reads what a player on a phone reads.
  expect(rendered.entriesLine, "the entries line does not state the assembly's own split").toBe(expected.entriesLine);
  expect(rendered.unfilled, "the panel lists other markers than the assembly left without a content source").toEqual([
    ...expected.unfilled,
  ]);
  expect(rendered.macros, "the panel lists other macro codes than the assembly refused").toEqual([...expected.macros]);
  expect(rendered.depthLine, "the depth line does not state the assembly's own count and depths").toBe(
    expected.depthLine,
  );
  expect(rendered.regionScrollTop, "the region is at its top when this is measured").toBe(0);
  for (const rect of rendered.rects)
    expect(
      rect.top >= 0 && rect.bottom <= rendered.windowHeight,
      `the ${rect.readout} is outside the 1440x900 window: it reads top ${rect.top}, bottom ${rect.bottom}, ` +
        `window ${rendered.windowHeight} px`,
    ).toBe(true);
});

/**
 * The line the panel draws about which preset is in force: the state it names, and the sentence under it.
 *
 * Both `null` is a reading - "the panel says nothing at all about the binding" - and deliberately not a throw: the
 * absent case is the one this journey exists to rule out, so it has to be readable rather than be a failure of the
 * reading itself.
 */
async function readBindingLine(page: Page): Promise<Readonly<{ state: string | null; sentence: string | null }>> {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="presets-surface"]');
    if (surface === null) throw new Error("the preset surface is not mounted");
    const lines = [...surface.querySelectorAll<HTMLElement>("[data-preset-active]")];
    if (lines.length > 1) throw new Error(`the panel draws ${lines.length} binding lines, not one`);
    if (lines.length === 0) return { state: null, sentence: null };
    const line = lines[0];
    return { state: line.getAttribute("data-preset-active"), sentence: (line.textContent ?? "").trim() };
  });
}

/**
 * Which preset is in force is the FIRST fact, because it decides whether any row below describes the request the
 * player is about to send - and every state asks something different of them. `none` is a choice nobody made,
 * `bound` names the assembling preset, `missing` is a binding whose preset is gone (the one state where doing nothing
 * leaves a player with an assembly they did not choose), and `unreported` is a body that did not carry the fact at
 * all.
 *
 * `unreported` is the contract's own case, not an invention: `activePreset` is `Type.Optional` on the Host's body, so
 * a Host that predates it still reads. It is NOT `none`: "nothing is bound" is a real binding the player answers by
 * importing or binding, and "this build was not told" is a fact about the panel. Drawing nothing for it made the
 * second read exactly like the first, and like a panel that never loaded at all.
 */
test("which preset is in force is named in every state, and an unreported binding says so", async ({ page }) => {
  const catalogue = messages("en");
  const cases: readonly Readonly<{ what: string; activePreset: unknown; state: string; expected: string }>[] = [
    { what: "nothing bound", activePreset: { state: "none" }, state: "none", expected: catalogue.presetActiveNone },
    {
      what: "a bound preset",
      activePreset: { state: "bound", presetId: SURFACE.presetId },
      state: "bound",
      expected: catalogue.presetActiveBound.replace("{{preset}}", SURFACE.presetId),
    },
    {
      what: "a bound preset the store no longer holds",
      activePreset: { state: "missing", presetId: "deleted-elsewhere" },
      state: "missing",
      expected: catalogue.presetActiveMissing.replace("{{preset}}", "deleted-elsewhere"),
    },
    {
      what: "a body with no binding fact at all",
      activePreset: undefined,
      state: "unreported",
      expected: catalogue.presetActiveUnreported,
    },
  ];
  await stubPresetSurface(page, [SURFACE]);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
  const surface = page.getByTestId("presets-surface");
  await expect(surface).toBeVisible();
  for (const { what, activePreset, state, expected } of cases) {
    await page.unroute("**/api/tavern/v1/presets");
    await stubPresetSurface(page, [SURFACE], activePreset);
    await page.reload();
    await expect(surface).toBeVisible();
    const shown = await readBindingLine(page);
    console.log(`[preset-binding/${what}] ${JSON.stringify(shown)}`);
    expect(shown.state, `${what}: the panel names the state it read`).toBe(state);
    expect(shown.sentence, `${what}: in that state's own words`).toBe(expected);
  }
  expect(
    catalogue.presetActiveUnreported,
    "an unreported binding does not borrow the `none` sentence - the two ask the player different things",
  ).not.toBe(catalogue.presetActiveNone);
});

/**
 * The empty state is a fact of its own, and a failed read is not it.
 *
 * A surface that rendered a blank region for both would let a player read "this preset does nothing" out of a Host
 * that never answered - which is the one reading the design forbids in as many words (§4: never silently empty).
 */
test("no imported preset and a read the Host refused say different things", async ({ page }) => {
  const catalogue = messages("en");
  await stubPresetSurface(page, []);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
  const surface = page.getByTestId("presets-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-preset-none]")).toHaveText(catalogue.presetEmpty);
  await expect(surface.locator("[data-preset-assembly]")).toHaveCount(0);

  await page.route("**/api/tavern/v1/presets", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
  );
  await page.reload();
  await expect(surface.locator("[data-preset-read-failed]")).toHaveText(catalogue.presetReadFailed);
  await expect(surface.locator("[data-preset-none]")).toHaveCount(0);
});

/**
 * The one read-failure banner the panel draws, by the attribute that names the fault and the sentence under it.
 *
 * Read as the browser laid it out rather than by selector, because the question is which of two banners appeared:
 * asking for one attribute at a time would answer "absent" for both when the panel drew the wrong one.
 */
async function readFailureBanner(page: Page): Promise<Readonly<{ attribute: string | null; sentence: string }>> {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="presets-surface"]');
    if (surface === null) throw new Error("the preset surface is not mounted");
    const banners = [
      ...surface.querySelectorAll<HTMLElement>("[data-preset-read-failed], [data-preset-reply-unreadable]"),
    ];
    if (banners.length !== 1)
      throw new Error(`the panel draws ${banners.length} read-failure banners, not exactly one`);
    const banner = banners[0];
    const attribute =
      ["data-preset-read-failed", "data-preset-reply-unreadable"].find((name) => banner.hasAttribute(name)) ?? null;
    return { attribute, sentence: (banner.textContent ?? "").trim() };
  });
}

/**
 * The Host not serving the read and the Host serving something this build cannot read are two facts, and the panel
 * says which.
 *
 * Both produce no readout, and both reached the player as one sentence: a bare `catch` turned every failure into
 * `failed`, so a Host that never answered and a reply whose body is not the published contract read exactly alike.
 * They ask for opposite things - read again, versus a build that knows what the Host now says - which is why the
 * companion world book's panel splits them on the client's own "the reply did not conform" fact
 * (`6b24a0b9`), and why this panel does the same.
 */
test("a read the Host refused and a reply this build cannot read say different things", async ({ page }) => {
  const catalogue = messages("en");
  const surface = page.getByTestId("presets-surface");

  // The Host does not serve the read at all: there is no reply to make sense of.
  await stubPresetSurface(page, [SURFACE]);
  await page.route("**/api/tavern/v1/presets", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
  await expect(surface).toBeVisible();
  const refused = await readFailureBanner(page);
  console.log(`[preset-read/host-refused] ${JSON.stringify(refused)}`);

  // The Host answers, and the answer states a total that cannot be true: the read succeeded, the reply is not the
  // readout this surface can show.
  await page.unroute("**/api/tavern/v1/presets");
  await stubPresetSurface(page, [{ ...SURFACE, entries: { ...SURFACE.entries, total: SURFACE.entries.total + 1 } }]);
  await page.reload();
  await expect(surface).toBeVisible();
  const unreadable = await readFailureBanner(page);
  console.log(`[preset-read/reply-unreadable] ${JSON.stringify(unreadable)}`);

  expect(refused.attribute, "a read the Host refused carries the read-failed attribute").toBe(
    "data-preset-read-failed",
  );
  expect(refused.sentence, "and says the assembly could not be read").toBe(catalogue.presetReadFailed);
  expect(unreadable.attribute, "a reply this build cannot read does not borrow the Host-refusal attribute").toBe(
    "data-preset-reply-unreadable",
  );
  expect(unreadable.sentence, "it says the reply was the thing that did not match").toBe(
    catalogue.presetReplyUnreadable,
  );
  expect(unreadable.sentence, "the two faults cannot share one sentence").not.toBe(refused.sentence);
});

/**
 * A readout that contradicts itself, or that carries a member this surface cannot show, is refused rather than
 * rendered - and the player is told the reply is one this build cannot read, not that the read failed.
 *
 * Each body below is the producer's own output with exactly one thing changed, so the refusal is a fact about that
 * one member: a total that is not `enabled + disabled`, a depth count that is not the blocks beside it, a macro
 * code that names a different macro than the row it sits on, a sampling row whose `source` this surface does not
 * know (which must never fall back to `preset`), an `unset` row that still carries a value, a decided row that
 * carries none, and a member this surface has no line for.
 */
test("a readout that contradicts itself is refused instead of shown", async ({ page }) => {
  const catalogue = messages("en");
  const drifted: Array<Readonly<{ what: string; body: unknown }>> = [
    {
      what: "a total that is not enabled + disabled",
      body: { ...SURFACE, entries: { total: SURFACE.entries.total + 1, enabled: SURFACE.entries.enabled, disabled: SURFACE.entries.disabled } },
    },
    {
      what: "a depth count that is not the blocks beside it",
      body: { ...SURFACE, depth: { ...SURFACE.depth, count: SURFACE.depth.count + 1 } },
    },
    {
      what: "a macro code that names another macro than its row does",
      body: {
        ...SURFACE,
        macros: [{ code: "macro_not_implemented:time", name: "if", entries: ["nsfwPrompt"] }],
      },
    },
    {
      what: "a sampling source this surface does not know",
      body: {
        ...SURFACE,
        sampling: SURFACE_SAMPLING_ROWS.map((row) => (row.key === "top_p" ? { ...row, source: "provider" } : row)),
      },
    },
    {
      what: "an unset sampling row that still carries a value",
      body: {
        ...SURFACE,
        sampling: SURFACE_SAMPLING_ROWS.map((row) => (row.source === "unset" ? { ...row, value: 0.5 } : row)),
      },
    },
    {
      what: "a decided sampling row that carries no value",
      body: {
        ...SURFACE,
        sampling: SURFACE_SAMPLING_ROWS.map((row) => (row.source === "preset" ? { ...row, value: null } : row)),
      },
    },
    {
      what: "a sampler reading that carries the rows and the reason at once",
      body: { ...SURFACE, sampling: { unavailable: "no_composed_model", rows: SURFACE_SAMPLING_ROWS } },
    },
    {
      what: "a sampler reading that carries neither the rows nor a reason",
      body: { ...SURFACE, sampling: {} },
    },
    {
      what: "a reason this surface has no line for",
      body: { ...SURFACE, sampling: { unavailable: "no_provider_configured" } },
    },
    { what: "a member this surface has no line for", body: { ...SURFACE, samplingParams: { temperature: 0.9 } } },
  ];

  for (const { what, body } of drifted) {
    await page.unroute("**/api/tavern/v1/presets");
    await stubPresetSurface(page, [body]);
    await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
    // The surface is asserted mounted before anything is read out of it: a read on a panel that never rendered
    // would throw its own error and be counted as a finding about the assembly.
    await expect(page.getByTestId("presets-surface")).toBeVisible();
    const surface = page.getByTestId("presets-surface");
    await expect(
      surface.locator("[data-preset-reply-unreadable]"),
      `${what} is not shown as the assembly's truth`,
    ).toHaveText(catalogue.presetReplyUnreadable);
    await expect(surface.locator("[data-preset-assembly]"), `${what} renders no assembly at all`).toHaveCount(0);
  }
});

/**
 * No composed model is a NAMED absence, not an empty row list and not the values the preset wrote.
 *
 * This is the state the product is in today: nothing binds a preset to the Chat runtime, so the readout cannot say
 * what would be sent. The panel must say THAT - a section with no rows would read to a player as "no setting is
 * sent", which is a different and false claim (§5).
 */
test("a preset with no composed model says the sampling was not measured", async ({ page }) => {
  const catalogue = messages("en");
  const unmeasured = presetAssemblySurface({
    presetId: "unmeasured",
    name: "A preset with no composed model",
    revision: 1,
    document: PRESET_DOCUMENT,
    macros: {
      char: "Mira",
      user: "the player",
      description: ASSEMBLY_MARKERS.charDescription,
      personality: ASSEMBLY_MARKERS.charPersonality,
      scenario: ASSEMBLY_MARKERS.scenario,
      persona: "A neighbour with a spare hour.",
      itemId: "unmeasured",
    },
    markers: ASSEMBLY_MARKERS,
    sampling: null,
  });
  expect(unmeasured.sampling, "the producer reports the named absence when no composed model is supplied").toEqual({
    unavailable: "no_composed_model",
  });

  await stubPresetSurface(page, [unmeasured]);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=presets`);
  const surface = page.getByTestId("presets-surface");
  const line = surface.locator("[data-preset-sampling-unavailable]");
  await line.scrollIntoViewIfNeeded();
  await expect(line, "the absence is stated in words rather than rendered as an empty section").toHaveText(
    catalogue.presetSamplingUnavailable,
  );
  await expect(line).toHaveAttribute("data-preset-sampling-unavailable", "no_composed_model");
  await expect(
    surface.locator("[data-preset-sampling-row]"),
    "no sampling row is rendered for a reading nobody took",
  ).toHaveCount(0);
});

/**
 * The four refusals of the sampler reading, each naming what it hit rather than "invalid body".
 *
 * They are asserted on the validator directly because the panel draws one banner for every reply it refuses: a
 * reader debugging a drifted Host needs to know which of the four it was, and only the message carries that.
 */
test("each refused sampler reading is refused by the name of what it did", () => {
  const read = (sampling: unknown) =>
    () => validatePresetAssemblyRead({ apiVersion: 1, presets: [{ ...SURFACE, sampling }] });

  expect(read({ unavailable: "no_composed_model", rows: SURFACE_SAMPLING_ROWS }), "rows and a reason at once").toThrow(
    /carries both the reason and the rows/u,
  );
  expect(read({ unavailable: "no_composed_model", samplingRows: [] }), "a reason with rows beside it").toThrow(
    /beside the reason, so rows are still attached to an absence/u,
  );
  expect(read({}), "neither shape").toThrow(/carries neither the rows nor the reason there are none/u);
  expect(read({ unavailable: "no_provider_configured" }), "a reason this surface cannot name").toThrow(
    /is "no_provider_configured", which is none of/u,
  );
  // And the shape that IS a reading passes, so the four refusals above are not a blanket refusal of the branch.
  expect(() => validatePresetAssemblyRead({ apiVersion: 1, presets: [SURFACE] })).not.toThrow();
});
