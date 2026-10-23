import { expect, test } from "@playwright/test";

/**
 * The character-card export controls, mounted.
 *
 * The deliverable is a FILE, and the browser is the surface that saves it: each
 * control asks the Host (`companion.card.export`) for one named form, and the bytes
 * the Host returns are what the browser writes to disk under the filename the Host
 * minted. These journeys prove the download actually happens and that what lands is
 * the Host's own payload - the JSON card's text, or the PNG card's whole file - not
 * a browser re-serialization, and measure each control's hit target, because a
 * control a finger cannot hit is not offered either.
 *
 * The refusals are asserted the same way: the Host's own bounded code reaches the
 * player as the sentence for that fact, so "her records are too large" and "she has
 * no picture for a PNG card" never read as "something failed".
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
/** A second, archived companion beside the one in play: the roster row a player inspects. */
const archivedHandle = "D".repeat(42) + "A";
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

/** The Host's own card text, so "what was saved" is compared against a known string. */
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

/**
 * The Host's own PNG card file, as the spec's own bytes.
 *
 * These are the bytes the Host's writer (`png-card-writer.ts`,
 * `writeCompanionCardPng`) produces for the `CARD` above over the same real 1x1
 * picture the other journeys use: signature, IHDR, one `chara` `tEXt` chunk
 * carrying that card as base64, the picture's own IDAT, IEND. The browser journey
 * both compares the saved file against them - so the download carried the Host's
 * payload rather than a re-encoding of it - and loads them as an image, so what
 * lands is proven to be a picture a real decoder accepts.
 */
const PNG_CARD_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAABinRFWHRjaGFyYQBleUp6Y0dWaklqb2lZMmhoY21GZlkyRnlaRjkyTXlJc0luTndaV05mZG1WeWMybHZiaUk2SWpNdU1DSXNJbVJoZEdFaU9uc2libUZ0WlNJNkl1ZVFwZWVQZ0NJc0luTmpaVzVoY21sdklqb2k1TDJnNUx1czVMaUE2TFczNVp5bzU2V1c2TDZJNTVXWjVMaUw1NXFFNVlhYzVaeTY2WWVNNWJ5QTVhZUw1cGF3NTVxRTU1U2Y1clM3NDRDQ0lpd2lZMmhoY21GamRHVnlYMkp2YjJzaU9uc2ljMk5oYmw5a1pYQjBhQ0k2TlN3aVpXNTBjbWxsY3lJNlczc2lZMjl0YldWdWRDSTZJdWE0cWVXdXBDSXNJbU52Ym5SbGJuUWlPaUxtdUtubHJxVG1tSy9scGJubGpydmx1YlRsaHF6bHBLbmt2NjdscGIzbm1vVGpnSUlpTENKclpYbHpJanBiSXVhNHFlV3VwQ0lzSXVlT3UrZVNnK2FJdnlKZGZWMTlmWDA9qq92rAAAAAxJREFUeJxj+M/AAAADAQEAyf6S7wAAAABJRU5ErkJggg==",
  "base64",
);

type CardFormat = "json" | "png";
type ExportResponse = (
  route: import("@playwright/test").Route,
  format: CardFormat,
  /** The companion handle the control addressed, read back from the exact path it sent. */
  handle: string,
) => Promise<void>;

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
  // The format and the companion are both named in the request, so the stub reads them
  // back from the exact request the control sent rather than assuming either. A
  // predicate on the path (not a glob) is what keeps the format query in view.
  await page.route(
    (url) => url.pathname.startsWith("/api/tavern/v1/companions/") && url.pathname.endsWith("/card"),
    (route) => {
      const url = new URL(route.request().url());
      const asked = url.pathname.split("/companions/")[1]!.split("/")[0]!;
      return options.onCard(route, url.searchParams.get("format") as CardFormat, asked);
    },
  );
  // The inspector's own read: the drawer the player opens beside this section.
  await page.route(
    (url) => url.pathname.startsWith("/api/tavern/v1/companions/") && url.pathname.endsWith("/profile"),
    (route) =>
      route.fulfill(
        jsonOk({
          apiVersion: 1,
          name: "A companion",
          revision: 1,
          persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
          scenario: { present: false, name: null, description: null },
          greetings: { present: false, label: null, variants: [] },
          worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
        }),
      ),
  );
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

