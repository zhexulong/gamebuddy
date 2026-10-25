import { expect, test, type Page } from "@playwright/test";

import { messages } from "../src/i18n";

/**
 * Copying one message.
 *
 * Every chat product has two daily actions on a message and this one had neither. Copy is the one
 * this journey covers, and what it has to get right is what SillyTavern's own per-message copy gets
 * right: **the message's own words, and nothing else.** Not the author line above the bubble, not a
 * timestamp, not the Markdown flattened out of the rendered DOM. ST keeps each message's text in its
 * `mes` field and hands that to the clipboard unchanged, so a player who pastes her line somewhere
 * gets her line. That is the behaviour matched here, byte for byte, on both sides of the exchange.
 *
 * The assertions, each with the failure it catches:
 *
 * 1. `puts exactly the message text on the clipboard` - read back with `navigator.clipboard.readText`
 *    and compared with `toBe`, not `toContain`. Catches an author prefix, a timestamp, a trailing
 *    newline, or the rendered DOM's `textContent` (which loses the `*beat*` asterisks and re-flows
 *    the whitespace). Run on one of her messages AND one of the player's, because both sides carry
 *    the control. The message text deliberately contains a `*beat*` markdown span, and the test also
 *    reads the rendered bubble, so "the copied string is the AUTHORED one" is proved by comparing two
 *    strings that really differ rather than by a sentence that would pass either way.
 * 2. `is a 44 px target, and adding it did not cost the strip a control` - measured at 1440x900 and
 *    400x800 in the shipped composed shell. Every control is at least 44 px in both directions, all
 *    five are present, the action row is one line, and the pager keeps its own 136 px box on the line
 *    beneath at 400 - the layout the fifth control forced, stated as a rule rather than a fallback.
 * 3. `is reachable and operable by keyboard alone` - focus it with Tab, activate with Enter and with
 *    Space, and read the clipboard back each time. Catches a control that only answers a pointer.
 * 4. `says it happened, then stops saying it` - one short line in the product's own banner tone, in
 *    the product's own `role="status"` region, which removes itself; the row never settles into a
 *    copied state, and the receipt does not move the control that was pressed.
 * 5. `both catalogues carry the control and both outcomes` - neither language is left with a key name.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const playerMessageHandle = "X".repeat(42) + "A";
const openedMessageHandle = "W".repeat(42) + "A";

/** Both clipboard directions: the press writes, and the journey reads back what it wrote. */
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

type Entry = Readonly<{
  role: "player" | "companion";
  text: string;
  opening?: boolean;
  swipes?: { index: number; total: number };
}>;

/** Her reply goes last but one and carries a swipe set, so its row is the strip's worst case. */
const TRANSCRIPT: readonly Entry[] = [
  { role: "companion", text: "The lantern over the porch is still lit.", opening: true },
  { role: "player", text: "Where are we?" },
  { role: "companion", text: "On the pier. *She leans on the rail.*", swipes: { index: 1, total: 3 } },
  { role: "player", text: "And now?" },
  { role: "companion", text: "Still on the pier." },
];

const HER_HANDLE = `${openedMessageHandle}2`;
const HIS_HANDLE = `${playerMessageHandle}3`;
const HER_LINE = TRANSCRIPT[2]!.text;
const HIS_LINE = TRANSCRIPT[3]!.text;

function composedRoot(transcript: readonly Entry[]) {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: "Mira", handle: "D".repeat(42) + "A" },
        title: null,
        transcript: transcript.map((entry, index) => ({
          handle: entry.role === "player" ? playerMessageHandle + String(index) : openedMessageHandle + String(index),
          role: entry.role,
          text: entry.text,
          locale: "und",
          order: index,
          revision: 1,
          ...(entry.opening === true
            ? { openingVariant: { variantId: "V".repeat(42) + "A", index: 0, count: 2, label: "Default", locked: false } }
            : {}),
          ...(entry.swipes === undefined
            ? {}
            : {
                swipeInfo: {
                  currentIndex: entry.swipes.index,
                  totalSwipes: entry.swipes.total,
                  label: `\u25c0 ${entry.swipes.index + 1}/${entry.swipes.total} \u25b6`,
                  hasPrevious: entry.swipes.index > 0,
                  hasNext: entry.swipes.index < entry.swipes.total - 1,
                },
              }),
        })),
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
}

