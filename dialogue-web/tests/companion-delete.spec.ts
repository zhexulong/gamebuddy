import { expect, test, type Locator, type Page } from "@playwright/test";
import { characterLabels } from "../src/components/character-domain-labels";

/**
 * Removing a companion from the inspector - the one irreversible control on this surface.
 *
 * Five facts this file holds, each of them a way the control could be a trap:
 *
 *  - the pair is ARMED, not a bare button: the trigger is replaced by a confirmation that
 *    restates "for good", so a mis-click cannot delete her;
 *  - a cancel changes nothing: the row stays, no request is sent, and focus returns to the
 *    control that was pressed (`armed-confirmation.ts`);
 *  - the companion in play has NO control at all and the reason is on screen in words - her
 *    Chats are the mounted conversation, so the Host would refuse her by name;
 *  - the sentences at the moment of the act name EVERY record the deletion removes. The
 *    first version of this file asserted only "her picture" and let a confirmation that
 *    said "her record and her picture" pass, while the deletion also removes her persona,
 *    her performance directive, her examples and her card additions - every one of them
 *    editable on the very panel the player is standing on. The omission check below is
 *    named item by named item, in both catalogues, because a sentence that silently drops
 *    one of them is the defect;
 *  - the sentences must NOT claim her conversations go with her: they stay on this machine,
 *    and a sentence that promised they were deleted would be the lie this spec exists to
 *    catch.
 *
 * Reachability is the sixth fact and it is measured, not assumed: the drawer is one 420 px
 * scrolling column, so the removal section being last in it made the trigger invisible on
 * open (measured on the companion in play: the whole control list was ['关闭',
 * '给她一张图片']). The section renders near the top now, and the assertions below read the
 * actual viewport instead of the DOM.
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
      companion: { name: "Mira", handle: currentHandle },
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

/**
 * A companion who carries everything a card can give her, at a length a real card has.
 *
 * Length is the point, not decoration: the drawer is a single scrolling column, so a stub
 * with every group absent renders a body short enough to keep ANY section on screen. The
 * reachability assertions would then pass for the wrong reason - and did, until this
 * profile was made real. The prose below is long because a card's prose is long.
 */
const authoredProfile = (name: string) => ({
  apiVersion: 1,
  name,
  revision: 1,
  persona: {
    present: true,
    core: "She reads the weather before she decides anything, and she has never once been wrong about the pass closing.",
    interactionStyle: "Direct, and never in a hurry. She answers the question you asked, not the one she would have asked.",
    expressionStyle: "Rarely raises her voice; when she does, the room stops and the kettle is already off the stove.",
  },
  scenario: {
    present: true,
    name: "Winter on the ridge",
    description:
      "The pass closes in November and opens again in April, and every year somebody misjudges it. The cabin sits below the treeline with one lamp lit and enough firewood for a season, which is either prudence or a warning depending on how long you have known her.",
  },
  greetings: {
    present: true,
    label: "The porch",
    variants: [
      { label: "Default", text: "You are late, and the kettle is cold. Sit down anyway; the fire is not the only thing that took work to keep alive today." },
      { label: "Rain", text: "Come in before the mud takes your boots. Leave them by the door and do not tell me you walked the whole ridge in this." },
    ],
  },
  worldBook: {
    apiVersion: 1,
    present: true,
    revision: 3,
    entries: [
      { title: "The pact", keys: [], constant: true, content: "They agreed to split the ridge, and neither of them has said out loud what happens if one of them stops coming up." },
      { title: "Greenhouse", keys: ["glass", "seedling"], constant: false, content: "The glass was replaced the spring after the storm, and the seedlings that survived it are the ones she trusts." },
    ],
  },
});

const profileFor = (name: string) => ({
  apiVersion: 1,
  name,
  revision: 1,
  persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
  scenario: { present: false, name: null, description: null },
  greetings: { present: false, label: null, variants: [] },
  worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
});


