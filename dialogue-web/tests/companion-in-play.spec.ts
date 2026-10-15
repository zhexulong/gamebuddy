import { expect, test } from "@playwright/test";

/**
 * A companion an imported card created is in the library, not in play - and the
 * Characters surface says so instead of implying a control it does not have.
 *
 * The defect (the character-surface audit): an import ended with
 * `It is now a companion you can chat with.` beside a companion the Chat surface
 * cannot show. There is no companion-activation route in the Host at all - the
 * served operation set is `companion.list` / `companion.detail` /
 * `companion.worldbook.read` / `companion.create` (`host/src/tavern/browser-contract/index.ts:639-642`),
 * the only `activate` in the route table is `settings.connection.activate`
 * (`:662`), and the companion in play is `manifest.principal.companionId`, a
 * start-up fact (`host/src/composition/desktop-presentation-admission-owner.ts:271`).
 * A runtime switch would move the deployment principal and therefore the
 * continuity/Memory partition, so no control may be offered here.
 *
 * The assertions, and the failure each one catches:
 *  - the sentence stating WHEN an imported companion becomes the one in play is
 *    rendered, in both catalogues: catches the promise being removed and nothing
 *    honest put in its place;
 *  - the import result no longer claims the new companion can be chatted with in
 *    this run, and states the same condition: catches the old sentence surviving
 *    a fix that only touched the list;
 *  - the companions list section renders exactly ONE button (the create control)
 *    and NO interactive element inside a companion entry: catches an "activate"
 *    affordance for a route that does not exist;
 *  - after the import the library shows two entries and exactly one current mark,
 *    on the mounted companion and not on the imported one: catches the imported
 *    companion being presented as the one in play.
 */

const token = "A".repeat(43);
const currentHandle = "B".repeat(42) + "A";
const importedHandle = "D".repeat(42) + "A";
const importId = "I".repeat(42) + "A";
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
      companion: { name: "Mira" },
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

/**
 * Everything the Characters surface reads once on mount. `library` is a function
 * because the truth under test is that a confirmed import ADDS an entry to the
 * library without making it current: the same route answers with the mounted
 * companion before the import and with both companions after it.
 */
async function stubCharacters(
  page: import("@playwright/test").Page,
  library: () => readonly ListedCompanion[],
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) => route.fulfill(jsonOk({ apiVersion: 1, companions: library() })));
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, entries: [] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: currentHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
}

/** The card decoder's report, as the Host would stage it, plus the confirm answer. */
async function stubImportSuccess(page: import("@playwright/test").Page): Promise<{ confirms: number[] }> {
  const confirms: number[] = [];
  await page.route("**/api/tavern/v1/imports", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        importId,
        name: "Nova",
        candidateRevision: 1,
        fields: [
          { field: "name", eligibility: "profile_eligible_after_explicit_review", chars: 4 },
          { field: "persona_core", eligibility: "profile_eligible_after_explicit_review", chars: 19 },
        ],
        dispositions: [{ field: "character_book", classification: "accepted_typed", reason: "bounded_inert_candidate" }],
      }),
    ),
  );
  await page.route(`**/api/tavern/v1/imports/${importId}/review`, (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, importId, reviewedFields: ["name", "persona_core"], approvedAtMs: 1 }),
    ),
  );
  await page.route(`**/api/tavern/v1/imports/${importId}/confirm`, (route) => {
    confirms.push(1);
    return route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" }));
  });
  return { confirms };
}

async function openCharacters(
  page: import("@playwright/test").Page,
  locale: "en" | "zh-CN",
  navLabel: string,
): Promise<import("@playwright/test").Locator> {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: navLabel, exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  return surface;
}

/**
 * Import the card through the surface's own picker, as a player would.
 *
 * The surface may stage the card and hold it for the player's approval
 * (design/26 §4.6) before anything durable happens: the file choice stages, the
 * confirm control creates her. That control is clicked when the surface renders
 * it, so this journey drives whichever approval shape is shipped.
 */
async function importCard(page: import("@playwright/test").Page): Promise<void> {
  const surface = page.getByTestId("characters-surface");
  await surface.locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ spec: "chara_card_v3", data: { name: "Nova", description: "A quiet astronomer." } }),
      "utf8",
    ),
  });
  const confirm = surface.locator("[data-card-import-review-confirm]");
  try {
    await confirm.waitFor({ state: "visible", timeout: 5_000 });
    await confirm.click();
  } catch {
    // No review step: choosing the card was the whole import.
  }
  await expect(surface.locator("[data-card-import-result=created]")).toBeVisible();
}

