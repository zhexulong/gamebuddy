import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The read-only companion inspector: what a roster companion carries, and what she
 * was provisioned without.
 *
 * `companion-in-play.spec.ts` holds the surface's PROMISE (nothing claims to switch
 * the in-play companion, and opening the inspector issues reads only). This file
 * holds the CONTENT: the projection `companion.profile.read` returns is shown group
 * by group, absence is stated in words rather than as an empty box, "present and
 * empty" is told apart from "made without one", and the drawer's only write is her
 * picture - the four groups it shows are reads, with no editor of their own.
 *
 * The three facts each assertion is built on:
 *
 *  - an archived companion's authored facts live on disk and no other route reads
 *    them: the persona/scenario/opening/directive editors all read the MOUNTED
 *    companion, and `persona.read` is the PLAYER's own record, so before this route
 *    her scenario, her openings and her persona were unreadable;
 *  - the projection renders the card's macros at the read seam, so the drawer shows
 *    the player words, not `{{user}}` - and the drawer must therefore show exactly
 *    what the Host sent, neither rewriting nor dropping it;
 *  - a group the companion was provisioned without is a different fact from a group
 *    that exists and is empty, and the projection carries the difference as `present`.
 */

const token = "A".repeat(43);
const currentHandle = "B".repeat(42) + "A";
const otherHandle = "D".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: currentHandle, generation: 1, stateRevision: currentHandle },
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

type ListedCompanion = Readonly<{ handle: string; name: string; isCurrent: boolean }>;
type Projection = Readonly<Record<string, unknown>>;

/** The roster, the mounted companion's own reads, and the inspector's projection. */
async function stubCharacters(
  page: Page,
  companions: readonly ListedCompanion[],
  profiles: Readonly<Record<string, Projection>>,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) => route.fulfill(jsonOk({ apiVersion: 1, companions })));
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/profile", (route) => {
    const handle = route.request().url().split("/companions/")[1]!.split("/")[0]!;
    return route.fulfill(jsonOk(profiles[handle] ?? absentProfile("Unknown")));
  });
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: currentHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
}

/** The honest "she was made without one" shape, for every group. */
function absentProfile(name: string): Projection {
  return {
    apiVersion: 1,
    name,
    persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
    scenario: { present: false, name: null, description: null },
    greetings: { present: false, label: null, variants: [] },
    worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
  };
}

async function openCharacters(page: Page): Promise<Locator> {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), "en");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  return surface;
}

async function openInspector(page: Page, name: string): Promise<Locator> {
  const surface = page.getByTestId("characters-surface");
  await surface.locator(`[data-companion-entry] [data-companion-inspect][aria-label*="${name}"]`).click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  // The drawer is ready when its own read has landed: the loading line is the one
  // thing every other assertion would otherwise be racing.
  await expect(drawer.locator(".loading-text")).toHaveCount(0);
  return drawer;
}

