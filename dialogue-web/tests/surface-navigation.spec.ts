/**
 * Moving between the shell's peer surfaces: the AppBar entry, the URL, and the locale.
 *
 * The Game entry selects the surface and names it in the URL, Back returns to the conversation
 * without dropping the draft, a refresh restores the selected surface and puts focus inside
 * it, and the Game surface reads in the player's own language with no English chrome left
 * behind.
 */
import { expect, test } from "./frontend-coverage";
import { token, draft, root } from "./composed-reference-game-fixtures";

/**
 * The single contextual panel itself (design/26 §4.2, §7.2; design/104 §2):
 * the AppBar entry opens it, the URL names it while it is open, Browser Back
 * closes it before it leaves the chat, and a refresh restores it.
 */
test("the AppBar Game entry selects the Game surface, the URL names it, and Back returns to the conversation without dropping the draft", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  // Returning to the conversation re-reads the composed root, which is this fixture's own
  // projection: the shell reads on arrival rather than trusting what it happened to hold.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // Closed until a player selects it: the Game surface is a peer of the
  // conversation, never an inline technical status block (design/104 §2).
  await expect(page.getByTestId("game-state-panel")).toHaveCount(0);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  const entry = page.getByRole("button", { name: "Game", exact: true });
  await expect(entry).toBeVisible();

  await entry.click();
  const surface = page.getByTestId("game-surface");
  await expect(surface).toBeVisible();
  // A peer surface, not a modal overlay: it takes the main region, it is a named
  // region rather than a dialog, and nothing dims or covers the shell. `region` is
  // the implicit role of the surface's named `<section>` (`SurfaceView`), which is
  // what names it for assistive technology alongside its heading - so the assertion
  // is the role rather than a `role` attribute (removed as redundant by `0f6b09ec`,
  // and `eslint.config.mjs` relies on the same implicit role).
  await expect(surface).toHaveRole("region");
  await expect(surface).toHaveAccessibleName("Game");
  await expect(page.locator("[aria-modal='true']")).toHaveCount(0);
  await expect(page.locator(".composed-drawer-backdrop")).toHaveCount(0);
  // The panel keeps its frozen anchors inside the surface.
  const panel = page.getByTestId("game-state-panel");
  await expect(panel).toHaveAttribute("data-game-state", "available");
  await expect(page.getByRole("region", { name: "Game state" })).toBeVisible();
  // Selecting names the surface in the URL and moves focus into it.
  await expect(page).toHaveURL(/#profile=composed-reference-game&panel=game$/);
  await expect(surface.getByRole("heading", { name: "Game", exact: true })).toBeFocused();
  // A player reads localized outcomes, never a raw Host enum (design/104 §10).
  const panelText = await panel.innerText();
  expect(panelText).not.toContain("connected_idle");
  expect(panelText).not.toContain("unchecked");
  expect(panelText).not.toContain("not_configured");

  // Browser Back re-shows the surface the player came from; the conversation and
  // the draft are untouched, and no message is replayed.
  await page.goBack();
  await expect(surface).toHaveCount(0);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();

  // Escape returns to the conversation from any other surface.
  await entry.click();
  await expect(surface).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(surface).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
});


test("the selected surface is restored from the URL after a refresh and takes keyboard focus into itself", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  await page.reload();
  // Refresh restores the selected surface without touching the conversation it
  // replaced: going back shows the same chat and draft the player left.
  const surface = page.getByTestId("game-surface");
  await expect(surface).toBeVisible();
  await expect(page.getByTestId("game-state-panel")).toHaveAttribute("data-game-state", "available");
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page.getByText("A durable delegated draft.")).toBeVisible();

  // Selecting a surface moves focus to its heading, and Tab then reaches the
  // surface's own controls: it is a peer region, not a modal trap, so the
  // keyboard path in is one-way and the way out is Escape or Browser Back.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(surface.getByRole("heading", { name: "Game", exact: true })).toBeFocused();
  let reachedSurfaceControl = false;
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => document.activeElement?.closest('[data-testid="game-surface"]') !== null);
    if (inside) reachedSurfaceControl = true;
  }
  expect(reachedSurfaceControl, "tabbing reaches the surface's own controls").toBe(true);

  await page.keyboard.press("Escape");
  await expect(surface).toHaveCount(0);
  await expect(page).toHaveURL(/#profile=composed-reference-game$/);
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
});


test("the Game surface renders localized player outcomes in zh-CN with no English chrome", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.addInitScript(() => window.localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.getByRole("button", { name: "游戏", exact: true }).click();
  // The surface's own accessible name is the localized entry text; the fixture's
  // other regions (the game state region and the installation panel) are named
  // separately, so match this one by its test id.
  const localizedSurface = page.getByTestId("game-surface");
  await expect(localizedSurface).toBeVisible();
  await expect(localizedSurface).toHaveAccessibleName("游戏");
  const panel = page.getByTestId("game-state-panel");
  // Group vocabulary, fact labels and fact values all come from the zh-CN
  // catalog; the panel is not a mix of English chrome and Chinese content.
  await expect(panel).toContainText("连接尚未连接游戏");
  await expect(panel).toContainText("兼容性尚未检查");
  await expect(panel).toContainText("下一步");
  await expect(panel).toContainText("启用伙伴陪玩");
  await expect(panel).toContainText("当前会话");
  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/Game state|Connection|Compatibility|Not checked|unchecked|connected_idle/);
});

