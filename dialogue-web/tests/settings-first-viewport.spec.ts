/**
 * Settings' first viewport: the control that resolves the surface's problem, and
 * the sentence that says there is one.
 *
 * Two defects were measured on this surface at 1440x900, and both are about what
 * a player meets before they have configured anything:
 *
 *  1. The connection form's save control - the only control that resolves the
 *     problem the page is about - sat at `y 884..928` against a window ending at
 *     899, so 16 of its 44 px were visible. Above it were a 78 px banner and the
 *     form's own fields, and one of them could have pushed it further down. That
 *     is a layout accident nobody notices until a field is added, which is why
 *     the assertion below is a rect check at the widest form the Host can
 *     publish rather than a snapshot of the copy that happens to fit today.
 *
 *  2. The "no connection selected" sentence was painted with `.warning-banner`
 *     whenever `active === null` - which is the ordinary new-player state, not a
 *     fault. Measured: a 637x78 px plate of `--warning` gold, the only saturated
 *     colour in the viewport. A warning plate on the normal first hour teaches a
 *     player that the product is broken before they have done anything.
 *
 * Both are asserted through what the browser computes, not through the class
 * names in the source: a control's rect is its rect, and a computed colour is
 * what the player sees.
 */
import { type Page, expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
    title: null,
    transcript: [],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const composedGame = {
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

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: composedChat,
  game: composedGame,
};

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/**
 * The Host's own escape hatch, verbatim from `host/src/tavern/provider-catalog.ts:213`.
 *
 * It is the widest form the panel can render - five setup fields, each one a
 * label, a control and its hint stacked above the save control - so it is the form
 * this surface's layout is measured against. Measuring the narrow operator entry
 * instead would prove nothing: two of the six field rows are what a future provider
 * is free to add again.
 *
 * A fresh open no longer lands on it (the panel opens on the entry that declares no
 * setup field at all, which is the entry a newcomer can actually use), so it is
 * chosen here through the picker - the way a player who has an endpoint of their own
 * reaches it. The premise the assertion needs is "the widest form", not "whatever
 * happens to be selected".
 */
const ESCAPE_HATCH = {
  providerId: "openai-compatible",
  label: "OpenAI-compatible endpoint",
  setupFields: ["baseUrl", "apiShape", "apiKey", "modelId", "apiKeyRequired"],
  allowedPlayerModels: [],
  escapeHatch: true,
  environmentManaged: false,
};

const OPERATOR = {
  providerId: "cpa-oai",
  label: "Operator gateway",
  setupFields: [],
  allowedPlayerModels: [
    {
      modelId: "deepseek-v4.1-flash",
      modelLabel: "DeepSeek V4.1 Flash",
      allowedThinkingLevels: ["low", "high"],
      defaultThinkingLevel: "high",
    },
  ],
  escapeHatch: false,
  environmentManaged: true,
};

/** Every route the composed shell and the Settings panels read. */
async function stubSettingsRoutes(page: Page, connections: readonly unknown[] = []): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 3, active: null, connections, providers: [ESCAPE_HATCH, OPERATOR] })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(json200({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({
        revision: 1,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(json200({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
}

/** Settings, at one viewport and one form, with its region scrolled to the top. */
async function mountSettings(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>,
  form: "widest" | "landing",
): Promise<void> {
  await page.setViewportSize(viewport);
  await stubSettingsRoutes(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  // The connection group renders only once its read resolves.
  await expect(surface.locator("#connection-provider")).toBeVisible();
  if (form === "widest") {
    // The widest form the Host can publish, chosen rather than assumed: the landing
    // selection is the entry with no field at all, so the fields under test only exist
    // once the escape hatch is picked.
    const connectionForm = surface.locator("[data-connection-form]");
    await connectionForm.locator("#connection-provider").selectOption(ESCAPE_HATCH.providerId);
    await expect(connectionForm.locator("#connection-api-key-required")).toBeVisible();
  }
  // The first viewport is the landing view, so the region's own scroll is reset
  // to its top rather than trusting whatever the browser restored.
  await surface.locator(".surface-content").evaluate((content) => {
    content.scrollTop = 0;
  });
}

/**
 * The surfaces whose primary save/submit control must be reachable where the
 * player lands, and the control that is primary on each.
 *
 * A table rather than a one-off selector because the defect is "a control below
 * the fold", not "the connection form is 65 px too tall": the next settings
 * surface that grows a primary save control enters here and is measured by the
 * same assertion without anybody remembering to write it.
 *
 * "Primary" is the control that resolves what the surface is about, not every
 * `<button type="submit">` on it. This surface also carries a save per model
 * profile, and those sit in their own sections further down a column that is
 * built to scroll (four field groups deep at 1440x900); moving them into the
 * first viewport would mean moving the connection form out of it. Measured at
 * 1440x900 with the widest connection form: "Save Chat" reads top 1635 and
 * "Save Game companion" top 1960 against a 900 px window - stated here so the
 * omission is a decision on the record rather than a selector that missed them.
 */
const PRIMARY_CONTROLS = [
  {
    surface: "Settings",
    control: "Save connection",
    selector: "[data-connection-form] button[type=submit]",
  },
] as const;

/**
 * Where each primary control lands, read in the window the player actually has.
 *
 * One reading for both viewports the describe below asserts: the rect is the rect, and a second copy
 * of this measurement in the 400 px test is a second place the selector could drift.
 */
async function readPrimaryControls(page: Page) {
  return await page.evaluate((controls) => {
    const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
    if (surface === null) throw new Error("the Settings surface is not mounted");
    const content = surface.querySelector<HTMLElement>(".surface-content");
    return controls.map((entry) => {
      const node = surface.querySelector<HTMLElement>(entry.selector);
      if (node === null) throw new Error(`${entry.surface} is missing its ${entry.control} control`);
      const rect = node.getBoundingClientRect();
      return {
        surface: entry.surface,
        control: entry.control,
        label: (node.textContent ?? "").trim(),
        enabled: !(node as HTMLButtonElement).disabled,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        viewportHeight: window.innerHeight,
        // The region's own scroll, so "inside the first viewport" cannot be a scrolled-to position.
        scrollerScrollTop: content === null ? null : content.scrollTop,
        // Whether the region scrolls at all: what a control below the fold still owes the player.
        scrollsIn: content !== null && content.scrollHeight > content.clientHeight,
        // The whole control, not a visible sliver: a control 16 of whose 44 px
        // are on screen is one the player cannot aim at.
        fullyInside: rect.top >= 0 && rect.bottom <= window.innerHeight,
      };
    });
  }, PRIMARY_CONTROLS);
}

test.describe("the primary save control of every settings surface is inside the first viewport", () => {
  test("at 1440x900, against the widest connection form the Host can publish", async ({ page }) => {
    await mountSettings(page, { width: 1440, height: 900 }, "widest");

    const readings = await readPrimaryControls(page);

    console.log(`[settings-first-viewport] ${JSON.stringify(readings)}`);

    for (const reading of readings) {
      expect(
        reading.fullyInside,
        `${reading.surface}: "${reading.control}" must be fully inside the 1440x900 window - ` +
          `it reads top ${reading.top}, bottom ${reading.bottom}, viewport height ${reading.viewportHeight}`,
      ).toBe(true);
      // The 44 px touch floor, asserted beside the fit: recovering space by
      // shrinking the control would satisfy the rect check and be the wrong fix.
      expect(reading.height, `${reading.surface}: "${reading.control}" keeps the 44 px touch floor`).toBeGreaterThanOrEqual(44);
    }
  });

  test("at 400x800 the widest form's control is below the fold, and that is stated rather than asserted away", async ({ page }) => {
    await mountSettings(page, { width: 400, height: 800 }, "widest");
    const reading = (await readPrimaryControls(page))[0]!;
    console.log(`[settings-first-viewport-400-widest] ${JSON.stringify(reading)}`);

    // A 400 px column cannot hold a six-row form and its save control at 800 px,
    // and pretending otherwise would mean shrinking controls or hiding fields.
    // What the narrow view owes is that the control is REACHABLE: the region
    // scrolls, and the control is inside the scrollable content rather than
    // clipped or overlaid. The landing view - the state a fresh player actually
    // meets - is asserted inside the window by the test below.
    expect(reading.bottom, "the widest form's save control sits below the 400x800 fold, as measured").toBeGreaterThan(
      reading.viewportHeight,
    );
    expect(reading.scrollsIn, "the region scrolls, so the control below the fold is reachable").toBe(true);
  });

  /**
   * The state a fresh player lands in: nothing chosen, so the form renders no field.
   *
   * This is the 400x800 reading that was missing. The widest form's control is 291 px below the fold
   * at this window (measured: top 1091 against 800), and the test above states that as a decision
   * about six stacked field rows rather than a defect. What nobody had measured is the viewport the
   * player is actually handed on a first open - where the same control must be inside the window
   * with the region at its top, because that is where they are being asked to bring a connection.
   */
  test("at 400x800, a fresh open hands the player its save control inside the window", async ({ page }) => {
    await mountSettings(page, { width: 400, height: 800 }, "landing");
    const readings = await readPrimaryControls(page);
    console.log(`[settings-first-viewport-400-landing] ${JSON.stringify(readings)}`);

    for (const reading of readings) {
      expect(reading.label, `${reading.surface}: the landing form's save control is the one measured`).toBe(
        "Save connection",
      );
      expect(reading.scrollerScrollTop, "the region is at its top when this is measured").toBe(0);
      expect(
        reading.fullyInside,
        `${reading.surface}: "${reading.control}" must be fully inside the 400x800 window on a fresh open - ` +
          `it reads top ${reading.top}, bottom ${reading.bottom}, viewport height ${reading.viewportHeight}`,
      ).toBe(true);
      expect(reading.height, `${reading.surface}: "${reading.control}" keeps the 44 px touch floor`).toBeGreaterThanOrEqual(
        44,
      );
    }
  });
});

/**
 * One saved connection that has been tested - the only state in which the row offers its own
 * next action, "Save and activate". `readiness: "ready"` is what the panel derives that from
 * (`management-panels.tsx:856`), so the control measured below is found by wearing `.primary`:
 * the row's own answer to "what do I press next", not a word hardcoded in one catalogue.
 */
const SAVED_MODEL_ID = "deepseek-v4.1-flash";
const SAVED_CONNECTION = {
  connectionId: "F".repeat(42) + "A",
  label: `DeepSeek · ${SAVED_MODEL_ID}`,
  providerId: "deepseek",
  providerLabel: "DeepSeek",
  configured: true,
  readiness: "ready",
  active: false,
  modelId: SAVED_MODEL_ID,
  modelLabel: "DeepSeek V4.1 Flash",
  thinkingLevel: "high",
  allowedThinkingLevels: ["low", "high"],
  modelIds: [SAVED_MODEL_ID, "deepseek-v4.1-pro"],
  baseUrl: null,
  failure: null,
  lastCheckedAtMs: null,
};

/** Settings with one saved connection, at one viewport, with its region scrolled to the top. */
async function mountSavedConnection(
  page: Page,
  viewport: Readonly<{ width: number; height: number }>,
): Promise<void> {
  await page.setViewportSize(viewport);
  await stubSettingsRoutes(page, [SAVED_CONNECTION]);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface.locator("[data-connection-row]")).toBeVisible();
  await surface.locator(".surface-content").evaluate((content) => {
    content.scrollTop = 0;
  });
}

/**
 * The saved row's own next action, and the strip it sits in.
 *
 * The defect this measures: the sheet turned `.connection-row .composer-actions` into a
 * column at <=560 px, stacking the row's two selects and three buttons on top of each other.
 * Measured on that sheet at 400x800 with the region at `scrollTop` 0 and a 682 px scroller,
 * the row's primary control - "Save and activate", the one control that resolves the row -
 * read `y 844, bottom 888` in a strip 310 px tall: 88 px below the window, in a strip the
 * row layout fits in 200 px.
 *
 * Read as a rect, not as a class: what the player meets is where the control lands.
 */
async function readSavedRowAction(page: Page) {
  return await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
    if (surface === null) throw new Error("the Settings surface is not mounted");
    const row = surface.querySelector<HTMLElement>("[data-connection-row]");
    if (row === null) throw new Error("the saved connection row is not rendered");
    const strip = row.querySelector<HTMLElement>(".composer-actions");
    if (strip === null) throw new Error("the saved connection row has no action strip");
    const control = strip.querySelector<HTMLButtonElement>("button.primary");
    if (control === null) throw new Error("the saved connection row points at no next action");
    const rect = control.getBoundingClientRect();
    const content = surface.querySelector<HTMLElement>(".surface-content");
    return {
      label: (control.textContent ?? "").trim(),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      viewportHeight: window.innerHeight,
      // The whole control, not a visible sliver: a control 16 of whose 44 px are on
      // screen is one the player cannot aim at.
      fullyInside: rect.top >= 0 && rect.bottom <= window.innerHeight,
      stripHeight: Math.round(strip.getBoundingClientRect().height),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      // The row layout must not buy the space by overflowing its own card sideways.
      stripOverflows: strip.scrollWidth > strip.clientWidth,
      scrollerClientHeight: content === null ? null : content.clientHeight,
      scrollerScrollTop: content === null ? null : content.scrollTop,
      scrollsIn: content !== null && content.scrollHeight > content.clientHeight,
    };
  });
}

test.describe("the saved connection row's own next action is inside the first viewport", () => {
  test("at 400x800, above the fold rather than 88 px below it", async ({ page }) => {
    await mountSavedConnection(page, { width: 400, height: 800 });
    const reading = await readSavedRowAction(page);
    console.log(`[settings-row-action-400] ${JSON.stringify(reading)}`);

    // The selector's own identity, read in the same run: `.primary` is the row's next
    // action, and the row's next action in this state is activation.
    expect(reading.label, "the row's next action is the activate control").toBe("Save and activate");
    // The first viewport, not a scrolled-to position.
    expect(reading.scrollerScrollTop, "the region is at its top when this is measured").toBe(0);
    expect(
      reading.fullyInside,
      'Settings: "Save and activate" must be fully inside the 400x800 window - ' +
        `it reads top ${reading.top}, bottom ${reading.bottom}, viewport height ${reading.viewportHeight}`,
    ).toBe(true);
    // The 44 px touch floor, asserted beside the fit: recovering space by shrinking the
    // control would satisfy the rect check and be the wrong fix.
    expect(reading.height, "the row's next action keeps the 44 px touch floor").toBeGreaterThanOrEqual(44);
    expect(reading.stripOverflows, "the row layout does not overflow its own card sideways").toBe(false);

    // The two labels taken out of the flow are what names the row's two selects: hiding them
    // must not cost either control its accessible name.
    const selects = page.getByTestId("settings-surface").locator("[data-connection-row] select");
    await expect(selects, "the row's two selects are both mounted").toHaveCount(2);
    await expect(selects.nth(0), "the served-model select is still named").toHaveAccessibleName("Model");
    await expect(
      selects.nth(1),
      "the thinking-level select is still named by the label that names its record",
    ).toHaveAccessibleName(`${SAVED_CONNECTION.label} thinking level`);
  });

  test("at 360x640 the same control is reachable by scrolling rather than inside the fold", async ({ page }) => {
    await mountSavedConnection(page, { width: 360, height: 640 });
    const reading = await readSavedRowAction(page);
    console.log(`[settings-row-action-360] ${JSON.stringify(reading)}`);

    expect(reading.label, "the row's next action is the activate control").toBe("Save and activate");
    // A 360x640 window is 160 px shorter than the one the row was fixed for, and the row's own
    // facts above the strip are most of that difference: measured after the fix, the control
    // reads top 755, bottom 799 against a 640 px window. That is a design question, not a
    // property of this sheet, so the assertion here is what the narrow view still owes: the
    // region scrolls, so the control below the fold is reachable rather than clipped.
    expect(reading.scrollsIn, "the region scrolls, so the control below the fold is reachable").toBe(true);
    expect(reading.scrollerScrollTop, "and it starts at its top").toBe(0);
  });
});

test.describe("nothing configured yet is not a fault", () => {
  test("the sentence that says so carries no warning or danger chrome", async ({ page }) => {
    await mountSettings(page, { width: 1440, height: 900 }, "widest");

    const reading = await page.evaluate(() => {
      const surface = document.querySelector<HTMLElement>('[data-testid="settings-surface"]');
      const node = surface?.querySelector<HTMLElement>("[data-connection-no-selection]") ?? null;
      if (node === null) throw new Error("the nothing-configured sentence is not rendered");
      // The tokens the two fault styles are built from, read off the document
      // rather than restated as literals: a palette retune moves both together.
      const root = getComputedStyle(document.documentElement);
      const token = (name: string): string => {
        const probe = document.createElement("span");
        probe.style.color = root.getPropertyValue(name).trim();
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      };
      const style = getComputedStyle(node);
      const classes = [...node.classList];
      const chromeClasses = classes.filter(
        (name) => name.endsWith("-banner") && ["warning-banner", "error-banner"].includes(name),
      );
      return {
        text: (node.textContent ?? "").slice(0, 80),
        classes,
        chromeClasses,
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderTopColor: style.borderTopColor,
        warningColor: token("--warning"),
        dangerColor: token("--danger"),
        proseColor: root.getPropertyValue("--text-secondary").trim(),
      };
    });

    console.log(`[settings-no-connection-chrome] ${JSON.stringify(reading)}`);

    expect(reading.chromeClasses, "the ordinary empty state renders no warning/error banner class").toEqual([]);
    // The computed colour, not only the class: a fault style could reach this
    // sentence through any selector, and what the player sees is the colour.
    expect(reading.color, "the sentence is not painted in --warning").not.toBe(reading.warningColor);
    expect(reading.color, "the sentence is not painted in --danger").not.toBe(reading.dangerColor);
    // The wash and the hairline are the other two carriers of a banner's colour.
    expect(reading.backgroundColor, "the sentence sits on no warning/danger wash").not.toContain("0.839216 0.658824");
    expect(reading.borderTopColor, "the sentence carries no warning/danger hairline").not.toBe(reading.warningColor);
    expect(reading.borderTopColor, "the sentence carries no danger hairline").not.toBe(reading.dangerColor);
  });
});
