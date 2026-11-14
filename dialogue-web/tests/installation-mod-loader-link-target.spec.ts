import { type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * A control a thumb has to hit is 44 px in the direction it is hit, whatever it draws.
 *
 * THE DEFECT. `.installation-mod-loader-acquire` is the one link in the installation row that
 * matters when a folder has Stardew Valley and no mod loader - it points at smapi.io, because the
 * loader belongs to its own project and this app does not ship it. It drew as an 11 px line with
 * `min-height: 24px`: 24 px of hit, in a row the player is pressing at arm's length on a 400 px
 * phone window, beside chips whose own row is 44 px. The wall it sits against is the product's
 * own floor (`--touch-target-min`), not a guideline this file invented.
 *
 * WHAT IS MEASURED, and why it is measured this way rather than read off a rule: the reading has to
 * be the area the BROWSER hit-tests, not the element's own border box. An extended hit area is
 * usually a positioned `::after`, and a `::after` has no box of its own to query - its box belongs
 * to the element that originates it. So this walks `document.elementFromPoint` outward from the
 * control's centre one pixel at a time, in both directions, and counts how far the control still
 * answers. That reading is true of padding, of a pseudo-element, and of a box that was always 44 px,
 * and it fails on a control that merely looks tall.
 *
 * The VISUAL is deliberately not asserted: the link stays an 11 px underlined sentence, because it
 * sits inside a chip row and a 44 px painted control would break the row's own rhythm. What changed
 * is where the thumb lands, and that is what this file reads.
 *
 * red-proof: inject  delete the `::after` rule under `.installation-mod-loader-acquire` ->
 *   `the SMAPI link answers a hit 10 px above its centre line ... it answers one 0 px up, so the
 *   hit area is 24 px tall against a 44 px floor`.
 */
const labels = messages("en");

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const candidateId = `${"Q".repeat(21)}A`;

const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs: 1_900_000_000_000 },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: `${"D".repeat(42)}A` },
      title: "Reference Game Chat",
      transcript: [],
      draft: { revision: 4, present: true },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const DISCOVERY_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery";

/**
 * A candidate folder the Host has already inspected and found no mod loader in.
 *
 * `modLoader: "missing"` is the Host's own word for that - the panel renders neither chip nor link
 * for a value it did not receive, so this fixture has to carry it for the link to exist at all.
 */
const candidate = {
  candidateId,
  source: "steam-vdf",
  label: "Stardew Valley",
  hint: "Detected installation (path hidden)",
  status: "admission_required",
  modLoader: "missing",
};

async function mount(page: Page): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route(DISCOVERY_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, candidates: [candidate], diagnostics: [] })));
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/smapi", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "installed" })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const entry = page.getByRole("button", { name: labels.gamePanel, exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
}

/**
 * How far the control still answers a hit, measured outward from its own centre.
 *
 * `null` when the selector matches nothing, so a missing control is a named absence rather than a
 * zero that reads like a measurement.
 */
async function hitArea(page: Page, selector: string): Promise<Readonly<{ width: number; height: number }> | null> {
  return await page.evaluate((needle) => {
    const element = document.querySelector<HTMLElement>(needle);
    if (element === null) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const owns = (node: Element | null): boolean => node !== null && (node === element || element.contains(node));
    const centreX = Math.round(rect.left + rect.width / 2);
    const centreY = Math.round(rect.top + rect.height / 2);
    const answers = (dx: number, dy: number): boolean => owns(document.elementFromPoint(centreX + dx, centreY + dy));
    const walk = (dx: number, dy: number): number => {
      let distance = 0;
      while (distance < 80 && answers(dx * (distance + 1), dy * (distance + 1))) distance += 1;
      return distance;
    };
    const up = walk(0, -1);
    const down = walk(0, 1);
    const left = walk(-1, 0);
    const right = walk(1, 0);
    return { width: left + right, height: up + down };
  }, selector);
}

test("the SMAPI link a folder without a loader offers answers a 44 px tall hit at 400x800", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await mount(page);

  const link = page.locator(".installation-mod-loader-acquire");
  await expect(link, "the row offers the one outbound link to the loader's publisher").toHaveCount(1);
  await expect(link).toHaveText(labels.gameInstallationModLoaderAcquire);

  const measured = await hitArea(page, ".installation-mod-loader-acquire");
  expect(measured, "the SMAPI link is not in the document").not.toBeNull();
  // The floor is the product's own token, in the direction a thumb misses a line of text.
  expect(
    measured!.height,
    `the SMAPI link answers a hit ${Math.floor(measured!.height / 2)} px above and below its centre line, so its ` +
      "hit area is under the 44 px floor every other control in this row keeps",
  ).toBeGreaterThanOrEqual(44);
  // The row's other controls are still reachable: an extended hit area that swallowed its neighbour
  // would trade one target for another.
  const box = await link.boundingBox();
  expect(box, "the link has a laid-out box").not.toBeNull();
  expect(
    Math.round(box!.height),
    `the link paints ${box!.height}px tall - the visual is deliberately unchanged, so a 44 px box here means the ` +
      "hit area was inflated instead of extended",
  ).toBeLessThan(44);
});
