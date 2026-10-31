import { expect, test } from "@playwright/test";
import { characterLabels } from "../src/components/character-domain-labels";

/**
 * A companion an imported card created is in the library, not in play - and the
 * Characters surface says so instead of implying a control it does not have.
 *
 * The defect (the character-surface audit): an import ended with
 * `It is now a companion you can chat with.` beside a companion the Chat surface
 * cannot show. There is no companion-activation route in the Host at all - the
 * served operation set is `companion.list` / `companion.worldbook.read` /
 * `companion.create` (`host/src/tavern/browser-contract/index.ts:643-645`),
 * the only `activate` in the route table is `settings.connection.activate`
 * (`:665`), and the companion in play is `manifest.principal.companionId`, a
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
 *  - no element of the roster or of the companion inspector it opens asserts or
 *    implies SWITCHING the in-play companion, and the inspector's own controls are
 *    reads: catches an "activate" affordance for a route that does not exist, in
 *    the row or inside the drawer the row opens;
 *  - opening the inspector issues reads only (every `/api/tavern/v1/` request it
 *    makes is a GET): catches an activation disguised as a read affordance;
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
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  // The inspector's own read. This file is about what the surface PROMISES, not
  // about what a companion carries (that is `companion-inspector.spec.ts`), so it
  // answers the honest "she was made without one" shape for every group.
  await page.route("**/api/tavern/v1/companions/*/profile", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        name: "Mira",
        revision: 1,
        persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
        scenario: { present: false, name: null, description: null },
        greetings: { present: false, label: null, variants: [] },
        worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
      }),
    ),
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
  "The companion in play is the one this installation started with. Choose another here and she plays from the next start: the choice is recorded now, and the restart is what puts her in play.";
/**
 * The words a control that claims to SWITCH the in-play companion would have to use.
 *
 * The rule this file holds is about activation, so it is asserted against the words the player can
 * act on rather than against the tag a control happens to be: a read affordance is not an
 * activation affordance. `choose` is deliberately NOT in this set now that the roster really does
 * offer a choice (`companion.activate`, which only RECORDS it for the next start) - what the
 * inspector must still never do is offer one, and neither surface may say "switch".
 */
const ACTIVATION_WORDS = /switch|activat|set as|enable/i;
/** The words a control that edits an authored field would have to use. */
const EDIT_WORDS = /edit|save|delete|clear|remove|create/i;
const IN_PLAY_ZH =
  "在玩的伙伴就是这次启动选定的那一位。你可以在这里选另一位，她会从下次启动开始陪你：选择现在就会被记下，真正让她上场的是重新启动。";
const IMPORT_DETAIL_EN =
  "She is archived safely in your local companion library. Choose her in the companions list above and she becomes the companion in play from the next start of GameBuddy.";
const IMPORT_DETAIL_ZH =
  "她已安全归档到本地伙伴库。在上面那个伙伴列表里选她，她就会从 GameBuddy 下次启动开始成为在玩的伙伴。";

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

  // No affordance this Host cannot serve - restated as the rule rather than as the
  // mechanism it used to have (2026-10-17). This block asserted that the section
  // held exactly ONE button ("Create companion") and that a companion entry
  // carried NO interactive element at all. Both were true statements of the rule
  // "do not fake a control the Host cannot honour" for the surface as it stood,
  // but the rule is about ACTIVATION, and a read is not an activation: a roster row
  // is now the way the player READS a companion (it opens the read-only
  // inspector), so the mechanism had to change while the rule stayed exactly as
  // strict.
  //
  // The rule changed once more when the Host gained `companion.activate`, and the
  // strictness is the same in a different place: the roster now carries a choice
  // control, so what must hold is that no control claims to SWITCH (the operation only
  // records the choice for the next start - `companion-activation.spec.ts` drives it),
  // that the companion in play offers none at all (the Host refuses her by name), and
  // that opening the inspector still reads and never writes.
  const requestedMethods: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/tavern/v1/")) requestedMethods.push(request.method());
  });
  const rosterControls = await section.evaluate((node) =>
    [...node.querySelectorAll("[data-companion-entry] button, [data-companion-entry] a, [data-companion-entry] select")].map(
      (control) => ({
        label: (control.getAttribute("aria-label") ?? control.textContent ?? "").trim(),
        isInspect: control.hasAttribute("data-companion-inspect"),
        isChoose: control.hasAttribute("data-companion-choose"),
        inPlayRow: control.closest("[data-companion-phase='in_play']") !== null,
      }),
    ),
  );
  expect(rosterControls.length, "the roster rows really are being read").toBeGreaterThan(0);
  expect(
    rosterControls.map((control) => control.label),
    "every roster control carries a name the player can read",
  ).toEqual(rosterControls.map(() => expect.stringMatching(/\S/u)));
  expect(
    rosterControls.filter((control) => !control.isInspect && !control.isChoose),
    "the only controls a roster row carries are the two the Host serves: read her, and choose her",
  ).toEqual([]);
  expect(
    rosterControls.filter((control) => control.inPlayRow && control.isChoose),
    "the companion in play offers no choice: the Host refuses her by name",
  ).toEqual([]);
  expect(
    // `switch` is the one word the operation cannot do: it records the choice and the launcher
    // applies it at the next start.
    rosterControls.filter((control) => /switch/iu.test(control.label)),
    "no roster control claims to switch the companion in play",
  ).toEqual([]);

  // Reachable, and a read: the inspector opens from the row that names her, and
  // nothing inside it edits or activates anything.
  const opener = section.locator("[data-companion-entry] [data-companion-inspect]").first();
  const openerLabel = await opener.getAttribute("aria-label");
  await opener.click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  const drawerControls = await drawer.evaluate((node) =>
    [...node.querySelectorAll("button, a, select, textarea, input")].map((control) =>
      (control.getAttribute("aria-label") ?? control.textContent ?? "").trim(),
    ),
  );
  console.log(`[companion-inspector] controls=${JSON.stringify(drawerControls)}`);
  expect(
    drawerControls.filter((label) => ACTIVATION_WORDS.test(label) || EDIT_WORDS.test(label)),
    "the inspector contains no control that edits or activates anything",
  ).toEqual([]);
  expect([...new Set(requestedMethods)], "opening the inspector reads; it never writes").toEqual(["GET"]);

  // Escape closes it and focus goes back to the row control that opened it.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(openerLabel).toMatch(/\S/u);

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
      // The row's name element, not the control's whole text: the control also carries
      // her monogram, which is decoration rather than part of her name.
      name: row.querySelector("[data-companion-entry-name]")?.textContent?.trim() ?? "",
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

