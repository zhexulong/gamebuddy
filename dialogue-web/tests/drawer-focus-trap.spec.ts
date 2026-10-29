import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * A modal drawer keeps the keyboard inside it, including past its last control.
 *
 * `ContextDrawer` is the shell's one drawer primitive and it owns the trap, so this
 * journey exercises it through the product's drawers - the companion inspector, for a
 * companion provisioned without authored groups (three controls and no disclosure) and
 * for one carrying all four (disclosures are stops too) - rather than through a
 * re-implementation of the trap's own list.
 *
 * The measured defect, before the fix: the trap's stops were
 *
 *   a[href],
 *   button:not([disabled]),
 *   input:not([disabled]),
 *   select:not([disabled]),
 *   textarea:not([disabled]),
 *   [tabindex]:not([tabindex="-1"])
 *
 * filtered on `offsetParent !== null || element === document.activeElement`.
 *
 * That predicate disagrees with the browser in two ways, and both let focus out of a
 * drawer through its last real control:
 *
 *  - the avatar section renders the browser's real file picker (`input[type="file"]`,
 *    hidden by `clip-path: inset(50%)`, out of the tab order by `tabIndex={-1}`), which
 *    the list matches - an `input`, not `disabled`, and still laid out - so the trap
 *    counted it as a stop the player can never land on;
 *  - a `<summary>` inside a CLOSED `<details>` keeps an `offsetParent` and a client
 *    rect while the browser refuses to focus it, so the trap counted an unreachable
 *    disclosure as a stop as well.
 *
 * In each case the trap believed its cycle ended one element past the last control a
 * player can reach, never matched `last`, did not intercept, and the browser moved focus
 * to the page behind the backdrop: one Tab from inside an `aria-modal="true"` dialog to
 * a control outside it.
 *
 * What this file reads is `document.activeElement` after each real key press: the
 * browser's own answer to "what is the next tab stop". A trap that disagrees with the
 * browser is the defect, so the browser is the oracle here and the trap's selector is
 * not copied.
 */

const token = "A".repeat(43);
const rosterHandle = "B".repeat(42) + "A";
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
    selection: { chatHandle: rosterHandle, generation: 1, stateRevision: rosterHandle },
    chat: {
      companion: { name: "Mira", handle: rosterHandle },
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
 * One stop of the keyboard walk. `key` identifies the ELEMENT (minted the first time it
 * is reached), so four `<summary>` disclosures that all read `summary.(no class)` are
 * still told apart, and a revisit is recognisable as the same stop rather than as "a
 * stop with the same tag".
 */
type Stop = Readonly<{ key: string; inside: boolean; name: string; hidden: boolean }>;

/** Runs in the page: where focus is now, with the hidden picker called out by name. */
const readStop = (): Stop => {
  const active = document.activeElement as HTMLElement | null;
  if (active === null || active === document.body || active === document.documentElement)
    return { key: "page", inside: false, name: "(page)", hidden: false };
  let key = active.getAttribute("data-trap-walk-key");
  if (key === null) {
    key = `stop-${document.querySelectorAll("[data-trap-walk-key]").length}`;
    active.setAttribute("data-trap-walk-key", key);
  }
  const marker =
    ["data-companion-avatar-choose", "data-companion-avatar-file", "data-companion-removal-arm"].find((attribute) =>
      active.hasAttribute(attribute),
    ) ?? null;
  return {
    key,
    inside: active.closest('[data-testid="companion-inspector"]') !== null,
    name:
      marker ??
      active.getAttribute("aria-label") ??
      `${active.tagName.toLowerCase()}.${active.className || "(no class)"}`,
    hidden: active.hasAttribute("data-companion-avatar-file"),
  };
};

async function mount(page: Page): Promise<{ uploads: unknown[] }> {
  const uploads: unknown[] = [];
  let stored: Buffer | null = null;
  let digest = "";

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: rosterHandle, name: "Mira", isCurrent: false }] })),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
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
    route.fulfill(jsonOk({ state: "none", revision: rosterHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.route(`**/api/tavern/v1/companions/${rosterHandle}/avatar`, (route) => {
    const body = route.request().postDataJSON() as { avatarBase64: string };
    uploads.push(body);
    stored = Buffer.from(body.avatarBase64, "base64");
    digest = createHash("sha256").update(stored).digest("hex");
    return route.fulfill(jsonOk({ apiVersion: 1, handle: rosterHandle, digest }));
  });
  await page.route("**/assets/companions/*/avatar.png", (route) => {
    if (stored === null) return route.fulfill({ status: 404, headers: { "cache-control": "no-store" }, body: "" });
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-cache", etag: `"${digest}"` },
      body: stored,
    });
  });
  return { uploads };
}

