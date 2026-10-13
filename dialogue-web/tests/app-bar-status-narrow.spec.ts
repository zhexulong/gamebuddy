import { expect, test } from "@playwright/test";

/**
 * U-02: the app-bar status stays a named badge on the companion, not a dot
 * floating in the bar.
 *
 * The measured defect at 400px: the status word was retired with
 * `clip-path: inset(50%)` so the companion's name could keep its width, which
 * left the dot alone beside the monogram. A dot on its own is not a status a
 * player can read.
 *
 * The assertions, and the failure each one catches:
 *  - the status badge overlaps the monogram: catches a badge that drifted back
 *    into the bar as a stray dot;
 *  - the badge is out of the row's flow (`position: absolute`) and the companion
 *    name is not truncated (`scrollWidth <= clientWidth`): catches a fix that
 *    bought the badge its space back out of the name;
 *  - the badge carries the status word as its accessible name: catches a state
 *    that is carried by colour alone;
 *  - no element in the bar overflows its own box: catches the retired status word
 *    coming back as a 1px box whose text still lays out 24px (`overBy 23`) - a
 *    clipped sliver that is neither readable nor gone.
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
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
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    chat: {
      companion: { name: "琥珀" },
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

test("the 400px app bar names its status on the companion's monogram and keeps the name whole", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, chats: [] })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const status = page.locator(".app-bar-status");
  await expect(status).toBeVisible();

  const measured = await page.evaluate(() => {
    const statusNode = document.querySelector<HTMLElement>(".app-bar-status");
    const dot = document.querySelector<HTMLElement>(".app-bar-status .status-dot");
    const avatar = document.querySelector<HTMLElement>(".app-bar-companion .avatar");
    const title = document.querySelector<HTMLElement>(".app-bar-title");
    const labelNode = document.querySelector<HTMLElement>(".app-bar-status-label");
    if (statusNode === null || dot === null || avatar === null || title === null || labelNode === null)
      throw new Error("app-bar-status-narrow: the app bar is not rendered");
    const box = (element: Element) => element.getBoundingClientRect();
    const dotBox = box(dot);
    const avatarBox = box(avatar);
    const appBar = document.querySelector(".app-bar");
    // Every element the bar lays out, not only the word: one element whose
    // scrollWidth beats its clientWidth is content a viewer sees cut off, and
    // `scrollWidth` is what the viewport gates measure.
    const appBarOverflowers =
      appBar === null
        ? []
        : [...appBar.querySelectorAll("*")]
            .map((node) => {
              const element = node as HTMLElement & { scrollWidth?: number; clientWidth?: number };
              const cls =
                typeof element.className === "string"
                  ? element.className
                  : (element.getAttribute("class") ?? "");
              return {
                tag: element.tagName.toLowerCase(),
                cls,
                overBy: (element.scrollWidth ?? 0) - (element.clientWidth ?? 0),
              };
            })
            .filter((entry) => entry.overBy > 0);
    return {
      labelInDom: (labelNode.textContent ?? "").trim(),
      labelDisplay: getComputedStyle(labelNode).display,
      labelBox: { width: Math.round(box(labelNode).width), height: Math.round(box(labelNode).height) },
      appBarOverflowers,
      titleInDom: (title.textContent ?? "").trim(),
      statusPosition: getComputedStyle(statusNode).position,
      titleOverflow: title.scrollWidth - title.clientWidth,
      titleWidth: Math.round(box(title).width),
      dotInsideAvatar:
        dotBox.left >= avatarBox.left - 1 &&
        dotBox.right <= avatarBox.right + 1 &&
        dotBox.top >= avatarBox.top - 1 &&
        dotBox.bottom <= avatarBox.bottom + 1,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  console.log(`[app-bar] ${JSON.stringify(measured)}`);
  // The badge is on the monogram, not floating in the bar.
  expect(measured.dotInsideAvatar, "the status dot is not on the companion's monogram").toBe(true);
  // The space it needs is not taken from the name.
  expect(measured.statusPosition, "the badge must leave the row's flow").toBe("absolute");
  expect(measured.titleOverflow, "the companion's name is truncated at 400px").toBeLessThanOrEqual(1);
  expect(measured.titleWidth, "the companion's name is not rendered at 400px").toBeGreaterThan(0);
  expect(measured.pageOverflowX, "the badge must not widen the bar").toBeLessThanOrEqual(0);
  // No element in the bar is wider than its own box. Catches the retired status
  // word coming back as the classic 1px-box recipe, whose text still laid out 24px
  // inside a 1px box and reported `scrollWidth 24 / clientWidth 1 / overBy 23`:
  // neither readable nor gone, and an overflow every viewport gate can see.
  expect(
    measured.appBarOverflowers,
    "an element in the app bar overflows its own box at 400px",
  ).toEqual([]);
  // The word is out of the flow at this width, not squeezed into a sliver: it is
  // still in the DOM (the accessible name below is read from it) and lays out no box.
  expect(measured.labelDisplay, "the status word is still laid out at 400px").toBe("none");
  expect(measured.labelBox, "the status word still occupies a box at 400px").toEqual({ width: 0, height: 0 });

  // The state is named, not merely coloured: the badge's accessible name is the
  // same word the live region carries.
  expect(measured.labelInDom.length).toBeGreaterThan(0);
  await expect(status).toHaveAccessibleName(measured.labelInDom);
  await expect(status).toHaveAttribute("aria-label", measured.labelInDom);
  await expect(status).toHaveAttribute("title", measured.labelInDom);
  expect(measured.titleInDom).toBe("琥珀");
});