test("a companion who carries her authored facts shows all of them, each one fold away", async ({ page }) => {
  const profile: Projection = {
    apiVersion: 1,
    name: "Mira",
    persona: {
      present: true,
      core: "She reads the weather before she decides anything.",
      interactionStyle: "Direct, and never in a hurry.",
      expressionStyle: "Rarely raises her voice.",
    },
    scenario: { present: true, name: "Winter on the ridge", description: "The pass closes in November." },
    greetings: {
      present: true,
      label: "The porch",
      variants: [
        { label: "Default", text: "You are late, and the kettle is cold." },
        { label: "Rain", text: "Come in before the mud takes your boots." },
      ],
    },
    worldBook: {
      apiVersion: 1,
      present: true,
      revision: 3,
      entries: [
        { title: "The pact", keys: [], constant: true, content: "They agreed to split the ridge." },
        { title: "Greenhouse", keys: ["glass", "seedling"], constant: false, content: "The glass was replaced." },
      ],
    },
  };
  await stubCharacters(page, [{ handle: otherHandle, name: "Mira", isCurrent: false }], { [otherHandle]: profile });
  await openCharacters(page);
  const drawer = await openInspector(page, "Mira");

  // Persona: present, so the group shows her words and never the absence line.
  await expect(drawer.locator("[data-companion-inspector-persona-core]")).toHaveText(profile.persona["core"]);
  await expect(drawer.locator("[data-companion-inspector-persona-interaction-style]")).toHaveText(
    "Direct, and never in a hurry.",
  );
  await expect(drawer.locator("[data-companion-inspector-persona] [data-companion-inspector-absent]")).toHaveCount(0);

  // Scenario: the name is shown, and its prose is one fold down so the drawer stays
  // scannable - which is also where a dropped body would show up as nothing at all.
  await expect(drawer.locator("[data-companion-inspector-scenario-name]")).toHaveText("Winter on the ridge");
  const scenarioText = drawer.locator("[data-companion-inspector-scenario-text]");
  await scenarioText.locator("> summary").click();
  await expect(scenarioText).toContainText("The pass closes in November.");

  // Openings: the set's own label, both variants, and each variant's text behind its
  // own fold.
  await expect(drawer.locator("[data-companion-inspector-openings-label]")).toHaveText("The porch");
  const openings = drawer.locator("[data-companion-inspector-opening]");
  await expect(openings).toHaveCount(2);
  const firstOpeningText = openings.first().locator("[data-companion-inspector-opening-text]");
  await firstOpeningText.locator("> summary").click();
  await expect(firstOpeningText).toContainText("the kettle is cold");
  const secondOpeningText = openings.nth(1).locator("[data-companion-inspector-opening-text]");
  await secondOpeningText.locator("> summary").click();
  await expect(secondOpeningText).toContainText("before the mud takes your boots");

  // World book: the count is stated as a word, and each entry says whether it is
  // always-on or keyed, with its body one fold down.
  const book = drawer.locator("[data-companion-inspector-world-book]");
  await book.locator("[data-companion-inspector-world-book-disclosure] > summary").click();
  await expect(book.locator("[data-companion-inspector-world-book-count]")).toContainText("2");
  const entries = book.locator("[data-companion-inspector-world-book-entry]");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText("The pact");
  await expect(entries.nth(1)).toContainText("Greenhouse");
  await expect(entries.nth(1)).toContainText("glass");
  const entryText = entries.first().locator("[data-companion-inspector-world-book-entry-text]");
  await entryText.locator("> summary").click();
  await expect(entryText).toContainText("They agreed to split the ridge.");

  // And nothing on this surface leaked a placeholder: the Host renders the card's
  // macros at the read seam, so the drawer must never paint one.
  await expect(drawer).not.toContainText("{{");
});