/**
 * The roster, the two companions' profiles, and a recorder for every DELETE the surface
 * sends. `deleted` starts empty and is appended to the moment a confirmation arrives, so
 * the cancel case can assert the request was never made rather than only that the row
 * survived.
 *
 * Every companion here carries a full card's worth of authored material (`authoredProfile`),
 * so the drawer she opens is as tall as the drawer a player actually opens. A library of
 * absent profiles would make the viewport assertions below pass whatever the layout did.
 */
async function stubCharacters(
  page: Page,
  companions: readonly Readonly<{ handle: string; name: string; isCurrent: boolean }>[],
  deleted: { handle: string; body: unknown }[],
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
    const named = companions.find((entry) => entry.handle === handle);
    return route.fulfill(jsonOk(authoredProfile(named?.name ?? "Unknown")));
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
  await page.route("**/api/tavern/v1/companions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const handle = route.request().url().split("/companions/")[1]!.split("?")[0]!;
    deleted.push({ handle, body: route.request().postDataJSON() });
    return route.fulfill(jsonOk({ apiVersion: 1, handle }));
  });
}

async function openCharacters(page: Page): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), "en");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

async function openInspector(page: Page, name: string) {
  await page
    .getByTestId("characters-surface")
    .locator(`[data-companion-entry] [data-companion-inspect][aria-label*="${name}"]`)
    .click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".loading-text")).toHaveCount(0);
  return drawer;
}

/**
 * What a player can actually reach without scrolling: the drawer's own box, the removal
 * section's box, and the sentence or control inside it, all in viewport coordinates.
 *
 * Reading `innerText` proves a sentence exists in the DOM; it does not prove the player
 * ever sees it, and the defect this replaces was exactly that gap - the paragraph was
 * written, translated and unreachable.
 */
async function measureRemoval(drawer: Locator, selector: string) {
  return await drawer.evaluate(
    (_panel, query) => {
      const node = document.querySelector<HTMLElement>(query);
      const panel = document.querySelector<HTMLElement>('[data-testid="companion-inspector"]');
      const content = panel?.querySelector<HTMLElement>(".drawer-content") ?? null;
      const box = node?.getBoundingClientRect() ?? null;
      return {
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        panelWidth: panel === null ? null : Math.round(panel.getBoundingClientRect().width),
        panelHeight: panel === null ? null : Math.round(panel.getBoundingClientRect().height),
        contentScrollHeight: content === null ? null : content.scrollHeight,
        contentClientHeight: content === null ? null : content.clientHeight,
        contentScrollTop: content === null ? 0 : Math.round(content.scrollTop),
        found: node !== null,
        top: box === null ? null : Math.round(box.top),
        bottom: box === null ? null : Math.round(box.bottom),
        height: box === null ? null : Math.round(box.height),
        // A box the player can see: non-zero, and inside the viewport the drawer fills.
        inViewport: box !== null && box.height > 0 && box.top < window.innerHeight && box.bottom > 0,
      };
    },
    selector,
  );
}

/**
 * The records the deletion removes, each named the way the panel names it.
 *
 * Every entry here is a fact about `host/src/tavern/companion-deletion-service.ts` (the
 * artifact root plus `identity-profile.json`), and every one of them is something the
 * player edits on this very drawer: the three persona dimensions and the performance
 * directive (`identity-profile.ts`), the picture, the scenario, the openings, her own
 * world book, her dialogue examples and the card's own additions. A confirmation that
 * omits one names less than it deletes.
 */
const REMOVED_RECORD_MARKERS = [
  { record: "persona", en: "her persona", zh: "她的设定" },
  { record: "performance directive", en: "how she speaks", zh: "说话方式" },
  { record: "picture", en: "her picture", zh: "她的画像" },
  { record: "scenario", en: "her scenario", zh: "她的场景" },
  { record: "openings", en: "her opening", zh: "开场白" },
  { record: "own world book", en: "her own world book", zh: "她自己的世界书" },
  { record: "dialogue examples", en: "her examples", zh: "对话示例" },
  { record: "card additions", en: "card additions", zh: "附加内容" },
] as const;

