import { type Page, expect, test } from "./frontend-coverage";

/**
 * The opening editor's variant list is the region that scrolls, so the card stops
 * growing with it - and the decision at the bottom of the card stays painted.
 *
 * Why this exists, in the numbers it was written against (1440x900, the composed
 * shell's Characters surface):
 *
 *  - the opening card was one of three columns of `columns: 420px`, and its
 *    variant list had no bound at all: every press of 添加开场白 added a 158 px
 *    row, the card grew 158 px with it, and the page grew by the same 158 px
 *    (surface `scrollHeight` 1330 with three variants, 1988 with seven).
 *  - the card is the tallest column, so the whole panel grew with it: the two
 *    neighbours' headings (伙伴 / 导入角色卡 / 演出指导, painted at the top of the
 *    panel) were pushed out of the viewport as the surface scrolled to reach the
 *    presses - measured at -673 px above the top edge with four presses.
 *  - the blank under a shorter column is `max column - that column`, so no column
 *    layout can take it below the tallest card's own height: with one unbounded
 *    1421 px card the floor is 670 px. That is why the layout is not the lever
 *    and this list is.
 *
 * The bound is the installation panel's own (`.installation-candidates`,
 * `min(32dvh, 300px)`), and its comment is the reason it lives on the list rather
 * than on the card: "with a `max-height` on the box that also holds the decision,
 * the cap cuts exactly the controls at the bottom. It did." So 添加开场白 and
 * 保存开场白 stay outside this region, and the last test here asserts that the
 * save control is still painted, enabled and outside the scrolling box.
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
    route.fulfill(jsonOk({ apiVersion: 1, present: true, revision: 1, entries: [] })),
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
        variants: [
          { label: "默认", text: "清晨的鹈鹕镇还没醒。" },
          { label: "雨夜", text: "雨点落在谷仓的铁皮上。" },
          { label: "集市", text: "集市的日子，人来人往。" },
        ],
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
 * The variant list, the card that holds it, the surface around them, and the one
 * decision the card must keep painted. The row gap is the card's own `gap` while
 * the rows are the card's direct children, and the region's gap once they have a
 * region - both 8 px, and measured rather than assumed.
 */
async function measure(page: Page) {
  return await page.evaluate(() => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const card = document.querySelector<HTMLElement>("[data-opening-editor]");
    const scroller = document.querySelector<HTMLElement>(".surface-content");
    if (card === null || scroller === null) return null;
    const rows = [...card.querySelectorAll<HTMLElement>(".opening-variant-row")];
    const region = card.querySelector<HTMLElement>("[data-opening-variants]");
    const band = scroller.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const rowGap =
      Number.parseFloat(getComputedStyle(region ?? card).rowGap) ||
      Number.parseFloat(getComputedStyle(region ?? card).gap) ||
      0;
    const rowsHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) + rowGap * (rows.length - 1);
    const headings = [...document.querySelectorAll<HTMLElement>("[data-characters-panel] > section > h3")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        text: node.textContent ?? "",
        top: round(rect.top),
        bottom: round(rect.bottom),
        inside: rect.top >= band.top && rect.bottom <= band.bottom,
      };
    });
    const save = [...card.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      (button.textContent ?? "").includes("保存"),
    );
    const saveBox = save?.getBoundingClientRect() ?? null;
    return {
      variantCount: rows.length,
      cardHeight: round(cardBox.height),
      rowHeight: rows[0] === undefined ? null : round(rows[0].getBoundingClientRect().height),
      rowGap,
      rowsHeight: round(region === null ? rowsHeight : region.clientHeight),
      rowsScrollHeight: region === null ? null : region.scrollHeight,
      regionTabIndex: region === null ? null : region.tabIndex,
      scrollTop: round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      bandTop: round(band.top),
      bandBottom: round(band.bottom),
      headings,
      save:
        save === undefined || saveBox === null
          ? null
          : {
              visible: save.checkVisibility(),
              disabled: save.disabled,
              top: round(saveBox.top),
              bottom: round(saveBox.bottom),
              inViewport: saveBox.top >= 0 && saveBox.bottom <= window.innerHeight,
              insideList: region !== null && region.contains(save),
            },
      bound: Math.min(window.innerHeight * 0.32, 300),
    };
  });
}

