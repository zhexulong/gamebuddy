import { type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * The collapsed menu is a keyboard closed loop (item 25).
 *
 * Measured defect at 400 px: `AppBar` opened the `More` panel and left focus on the trigger, so
 * the panel was open but the keyboard was still in the bar. Tab then walked out of the panel into
 * the page behind it - the trigger is followed in DOM order by the panel, but nothing held focus
 * inside it - and the four peers the panel exists to keep reachable at this width became a
 * one-way trip away from the place the player had just opened.
 *
 * What the component does now, and why this shape:
 *
 *  - opening moves focus onto the panel's first entry, because the panel is what the player
 *    opened and the trigger's next Tab would otherwise land behind it;
 *  - Tab wraps inside the panel (last → first, and Shift+Tab first → last). The panel is not
 *    modal in the visual sense - no backdrop, nothing covered - but the folded peers exist
 *    nowhere else in a 400 px bar, so letting Tab out of it would leave those peers reachable only
 *    by Escape or by a reverse walk through the whole document;
 *  - Escape closes it and hands focus back to the trigger (the behaviour that already existed and
 *    is kept here as the same assertion, so this file states the whole contract in one place);
 *  - the trigger's `aria-expanded`/`aria-controls` name the panel it opens, as the Game create
 *    form's own disclosure does.
 *
 * Red readings before the change, from this file: focus stayed on the trigger after opening
 * (`inMenu: false`), and the Tab walk was `More, Chats, Characters, Settings, Memory, Chat
 * transcript` - the fifth press landed on the conversation behind the open panel. The Escape
 * reading was already green; it is asserted here so the contract cannot be half-implemented later.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const catalogue = messages("en");

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
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: `${"D".repeat(42)}A` },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Where the keyboard is, and whether that place is inside the collapsed panel. */
async function focused(page: Page): Promise<Readonly<{ name: string | null; inMenu: boolean }>> {
  return await page.evaluate(() => {
    const element = document.activeElement;
    const menu = document.querySelector(".app-bar-more-menu");
    return {
      name:
        element === null
          ? null
          : (element.getAttribute("aria-label") ?? (element.textContent ?? "").trim()) || null,
      inMenu: element !== null && menu !== null && menu.contains(element),
    };
  });
}

test("the collapsed menu takes focus in, wraps Tab and Escape, and Escape returns focus to its trigger", async ({
  page,
}) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const trigger = page.getByRole("button", { name: catalogue.appBarMore, exact: true });
  const panel = page.locator(".app-bar-more-menu");
  await expect(trigger).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(trigger, "a collapsed menu says it is collapsed").toHaveAttribute("aria-expanded", "false");

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(trigger, "and that it is open").toHaveAttribute("aria-expanded", "true");

  // The panel the trigger names is the panel that opened - read by id, because `useId` is not a
  // CSS-safe identifier and a selector would silently find nothing.
  const controls = await trigger.getAttribute("aria-controls");
  expect(controls, "the trigger names the region it controls").toBeTruthy();
  expect(
    await page.evaluate((id) => document.getElementById(id ?? "")?.getAttribute("class") ?? null, controls),
    "and the id it names is that region",
  ).toBe("app-bar-more-menu");

  const entered = await focused(page);
  expect(entered.inMenu, "opening the panel moves focus into it").toBe(true);
  expect(entered.name, "onto its first entry").toBe(catalogue.chatsPanel);

  // Backwards from the first entry wraps to the last, and forwards from the last wraps back, so
  // the panel is a loop in both directions rather than a corridor with two exits.
  await page.keyboard.press("Shift+Tab");
  const backwards = await focused(page);
  expect(backwards.inMenu, "Shift+Tab from the first entry stays in the panel").toBe(true);
  expect(backwards.name).toBe(catalogue.presetsPanel);

  const walk: Array<Readonly<{ name: string | null; inMenu: boolean }>> = [];
  for (let press = 0; press < 5; press += 1) {
    await page.keyboard.press("Tab");
    walk.push(await focused(page));
  }
  expect(walk.map((stop) => stop.name), "Tab walks the same five peers, and the sixth press is a wrap").toEqual([
    catalogue.chatsPanel,
    catalogue.charactersPanel,
    catalogue.settingsPanel,
    catalogue.memoryPanel,
    catalogue.presetsPanel,
  ]);
  expect(
    walk.filter((stop) => !stop.inMenu),
    "no Tab press lands on a control outside the open panel",
  ).toEqual([]);

  // Escape closes it and the keyboard comes back to the control that opened it - without also
  // stepping the shell back to the conversation behind it.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