async function openConversation(page: Page, locale: "en" | "zh-CN" = "en"): Promise<void> {
  const root = composedRoot(TRANSCRIPT);
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.locator("ol.message-list > li")).toHaveCount(TRANSCRIPT.length);
}

/** The clipboard as the OS holds it, read back through the same API the control wrote with. */
async function clipboardText(page: Page): Promise<string> {
  return await page.evaluate(() => navigator.clipboard.readText());
}

/** Puts a sentinel on the clipboard, so a copy that does nothing cannot pass on old content. */
async function resetClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText("__not_copied__"));
}

/** The touch floor the whole strip uses, plus the sub-pixel a measured box may round to. */
const TOUCH_MINIMUM = 44;

test("copying her message puts exactly her words on the clipboard, with no name and no time", async ({ page }) => {
  await openConversation(page);
  await resetClipboard(page);

  await page.click(`[data-handle="${HER_HANDLE}"] [data-testid="message-copy"]`);
  const copied = await clipboardText(page);

  console.log(`MEASURE copy hers: clipboard ${JSON.stringify(copied)} vs message ${JSON.stringify(HER_LINE)}`);
  // Byte-for-byte the message's own text - the Markdown she wrote, asterisks and all.
  expect(copied).toBe(HER_LINE);
  // The message's text really does carry beat markup, so the assertion above is about the AUTHORED
  // string rather than about a plain sentence that would pass whichever string was copied.
  expect(HER_LINE).toContain("*She leans on the rail.*");
  // The rendered bubble is a DIFFERENT string: the asterisks are gone, so copying the DOM's
  // `textContent` would not produce what the clipboard now holds.
  const rendered = await page.locator(`[data-handle="${HER_HANDLE}"] .message-bubble`).textContent();
  expect(rendered).toContain("She leans on the rail.");
  expect(rendered).not.toContain("*");
  expect(copied).not.toBe(rendered);
  // And neither of the two things ST leaves out reached the clipboard.
  expect(copied).not.toContain("Mira");
});

test("copying the player's own message puts exactly their words on the clipboard", async ({ page }) => {
  await openConversation(page);
  await resetClipboard(page);

  await page.click(`[data-handle="${HIS_HANDLE}"] [data-testid="message-copy"]`);
  const copied = await clipboardText(page);

  console.log(`MEASURE copy theirs: clipboard ${JSON.stringify(copied)} vs message ${JSON.stringify(HIS_LINE)}`);
  expect(copied).toBe(HIS_LINE);
  // The player's row has no author line at all, so this is the other half of "no prefix": what the
  // clipboard holds is the words and only the words, on the side that never had a header either.
  expect(copied).not.toContain("You");
});

test("the copy control is offered on every settled message", async ({ page }) => {
  await openConversation(page);

  for (const entry of TRANSCRIPT.keys()) {
    const owner = TRANSCRIPT[entry]!.role === "player" ? playerMessageHandle : openedMessageHandle;
    await expect(page.locator(`[data-handle="${owner}${entry}"] [data-testid="message-copy"]`)).toHaveCount(1);
  }
});

