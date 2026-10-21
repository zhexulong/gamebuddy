import { expect, test, type Page } from "@playwright/test";

/**
 * The message-level rewind, mounted, with its own measurements.
 *
 * The rewind KEEPS the row it names and drops everything after it (the owner's ruling, 2026-10-20:
 * rewind the way Pi and SillyTavern do), so the presentation contract is four things at once, and
 * each one is an assertion here:
 *
 * 1. `names what it will remove, and its target is the touch minimum` - the count in the accessible
 *    name is the number of rows AFTER this one, because this row survives the cut; the box is
 *    measured from the layout rather than from a class name, so it is at least the 44 px touch
 *    minimum the rest of the strip uses (`--touch-target-min`).
 * 2. `is offered on both sides of the exchange, and nowhere the cut would be empty` - never on the
 *    greeting (message zero: the Host refuses it, because a cut there would leave nothing but the
 *    conversation's own opening), never on the transcript's LAST row (keeping it removes nothing, so
 *    that row offers the delete alone), and on every other row INCLUDING the player's own line - a
 *    player rewinds to their own words, keeps them, and drops the reply that answered them, which is
 *    what makes "answer me again" reachable.
 * 3. `arms, replaces the row's own controls, and sends the point it was shown at` - the first press
 *    only arms; the confirmation states what it keeps and what it removes, the row's pager,
 *    regenerate, edit and Delete step aside while it is up, its own block measures INSIDE the row (an
 *    earlier defect blew a row to 3148 px when a confirmation sat inside a horizontal flex row), the
 *    confirm sends the handle AND the order the page rendered the row at (the Host refuses a stale
 *    pair), and the cancel closes the arm and sends nothing.
 * 4. `keeps the row it names and drops exactly the rows after it` - from either role: the clicked row
 *    stays where it was, the rows after it go, and the transcript's length changes by exactly the
 *    number the control named.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

type RewindProbe = {
  rewindControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
  } | null;
  deleteControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null;
  rewindConfirm(handle: string): {
    prompt: string | null;
    yes: string | null;
    no: string | null;
    ordinaryControls: number;
  } | null;
  rewindCalls(): readonly { kind: "arm" | "confirm" | "cancel"; handle: string; order: number }[];
  resetRewindCalls(): void;
};

declare global {
  interface Window {
    chatProbe: RewindProbe & {
      setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
      transcriptRows(): readonly { handle: string; index: number; text: string | null; bubbles: number }[];
    };
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

/** The two widths every message-row journey is measured at. */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 400, height: 800 },
] as const;

/** The touch minimum the rest of the strip uses, plus the sub-pixel the measured box may round to. */
const TOUCH_MINIMUM = 44;

/** The page's own horizontal overflow, which a wide confirmation block would create. */
async function horizontalOverflow(page: Page): Promise<number> {
  return await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("the rewind control names what it will remove, and its target is the touch minimum", async ({ page }) => {
  await openConversation(page);

  // The middle reply (h2) KEEPS itself and drops the two rows after it, so the count it names is two -
  // it used to name three, when the press also removed the row it was named after.
  const control = await page.evaluate(() => window.chatProbe.rewindControl("h2"));
  expect(control).not.toBeNull();
  expect(control?.label?.trim()).toBe("Rewind to here");
  expect(control?.ariaLabel).toContain("2");
  expect(control?.ariaLabel).toContain("Rewind to here");
  // The name states the shape of the cut, not only its size: this row stays.
  expect(control?.ariaLabel).toContain("keeps this message");
  expect(control?.title).toBe(control?.ariaLabel);
  // Measured from the layout: the whole target, not a class name.
  expect(control?.width).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
  expect(control?.height).toBeGreaterThanOrEqual(TOUCH_MINIMUM);

  // The row one step from the tail is the smallest legal point there is: it keeps itself and drops the
  // one row after it.
  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
      { role: "companion", text: "On the pier." },
      { role: "player", text: "And now?" },
    ]),
  );
  const smallest = await page.evaluate(() => window.chatProbe.rewindControl("h2"));
  expect(smallest, "the reply one step from the tail is still a rewind point").not.toBeNull();
  expect(smallest?.ariaLabel).toContain("1");
});

