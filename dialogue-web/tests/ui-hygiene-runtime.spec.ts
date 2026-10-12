/**
 * Gate 3: the mounted UI's runtime touch and colour floor.
 *
 * The static gates read source; this one reads the live cascade. A control can
 * pass every static rule and still be a 39 px target, and a `var(--x)` mistake
 * - or a class the layer order silently dropped - can leave the stop control or
 * the card-import trigger computing to a transparent background: invisible
 * rather than merely ugly. Nothing about "the stylesheet says 44" is checked
 * here; the browser's own computed values are.
 *
 * The touch floor (every button/input >= 44 px) is asserted below; its cause
 * was `.form-input` / `.form-select` in style.css having no `min-height`
 * (8 px padding + 14 px font = 36 px), which the CSS lane has now given the
 * `--touch-target-min` floor. The panels are exactly the ones the composed
 * suite already mounts: the chat surface (whose composer holds the stop
 * control) and the characters surface (whose card import holds the file
 * trigger).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const turnHandle = `${"T".repeat(42)}A`;
const worldBookRevision = `${"W".repeat(42)}A`;

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
    title: "Reference Game Chat",
    transcript: [],
    draft: { revision: 4, present: false },
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

/** A live turn whose cancel is offered: this is what renders the stop control. */
const runningRoot = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    ...chat,
    operations: [
      { operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" },
    ],
    chat: {
      ...chat.chat,
      turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
    },
  },
  game,
};

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mountBothPanels(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(runningRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(runningRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Mira", isCurrent: true }] })),
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
    route.fulfill(jsonOk({ state: "none", revision: worldBookRevision, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

/** The computed background, asserted opaque; the value is returned for the report. */
async function expectOpaque(locator: Locator, what: string): Promise<string> {
  const background = await locator.evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(["transparent", "rgba(0, 0, 0, 0)"], `${what} must not compute to a transparent background`).not.toContain(
    background,
  );
  return background;
}

/** Every laid-out button/input under the surface keeps the 44 px touch floor. */
async function measureTouchFloor(page: Page, testId: string): Promise<{ checked: number; short: string[] }> {
  const measured = await page.locator(`[data-testid="${testId}"] button, [data-testid="${testId}"] input`).evaluateAll(
    (nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          label: node.getAttribute("aria-label") ?? (node.textContent ?? "").trim().slice(0, 40),
          height: node.getBoundingClientRect().height,
        })),
  );
  const short = measured
    .filter((control) => control.height < 44)
    .map((control) => `${control.tag} "${control.label}" = ${Math.round(control.height)}px`);
  return { checked: measured.length, short };
}

test("gate 3: the stop control and the card-import trigger are not transparent", async ({ page }) => {
  await mountBothPanels(page);
  const checked: string[] = [];

  // The stop control is the destructive action: it must not have been left
  // transparent by a dropped declaration.
  const stop = page.getByTestId("chat-surface").getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  checked.push(`chat-surface stop control=${await expectOpaque(stop, "the stop control")}`);

  // The characters surface: the card-import file trigger is the primary path
  // into importing a companion card, so it is the second control pinned opaque.
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const trigger = page.getByTestId("characters-surface").locator("[data-card-import-file]");
  await expect(trigger).toBeVisible();
  checked.push(`characters-surface card-import trigger=${await expectOpaque(trigger, "the card-import trigger")}`);

  test.info().annotations.push({ type: "colour-floor", description: checked.join("; ") });
  console.log(`gate 3 colour floor: checked ${checked.length} anchors, all opaque - ${checked.join("; ")}`);
});

test("gate 3 (touch floor): mounted buttons and inputs clear the 44 px target", async ({ page }) => {
  await mountBothPanels(page);

  const chat = await measureTouchFloor(page, "chat-surface");
  expect(chat.short, 'controls under [data-testid="chat-surface"] below the 44 px floor').toEqual([]);

  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const characters = await measureTouchFloor(page, "characters-surface");
  expect(characters.short, 'controls under [data-testid="characters-surface"] below the 44 px floor').toEqual([]);

  const summary = `chat-surface ${chat.checked} control(s), characters-surface ${characters.checked} control(s); all >= 44px`;
  test.info().annotations.push({ type: "touch-floor", description: summary });
  console.log(`gate 3 touch floor: ${summary}`);
});

/**
 * Theme tokens that name a *surface*: a control may paint itself with one of
 * these, or leave its own background transparent so the themed surface behind it
 * shows through. Anything else that is opaque is the browser's own control face.
 */
const THEME_SURFACE_TOKENS = [
  "--surface-canvas",
  "--surface-panel",
  "--surface-card",
  "--surface-elevated",
  "--surface-raised",
  "--surface-hover",
  "--selection",
  "--accent",
  "--accent-solid",
  "--accent-solid-hover",
  "--success",
  "--warning",
  "--danger",
];

/**
 * Every laid-out interactive control under a surface, with its computed
 * background. A control is clean when its background is see-through (alpha < 1,
 * so the themed surface underneath is what the player sees) or exactly one of
 * the theme's own surface tokens. The defect this catches: the Chats row select
 * control carried a class that set no background at all, so the browser painted
 * its default near-white `ButtonFace` inside a dark card.
 */
async function controlSurfaceViolations(
  page: Page,
  testId: string,
): Promise<{ checked: number; foreign: string[] }> {
  const measured = await page
    .locator(`[data-testid="${testId}"] button, [data-testid="${testId}"] input, [data-testid="${testId}"] select, [data-testid="${testId}"] textarea`)
    .evaluateAll(
      (nodes, tokens) => {
        const probe = document.createElement("span");
        probe.style.display = "none";
        document.body.append(probe);
        const themed = new Set();
        for (const token of tokens) {
          if (getComputedStyle(document.documentElement).getPropertyValue(token).trim() === "") continue;
          probe.style.color = "";
          probe.style.color = `var(${token})`;
          themed.add(getComputedStyle(probe).color);
        }
        probe.remove();

        const rgba = (value) => {
          const match = /^rgba?\(([^)]+)\)$/u.exec(value);
          if (match === null) return null;
          const parts = match[1].split(",").map((part) => Number(part.trim()));
          return { alpha: parts.length === 3 ? 1 : parts[3] };
        };
        return nodes
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => {
            const background = getComputedStyle(node).backgroundColor;
            const parsed = rgba(background);
            return {
              tag: node.tagName.toLowerCase(),
              className: node.getAttribute("class") ?? "",
              label: node.getAttribute("aria-label") ?? (node.textContent ?? "").trim().slice(0, 30),
              background,
              // See-through: the themed surface behind the control is what shows.
              seeThrough: parsed === null || parsed.alpha < 1,
              themed: themed.has(background),
            };
          });
      },
      THEME_SURFACE_TOKENS,
    );
  const foreign = measured
    .filter((control) => !control.seeThrough && !control.themed)
    .map(
      (control) =>
        `${control.tag} "${control.label}" [${control.className}] background=${control.background} is not a theme surface token`,
    );
  return { checked: measured.length, foreign };
}

test("gate 3 (control surface): no control paints itself with the browser's own face", async ({ page }) => {
  await page.route("**/api/tavern/v1/chats*", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [{ handle, title: null, status: "active", managementRevision: 1, isSelected: true }],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: handle, memories: [], chapters: [] })),
  );
  await mountBothPanels(page);

  const summary: string[] = [];
  for (const [label, testId] of [
    ["Chats", "chats-surface"],
    ["Characters", "characters-surface"],
    ["Settings", "settings-surface"],
    ["Memory", "memory-surface"],
  ] as const) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByTestId(testId)).toBeVisible();
    const { checked, foreign } = await controlSurfaceViolations(page, testId);
    expect(foreign, `controls on ${testId} painted by a background that is not a theme surface token`).toEqual([]);
    summary.push(`${testId} ${checked} control(s)`);
  }

  test.info().annotations.push({ type: "control-surface", description: summary.join("; ") });
  console.log(`gate 3 control surface: ${summary.join("; ")}; all controls see-through or theme-token painted`);
});
