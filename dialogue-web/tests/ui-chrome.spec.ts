/**
 * The chrome the platform will not give a dark theme for free.
 *
 * Reviewer audit, the CSS half: a native `<select>` on Windows is a white box
 * with the system's black arrow, a `<details>` keeps the browser's triangle, two
 * lists render as bare bulleted text under a 40 px native indent, the voice
 * status has no rules at all, and the two banner classes a bare `<p>` needs were
 * half missing. Each test here reads the *computed* style of the shipped shell -
 * a class name in the markup proves nothing about what the player sees, and a
 * rule that lost a layer-order fight looks exactly like a rule that was never
 * written.
 */
import { expect, test, type Page } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const chat = {
  apiVersion: 1,
  build: {
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.chat-core.reference-pipeline",
  },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira" },
    title: "Chrome",
    transcript: [],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const game = {
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
};

/** The additive v1 voice field lives on the envelope, not on the nested chat. */
function composed(voice: "unavailable" | "ready" | "speaking" | null = null) {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: voice === null ? chat : { ...chat, voice: { state: voice } },
    game,
  };
}

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mountChat(page: Page, voice: "unavailable" | "ready" | "speaking" | null = null): Promise<void> {
  const root = composed(voice);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

const worldBookHandle = `${"W".repeat(42)}A`;
const worldBookRevision = `${"B".repeat(42)}A`;
const importId = `${"I".repeat(42)}A`;

/**
 * The Characters surface: the panel the audit measured its five short controls
 * on, and the only panel that mounts both a `<details>` disclosure and the two
 * lists. Its world book is published with one entry so the list has a row to
 * render rather than an empty state.
 */
async function mountCharacters(page: Page): Promise<void> {
  const root = composed();
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Mira", isCurrent: true }] })),
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
    route.fulfill(
      jsonOk({
        state: "ready",
        revision: worldBookRevision,
        items: [
          {
            handle: worldBookHandle,
            title: "Pelican Town",
            summary: "A valley town, and the people in it.",
            selected: false,
            pending: false,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        entries: [
          {
            importId,
            cardName: "Mira Card",
            occurredAtMs: 1_700_000_000_000,
            counts: {
              accepted_typed: 3,
              preserved_opaque: 1,
              dropped_unsupported: 1,
              rejected_invalid: 0,
            },
          },
        ],
      }),
    ),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

/**
 * Item 1: the native `<select>`.
 *
 * The failure it catches: without `appearance: none` every select in the product
 * renders as the platform's own white box with a black system arrow in the
 * middle of the dark surface, and without the 44 px floor the fields around it
 * compute to 36 px. Both are asserted on the drawer's own controls, and the
 * floor on an input as well as on the select, because the audit found the floor
 * missing on the whole `.form-input` family.
 */
test("the model drawer's select is themed and the fields keep the 44px floor", async ({ page }) => {
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        recommendedModels: [
          {
            providerId: "cpa-oai",
            providerLabel: "CPA OAI",
            modelId: "deepseek-v4",
            modelLabel: "DeepSeek V4",
            allowedThinkingLevels: ["off", "medium", "high"],
            defaultThinkingLevel: "medium",
          },
        ],
      }),
    ),
  );

  await mountChat(page);
  await page.getByTestId("chat-model-trigger").click();
  const drawer = page.getByTestId("chat-model-drawer");
  await expect(drawer).toBeVisible();

  const measured = await drawer.evaluate((node) => {
    const read = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        appearance: style.appearance,
        height: Math.round(rect.height),
        backgroundImage: style.backgroundImage,
        colorScheme: style.colorScheme,
      };
    };
    const select = node.querySelector("select");
    const input = node.querySelector("input");
    return {
      select: select === null ? null : read(select),
      input: input === null ? null : read(input),
    };
  });

  // The platform's chrome is retired, and the arrow is drawn by the stylesheet.
  expect(measured.select?.appearance, "the select no longer renders the platform's own control").toBe("none");
  expect(measured.select?.backgroundImage, "the stylesheet draws the select's arrow").not.toBe("none");
  expect(measured.select?.colorScheme).toBe("dark");
  // The floor comes from the token, for the select and for the text field beside it.
  expect(measured.select?.height, "the select keeps the 44 px floor").toBeGreaterThanOrEqual(44);
  expect(measured.input?.height, "the input keeps the 44 px floor").toBeGreaterThanOrEqual(44);
});