test("the rewind is offered on both sides of the exchange, and nowhere the cut would be empty", async ({ page }) => {
  await openConversation(page);

  // Message zero is the greeting: the Host refuses to cut there, so the surface does not offer it.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h0"))).toBeNull();
  // Her reply in the middle is a legal point.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h2"))).not.toBeNull();
  // And so is the PLAYER's own line, on both of the rows they spoke: the cut keeps their words and
  // drops the answer, which is the one thing a player needs before being answered again.
  const playerAt1 = await page.evaluate(() => window.chatProbe.rewindControl("h1"));
  const playerAt3 = await page.evaluate(() => window.chatProbe.rewindControl("h3"));
  expect(playerAt1, "the player's first line is a rewind point").not.toBeNull();
  expect(playerAt3, "the player's second line is a rewind point").not.toBeNull();
  // The player's row names the same shape of cut, counted from their own line: three rows follow h1.
  expect(playerAt1?.ariaLabel).toContain("3");
  expect(playerAt1?.ariaLabel).toContain("keeps this message");

  // The transcript's LAST row is a legal point for the DELETE and not for the rewind: keeping it
  // removes nothing, so the cut would be empty rather than a cut.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h4"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h4"))).not.toBeNull();
  // Read by name on the page itself: the last row carries no rewind control and one delete.
  await expect(page.locator('[data-handle="h4"] [data-testid="message-rewind"]')).toHaveCount(0);
  await expect(page.locator('[data-handle="h4"] [data-testid="message-delete"]')).toHaveCount(1);

  // Counted on the page that renders it: the rows the control is measured on are the transcript's.
  const rows = await page.locator("ol.message-list > li").count();
  expect(rows).toBe(CONVERSATION.length);

  // A shortened conversation moves the edge: the player's line is now the last row, so it keeps the
  // delete and loses the rewind - the absence follows the transcript, not the role.
  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
    ]),
  );
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h1"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h1"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h0"))).toBeNull();
});

test("arming replaces the row's own controls with the confirmation, which measures inside the row", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetRewindCalls());

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;

    await page.click('[data-handle="h2"] [data-testid="message-rewind"]');

    const armed = await page.evaluate(() => window.chatProbe.rewindConfirm("h2"));
    expect(armed, where).not.toBeNull();
    // The confirmation says what SURVIVES and what goes, in the owner's words; its two answers are
    // the rewind and the way out.
    expect(armed?.prompt, where).toBe(
      "Confirm rewind to here (keeps this message, deletes everything after it)",
    );
    expect(armed?.yes, where).toBe("Rewind to here");
    expect(armed?.no, where).toBe("Cancel");
    // The confirmation is the row's only control while it is up: the pager and regenerate step aside.
    expect(armed?.ordinaryControls, where).toBe(0);

    // The block's own geometry, not only its text. The earlier defect blew a row to 3148 px when the
    // confirmation sat inside a horizontal flex row, so the block is measured against the row it
    // lives in: it must fit inside it, and be a short block rather than a stretched one.
    const confirmBox = await page.locator('[data-handle="h2"] [data-testid="message-rewind-confirm"]').boundingBox();
    const rowBox = await page.locator('[data-handle="h2"]').boundingBox();
    expect(confirmBox, where).not.toBeNull();
    expect(rowBox, where).not.toBeNull();
    console.log(
      `MEASURE rewind-confirm ${where}: block ${confirmBox?.width}x${confirmBox?.height} at ${confirmBox?.x} | ` +
        `row ${rowBox?.width}x${rowBox?.height} at ${rowBox?.x} | overflow ${await horizontalOverflow(page)}`,
    );
    expect(confirmBox!.width, where).toBeLessThanOrEqual(rowBox!.width + 1);
    expect(confirmBox!.height, where).toBeLessThan(200);
    expect(confirmBox!.x!, where).toBeGreaterThanOrEqual(rowBox!.x! - 1);
    expect(confirmBox!.x! + confirmBox!.width, where).toBeLessThanOrEqual(rowBox!.x! + rowBox!.width + 1);
    // And nothing on the row pushed the page sideways.
    expect(await horizontalOverflow(page), where).toBeLessThanOrEqual(0);

    await page.click('[data-testid="message-rewind-confirm-no"]');
    expect(await page.evaluate(() => window.chatProbe.rewindConfirm("h2")), where).toBeNull();
    expect(await page.evaluate(() => window.chatProbe.rewindControl("h2")), where).not.toBeNull();
  }

  // Cancelling sends nothing: the arm and its close are the surface's own state.
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "cancel", handle: "", order: -1 },
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "cancel", handle: "", order: -1 },
  ]);
  await page.evaluate(() => window.chatProbe.resetRewindCalls());

  // The confirm sends the handle and the order the page rendered it at.
  await page.click('[data-handle="h2"] [data-testid="message-rewind"]');
  await page.click('[data-testid="message-rewind-confirm-yes"]');
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([
    { kind: "arm", handle: "h2", order: 2 },
    { kind: "confirm", handle: "h2", order: 2 },
  ]);
  expect(await page.evaluate(() => window.chatProbe.rewindConfirm("h2"))).toBeNull();
});