test("item 23: the opening editor's variant list is what scrolls, not the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubCharacters(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  await expect(page.locator("[data-opening-editor]")).toBeVisible();
  // The card paints before its read lands (h3, hint, loading line), so the rows are
  // what "the editor is ready" means here.
  await expect(page.locator("[data-opening-editor] .opening-variant-row")).toHaveCount(3);

  const start = await measure(page);
  console.log(`[item-23 start] ${JSON.stringify(start)}`);
  expect(start, "the opening editor renders").not.toBeNull();
  expect(start!.variantCount, "the stored opening's three variants are the list").toBe(3);
  expect(start!.rowHeight, "a variant row measures its own height").not.toBeNull();

  const add = page.getByRole("button", { name: "添加开场白", exact: true });
  await expect(add).toBeVisible();
  for (let press = 0; press < 4; press += 1) {
    await add.click();
    await expect(page.locator(".opening-variant-row")).toHaveCount(4 + press);
  }
  const grown = await measure(page);
  console.log(`[item-23 after 4 adds] ${JSON.stringify(grown)}`);
  expect(grown!.variantCount, "four 添加开场白 press add four variants").toBe(7);

  // (a) The list is bounded, and it really scrolls: the extra variants are
  // reachable rather than dropped.
  expect(
    grown!.rowsHeight,
    `the variant list stays under the panel's own bound (${grown!.rowsHeight} against ${grown!.bound})`,
  ).toBeLessThanOrEqual(grown!.bound);
  expect(
    grown!.rowsScrollHeight!,
    `the bound hides nothing: the list scrolls its ${grown!.rowsScrollHeight} px of rows inside ${grown!.rowsHeight} px`,
  ).toBeGreaterThan(grown!.rowsHeight);

  // (a) …and the page stops growing with it. Three rows already fill the bound, so
  // four more add no page height at all; the card used to add one 158 px row each.
  expect(
    grown!.scrollHeight - start!.scrollHeight,
    `the surface does not grow with the list (${start!.scrollHeight} -> ${grown!.scrollHeight} for four more variants)`,
  ).toBeLessThanOrEqual(2 * (grown!.rowHeight ?? 0));

  // (b) The other columns keep their headings: the card no longer dictates the
  // surface's scroll, so nothing turned the page while the presses landed.
  expect(grown!.scrollTop, `the surface did not scroll (scrollTop ${grown!.scrollTop})`).toBe(0);
  const pushedOut = grown!.headings.filter((heading) => !heading.inside).map((heading) => heading.text);
  expect(
    pushedOut,
    `every column's heading is inside the viewport after four presses (out: ${JSON.stringify(pushedOut)})`,
  ).toEqual([]);

  // (c) The decision stays outside the scrolling box, painted and enabled.
  expect(grown!.save, "the card's save control is rendered").not.toBeNull();
  expect(grown!.save!.insideList, "保存开场白 sits outside the list that scrolls").toBe(false);
  expect(grown!.save!.visible, "保存开场白 is rendered visible").toBe(true);
  expect(grown!.save!.disabled, "保存开场白 is enabled while an opening has text").toBe(false);
  expect(
    grown!.save!.inViewport,
    `保存开场白 is inside the viewport without scrolling (${grown!.save!.top}..${grown!.save!.bottom})`,
  ).toBe(true);

  // (d) The scrolling region is the tab stop the installation panel's list is: a
  // scroll container a keyboard cannot reach is unscrollable for that player.
  expect(grown!.regionTabIndex, "the variant list takes focus, as .installation-candidates does").toBe(0);
});