test("a companion provisioned without them says so, and an empty book is not an absent one", async ({ page }) => {
  // Two companions in one library: one made without any of the four groups, one who
  // has a book that exists and holds nothing. The second is the distinction the
  // brief asked for - "she has none" and "she has one and it is empty" must not read
  // the same on screen.
  const bare: Projection = absentProfile("Bare");
  const emptyBook: Projection = {
    ...absentProfile("Bare"),
    name: "Bookless",
    worldBook: { apiVersion: 1, present: true, revision: 3, entries: [] },
  };
  await stubCharacters(
    page,
    [
      { handle: otherHandle, name: "Bare", isCurrent: false },
      { handle: currentHandle, name: "Bookless", isCurrent: true },
    ],
    { [otherHandle]: bare, [currentHandle]: emptyBook },
  );
  await openCharacters(page);

  const bareDrawer = await openInspector(page, "Bare");
  // Every group states its own absence - four of them, each with its own words, so
  // a single generic "nothing here" would fail this.
  const absentLines = bareDrawer.locator("[data-companion-inspector-absent]");
  await expect(absentLines).toHaveCount(4);
  const sentences = await absentLines.allTextContents();
  expect(sentences.map((sentence) => sentence.trim())).toEqual(sentences.map(() => expect.stringMatching(/\S/u)));
  expect(new Set(sentences.map((sentence) => sentence.trim())).size, `four groups, four sentences: ${JSON.stringify(sentences)}`).toBe(4);
  // The four groups still render their own headings, so the drawer says WHAT is
  // absent rather than collapsing to one line.
  for (const heading of ["persona", "scenario", "openings", "world-book"]) {
    await expect(bareDrawer.locator(`[data-companion-inspector-${heading}] h3`)).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  await expect(bareDrawer).toHaveCount(0);

  const emptyDrawer = await openInspector(page, "Bookless");
  // Present but empty: the book's own sentence, and NOT the book's absence line.
  await expect(emptyDrawer.locator("[data-companion-inspector-world-book-empty]")).toBeVisible();
  await expect(emptyDrawer.locator("[data-companion-inspector-world-book] [data-companion-inspector-absent]")).toHaveCount(0);
  await expect(emptyDrawer.locator("[data-companion-inspector-world-book-empty]")).not.toHaveText(
    sentences[3]!.trim(),
  );
});

test("the inspector shows four groups with no editor, and its one write is her picture", async ({ page }) => {
  await stubCharacters(
    page,
    [{ handle: otherHandle, name: "Mira", isCurrent: false }],
    {
      [otherHandle]: {
        ...absentProfile("Mira"),
        persona: { present: true, core: "Keeps the ledgers.", interactionStyle: null, expressionStyle: null },
      },
    },
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Mira");

  // Nothing that writes a RECORD: no text field, no textarea, no select, no control
  // whose words claim an edit or an activation. The premise moved when her picture
  // became settable here (Add-5) - so the file picker is expected, and it is excluded
  // by `type` rather than by name: what this counts is every control that could carry
  // authored text, and a file input carries a file.
  const controls = await drawer.evaluate((node) => ({
    editableFields: node.querySelectorAll(
      'input:not([type="file"]), textarea, select, [contenteditable="true"]',
    ).length,
    filePickers: [...node.querySelectorAll('input[type="file"]')].map((input) => ({
      accept: input.getAttribute("accept"),
      label: (input.getAttribute("aria-label") ?? "").trim(),
    })),
    buttons: [...node.querySelectorAll("button")].map((button) =>
      (button.getAttribute("aria-label") ?? button.textContent ?? "").trim(),
    ),
    summaries: [...node.querySelectorAll("summary")].map((summary) => (summary.textContent ?? "").trim()),
    placeholderLeaks: (node.textContent ?? "").includes("{{"),
  }));
  console.log(`[companion-inspector-content] ${JSON.stringify(controls)}`);
  expect(controls.editableFields, "no record the inspector shows can be edited").toBe(0);
  expect(controls.placeholderLeaks, "no placeholder reaches the player").toBe(false);
  expect(controls.buttons.filter((label) => /edit|save|delete|clear|remove|create|switch|activat|select|set as|enable/i.test(label))).toEqual([]);
  for (const label of controls.buttons) expect(label, "every control carries a readable name").toMatch(/\S/u);
  for (const summary of controls.summaries) expect(summary, "every disclosure is labelled").toMatch(/\S/u);

  // The one exception, stated exactly: one hidden picker that takes a PNG and nothing
  // else, named for the player, driven by the themed control beside it.
  expect(controls.filePickers).toHaveLength(1);
  expect(controls.filePickers[0]?.accept).toBe("image/png");
  expect(controls.filePickers[0]?.label).toMatch(/\S/u);

  // The roster's own control on that row is the inspect one, and it says what it does.
  const rosterControl = page.getByTestId("characters-surface").locator("[data-companion-entry] [data-companion-inspect]").first();
  await expect(rosterControl).toHaveAttribute("aria-label", /\S/u);
});
