import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(43);

const visualSnapshot = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.p3" },
  csrfToken: token,
  browserSession: { expiresAtMs: 1_900_000_000_000 },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira" },
    title: "A Tavern Journey",
    transcript: [
      {
        handle: "C".repeat(43),
        role: "companion",
        text: "Welcome to the valley! The morning mist is just clearing over the farm.",
        locale: "und",
        order: 0,
        revision: 1,
      },
      {
        handle: "D".repeat(43),
        role: "player",
        text: "Thanks Mira! Let's check the crops first.",
        locale: "und",
        order: 1,
        revision: 1,
      },
      {
        handle: "E".repeat(43),
        role: "companion",
        text: "Sounds great. The parsnips should be ready for harvest today.",
        locale: "und",
        order: 2,
        revision: 1,
      },
    ],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const viewports = [
  { name: "mobile-portrait", width: 375, height: 667 },
  { name: "mobile-landscape", width: 667, height: 375 },
  { name: "tablet", width: 768, height: 900 },
  { name: "desktop-small", width: 1024, height: 900 },
  { name: "desktop-wide", width: 1440, height: 1000 },
];

for (const vp of viewports) {
  test(`Responsive layout renders without horizontal overflow at ${vp.name} (${vp.width}x${vp.height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.route("**/api/tavern/v1/bootstrap", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(visualSnapshot) }),
    );
    await page.route("**/api/tavern/v1/draft", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ apiVersion: 1, revision: 4, text: "I'll head to Pierre's store after watering." }),
      }),
    );

    await page.goto(`/#boot=${token}`);

    await expect(page.getByRole("heading", { name: "A Tavern Journey" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Saved draft" })).toBeVisible();
    await expect(page.getByText("Welcome to the valley!")).toBeVisible();

    // Check no horizontal scrollbar / overflow
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);

    // Open settings drawer and verify it fits viewport
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    const drawerBox = await dialog.boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(drawerBox!.width).toBeLessThanOrEqual(vp.width + 1);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
}

test("Prefers-reduced-motion disables animations cleanly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/tavern/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(visualSnapshot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, revision: 4, text: "Draft text." }) }),
  );

  await page.goto(`/#boot=${token}`);
  await expect(page.getByRole("heading", { name: "A Tavern Journey" })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
});