test("rewinding at a companion reply keeps that reply and drops exactly what followed it", async ({ page }) => {
  await openConversation(page);
  const before = await page.evaluate(() => window.chatProbe.transcriptRows());
  expect(before.map((row) => row.handle)).toEqual(["h0", "h1", "h2", "h3", "h4"]);

  // The count the control named before the press: the rows after h2.
  const named = await page.evaluate(() => window.chatProbe.rewindControl("h2"));
  const removes = Number(named?.ariaLabel?.match(/\((\d+) in all\)/u)?.[1]);
  expect(removes).toBe(2);

  await page.click('[data-handle="h2"] [data-testid="message-rewind"]');
  await page.click('[data-testid="message-rewind-confirm-yes"]');

  // The Host answers by truncating; the surface renders the authoritative reread and nothing it
  // dropped locally.
  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
      { role: "companion", text: "On the pier." },
    ]),
  );
  // The reread is rendered, not read from the mutation's own answer: wait for the rows to be the ones
  // the reread returned before measuring them.
  await expect(page.locator("ol.message-list > li")).toHaveCount(3);
  await expect(page.locator('[data-handle="h2"] .message-bubble')).toContainText("On the pier.");

  const after = await page.evaluate(() => window.chatProbe.transcriptRows());
  console.log(
    `MEASURE rewind-companion: rows ${before.length} -> ${after.length} handles ${after
      .map((row) => row.handle)
      .join(",")} kept ${JSON.stringify(after[2]?.text)}`,
  );
  // The row the player clicked is still there, with its own words, at its own position.
  expect(after.map((row) => row.handle)).toEqual(["h0", "h1", "h2"]);
  expect(after[2]?.index).toBe(2);
  expect((after[2]?.text ?? "").trim()).toBe("On the pier.");
  expect(after[2]?.bubbles).toBe(1);
  // Everything after it went, and the length moved by exactly the number the control named.
  await expect(page.locator('[data-handle="h3"]')).toHaveCount(0);
  await expect(page.locator('[data-handle="h4"]')).toHaveCount(0);
  expect(before.length - after.length).toBe(removes);

  // The shortened transcript makes the kept reply the last row, so it now offers the delete alone -
  // the absence follows where the conversation ends, not what happened to it.
  expect(await page.evaluate(() => window.chatProbe.rewindControl("h2"))).toBeNull();
  expect(await page.evaluate(() => window.chatProbe.deleteControl("h2"))).not.toBeNull();
});