test("the JSON control saves the Host's own card text and clears 44 px, and the request names its format", async ({
  page,
}) => {
  const requested: CardFormat[] = [];
  await stubCharacters(page, {
    companions: oneCompanion,
    onCard: async (route, format) => {
      requested.push(format);
      await route.fulfill(
        jsonOk({ apiVersion: 1, format: "json", spec: "chara_card_v3", fileName: "琥珀.json", card: CARD }),
      );
    },
  });
  const surface = await openCharacters(page);

  const section = surface.locator("[data-companion-card-export-section]");
  await expect(section).toBeVisible();
  await expect(section.locator("h3")).toHaveText("把她另存为角色卡");
  const button = section.locator("[data-companion-card-export-json]");
  await expect(button).toBeVisible();
  // Its accessible name says what it does, and says which form it saves.
  await expect(button).toHaveAttribute("aria-label", "导出 JSON 角色卡: 琥珀");

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
  expect(measured.label, "the control's own words say which form it saves").toContain("导出 JSON 角色卡");
  expect(measured.height, "the control clears the 44 px hit target").toBeGreaterThanOrEqual(44);

  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(download.suggestedFilename()).toBe("琥珀.json");
  const path = await download.path();
  expect(path, "the download completes").not.toBeNull();
  const saved = await import("node:fs/promises").then((fs) => fs.readFile(path!, "utf8"));
  // What landed is the Host's own bytes, not a browser re-serialization: the two
  // parse to the same card and the strings are byte-identical.
  expect(saved).toBe(CARD);
  expect(JSON.parse(saved).data.character_book.scan_depth).toBe(5);
  expect(requested, "the request names the form it wants").toEqual(["json"]);
  await expect(section.locator("[data-companion-card-export-notice]")).toHaveText("已保存 琥珀.json。");
});

test("the PNG control saves the Host's own card file, byte for byte, and names the PNG form", async ({ page }) => {
  const requested: CardFormat[] = [];
  await stubCharacters(page, {
    companions: oneCompanion,
    onCard: async (route, format) => {
      requested.push(format);
      await route.fulfill(
        jsonOk({
          apiVersion: 1,
          format: "png",
          spec: "chara_card_v3",
          fileName: "琥珀.png",
          cardFileBase64: PNG_CARD_BYTES.toString("base64"),
        }),
      );
    },
  });
  const surface = await openCharacters(page);
  const section = surface.locator("[data-companion-card-export-section]");
  const button = section.locator("[data-companion-card-export-png]");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-label", "导出 PNG 角色卡: 琥珀");
  const height = await button.evaluate((node) => Math.round(node.getBoundingClientRect().height));
  expect(height, "the control clears the 44 px hit target").toBeGreaterThanOrEqual(44);

  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(download.suggestedFilename()).toBe("琥珀.png");
  const path = await download.path();
  expect(path, "the download completes").not.toBeNull();
  const saved = await import("node:fs/promises").then((fs) => fs.readFile(path!));
  // The bytes are the Host's own card file: the base64 payload decoded, not a
  // different encoding of it.
  expect(Buffer.compare(saved, PNG_CARD_BYTES)).toBe(0);
  expect(Array.from(saved.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(requested, "the request names the PNG form").toEqual(["png"]);

  // A real decoder, not our own chunk walk: the bytes that landed on disk are
  // loaded back into this browser as an image. A card chunk framed wrong (a
  // length or CRC that does not match its bytes) is exactly what would stop an
  // image decoder here, and a card the player cannot open as a picture is not a
  // card. `naturalWidth` is the decoded pixel size, so it is 0 for bytes that
  // never decoded - a monogram, a broken file and a card with no image all fail.
  const decodedImage = await page.evaluate(async (bytes: number[]) => {
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    try {
      await image.decode();
    } catch {
      /* the natural size below is the assertion, not the absence of a throw */
    }
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, Array.from(saved));
  console.log(`[card-export] the saved PNG decoded in the browser: ${JSON.stringify(decodedImage)}`);
  expect(decodedImage, "the saved card file decodes as an image in the browser").toEqual({ width: 1, height: 1 });
  await expect(section.locator("[data-companion-card-export-notice]")).toHaveText("已保存 琥珀.png。");
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
  await section.locator("[data-companion-card-export-json]").click();
  await expect(section.locator("[data-companion-card-export-notice]")).toHaveText(
    "她的档案太大，放不进一张角色卡，因此没有导出。",
  );
});

test("a companion with no picture is refused the PNG form in her own sentence", async ({ page }) => {
  await stubCharacters(page, {
    companions: oneCompanion,
    onCard: async (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "No picture",
          status: 409,
          code: "companion_card_image_absent",
          requestId: csrfToken,
          retryable: false,
        }),
      }),
  });
  const surface = await openCharacters(page);
  const section = surface.locator("[data-companion-card-export-section]");
  await section.locator("[data-companion-card-export-png]").click();
  await expect(section.locator("[data-companion-card-export-notice]")).toHaveText(
    "她没有画像，无法生成 PNG 角色卡。请用 JSON 角色卡——它同样携带她的设定，只是没有画像。",
  );
});

