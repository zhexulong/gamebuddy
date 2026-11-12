import { type Page, expect, test } from "./frontend-coverage";
import { hostWorldBookReply } from "./host-world-book-reply";

/**
 * Expanding a world-book entry moves no line above it out of the scroller.
 *
 * The claim this file was written against: at 400x800, expanding an entry clips
 * the top of the entry and half a line of the text above it - the shape of a
 * scroll-into-view that puts the expanded block at the scroller's own top edge
 * instead of at the nearest position that reveals it.
 *
 * It does not reproduce, and this file records that as a measurement rather than
 * as a fix. The product performs no scroll on this path: the whole frontend has
 * two scrolls (`Timeline`'s tail follow and `CharacterCardImport`'s
 * `scrollIntoView({ block: "nearest" })` after its review opens), and the
 * companion's book, the managed library and the inspector's book have none -
 * measured here, `scrollTop` is identical before and after an entry opens, the
 * expanded entry's top sits far below the scroller's top, and the entry above it
 * is wholly visible.
 *
 * What is left is the invariant, so a future scroll cannot reintroduce the
 * shape: the assertion below reads the scroller and its two neighbours on every
 * entry, and the sensitivity proof at the end drives the scroller to exactly the
 * overshooting position - the expanded block aligned to the top edge - to show
 * the same probe reporting the clipped line.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"B".repeat(42)}A`;
const worldInfoHandle = `${"W".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

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
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available",
        routeId: "chat.submit",
      },
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: companionHandle, generation: 1, stateRevision: companionHandle },
    chat: {
      companion: { name: "琥珀", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
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

/** Her own book: seven entries, each with a body long enough to be a few lines. */
const worldBookEntries = Array.from({ length: 7 }, (_, index) => ({
  title: `词条 ${index}`,
  keys: ["料理", "做饭"],
  constant: false,
  enabled: true,
  content: `第 ${index} 条正文。这一条写得长一点，展开之后它自己要有好几行，才能看出上下两条各自是否完整。`,
}));

async function stubCharacters(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: companionHandle, name: "琥珀", isCurrent: true }] })),
  );
  await page.route(/\/api\/tavern\/v1\/companions\/[^/]+\/voice/u, (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, profileRevision: 1, characterVoice: { text: "轻声，语速慢一点。", source: "card" } }),
    ),
  );
  await page.route(/\/api\/tavern\/v1\/companions\/[^/]+\/worldbook/u, (route) =>
    route.fulfill(
      jsonOk(hostWorldBookReply({ apiVersion: 1, present: true, revision: 1, entries: worldBookEntries })),
    ),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: true, revision: 1, name: "拓荒者", description: "刚下车的农场主。" })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, name: "鹈鹕镇", description: "春天的第一周。", preview: null }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        label: "默认",
        variants: [{ label: "默认", text: "清晨的鹈鹕镇还没醒。" }],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: worldInfoHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/u, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
}

/**
 * The scroller's band, one entry, and the last line of the entry above it - in
 * viewport coordinates, so "clipped" is two numbers rather than an impression.
 */
async function measureEntry(page: Page, index: number) {
  return await page.evaluate((wanted: number) => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const scroller = document.querySelector<HTMLElement>(".surface-content");
    const list = document.querySelector<HTMLElement>("[data-companion-world-book-list]");
    if (scroller === null || list === null) return null;
    const entries = [...list.querySelectorAll<HTMLElement>("[data-companion-world-book-entry]")];
    const band = scroller.getBoundingClientRect();
    const box = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height) };
    };
    const entry = entries[wanted];
    const previous = wanted > 0 ? entries[wanted - 1] : undefined;
    // The entry above's last line is the last paragraph it paints: its trigger
    // words while folded, its body once it is open.
    const previousLastLine = previous?.querySelector("p:last-of-type") ?? null;
    return {
      scrollTop: round(scroller.scrollTop),
      bandTop: round(band.top),
      bandBottom: round(band.bottom),
      entry: entry === undefined ? null : box(entry),
      entryDetails: entry === undefined ? null : box(entry.querySelector("details")!),
      previousLastLine: previousLastLine === null ? null : box(previousLastLine),
    };
  }, index);
}

test("item 30: opening a world-book entry leaves the line above it where it was", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await stubCharacters(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  const disclosure = page.locator("[data-companion-world-book-disclosure]");
  await disclosure.locator("summary").first().click();
  const entrySummaries = surface.locator("[data-companion-world-book-entry-text] > summary");
  await expect(entrySummaries).toHaveCount(7);

  for (const index of [1, 2]) {
    const summary = entrySummaries.nth(index);
    await summary.scrollIntoViewIfNeeded();
    const before = await measureEntry(page, index);
    await summary.click();
    const after = await measureEntry(page, index);
    console.log(`[item-30 entry ${index} before] ${JSON.stringify(before)}`);
    console.log(`[item-30 entry ${index} after] ${JSON.stringify(after)}`);
    expect(after, `entry ${index} measures inside the surface's scroller`).not.toBeNull();

    // Nothing scrolled the surface: the entry opens where the player left it.
    expect(
      after!.scrollTop,
      `opening entry ${index} does not move the surface (${after!.scrollTop} against ${before!.scrollTop})`,
    ).toBe(before!.scrollTop);
    // The expanded entry begins below the scroller's own top edge rather than
    // above it: its first line is painted, not cut.
    expect(
      after!.entry!.top,
      `entry ${index} starts at or below the scroller's top (${after!.entry!.top} against ${after!.bandTop})`,
    ).toBeGreaterThanOrEqual(after!.bandTop);
    // …and the line above it is still wholly visible, both ends inside the band.
    expect(
      after!.previousLastLine!.top >= after!.bandTop && after!.previousLastLine!.bottom <= after!.bandBottom,
      `the line above entry ${index} is still fully visible ` +
        `([${after!.previousLastLine!.top}, ${after!.previousLastLine!.bottom}] inside ` +
        `[${after!.bandTop}, ${after!.bandBottom}])`,
    ).toBe(true);
    // The opened body is really there: the entry grew by its own text.
    expect(
      after!.entry!.height,
      `entry ${index} grew by the body it opened (${after!.entry!.height} against ${before!.entry!.height})`,
    ).toBeGreaterThan(before!.entry!.height);
    await summary.click();
  }

  // Sensitivity proof: the defect this file exists for is a scroll that puts the
  // expanded block at the scroller's own top edge. Driving the scroller there -
  // the position an overshooting scroll-into-view would leave - makes the same
  // probe report the clipped line above, so the assertion is not passing because
  // it can never fail.
  const summary = entrySummaries.nth(2);
  await summary.scrollIntoViewIfNeeded();
  await summary.click();
  const honest = await measureEntry(page, 2);
  const overshot = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".surface-content")!;
    const entry = document.querySelectorAll<HTMLElement>("[data-companion-world-book-entry]")[2]!;
    const target = entry.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = target;
    return scroller.scrollTop;
  });
  const clipped = await measureEntry(page, 2);
  console.log(`[item-30 overshoot] scrollTop=${overshot} ${JSON.stringify(clipped)}`);
  expect(
    clipped!.previousLastLine!.top < clipped!.bandTop,
    `with the entry aligned to the top edge the line above it is cut ` +
      `(${clipped!.previousLastLine!.top} above ${clipped!.bandTop})`,
  ).toBe(true);
  // The honest reading is the one the product produces; the injected one is not.
  expect(
    honest!.previousLastLine!.top,
    `the card's own open moves nothing, so the line above stays inside the band (${honest!.previousLastLine!.top})`,
  ).toBeGreaterThanOrEqual(honest!.bandTop);
});