/**
 * The removed records a sentence fails to name, by name.
 *
 * Case-insensitive on purpose: the sentence capitalises the first clause ("Her persona and
 * how she speaks, ...") and a test that compared raw substrings would fail on that capital
 * rather than on an omission - which is a test bug that teaches the wrong lesson.
 *
 * One predicate, used by both the catalogue test and the mounted test below, so
 * "names everything" has a single spelling in this file.
 */
function unnamedRemovedRecords(text: string, locale: "en" | "zh-CN"): string[] {
  const lowered = text.toLowerCase();
  return REMOVED_RECORD_MARKERS.filter(
    (marker) => !lowered.includes((locale === "en" ? marker.en : marker.zh).toLowerCase()),
  ).map((marker) => marker.record);
}

/**
 * The sentences as they stood before this change, kept as the red proof.
 *
 * Not read from git history: the point is that the check itself is exercised on a real
 * omission every run, so it cannot quietly become a check that always passes. These are
 * the exact catalogue values that shipped - the hint named five records, the confirmation
 * named two, and the deletion removed eight.
 */
const SUPERSEDED_SENTENCES = [
  {
    where: "the hint that shipped",
    text: "This removes her for good: her record, her picture, her scenario, her openings and her own world book are deleted. It cannot be undone. The conversations you had with her are not deleted - that text stays on this machine - but this Chat list only ever shows the companion in play, so her Chats are not opened or cleaned up from here, either before or after her removal.",
    unnamedByTheOldCheck: ["persona", "performance directive", "dialogue examples", "card additions"],
  },
  {
    where: "the confirmation that shipped",
    text: "Delete Mira for good? Her record and her picture are gone permanently.",
    unnamedByTheOldCheck: [
      "persona",
      "performance directive",
      "scenario",
      "openings",
      "own world book",
      "dialogue examples",
      "card additions",
    ],
  },
] as const;

/**
 * Both catalogues name every removed record, in the hint AND in the confirmation, and
 * neither claims the conversations are deleted.
 *
 * This is the assertion the first version of this file lacked: it checked "her picture"
 * and passed a confirmation that said "her record and her picture", while six further
 * records were deleted. Named item by named item, in both languages, because the omission
 * was in both. The second test is the red proof: the same predicate, on the sentences that
 * shipped, must report exactly the omissions this change exists to fix.
 */
test("both sentences name every record the removal deletes, and never claim the conversations go", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const labels = characterLabels(locale);
    for (const sentence of [
      { where: "companionDeleteHint", text: labels.companionDeleteHint },
      { where: "companionDeleteConfirm", text: labels.companionDeleteConfirm },
    ]) {
      expect(
        unnamedRemovedRecords(sentence.text, locale),
        `${locale} ${sentence.where} leaves these records unnamed: ${JSON.stringify(unnamedRemovedRecords(sentence.text, locale))}`,
      ).toEqual([]);
      // "cannot be undone" is the fact that makes the rest an informed choice.
      expect(sentence.text, `${locale} ${sentence.where} says it cannot be undone`).toMatch(
        locale === "en" ? /cannot be undone/u : /无法撤销/u,
      );
      // And it must not read as if the conversations went with her.
      expect(sentence.text, `${locale} ${sentence.where} says the conversations are kept`).toMatch(
        locale === "en" ? /conversations you had with her are not deleted/u : /你和她有过的对话不会被删除/u,
      );
    }
  }
});

test("(red proof) the same check reports the omissions in the sentences that shipped", () => {
  for (const sentence of SUPERSEDED_SENTENCES)
    expect(
      unnamedRemovedRecords(sentence.text, "en"),
      `${sentence.where} must be caught by the check, not by a reader`,
    ).toEqual(sentence.unnamedByTheOldCheck);
});