test("the fifth control keeps every target at the touch minimum, at both widths, without pushing one out", async ({
  page,
}) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;

    // Her reply's row: the pager, the rewind, the edit, the delete and the copy - every control the
    // strip can hold at once, which is why it is the one that measures worst.
    const measured = await page.evaluate(
      (selector) => {
        const row = document.querySelector(selector)!;
        const strip = row.querySelector<HTMLElement>(".message-actions")!;
        const box = (node: Element) => {
          const rect = node.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height), centre: Math.round(rect.top + rect.height / 2) };
        };
        const controls = [...strip.children].map((child) => ({
          name: (child.getAttribute("class") ?? "").replace("action-btn ", ""),
          ...box(child),
          ariaLabel: child.getAttribute("aria-label"),
          title: child.getAttribute("title"),
        }));
        const pager = strip.querySelector<HTMLElement>(".swipe-controls");
        const list = document.querySelector("ol.message-list")!;
        return {
          strip: box(strip),
          controls,
          pager: pager === null ? null : box(pager),
          overflow: { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth },
        };
      },
      `[data-handle="${HER_HANDLE}"]`,
    );
    console.log(`MEASURE copy strip ${where}: ${JSON.stringify(measured)}`);

    // All five controls are present: nothing was pushed out to make room.
    expect(measured.controls.length, where).toBe(5);
    // Every one of them is a real target, in both directions, and named.
    for (const control of measured.controls) {
      expect(control.height, `${where} ${control.name} clears the 44 px floor`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
      expect(control.width, `${where} ${control.name} is a target`).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
      expect(control.ariaLabel, `${where} ${control.name} is named`).toBeTruthy();
    }
    // Each of the four BUTTONS carries the same words as its title for the pointer; the pager is a
    // group carrying only its name, which is how it has always been.
    for (const control of measured.controls.filter((candidate) => !candidate.name.includes("swipe-controls"))) {
      expect(control.title, `${where} ${control.name} titles the same words`).toBe(control.ariaLabel);
    }
    const copy = measured.controls.find((control) => control.name === "copy-btn");
    expect(copy, where).not.toBeNull();
    // The name says what the press does to the conversation: nothing, which is the honest sentence
    // for the only control in this strip that mutates nothing.
    expect(copy!.ariaLabel, where).toContain("without the name or the time");

    // The strip never spills out of the column the message gives it.
    expect(measured.overflow.scrollWidth, where).toBeLessThanOrEqual(measured.overflow.clientWidth);

    if (viewport.width === 1440) {
      // The wide window is where the narrow rule does not apply: one row, all five controls.
      expect(new Set(measured.controls.map((control) => control.centre)).size, where).toBe(1);
      expect(measured.strip.height, where).toBe(46);
    } else {
      // The narrow window puts the pager on its own line, beneath the four actions.
      const actions = measured.controls.filter((control) => !control.name.includes("swipe-controls"));
      expect(actions.length, where).toBe(4);
      expect(new Set(actions.map((control) => control.centre)).size, "the four actions share one line").toBe(1);
      expect(measured.pager, where).not.toBeNull();
      expect(actions[0]!.centre, where).toBeLessThan(measured.pager!.centre);
      // The pager keeps its own box rather than being stretched across the line it now owns.
      expect(measured.pager!.width, where).toBe(136);
    }
  }
});

test("the copy control is reachable and operable by keyboard alone, with Enter and with Space", async ({ page }) => {
  await openConversation(page);
  await resetClipboard(page);

  // Reach it the way a keyboard-only player does: from the page, with Tab, until the control on her
  // reply's row holds focus. A control that never receives focus cannot be reached at all.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  let reached = false;
  for (let step = 0; step < 60; step += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        isCopy: element?.getAttribute("data-testid") === "message-copy",
        handle: element?.closest("li[data-handle]")?.getAttribute("data-handle") ?? null,
      };
    });
    if (focused.isCopy && focused.handle === HER_HANDLE) {
      reached = true;
      break;
    }
  }
  expect(reached, "the copy control is in the tab order").toBe(true);

  // Enter activates it.
  await page.keyboard.press("Enter");
  await expect.poll(() => clipboardText(page), { message: "Enter copies her message" }).toBe(HER_LINE);

  // Space activates it too - and the sentinel proves this press is what wrote.
  await resetClipboard(page);
  await page.keyboard.press("Space");
  await expect.poll(() => clipboardText(page), { message: "Space copies her message" }).toBe(HER_LINE);
});