test("a roster with no companion in play says there is nothing to export", async ({ page }) => {
  await stubCharacters(page, {
    companions: { apiVersion: 1, companions: [] },
    onCard: async (route) =>
      route.fulfill(jsonOk({ apiVersion: 1, format: "json", spec: "chara_card_v3", fileName: "x.json", card: CARD })),
  });
  const surface = await openCharacters(page);
  const section = surface.locator("[data-companion-card-export-section]");
  await expect(section.locator("[data-companion-card-export-nothing]")).toHaveText("还没有可以导出的伙伴。");
  await expect(section.locator("[data-companion-card-export-json]")).toHaveCount(0);
  await expect(section.locator("[data-companion-card-export-png]")).toHaveCount(0);
});

/**
 * The card this control saves is the companion the player was reading, not the one
 * in play.
 *
 * The roster holds two companions: the one the run is playing and an archived one.
 * The player opens the archived companion's inspector, reads her, closes it, and
 * presses export. The request must name HER handle, and the file that lands must be
 * the card the Host built from HER records - so the stub answers per companion and
 * the assertion is on the saved file's own `data.name`. If the control reverted to
 * the companion in play, both the request and the name in the file would be the
 * other companion's, which is exactly the defect this journey exists for.
 */
test("the card export saves the companion the player inspected, not the one in play", async ({ page }) => {
  const names: Readonly<Record<string, string>> = { [handle]: "琥珀", [archivedHandle]: "米拉" };
  const requested: string[] = [];
  await stubCharacters(page, {
    companions: {
      apiVersion: 1,
      companions: [
        { handle, name: "琥珀", isCurrent: true },
        { handle: archivedHandle, name: "米拉", isCurrent: false },
      ],
    },
    onCard: async (route, format, asked) => {
      requested.push(`${asked}:${format}`);
      await route.fulfill(
        jsonOk({
          apiVersion: 1,
          format: "json",
          spec: "chara_card_v3",
          fileName: `${names[asked]}.json`,
          card: JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { name: names[asked] } }),
        }),
      );
    },
  });
  const surface = await openCharacters(page);

  // Before anything is inspected, the control names the companion in play.
  const section = surface.locator("[data-companion-card-export-section]");
  const json = section.locator("[data-companion-card-export-json]");
  await expect(json).toHaveAttribute("aria-label", "导出 JSON 角色卡: 琥珀");

  // Open the archived companion's inspector and read her.
  await surface.locator('[data-companion-entry] [data-companion-inspect][aria-label*="米拉"]').click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { level: 2 })).toHaveText("米拉");
  // The drawer owns the surface while it is open, so the player closes it to reach
  // the control below - and the control still names her, not the companion in play.
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(json).toHaveAttribute("aria-label", "导出 JSON 角色卡: 米拉");

  const [download] = await Promise.all([page.waitForEvent("download"), json.click()]);
  expect(download.suggestedFilename()).toBe("米拉.json");
  const path = await download.path();
  expect(path, "the download completes").not.toBeNull();
  const saved = await import("node:fs/promises").then((fs) => fs.readFile(path!, "utf8"));
  expect(JSON.parse(saved).data.name, "the saved card is the companion the player was reading").toBe("米拉");
  expect(requested, "the request names the companion the player was reading").toEqual([`${archivedHandle}:json`]);
});