test("the confirmation says what goes and what stays, and only a second answer deletes her", async ({ page }) => {
  // The drawer is 420x900 and scrolls, so the viewport is the size a player actually has.
  await page.setViewportSize({ width: 1440, height: 900 });
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Nova");

  // Reachable: the removal entry, its trigger and the sentence that introduces it are in
  // the first viewport, without scrolling. It sat at the end of the drawer's scrolling
  // column before this, behind her picture and her whole persona/scenario/openings/world
  // book, so a sighted player had to hunt for the only control that removes her.
  const triggerAt = await measureRemoval(drawer, "[data-companion-removal-arm]");
  const hintAt = await measureRemoval(drawer, "[data-companion-removal] > p");
  console.log(`[companion-removal @1440] ${JSON.stringify({ trigger: triggerAt, hint: hintAt })}`);
  expect(triggerAt.found, "the removal trigger is in the drawer").toBe(true);
  expect(triggerAt.height, "the removal trigger has a painted box").toBeGreaterThan(0);
  expect(
    triggerAt.top!,
    `the removal trigger sits inside the first viewport (top ${triggerAt.top} of ${triggerAt.viewportHeight})`,
  ).toBeLessThan(triggerAt.viewportHeight);
  expect(hintAt.top! + hintAt.height!, "the sentence above the trigger is inside the first viewport too")
    .toBeLessThan(triggerAt.viewportHeight);

  // The pair's own two sentences: what goes, and that this cannot be undone. The catalogue
  // test above holds the full enumeration; here the mounted surface is checked to render
  // that same sentence rather than a shortened version of it.
  await expect(drawer.locator("[data-companion-removal]")).toContainText("cannot be undone");
  const hint = await drawer.locator("[data-companion-removal] > p").innerText();
  expect(unnamedRemovedRecords(hint, "en"), `the hint renders every removed record: ${JSON.stringify(hint)}`).toEqual([]);
  // What must NOT be claimed: her conversations are not deleted.
  expect(hint).toContain("conversations you had with her are not deleted");
  expect(hint).not.toContain("conversations you had with her are deleted");

  // Arming is not deleting: no request yet.
  await drawer.locator("[data-companion-removal-arm]").click();
  await expect(drawer.locator("[data-companion-removal-confirm]")).toBeVisible();
  expect(deleted).toHaveLength(0);
  // The confirmation restates it rather than asking whether the player is sure, and it
  // names every record the hint named: the moment of the act is not where a sentence is
  // allowed to get shorter. Its own sentence is read on its own (the two answers beside it
  // are controls, not claims).
  const confirmation = drawer.locator("[data-companion-removal-confirm] > p");
  await expect(confirmation).toContainText("for good");
  const confirmText = await confirmation.innerText();
  expect(
    unnamedRemovedRecords(confirmText, "en"),
    `the confirmation renders every removed record: ${JSON.stringify(confirmText)}`,
  ).toEqual([]);
  expect(confirmText, "the confirmation says it cannot be undone").toContain("It cannot be undone.");
  expect(confirmText, "the confirmation keeps the conversations-are-kept clause").toContain(
    "not deleted - that text stays on this machine",
  );
  // The answers are the two the player already knows.
  await expect(drawer.locator("[data-companion-removal-confirm-yes]")).toHaveText("Delete her for good");
  await expect(drawer.locator("[data-companion-removal-confirm-no]")).toHaveText("Keep her");
  // The armed pair is where the player is asked to confirm: it must be visible, not just
  // mounted at the bottom of a scroll.
  const confirmAt = await measureRemoval(drawer, "[data-companion-removal-confirm]");
  console.log(`[companion-removal-armed @1440] ${JSON.stringify(confirmAt)}`);
  expect(confirmAt.top!, `the confirmation sits inside the first viewport (top ${confirmAt.top})`).toBeLessThan(
    confirmAt.viewportHeight,
  );

  await drawer.locator("[data-companion-removal-confirm-yes]").click();
  await expect.poll(() => deleted.length).toBe(1);
  expect(deleted[0]!.handle).toBe(otherHandle);
  expect(deleted[0]!.body).toEqual({ apiVersion: 1, expectedRevision: 1 });

  // The row goes and the drawer closes: a deleted companion must not remain on screen.
  await expect(page.getByTestId("companion-inspector")).toHaveCount(0);
  await expect(
    page.getByTestId("characters-surface").locator(`[data-companion-inspect][aria-label*="Nova"]`),
  ).toHaveCount(0);
  await expect(page.getByTestId("characters-surface").locator("[data-companion-removed]")).toContainText("Nova");
});