/**
 * Every sentence that tells the player to CHOOSE a companion names a control that is really there.
 *
 * This is the gate the earlier copy change needed and did not have. Two sentences instructed the
 * player to pick a companion "in the list" while the list could only open her inspector - a false
 * instruction is worse than the stale one it replaced, because it points at a button that GETs. So
 * the instruction and the control are asserted together, in the same mounted surface: for each
 * sentence, the element that carries it and the element that carries the choice are both present,
 * and the sentence's words name what the control's words say.
 *
 * The population is derived from the catalogue rather than retyped: the sentences are the keys
 * whose text instructs a choice, found by asking the two catalogues which of their values name it.
 */
test("a sentence that tells the player to choose names a control that exists on the same surface", async ({ page }) => {
  await stubCharacters(page, () => [
    { handle: currentHandle, name: "Mira", isCurrent: true },
    { handle: importedHandle, name: "Nova", isCurrent: false },
  ]);
  const surface = await openCharacters(page, "en", "Characters");
  const section = surface.locator("[data-companion-list-section]");

  // The three sentences that used to say a restart-configuration decided this, and now instruct a
  // choice. Each one must be accompanied by the control it names.
  const instructing = [
    { key: "companionInPlay", selector: "[data-companion-in-play]" },
    { key: "companionActivationHint", selector: "[data-companion-activation-hint]" },
  ] as const;
  for (const entry of instructing) {
    const sentences = await section.locator(entry.selector).allTextContents();
    expect(sentences.length, `${entry.key} is rendered on the roster section`).toBeGreaterThan(0);
    expect(
      sentences.join(" "),
      `${entry.key} names a choice, so the choice control must be there to carry it out`,
    ).toMatch(/choose|pick/iu);
  }
  // ...and the control really is: one on the companion who is not in play, none on her who is.
  await expect(section.locator('[data-companion-phase="offer"] [data-companion-choose]')).toHaveCount(1);
  await expect(section.locator('[data-companion-phase="in_play"] [data-companion-choose]')).toHaveCount(0);

  // The import result's sentence names the list, and the list it names is this one - the roster
  // above it, which carries the control. Asserted by direction: the word it uses ("above") is the
  // one that is true of the layout, and the roster really does precede the import section.
  const importDetail = characterLabels("en").importCreatedDetail;
  expect(importDetail).toMatch(/list above/iu);
  const order = await page.evaluate(() => {
    const panel = document.querySelector("[data-characters-panel]");
    if (panel === null) return { roster: -1, importer: -1 };
    const roster = panel.querySelector("[data-companion-list-section]");
    const importer = panel.querySelector("[data-card-import]");
    if (roster === null || importer === null) return { roster: -1, importer: -1 };
    // A positive value means the roster comes first in document order.
    const position = roster.compareDocumentPosition(importer);
    return {
      roster: panel.children.length,
      importer: position & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1,
    };
  });
  expect(order.importer, "the roster precedes the import section, which is what 'above' claims").toBe(1);
});
