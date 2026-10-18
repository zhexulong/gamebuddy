import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * The character-card export control, mounted.
 *
 * The deliverable is a FILE, and the browser is the surface that saves it: the
 * control asks the Host (`companion.card.export`), and the bytes the Host returns
 * are what the browser writes to disk under the filename the Host minted. This
 * journey proves the download actually happens and that what lands is the Host's
 * own card text - not a browser re-serialization - and measures the control's hit
 * target, because a control a finger cannot hit is not offered either.
 *
 * The refusals are asserted the same way: the Host's own bounded code reaches the
 * player as the sentence for that fact, so "her records are too large" never reads
 * as "something failed".
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

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The Host's own card bytes, so "what was saved" is compared against a known string. */
const CARD = JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "琥珀",
    scenario: "你们一起在祖辈留下的农场里开始新的生活。",
    character_book: {
      scan_depth: 5,
      entries: [{ comment: "温室", content: "温室是她去年冬天修好的。", keys: ["温室", "玻璃房"] }],
    },
  },
});

type ExportResponse = (route: import("@playwright/test").Route) => Promise<void>;

/** Everything the Characters surface reads once on mount, with the export route under test. */
async function stubCharacters(
  page: import("@playwright/test").Page,
  options: Readonly<{ companions: unknown; onCard: ExportResponse }>,
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) => route.fulfill(jsonOk(options.companions)));
  await page.route(`**/api/tavern/v1/companions/${handle}/card`, options.onCard);
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route(`**/api/tavern/v1/companions/${handle}/voice`, (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, profileRevision: 1, characterVoice: { text: "先做一个动作,再说一句话。", source: "card" } }),
    ),
  );
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
    route.fulfill(jsonOk({ state: "none", revision: handle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
}

const oneCompanion = {
  apiVersion: 1,
  companions: [{ handle, name: "琥珀", isCurrent: true }],
};

async function openCharacters(page: import("@playwright/test").Page): Promise<import("@playwright/test").Locator> {
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  return surface;
}

test("the export control saves the Host's own card bytes under the Host's filename, and clears 44 px", async ({ page }) => {
  await stubCharacters(page, {
    companions: oneCompanion,
    onCard: async (route) =>
      route.fulfill(jsonOk({ apiVersion: 1, spec: "chara_card_v3", fileName: "琥珀.json", card: CARD })),
  });
  const surface = await openCharacters(page);

  const section = surface.locator("[data-companion-card-export-section]");
  await expect(section).toBeVisible();
  await expect(section.locator("h3")).toHaveText("把她另存为角色卡");
  const button = section.locator("[data-companion-card-export]");
  await expect(button).toBeVisible();
  // Its accessible name says what it does.
  await expect(button).toHaveAttribute("aria-label", "导出角色卡: 琥珀");

  const measured = await button.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      label: node.textContent ?? "",
      minHeight: getComputedStyle(node).minHeight,
    };
  });
  console.log(`[card-export] measured: ${JSON.stringify(measured)}`);
  expect(measured.label, "the control's own words say what it does").toContain("导出角色卡");
  expect(measured.height, "the control clears the 44 px hit target").toBeGreaterThanOrEqual(44);

  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(download.suggestedFilename()).toBe("琥珀.json");
  const path = await download.path();
  expect(path, "the download completes").not.toBeNull();
  const saved = await readFile(path!, "utf8");
  // What landed is the Host's own bytes, not a browser re-serialization: the two
  // parse to the same card and the strings are byte-identical.
  expect(saved).toBe(CARD);
  expect(JSON.parse(saved).data.character_book.scan_depth).toBe(5);
  await expect(section.locator("[data-companion-card-export-notice]")).toHaveText("已保存 琥珀.json。");
});

test("a refused export states the fact it was refused for", async ({ page }) => {
  await stubCharacters(page, {
    companions: oneCompanion,
    onCard: async (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Card too large",
          status: 409,
          code: "companion_card_too_large",
          requestId: csrfToken,
          retryable: false,
        }),
      }),
  });
  const surface = await openCharacters(page);
  const section = surface.locator("[data-companion-card-export-section]");
  await section.locator("[data-companion-card-export]").click();
  await expect(section.locator("[data-companion-card-export-notice]")).toHaveText(
    "她的档案太大，放不进一张角色卡，因此没有导出。",
  );
});

test("a roster with no companion in play says there is nothing to export", async ({ page }) => {
  await stubCharacters(page, {
    companions: { apiVersion: 1, companions: [] },
    onCard: async (route) =>
      route.fulfill(jsonOk({ apiVersion: 1, spec: "chara_card_v3", fileName: "x.json", card: CARD })),
  });
  const surface = await openCharacters(page);
  const section = surface.locator("[data-companion-card-export-section]");
  await expect(section.locator("[data-companion-card-export-nothing]")).toHaveText("还没有可以导出的伙伴。");
  await expect(section.locator("[data-companion-card-export]")).toHaveCount(0);
});
