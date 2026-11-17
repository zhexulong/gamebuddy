/**
 * Arriving at the Game surface again is not a second installation scan.
 *
 * The panel is a sibling of the Game state region inside the surface, and a peer surface renders nothing while
 * another is selected - so every switch away unmounts the panel, and its mount effect started a scan. A scan is
 * the slowest thing the surface does on a cold machine: the Host reads the registry, the Steam libraries and
 * every known location (`host/src/windows-stardew-installation-discovery`), and the answer it produces does not
 * change because the player looked at their conversation. Measured on the mounted shell, phases
 * mount | chat-idle | game-1 | chat-2 | game-2, `game/installation/discovery` per phase: 0 | 0 | 1 | 0 | 1.
 *
 * The answer is kept by the surface (which stays mounted) and handed back on the next mount, so the first
 * arrival pays the one scan and a returning player reads the answer they already had. A scan is the player's own
 * request after that, which is the second half of this journey: "Find again" still asks the Host.
 */
import { expect, test } from "./frontend-coverage";
import { draft, jsonOk, root, stubGameRead, token } from "./composed-reference-game-fixtures";

/** One installation the Host's scan offers, in the status a production reply carries. */
const foundInstallation = {
  apiVersion: 1,
  candidates: [
    {
      candidateId: "Q".repeat(22),
      source: "known-location",
      label: "Stardew Valley",
      hint: "Detected installation (path hidden)",
      status: "admission_required",
    },
  ],
  diagnostics: [],
};

const panel = (page: Parameters<typeof stubGameRead>[0]) => page.locator(".game-installation-panel");

test("the installation scan is taken on the first arrival and not on the next one", async ({ page }) => {
  let scans = 0;
  let retries = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await stubGameRead(page, () => root.game);
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/retry", (route) => {
    retries += 1;
    return route.fulfill(jsonOk(foundInstallation));
  });
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) => {
    scans += 1;
    return route.fulfill(jsonOk(foundInstallation));
  });
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.waitForTimeout(750);
  expect(scans, "the panel is not on screen, so nothing may be scanning for it").toBe(0);

  // The first arrival scans, and the answer is what the player reads.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect.poll(() => scans).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-state", "candidates");

  // Away and back. The answer is on screen again without a scan behind it.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-state", "candidates");
  await page.waitForTimeout(750);
  expect(scans, "a returning player reads the scan they already had, not a second sweep").toBe(1);

  // A fresh scan is still the player's to ask for, and it is the Host's answer that replaces the old one.
  await panel(page).getByRole("button", { name: "Find again", exact: true }).click();
  await expect.poll(() => retries).toBe(1);
  await expect(panel(page)).toHaveAttribute("data-state", "candidates");
  expect(scans, "the retry is the retry route, not a silent second mount scan").toBe(1);
});