const IN_PLAY_EN =
  "The companion in play is chosen by the start-up configuration — a companion imported or created here is archived safely in your local companion library, and becomes the one in play only when GameBuddy later starts with her.";
const IN_PLAY_ZH =
  "在玩的伙伴由启动配置选定——你在这里导入或创建的伙伴会安全归档到本地伙伴库，只有在 GameBuddy 以她重新启动后，她才会成为在玩的伙伴。";
const IMPORT_DETAIL_EN =
  "She is archived safely in your local companion library; the companion in play is chosen by the start-up configuration, so she becomes the one in play only when GameBuddy later starts with her.";
const IMPORT_DETAIL_ZH =
  "她已安全归档到本地伙伴库；在玩的伙伴由启动配置选定，所以只有在 GameBuddy 以她重新启动后，她才会成为在玩的伙伴。";

test("a companion an import created is not the one in play, and the surface states when she can be", async ({
  page,
}) => {
  let imported = false;
  const library = (): readonly ListedCompanion[] =>
    imported
      ? [
          { handle: currentHandle, name: "Mira", isCurrent: true },
          { handle: importedHandle, name: "Nova", isCurrent: false },
        ]
      : [{ handle: currentHandle, name: "Mira", isCurrent: true }];

  await stubCharacters(page, library);
  const { confirms } = await stubImportSuccess(page);
  const surface = await openCharacters(page, "en", "Characters");

  const section = surface.locator("[data-companion-list-section]");
  // The truth about when she can be in play, in the player's own words.
  await expect(section.locator("[data-companion-in-play]")).toHaveText(IN_PLAY_EN);

  // No affordance this Host cannot serve: the section's only button is "Create
  // companion", and a companion entry carries no interactive element at all.
  const controls = await section.evaluate((node) => ({
    buttons: [...node.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? ""),
    entryInteractives: node.querySelectorAll("[data-companion-entry] button, [data-companion-entry] a, [data-companion-entry] select")
      .length,
  }));
  expect(controls.buttons).toEqual(["Create companion"]);
  expect(controls.entryInteractives, "a companion entry offers no control the Host cannot serve").toBe(0);

  imported = true;
  await importCard(page);
  await expect.poll(() => confirms.length).toBe(1);

  // The import result states the same condition instead of promising a chat.
  const created = surface.locator("[data-card-import-result=created]");
  await expect(created).toContainText(IMPORT_DETAIL_EN);

  // Two companions in the library, exactly one marked as the one in play, and it
  // is the mounted one - not the card that just arrived.
  const entries = section.locator("[data-companion-entry]");
  await expect(entries).toHaveCount(2);
  await expect(section.locator("em.companion-current-badge")).toHaveCount(1);
  const marks = await section.evaluate((node) => {
    const rows = [...node.querySelectorAll("[data-companion-entry]")];
    return rows.map((row) => ({
      name: row.querySelector("span")?.textContent?.trim() ?? "",
      marked: row.querySelector("em.companion-current-badge")?.textContent?.trim() ?? null,
      markWidth: Math.round(
        row.querySelector("em.companion-current-badge")?.getBoundingClientRect().width ?? 0,
      ),
    }));
  });
  expect(marks).toEqual([
    { name: "Mira", marked: "current", markWidth: marks[0]?.markWidth },
    { name: "Nova", marked: null, markWidth: 0 },
  ]);
  expect(marks[0]?.markWidth ?? 0, "the current mark is laid out, not a zero-width badge").toBeGreaterThan(0);
});

test("the Chinese surface states the same condition in the panel and in the import result", async ({ page }) => {
  let imported = false;
  const library = (): readonly ListedCompanion[] =>
    imported
      ? [
          { handle: currentHandle, name: "Mira", isCurrent: true },
          { handle: importedHandle, name: "Nova", isCurrent: false },
        ]
      : [{ handle: currentHandle, name: "Mira", isCurrent: true }];

  await stubCharacters(page, library);
  const { confirms } = await stubImportSuccess(page);
  const surface = await openCharacters(page, "zh-CN", "角色");

  await expect(surface.locator("[data-companion-in-play]")).toHaveText(IN_PLAY_ZH);

  imported = true;
  await importCard(page);
  await expect.poll(() => confirms.length).toBe(1);
  await expect(surface.locator("[data-card-import-result=created]")).toContainText(IMPORT_DETAIL_ZH);
});
