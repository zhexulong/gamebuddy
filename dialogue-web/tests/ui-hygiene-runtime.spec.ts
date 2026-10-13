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

/**
 * Every laid-out button/input under the surface keeps the 44 px touch floor. A
 * control the sheet has taken out of the visual flow (`clip-path: inset(50%)`)
 * is not a target at all: the themed trigger that drives it is, and it is
 * measured here instead.
 */
async function measureTouchFloor(page: Page, testId: string): Promise<{ checked: number; clipped: number; short: string[] }> {
  const measured = await page.locator(`[data-testid="${testId}"] button, [data-testid="${testId}"] input`).evaluateAll(
    (nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 0)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          label: node.getAttribute("aria-label") ?? (node.textContent ?? "").trim().slice(0, 40),
          height: node.getBoundingClientRect().height,
          clipped: getComputedStyle(node).clipPath === "inset(50%)",
        })),
  );
  const targets = measured.filter((control) => !control.clipped);
  const short = targets
    .filter((control) => control.height < 44)
    .map((control) => `${control.tag} "${control.label}" = ${Math.round(control.height)}px`);
  return { checked: targets.length, clipped: measured.length - targets.length, short };
}

test("gate 3: the stop control and the card-import trigger are not transparent", async ({ page }) => {
  await mountBothPanels(page);
  const checked: string[] = [];

  // The stop control is the destructive action: it must not have been left
  // transparent by a dropped declaration.
  const stop = page.getByTestId("chat-surface").getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  checked.push(`chat-surface stop control=${await expectOpaque(stop, "the stop control")}`);

  // The characters surface: the card-import trigger is the primary path into
  // importing a companion card, so it is the second control pinned opaque. It is
  // the themed trigger, not the file input behind it: the input is taken out of
  // the visual flow (gate 1.1 of `component-hygiene-gate.test.mjs`), and it was
  // the platform's own white "Choose file" face that this anchors.
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const trigger = page.getByTestId("characters-surface").locator("[data-card-import-trigger]");
  await expect(trigger).toBeVisible();
  checked.push(`characters-surface card-import trigger=${await expectOpaque(trigger, "the card-import trigger")}`);

  test.info().annotations.push({ type: "colour-floor", description: checked.join("; ") });
  console.log(`gate 3 colour floor: checked ${checked.length} anchors, all opaque - ${checked.join("; ")}`);
});

test("gate 3 (file control): the card-import input is out of the visual flow, and its trigger is the control the player gets", async ({
  page,
}) => {
  // The audit's `10-角色-1440x900.png`: a bare `<input type="file">` painted the
  // platform's own white "Choose file" face in the middle of the tavern surface.
  // The pair is what is measured here on the real mount - the input taken out of
  // the visual flow, and the themed trigger that is the control the player sees.
  await mountBothPanels(page);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();

  const measured = await page.getByTestId("characters-surface").evaluate((surface) => {
    const input = surface.querySelector<HTMLElement>('[data-card-import-file]');
    const trigger = surface.querySelector<HTMLElement>("[data-card-import-trigger]");
    if (input === null || trigger === null) throw new Error("the card-import control pair is not rendered");
    const inputBox = input.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    return {
      input: {
        clipPath: getComputedStyle(input).clipPath,
        width: Math.round(inputBox.width),
        height: Math.round(inputBox.height),
        tabIndex: input.tabIndex,
      },
      trigger: {
        tag: trigger.tagName.toLowerCase(),
        background: getComputedStyle(trigger).backgroundColor,
        width: Math.round(triggerBox.width),
        height: Math.round(triggerBox.height),
      },
    };
  });
  console.log(`gate 3 file control: ${JSON.stringify(measured)}`);

  expect(measured.input.clipPath, "the native file control is out of the visual flow, not merely styled").toBe(
    "inset(50%)",
  );
  expect(measured.input.width, "nothing of the platform's file widget is laid out").toBeLessThanOrEqual(1);
  expect(measured.input.tabIndex, "the hidden input is not a tab stop").toBe(-1);
  expect(measured.trigger.tag, "the player's control is the product's own button").toBe("button");
  expect(
    ["transparent", "rgba(0, 0, 0, 0)"],
    "the trigger is not left to the browser's control face",
  ).not.toContain(measured.trigger.background);
  expect(measured.trigger.height, "the trigger keeps the 44 px touch floor").toBeGreaterThanOrEqual(44);
  expect(measured.trigger.width, "the trigger keeps the 44 px touch floor").toBeGreaterThanOrEqual(44);
});