/**
 * Item 1, second half: the floor the same stylesheet declares.
 *
 * The failure it catches: a padded field with a 14 px font computes to 36 px, so
 * `.form-input` and `.form-select` - and every control built on them - sat under
 * the `--touch-target-min` floor the product itself declares. The audit measured
 * five such controls on this surface; this asserts the family rather than the
 * five, and asserts that it measured something at all, so a surface that stopped
 * rendering its fields cannot pass by having nothing to measure.
 */
test("every field on the Characters surface clears the 44px floor", async ({ page }) => {
  await mountCharacters(page);

  const measured = await page.getByTestId("characters-surface").evaluate((node) =>
    [...node.querySelectorAll("input, select, textarea")]
      .filter((control) => (control as HTMLElement).getClientRects().length > 0)
      .map((control) => ({
        tag: control.tagName.toLowerCase(),
        label: control.getAttribute("aria-label") ?? control.getAttribute("type") ?? "",
        height: Math.round(control.getBoundingClientRect().height),
      })),
  );

  expect(measured.length, "the surface still renders fields to measure").toBeGreaterThan(0);
  expect(
    measured.filter((control) => control.height < 44),
    "controls under the 44 px floor",
  ).toEqual([]);
});

/**
 * Item 2: the disclosure.
 *
 * The failure it catches: without a rule of its own a `<details>` renders the
 * platform's triangle at the platform's indent, which is the same
 * black-on-dark accident the native select was, and the chevron inside the
 * summary never changes - so an open disclosure looks exactly like a closed one
 * to anyone who did not see the click. Both are asserted as computed style, and
 * the rotation is asserted by opening the element rather than by looking for a
 * rule.
 */
test("the paste disclosure retires the native marker and carries its open state", async ({ page }) => {
  await mountCharacters(page);

  const details = page.locator("details.custom-disclosure").first();
  const summary = details.locator("> summary");
  await expect(summary).toBeVisible();

  const closed = await summary.evaluate((node) => {
    const style = getComputedStyle(node);
    const chevron = node.querySelector("svg");
    return {
      listStyleType: style.listStyleType,
      display: style.display,
      height: Math.round(node.getBoundingClientRect().height),
      chevron: chevron === null ? null : getComputedStyle(chevron).transform,
    };
  });
  expect(closed.listStyleType, "the platform's marker is retired").toBe("none");
  expect(closed.display).toBe("flex");
  expect(closed.height, "the summary is a 44 px row").toBeGreaterThanOrEqual(44);
  expect(closed.chevron, "the summary carries the chevron").not.toBeNull();

  await summary.click();
  await expect(details).toHaveAttribute("open", "");
  const open = await summary.evaluate((node) => {
    const chevron = node.querySelector("svg");
    return chevron === null ? null : getComputedStyle(chevron).transform;
  });
  // The open state is rendered: the glyph is rotated, so a player who did not
  // see the click can still tell which way the disclosure went.
  expect(open).not.toBe(closed.chevron);
  expect(open).not.toBe("none");
});

/**
 * The Game diagnostics disclosure moved onto that shared treatment (it used to
 * state the same rules under its own class). Its own panel keeps its shape: the
 * summary still rotates its right-pointing chevron downwards when it opens.
 */
test("the Game diagnostics disclosure keeps its treatment on the shared rule", async ({ page }) => {
  await mountChat(page);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  const details = page.getByTestId("game-diagnostics-disclosure");
  const summary = details.locator("> summary");
  await expect(summary).toBeVisible();
  expect(await summary.evaluate((node) => getComputedStyle(node).listStyleType)).toBe("none");
  expect(await summary.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);

  const before = await page.getByTestId("game-diagnostics-disclosure").locator("> summary > svg").evaluate((node) => getComputedStyle(node).transform);
  await summary.click();
  const after = await page.getByTestId("game-diagnostics-disclosure").locator("> summary > svg").evaluate((node) => getComputedStyle(node).transform);
  expect(after).not.toBe(before);
  expect(after).not.toBe("none");
});
