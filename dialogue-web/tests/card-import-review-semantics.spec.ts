import { expect, test, type Page } from "@playwright/test";

/**
 * The card-import review is a list of player sentences, and every card field it
 * names is named in the player's words.
 *
 * Two defects the audit found in the shipped review, both measured on the real
 * surface:
 *
 *  - the review and the result rendered their rows as `<div><dd>` inside a
 *    `<dl>` with no `<dt>` anywhere, which is not a description list at all: a
 *    `<dl>`'s child must be a `dt`/`dd` pair, and a row here is one sentence
 *    ("Will keep 5 card fields: Name, Persona, ..."), never a term and its
 *    definition. The blocks are lists of sentences, so they are `<ul>`/`<li>`;
 *    the assertions below read the roles the browser maps, not a class name;
 *  - the same sentences printed the Host's own field identifiers
 *    (`persona_core`, `system_prompt`, `example_1`, `regex_scripts`) to the
 *    player. The review now names each field in the domain's own words, in both
 *    catalogues - and still sends the identifiers back to the Host, because the
 *    translation is the review's, not the protocol's.
 */

const token = "A".repeat(43);
const chatHandle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const importIdHandle = "D".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

/** The Host's own field identifiers for a card it would really stage. */
const KEPT = ["name", "persona_core", "system_prompt", "example_1", "first_greeting"] as const;
/** The card keys the decoder refuses, which the "could not use" sentence names. */
const REFUSED = ["regex_scripts", "alternate_greetings"] as const;

/** Every identifier the review must not print, including the ones it never renders. */
const IDENTIFIERS = [...KEPT, ...REFUSED, "character_book", "worldbook_entry_1"] as const;

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

/** The Host's staged report, in the vocabulary the review has to translate. */
function stageResult(): Record<string, unknown> {
  return {
    apiVersion: 1,
    importId: importIdHandle,
    name: "Nova",
    candidateRevision: 1,
    fields: [
      ...KEPT.map((field, index) => ({
        field,
        eligibility: "profile_eligible_after_explicit_review",
        chars: 10 + index,
      })),
      { field: "worldbook_entry_1", eligibility: "candidate_only", chars: 12 },
    ],
    dispositions: [
      { field: "character_book", classification: "accepted_typed", reason: "bounded_inert_candidate" },
      ...REFUSED.map((field) => ({
        field,
        classification: "dropped_unsupported",
        reason: "executable_or_prompt_control_field",
      })),
    ],
  };
}

/** The Characters surface's other reads, so the import card's control pair renders. */
const characterReads: Readonly<Record<string, unknown>> = {
  companions: { apiVersion: 1, companions: [] },
  persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
  scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
  greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
  "import-history": { apiVersion: 1, entries: [] },
  "world-info": { state: "none", revision: chatHandle, items: [] },
};

/**
 * Stages the Host's report through the real file picker and returns the review
 * region plus every `reviewedFields` body the review route received.
 */
async function stageCard(page: Page, locale: "en" | "zh-CN") {
  const reviews: unknown[] = [];
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  for (const [path, body] of Object.entries(characterReads))
    await page.route(`**/api/tavern/v1/${path}`, (route) => route.fulfill(jsonOk(body)));
  await page.route("**/api/tavern/v1/imports", (route) => route.fulfill(jsonOk(stageResult())));
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) => {
    reviews.push(route.request().postDataJSON());
    return route.fulfill(
      jsonOk({ apiVersion: 1, importId: importIdHandle, reviewedFields: [...KEPT], approvedAtMs: 1 }),
    );
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  await surface.locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova" } }), "utf8"),
  });
  const review = surface.locator("[data-card-import-review]");
  await expect(review).toBeVisible();
  return { surface, review, reviews };
}

/** Fails when the review's own text carries one of the Host's identifiers. */
async function expectNoIdentifiers(region: ReturnType<Page["locator"]>, what: string): Promise<void> {
  const text = await region.innerText();
  for (const identifier of IDENTIFIERS) {
    // `name` is a word of the sentence itself ("The card names it Nova."), so the
    // check is word-bounded and case-sensitive: the label is `Name`.
    const pattern = new RegExp(`\\b${identifier}\\b`, "u");
    expect(text, `${what} prints the field identifier ${identifier}: ${JSON.stringify(text)}`).not.toMatch(pattern);
  }
}

test("the import review is a list of player sentences, with human field names", async ({ page }) => {
  const { review, reviews, surface } = await stageCard(page, "en");

  // Structure, read as the roles the browser maps: a list of items, and not one
  // description-list element - the malformed `<dl>` held four `<dd>` and no `<dt>`.
  await expect(review.getByRole("list")).toHaveCount(1);
  await expect(review.getByRole("definition")).toHaveCount(0);
  expect(
    await review.locator("dl, dt, dd").count(),
    "a <dd> with no <dt> is not a description list; the review is a list of sentences",
  ).toBe(0);

  const items = review.getByRole("listitem");
  // Five rows: the card's name, the kept-field sentence, the refused-field
  // sentence, the lorebook count and the carried directive.
  await expect(items).toHaveCount(5);
  await expect(items.nth(1), "the kept fields are named in the player's words").toHaveText(
    "Will keep 5 card fields: Name, Persona, Performance directive, Example dialogue, Opening.",
  );
  await expect(items.nth(2), "a refused card key is named in the player's words").toHaveText(
    "Could not use: Regular expressions, Alternate opening.",
  );
  await expectNoIdentifiers(review, "the review");

  // The translation is the review's, not the protocol's: the Host still receives
  // the identifiers it published, and only the ones it marked eligible.
  await review.getByRole("button", { name: "Import this card" }).click();
  await expect.poll(() => reviews.length).toBe(1);
  expect((reviews[0] as { reviewedFields: string[] }).reviewedFields).toEqual([...KEPT]);

  // The result block the same class carried is a list of sentences too.
  const created = surface.locator("[data-card-import-result=created]");
  await expect(created).toBeVisible();
  await expect(created.getByRole("list")).toHaveCount(1);
  expect(await created.locator("dl, dt, dd").count()).toBe(0);
  await expect(created.getByRole("listitem").first()).toHaveText("Imported Nova.");
  await expectNoIdentifiers(created, "the result");
});

test("the review names its fields in Chinese too, with no identifier in either catalogue", async ({ page }) => {
  const { review } = await stageCard(page, "zh-CN");

  await expect(review.getByRole("list")).toHaveCount(1);
  const items = review.getByRole("listitem");
  await expect(items).toHaveCount(5);
  await expect(items.nth(1), "the kept fields are named in the player's words").toHaveText(
    "将保留 5 个卡片字段：名称、用户设定、演出指导、对话示例、开场白。",
  );
  await expect(items.nth(2), "a refused card key is named in the player's words").toHaveText(
    "无法使用：正则表达式、备用开场白。",
  );
  await expectNoIdentifiers(review, "zh 的 review");
});