test("gate 3 (touch floor): mounted buttons and inputs clear the 44 px target", async ({ page }) => {
  await mountBothPanels(page);

  const chat = await measureTouchFloor(page, "chat-surface");
  expect(chat.short, 'controls under [data-testid="chat-surface"] below the 44 px floor').toEqual([]);

  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const characters = await measureTouchFloor(page, "characters-surface");
  expect(characters.short, 'controls under [data-testid="characters-surface"] below the 44 px floor').toEqual([]);

  const summary = `chat-surface ${chat.checked} control(s) (${chat.clipped} out of the visual flow), characters-surface ${characters.checked} control(s) (${characters.clipped} out of the visual flow); all >= 44px`;
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

/**
 * Gate 3 (chat row reading): the Chats row's own select control keeps a real
 * contrast ratio against the card it is painted on, at both the narrow and the
 * wide layout.
 *
 * The measured defect (commit `ca7db343`): the control carried
 * `chat-item-title chat-item-select`, and `chat-item-select` had no rule at all -
 * so Chromium painted its own near-white `ButtonFace` (rgb(240, 240, 240)) under
 * `--text-primary` (`#f5f0e8`), a ratio of 1.005:1. The surface read as an
 * invisible button. The control-surface gate above catches the *class* whose
 * background is foreign; this catches the *reading*, which a future class that
 * paints a themed-but-too-similar surface would pass.
 */
test("gate 3 (chat row reading): the Chats row select control stays legible at both widths", async ({ page }) => {
  await page.route("**/api/tavern/v1/chats*", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [{ handle, title: "A named conversation", status: "active", managementRevision: 1, isSelected: true }],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: handle, memories: [], chapters: [] })),
  );

  const readings: string[] = [];
  const failures: string[] = [];
  for (const width of [400, 1280] as const) {
    await page.setViewportSize({ width, height: 800 });
    // The surface is the URL's own fact, so the panel is opened by the route
    // rather than by a click an app-bar fold could hide at 400 px.
    await mountBothPanels(page);
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.slice(1));
      params.set("panel", "chats");
      window.history.replaceState({ gbPanel: "chats" }, "", `${url.pathname}${url.search}#${params.toString()}`);
    });
    await page.reload();
    await expect(page.getByTestId("chats-surface")).toBeVisible();
    // The row exists once the panel's own list read has landed; the surface
    // frame alone can be on screen before its list is.
    await expect(page.getByTestId("chat-select")).toBeVisible();

    const reading = await page.evaluate(() => {
      const node = document.querySelector('[data-testid="chat-select"]');
      if (node === null) return null;
      const parse = (value: string): number[] | null => {
        const match = /^rgba?\(([^)]+)\)$/u.exec(value);
        if (match === null) return null;
        const parts = match[1].split(",").map((part) => Number(part.trim()));
        return parts.length === 3 ? [...parts, 1] : parts;
      };
      const opaqueOver = (front: number[], behind: number[]): number[] =>
        front[3]! >= 1 ? front.slice(0, 3) : [0, 1, 2].map((index) => front[index]! * front[3]! + behind[index]! * (1 - front[3]!));
      // The card behind the control: the first ancestor painting anything at all.
      let behind: number[] | null = null;
      for (let element: Element | null = node; element !== null; element = element.parentElement) {
        const parsed = parse(getComputedStyle(element).backgroundColor);
        if (parsed !== null && parsed[3]! > 0) {
          behind = parsed[3]! >= 1 ? parsed.slice(0, 3) : opaqueOver(parsed, [255, 255, 255]);
          break;
        }
      }
      const fallback = [255, 255, 255];
      const background = behind ?? fallback;
      const foreground = opaqueOver(parse(getComputedStyle(node).color)!, background);
      const luminance = (rgb: number[]): number => {
        const channel = (value: number): number => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
      };
      const first = luminance(foreground);
      const second = luminance(background);
      return {
        className: node.getAttribute("class") ?? "",
        color: getComputedStyle(node).color,
        background: `rgb(${background.map((value) => Math.round(value)).join(", ")})`,
        ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      };
    });

    if (reading === null) {
      failures.push(`${width}px: the Chats row select control is not rendered`);
      continue;
    }
    readings.push(`${width}px ${reading.className} ${reading.color} on ${reading.background} = ${reading.ratio.toFixed(2)}:1`);
    if (reading.ratio < 4.5) {
      failures.push(`${width}px: the Chats row select control reads ${reading.ratio.toFixed(2)}:1`);
    }
  }

  test.info().annotations.push({ type: "chat-row-contrast", description: readings.join("; ") });
  console.log(`gate 3 chat row reading: ${readings.join("; ")}`);
  expect(failures, "the Chats row's own select control must stay legible against its card").toEqual([]);
});