test("rewinding at a player row keeps their words and drops the reply and everything after it", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.resetRewindCalls());

  const named = await page.evaluate(() => window.chatProbe.rewindControl("h1"));
  expect(named?.ariaLabel).toContain("3");
  expect(named?.ariaLabel).toContain("keeps this message");

  await page.click('[data-handle="h1"] [data-testid="message-rewind"]');
  // The player's row arms the same confirmation as her reply: it is one presentation, not one per role.
  const armed = await page.evaluate(() => window.chatProbe.rewindConfirm("h1"));
  expect(armed?.prompt).toBe("Confirm rewind to here (keeps this message, deletes everything after it)");
  expect(armed?.yes).toBe("Rewind to here");
  expect(armed?.no).toBe("Cancel");
  expect(armed?.ordinaryControls).toBe(0);
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([{ kind: "arm", handle: "h1", order: 1 }]);

  await page.click('[data-testid="message-rewind-confirm-yes"]');
  expect(await page.evaluate(() => window.chatProbe.rewindCalls())).toEqual([
    { kind: "arm", handle: "h1", order: 1 },
    { kind: "confirm", handle: "h1", order: 1 },
  ]);

  // The reread the Host's truncation produces: the opening and the player's own line.
  await page.evaluate(() =>
    window.chatProbe.setConversation([
      { role: "companion", text: "An opening greet." },
      { role: "player", text: "Where are we?" },
    ]),
  );
  await expect(page.locator("ol.message-list > li")).toHaveCount(2);

  const after = await page.evaluate(() => window.chatProbe.transcriptRows());
  console.log(
    `MEASURE rewind-player: rows 5 -> ${after.length} handles ${after.map((row) => row.handle).join(",")} kept ${JSON.stringify(after[1]?.text)}`,
  );
  expect(after.map((row) => row.handle)).toEqual(["h0", "h1"]);
  expect((after[1]?.text ?? "").trim()).toBe("Where are we?");
  expect(after[1]?.bubbles).toBe(1);
  await expect(page.locator('[data-handle="h2"]')).toHaveCount(0);
  expect(5 - after.length).toBe(3);
});

/**
 * The two facts a destructive confirmation owes a player who cannot see it well, or is on a keyboard:
 * it must LOOK destructive, and it must not take their place away.
 *
 * Both are measured here as the browser computes them, never as a class name:
 *
 *  - the affirmative's own colour and background, against the quiet control it replaces and against
 *    the `--danger` token the product paints every other destructive act with (`game-action.danger`,
 *    `small-button.danger` in style.css);
 *  - `document.activeElement`, by selector, at the three moments that matter: on the control before it
 *    is pressed, immediately after the press opens the confirmation, and after it is cancelled.
 *
 * The same three moments are then read on the DELETE pair, which shares one stylesheet block and one
 * keyboard path with the rewind's.
 */