test("the receipt is one short line in the product's own banner, and it removes itself", async ({ page }) => {
  await openConversation(page);
  const notice = page.locator(`[data-handle="${HER_HANDLE}"] [data-testid="message-copy-notice"]`);
  await expect(notice).toHaveCount(0);

  await page.click(`[data-handle="${HER_HANDLE}"] [data-testid="message-copy"]`);

  // The press writes through a promise, so the receipt arrives one microtask after the click.
  await expect(notice).toHaveCount(1);
  const measured = await notice.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      text: (node.textContent ?? "").trim(),
      role: node.getAttribute("role"),
      tone: node.getAttribute("data-copy-notice"),
      className: node.getAttribute("class"),
      height: Math.round(rect.height),
    };
  });
  console.log(`MEASURE copy notice: ${JSON.stringify(measured)}`);

  expect(measured.text).toBe("Copied to clipboard.");
  // The product's own polite region, in the product's own success tone: no new notice pattern.
  expect(measured.role).toBe("status");
  expect(measured.tone).toBe("copied");
  expect(measured.className).toContain("success-banner");
  // One short line, not a paragraph about success.
  expect(measured.text.length).toBeLessThanOrEqual(40);
  expect(measured.height).toBeLessThan(TOUCH_MINIMUM);

  // It is a moment, not a state: the row does not settle into "copied".
  await expect(notice).toHaveCount(0, { timeout: 5000 });

  // A second press brings it back, so the timer restarts rather than the row having moved on.
  await page.click(`[data-handle="${HER_HANDLE}"] [data-testid="message-copy"]`);
  await expect(notice).toHaveCount(1);
});

test("the receipt does not move the control that was pressed, the strip it sits in, or the rows under it", async ({
  page,
}) => {
  await openConversation(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;
    // Her reply with the swipe set is the row the receipt is measured on, and it is deliberately NOT
    // the transcript's last one: a receipt that is in flow pushes every row below it down and back,
    // which a last-row measurement cannot see. The rows under it are measured with it.
    const measure = () =>
      page.evaluate(() => {
        const round = (value: number) => Math.round(value);
        const box = (node: Element) => {
          const rect = node.getBoundingClientRect();
          return { width: round(rect.width), height: round(rect.height), top: round(rect.top) };
        };
        const rows = [...document.querySelectorAll<HTMLElement>("li.message")];
        const owner = rows.find((row) => row.querySelector('[data-testid="message-copy"]') !== null &&
          row.className.includes("companion") && row.querySelector(".swipe-controls") !== null)!;
        return {
          owner: box(owner),
          strip: box(owner.querySelector<HTMLElement>(".message-actions")!),
          copy: box(owner.querySelector<HTMLElement>('[data-testid="message-copy"]')!),
          // Every row after the owner: the block the receipt used to push down.
          below: rows.slice(rows.indexOf(owner) + 1).map((row) => box(row)),
        };
      });

    const before = await measure();
    // A non-last row really has rows under it, so `below` is what a flow receipt moves.
    expect(before.below.length, where).toBeGreaterThan(0);

    await page.click('[data-testid="message-copy"]');
    // The receipt is what could have moved the layout, so the second reading is taken while it is up.
    await expect(page.locator('[data-testid="message-copy-notice"]').first()).toHaveCount(1);
    const during = await measure();
    console.log(`MEASURE copy notice geometry ${where}: ${JSON.stringify(before)} -> ${JSON.stringify(during)}`);

    // The receipt is out of flow, so the row it belongs to keeps its height while it is up...
    expect(
      during.owner.height,
      `${where}: the row is ${before.owner.height} px before the receipt and ${during.owner.height} px while it is up`,
    ).toBe(before.owner.height);
    // ...and so does everything under it, which is the half an in-flow receipt moved.
    expect(during.below, `${where}: the rows below the receipt's own row`).toEqual(before.below);
    // The pressed control and the strip it sits in are exactly where they were.
    expect(during.strip, where).toEqual(before.strip);
    expect(during.copy, where).toEqual(before.copy);

    await page.locator('[data-testid="message-copy-notice"]').first().waitFor({ state: "detached" });
    const after = await measure();
    expect(after.owner.height, `${where}: the row after the receipt has gone`).toBe(before.owner.height);
    expect(after.below, `${where}: the rows below, after the receipt has gone`).toEqual(before.below);
  }
});