test("cancelling the armed pair changes nothing and gives focus back to the control", async ({ page }) => {
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Nova");

  const trigger = drawer.locator("[data-companion-removal-arm]");
  await trigger.click();
  await drawer.locator("[data-companion-removal-confirm-no]").click();

  // Back to the trigger, with focus on it - the safe answer was the one that had focus.
  await expect(drawer.locator("[data-companion-removal-arm]")).toBeFocused();
  expect(deleted).toHaveLength(0);
  await expect(page.getByTestId("companion-inspector")).toBeVisible();
  await expect(
    page.getByTestId("characters-surface").locator(`[data-companion-inspect][aria-label*="Nova"]`),
  ).toHaveCount(1);
});

test("Escape closes the armed pair without deleting her", async ({ page }) => {
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Nova");

  await drawer.locator("[data-companion-removal-arm]").click();
  await expect(drawer.locator("[data-companion-removal-confirm]")).toBeVisible();
  // The confirmation holds focus, so Escape reaches it before the drawer behind it.
  await page.keyboard.press("Escape");
  await expect(drawer.locator("[data-companion-removal-confirm]")).toHaveCount(0);
  expect(deleted).toHaveLength(0);
  // Escape stopped at the confirmation: the drawer it was opened in is still open.
  await expect(page.getByTestId("companion-inspector")).toBeVisible();
});

test("the companion in play has no removal control, and the reason is on screen where it would be", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const deleted: { handle: string; body: unknown }[] = [];
  await stubCharacters(
    page,
    [
      { handle: currentHandle, name: "Mira", isCurrent: true },
      { handle: otherHandle, name: "Nova", isCurrent: false },
    ],
    deleted,
  );
  await openCharacters(page);
  const drawer = await openInspector(page, "Mira");

  await expect(drawer.locator("[data-companion-removal-arm]")).toHaveCount(0);
  // The reason is text on screen, so a sighted and a screen-reader player both read it -
  // and "on screen" is measured, not inferred. Before this, the sentence was mounted at
  // the end of a scrolling 420 px column: a player opening the companion in play saw
  // ['关闭', '给她一张图片'] and nothing about removal at all, which reads as "nobody can be
  // removed" rather than "this one cannot be removed right now".
  const reasonAt = await measureRemoval(drawer, "[data-companion-removal-in-play]");
  console.log(`[companion-removal-in-play @1440] ${JSON.stringify(reasonAt)}`);
  expect(reasonAt.found, "the in-play sentence is in the drawer").toBe(true);
  expect(reasonAt.height, "the in-play sentence has a painted box").toBeGreaterThan(0);
  expect(
    reasonAt.top!,
    `the in-play sentence is inside the first viewport (top ${reasonAt.top} of ${reasonAt.viewportHeight})`,
  ).toBeLessThan(reasonAt.viewportHeight);
  await expect(drawer.locator("[data-companion-removal-in-play]")).toContainText("cannot be deleted");
  // And her section's heading says what the reader is being told about.
  await expect(drawer.locator("[data-companion-removal] h3")).toHaveText("Remove this companion");

  // The narrow viewport is reported, not asserted to the same bar: the drawer is then the
  // whole 400 px width and the sheet's own chrome is taller, so a section that is one
  // screen down at 400x800 is still normal - but it must be a painted box the player can
  // scroll to, and the number has to be written down rather than assumed either way.
  await page.setViewportSize({ width: 400, height: 800 });
  const narrowAt = await measureRemoval(drawer, "[data-companion-removal-in-play]");
  console.log(`[companion-removal-in-play @400] ${JSON.stringify(narrowAt)}`);
  expect(narrowAt.height, "at 400x800 the sentence still has a painted box").toBeGreaterThan(0);
  expect(deleted).toHaveLength(0);
});