/** A companion made without any authored group: the drawer's own three controls, no disclosure. */
async function stubBareProfile(page: Page): Promise<void> {
  await page.route("**/api/tavern/v1/companions/*/profile", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        name: "Mira",
        revision: 1,
        persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
        scenario: { present: false, name: null, description: null },
        greetings: { present: false, label: null, variants: [] },
        worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
      }),
    ),
  );
}

/** A companion carrying all four groups, so disclosures are part of the drawer's cycle. */
async function stubFullProfile(page: Page): Promise<void> {
  await page.route("**/api/tavern/v1/companions/*/profile", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        name: "Mira",
        revision: 1,
        persona: { present: true, core: "Keeps the ledgers.", interactionStyle: null, expressionStyle: null },
        scenario: { present: true, name: "Winter on the ridge", description: "The pass closes in November." },
        greetings: { present: true, label: "The porch", variants: [{ label: "Default", text: "You are late." }] },
        worldBook: {
          apiVersion: 1,
          present: true,
          revision: 3,
          entries: [{ title: "The pact", keys: [], constant: true, content: "They split the ridge." }],
        },
      }),
    ),
  );
}

/** One real PNG, encoded by the browser's own encoder. */
async function pictureOf(page: Page): Promise<Buffer> {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    context.fillStyle = "#a2445c";
    context.fillRect(0, 0, 2, 2);
    return canvas.toDataURL("image/png").split(",", 2)[1] ?? "";
  });
  return Buffer.from(encoded, "base64");
}

async function openDrawer(page: Page) {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), "en");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  await surface.locator('[data-companion-entry] [data-companion-inspect][aria-label*="Mira"]').click();
  const drawer = page.getByTestId("companion-inspector");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".loading-text")).toHaveCount(0);
  return drawer;
}

/**
 * Presses Tab (or Shift+Tab) from where focus is and walks until a stop repeats; returns
 * the stops of that cycle, with the repeating press excluded.
 *
 * The walk does not assume the currently focused element is a stop of the cycle: the
 * drawer moves focus to its `tabindex="-1"` heading on open, which is a place focus
 * LANDS and not a stop a player can return to. The cycle is therefore defined by its
 * first REPEAT, and an escape ends the walk at the outside element instead of running to
 * the bound - so a failure names where focus went rather than "the cycle never closed".
 */
async function walkOneCycle(page: Page, shift = false, bound = 24): Promise<{ stops: Stop[]; closed: boolean }> {
  const stops: Stop[] = [];
  for (let press = 0; press < bound; press += 1) {
    await page.keyboard.press(shift ? "Shift+Tab" : "Tab");
    const stop = await page.evaluate(readStop);
    const seen = stops.findIndex((previous) => previous.key === stop.key);
    if (seen >= 0) return { stops: stops.slice(seen), closed: true };
    stops.push(stop);
    if (!stop.inside) return { stops, closed: false };
  }
  throw new Error(`the drawer's cycle did not close within ${bound} presses: ${names(stops)}`);
}

/** The walk in a failure message: every stop, in the order the browser took them. */
function names(stops: readonly Stop[]): string {
  return JSON.stringify(stops.map((stop) => (stop.hidden ? `[hidden] ${stop.name}` : stop.name)));
}

test("Tab from the drawer's last control wraps to its first, and never lands on the hidden picker", async ({ page }) => {
  await mount(page);
  await stubBareProfile(page);
  const drawer = await openDrawer(page);

  // The picker is out of the tab order by attribute and reachable only programmatically
  // (the trigger beside it calls `.click()` on it), which is the premise of the defect.
  await expect(drawer.locator("[data-companion-avatar-file]")).toHaveAttribute("tabindex", "-1");
  await expect(drawer.locator("#companion-inspector-title")).toBeFocused();

  const forward = await walkOneCycle(page);
  const cycle = forward.stops;

  expect(forward.closed, `the walk left the drawer: ${names(cycle)}`).toBe(true);
  expect(cycle.filter((stop) => !stop.inside), `no Tab leaves the modal drawer: ${names(cycle)}`).toEqual([]);
  expect(cycle.filter((stop) => stop.hidden), `the hidden picker is never one of its stops: ${names(cycle)}`).toEqual([]);
  // Three controls a player can reach: close, remove her, give her a picture. The heading
  // is where focus LANDS on open (it carries `tabindex="-1"`), not a stop of the cycle.
  expect(cycle.map((stop) => stop.name)).toEqual(["Close", "data-companion-removal-arm", "data-companion-avatar-choose"]);
  // Shift+Tab walks the same stops backwards: from the first stop it wraps to the last,
  // and never reaches the picker or the page behind the backdrop.
  const backward = await walkOneCycle(page, true);
  expect(backward.closed, `the backward walk left the drawer: ${names(backward.stops)}`).toBe(true);
  expect(backward.stops.filter((stop) => !stop.inside), `no Shift+Tab leaves the modal drawer: ${names(backward.stops)}`).toEqual(
    [],
  );
  expect(
    backward.stops.filter((stop) => stop.hidden),
    `Shift+Tab never lands on the hidden picker: ${names(backward.stops)}`,
  ).toEqual([]);
  expect(
    backward.stops.map((stop) => stop.key),
    "Shift+Tab from the first stop wraps to the last control, then walks the cycle backwards",
  ).toEqual([...cycle].reverse().map((stop) => stop.key));
});