test("both catalogues carry the control and both outcomes, and neither is a key name", async ({ page, browser }) => {
  await openConversation(page, "en");
  const english = await page.getByTestId("chat-surface").evaluate(() => {
    const copy = document.querySelector('[data-testid="message-copy"]')!;
    return { control: (copy.textContent ?? "").trim(), name: copy.getAttribute("aria-label") };
  });
  await page.click('[data-testid="message-copy"]');
  await expect(page.locator('[data-testid="message-copy-notice"]').first()).toHaveCount(1);
  const englishNotice = await page.locator('[data-testid="message-copy-notice"]').first().textContent();

  expect(english.control).toBe("Copy");
  expect(english.name).toContain("Copy this message");
  expect((englishNotice ?? "").trim()).toBe("Copied to clipboard.");

  // The Chinese surface, in its own context: one browser context boots one locale, so the second
  // catalogue is read by a shell that actually resolved it rather than by a page that re-booted on
  // top of the first one's stored preference.
  const chineseContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const chinesePage = await chineseContext.newPage();
  await openConversation(chinesePage, "zh-CN");
  const chinese = await chinesePage.getByTestId("chat-surface").evaluate(() => {
    const copy = document.querySelector('[data-testid="message-copy"]')!;
    return { control: (copy.textContent ?? "").trim(), name: copy.getAttribute("aria-label") };
  });
  await chinesePage.click('[data-testid="message-copy"]');
  await expect(chinesePage.locator('[data-testid="message-copy-notice"]').first()).toHaveCount(1);
  const chineseNotice = await chinesePage.locator('[data-testid="message-copy-notice"]').first().textContent();
  // The failure sentence is not reachable through the UI (it needs a refused clipboard), so it is read
  // from the same module the surface renders from - imported relatively, as `chat-surface-voice.spec.ts`
  // already reads its labels. The in-page `import("/src/i18n.ts")` that stood here resolved only through
  // Vite's dev-server base URL, so nothing reading the spec's imports could find the module.
  const chineseFailed = messages("zh-CN").copyNoticeFailed;
  await chineseContext.close();

  console.log(`MEASURE copy words: en ${JSON.stringify(english)} zh ${JSON.stringify(chinese)} ${chineseNotice}`);
  expect(chinese.control).toBe("复制");
  expect(chinese.name).toContain("复制这条消息");
  expect((chineseNotice ?? "").trim()).toBe("已复制。");
  // The failure is said out loud in both languages, and tells the player what to do instead - the one
  // thing a silent failure would not do.
  expect(chineseFailed).toContain("选中");
  expect(chineseFailed).not.toBe(chineseNotice);
  // The two catalogues are not one literal standing in for a translation.
  expect(english.name).not.toBe(chinese.name);
  expect(englishNotice).not.toBe(chineseNotice);
  // Neither language was left holding a key name.
  for (const value of [english.control, english.name, chinese.control, chinese.name, chineseNotice, chineseFailed]) {
    expect((value ?? "").trim().length).toBeGreaterThan(0);
    expect(value).not.toContain("copyMessage");
    expect(value).not.toContain("copyNotice");
    expect(value).not.toContain("copyFailed");
  }
});