test("the destructive answer is painted as one, and the keyboard keeps its place", async ({ page }) => {
  await openConversation(page);

  const trigger = '[data-handle="h2"] [data-testid="message-rewind"]';
  const confirmYes = '[data-testid="message-rewind-confirm-yes"]';
  const confirmNo = '[data-testid="message-rewind-confirm-no"]';

  /** Where focus is, named by the key whose selector matches the focused element. */
  const focused = async (selectors: Record<string, string>): Promise<string> =>
    await page.evaluate((named: Record<string, string>) => {
      const active = document.activeElement;
      if (active === null || active === document.body) return "body";
      for (const [name, selector] of Object.entries(named)) if (active.matches(selector)) return name;
      return `${active.tagName.toLowerCase()}.${active.className}`;
    }, selectors);

  /** The paint the browser resolves for one element: colour, background and border. */
  const paint = async (selector: string) =>
    await page.evaluate((value: string) => {
      const element = document.querySelector(value);
      if (element === null) throw new Error(`no element for ${value}`);
      const style = getComputedStyle(element);
      return { color: style.color, backgroundColor: style.backgroundColor, borderColor: style.borderTopColor };
    }, selector);

  /** The product's own destructive colour, resolved from the token rather than restated here. */
  const danger = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--danger)";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });

  // The quiet control's own paint, read while it is still the thing on the row.
  const quiet = await paint(trigger);

  const rewindPair = { trigger, yes: confirmYes, no: confirmNo };
  // Moment one: a keyboard player standing on the control that arms the pair. Its press is Enter,
  // which is the same press a mouse makes - and the last moment the control itself is on the page.
  await page.locator(trigger).focus();
  console.log(`MEASURE destructive-confirm focus: before="${await focused(rewindPair)}"`);
  expect(await focused(rewindPair), "the pressed control is the one that holds focus").toBe("trigger");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="message-rewind-confirm"]')).toHaveCount(1);

  // Moment two: the confirmation is open and focus went INTO it - onto its cancel answer, the safe
  // one, not onto the button that deletes. It used to fall to <body>, because arming unmounts the very
  // control that was pressed.
  console.log(`MEASURE destructive-confirm focus: on open="${await focused(rewindPair)}"`);
  expect(await focused(rewindPair), "focus enters the confirmation, on its cancel answer").toBe("no");

  const answered = await paint(confirmYes);
  const cancelPaint = await paint(confirmNo);
  console.log(
    `MEASURE destructive-confirm paint: quiet=${quiet.color}/${quiet.backgroundColor} ` +
      `yes=${answered.color}/${answered.backgroundColor} no=${cancelPaint.color}/${cancelPaint.backgroundColor} ` +
      `danger=${danger}`,
  );
  expect(answered.color, "the button that cuts the conversation away carries --danger").toBe(danger);
  expect(answered.color, "and is not painted like the quiet control it replaced").not.toBe(quiet.color);
  expect(answered.backgroundColor, "it also takes the destructive wash, not the quiet plate").not.toBe(
    quiet.backgroundColor,
  );
  expect(cancelPaint.color, "the way out stays quiet: it is not the act").not.toBe(danger);
  expect(cancelPaint.backgroundColor, "and keeps no plate of its own").toBe("rgba(0, 0, 0, 0)");

  // Moment three: cancelling puts the player back on the control they pressed. The control was
  // unmounted while the pair was open, so this is the pair's own restoration, not the browser's.
  await page.click(confirmNo);
  await expect(page.locator('[data-testid="message-rewind-confirm"]')).toHaveCount(0);
  console.log(`MEASURE destructive-confirm focus: after cancel="${await focused(rewindPair)}"`);
  expect(await focused(rewindPair), "cancel returns focus to the control that armed the pair").toBe("trigger");

  // Escape is the same close, from the keyboard the confirmation now owns: it dismisses the pair and
  // still gives the control back.
  await page.locator(trigger).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="message-rewind-confirm"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="message-rewind-confirm"]')).toHaveCount(0);
  expect(await focused(rewindPair), "Escape dismisses the pair and returns focus too").toBe("trigger");

  // The delete pair is the same presentation, so the same three moments are read on it: the last row
  // offers the delete and not the rewind.
  const deleteTrigger = '[data-handle="h4"] [data-testid="message-delete"]';
  const deleteYes = '[data-testid="message-delete-confirm-yes"]';
  const deleteNo = '[data-testid="message-delete-confirm-no"]';
  const deletePair = { trigger: deleteTrigger, yes: deleteYes, no: deleteNo };
  const quietDelete = await paint(deleteTrigger);
  await page.click(deleteTrigger);
  await expect(page.locator('[data-testid="message-delete-confirm"]')).toHaveCount(1);
  expect(await focused(deletePair), "the delete confirmation takes focus too").toBe("no");
  const deleteAnswered = await paint(deleteYes);
  console.log(
    `MEASURE destructive-confirm delete paint: quiet=${quietDelete.color}/${quietDelete.backgroundColor} ` +
      `yes=${deleteAnswered.color}/${deleteAnswered.backgroundColor}`,
  );
  expect(deleteAnswered.color, "the delete's affirmative carries --danger too").toBe(danger);
  expect(deleteAnswered.color, "and is not the quiet delete control's own colour").not.toBe(quietDelete.color);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="message-delete-confirm"]')).toHaveCount(0);
  expect(await focused(deletePair), "and gives the delete control back on Escape").toBe("trigger");
});