/**
 * The same invariant when the drawer's last real stop is not the picture control: this
 * stub answers with all four authored groups, so the drawer's cycle runs through four
 * `<summary>` disclosures and ends on one of them.
 */
test("the wrap holds when the drawer's last stop is a disclosure", async ({ page }) => {
  await mount(page);
  await stubFullProfile(page);
  const drawer = await openDrawer(page);
  await expect(drawer.locator("[data-companion-inspector-world-book-disclosure]")).toHaveCount(1);

  const forward = await walkOneCycle(page);
  expect(forward.closed, `the walk left the drawer: ${names(forward.stops)}`).toBe(true);
  expect(forward.stops.filter((stop) => !stop.inside), `no Tab leaves the modal drawer: ${names(forward.stops)}`).toEqual([]);
  expect(
    forward.stops.filter((stop) => stop.hidden),
    `the hidden picker is never one of its stops: ${names(forward.stops)}`,
  ).toEqual([]);
  expect(forward.stops.length, `the drawer's disclosures are part of the cycle: ${names(forward.stops)}`).toBeGreaterThan(4);

  const backward = await walkOneCycle(page, true);
  expect(backward.closed, `the backward walk left the drawer: ${names(backward.stops)}`).toBe(true);
  expect(
    backward.stops.map((stop) => stop.key),
    "Shift+Tab walks the same stops backwards",
  ).toEqual([...forward.stops].reverse().map((stop) => stop.key));
});

/**
 * The fix must not move the avatar feature: the hidden input stays out of the tab order,
 * and the visible trigger still opens the browser's real picker and the upload completes.
 * `filechooser` fires only for a real click on the input, so this proves the programmatic
 * path rather than setting files on a control nothing can reach.
 *
 * NOTE, measured and deliberately NOT fixed here: while the upload is in flight the
 * trigger is `disabled={busy}`, and disabling the focused control drops focus to `<body>`
 * - so after an upload a keyboard player is outside the drawer with no stop to press
 * (`[probe] focusout from trigger, fromDisabled true, to null`). That is the avatar
 * feature's own busy-state behaviour, not the trap's stop list, and changing it is a
 * decision about that feature rather than about this defect.
 */
test("the picture control still opens the picker and the upload completes", async ({ page }) => {
  const host = await mount(page);
  await stubBareProfile(page);
  const drawer = await openDrawer(page);
  const trigger = drawer.locator("[data-companion-avatar-choose]");

  // Reached by keyboard, as a player would, from the focus the drawer takes on open. Its
  // heading is `tabindex="-1"`, so the first press lands on the close control.
  await page.keyboard.press("Tab"); // the close control
  await page.keyboard.press("Tab"); // the removal control
  await page.keyboard.press("Tab"); // the picture control
  await expect(trigger).toBeFocused();

  const chooser = page.waitForEvent("filechooser", { timeout: 8000 });
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "mira.png", mimeType: "image/png", buffer: await pictureOf(page) });

  await expect(drawer.locator("[data-companion-avatar-notice]")).toHaveText("She has this picture now.");
  expect(host.uploads.length, "the upload reached the Host").toBe(1);
  await expect
    .poll(async () => drawer.locator(".avatar-image").evaluate((node) => (node as HTMLImageElement).naturalWidth))
    .toBe(2);

  // The picker is still out of the tab order after the re-render, and the drawer's cycle
  // is still the three controls a player can reach. Focus is brought back inside the way a
  // player would - by pointing at the drawer - because the upload's own busy state drops
  // it to `<body>` (measured: `focusout` from the trigger with `disabled === true`); that
  // drop is the avatar section's busy-state behaviour, not this trap, and it is reported
  // rather than changed here.
  await expect(drawer.locator("[data-companion-avatar-file]")).toHaveAttribute("tabindex", "-1");
  await drawer.locator(".drawer-header h2").click();
  const cycle = await walkOneCycle(page);
  expect(cycle.closed, `the drawer's cycle closes after an upload: ${names(cycle.stops)}`).toBe(true);
  expect(
    cycle.stops.filter((stop) => !stop.inside || stop.hidden),
    `the cycle stays inside the drawer: ${names(cycle.stops)}`,
  ).toEqual([]);
});
