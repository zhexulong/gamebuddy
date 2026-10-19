import { expect, test, type Page } from "@playwright/test";

/**
 * Editing HER reply, mounted, with its own measurements.
 *
 * The owner ruled that a companion's reply is editable - in a roleplay product, correcting the model
 * is one of the most frequent things a player does - and the Host half landed (the store rewrites the
 * row's text AND the active variant it stands on, refuses the greeting with its own code
 * `chat_edit_opening_retained`, and keeps its other refusals by name). What is asserted here is the
 * surface: the capability was unreachable because her rows had no affordance.
 *
 * 1. `one control in the strip she already has, with room to write` - the control is the player row's
 *    edit control on the other side of the exchange: 44 px, an accessible name that says the model
 *    reads the rewritten words from the next turn on, and NO second control (tonight's reviews
 *    complained twice about that strip becoming a wall of buttons). Opened, the strip IS the editor -
 *    the pager, the switcher, regenerate, the rewind and the destructive Delete step aside AND the
 *    bubble gives up its place to the field (the in-place ruling) - and the field takes the panel's
 *    own measure instead of the 187 px slot it was. Measured from the layout at both widths, printed,
 *    and asserted.
 * 2. `rewrites that row in place` - the same handle, the same position, ONE bubble, the same number of
 *    rows, and the editor closes on the row the authoritative reread returned. An edit that appended a
 *    second bubble, or that left the editor open over a refusal, is the defect this measures.
 * 3. `lands on the variant that is active` - her reply's words stand in two places (the row's text and
 *    the variant a later swipe selects back to), and the edit lands on the ACTIVE one: the pager still
 *    says the same position after the edit, the variant the player swipes to carries the Host's own
 *    untouched words, and swiping back shows the edit.
 * 4. `the greeting carries no control at all` - not a disabled one: the greeting has its own editor on
 *    the Characters surface and the Host refuses an edit of it by name, so an affordance that exists
 *    only to refuse is worse than none. The row is still one of HER rows, which is what makes the
 *    absence a decision rather than an accident of role.
 * 5. `a refusal keeps its own sentence, and the conversation it refused is unchanged` - driven through
 *    the real composed shell, because that is where a refusal becomes a sentence. The refusal is
 *    resolved by the authoritative reread when that reread can run, so the conversation is asserted
 *    unchanged there; when the reread cannot run either, the sentence is what the player has, and each
 *    code states its own (a stale order says the conversation moved on, the greeting's own code says
 *    where the greeting IS edited).
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

/** The same two constants the mounted player-edit journey measures against. */
const TOUCH_MINIMUM = 44;
const ONE_ROW = TOUCH_MINIMUM + 1;
/** The panel's own measure, which the field may not exceed. */
const PANEL_MEASURE = 640;
/** The field's floor: below it the words being rewritten are read through a slot. */
const FIELD_FLOOR = 280;

type ReplyEditProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  editControl(handle: string): {
    ariaLabel: string | null;
    title: string | null;
    label: string | null;
    width: number;
    height: number;
    stripHeight: number;
  } | null;
  editForm(handle: string): { value: string | null; save: string | null; cancel: string | null } | null;
  editFieldBox(handle: string): {
    field: { width: number; height: number; left: number; right: number };
    bubble: { width: number; height: number; left: number; right: number } | null;
    strip: { width: number; height: number };
  } | null;
  editCalls(): readonly { handle: string; order: number; text: string }[];
  resetEditCalls(): void;
  applyEditedText(handle: string, text: string): void;
  setPending(pending: { kind: "swipe" | "regenerate" | "opening" | "rewind" | "edit" | "delete"; handle: string } | null): void;
  withSwipes(handle: string, text: string): void;
  swipeTo(handle: string, currentIndex: number, text: string): void;
  transcriptRowCount(): number;
  transcriptRows(): readonly { handle: string | null; index: number; text: string | null; bubbles: number }[];
};

declare global {
  interface Window {
    chatProbe: ReplyEditProbe;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

test("her reply's edit control is one control in the strip she already has, with room to write", async ({ page }) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;
    const control = await page.evaluate(() => window.chatProbe.editControl("h2"));
    // ONE control on her row, and it is the edit: a second one is the wall of buttons the reviews named.
    await expect(page.locator('[data-handle="h2"] [data-testid="message-edit"]'), where).toHaveCount(1);
    // The player row's own bubble and strip, for the claim that her control changes nothing there.
    const playerBubble = await page.locator('[data-handle="h1"] .message-bubble').boundingBox();
    const playerStrip = await page.locator('[data-handle="h1"] .message-actions').boundingBox();

    await page.click('[data-handle="h2"] [data-testid="message-edit"]');
    const box = await page.evaluate(() => window.chatProbe.editFieldBox("h2"));
    const form = await page.evaluate(() => window.chatProbe.editForm("h2"));
    const buttons = await page.locator('[data-handle="h2"] .message-actions button').allTextContents();
    const rows = await page.evaluate(() => window.chatProbe.transcriptRows());

    // Printed before the assertions, so a failing run still reports the numbers it measured.
    console.log(
      `MEASURE journey4.1 ${where}: control ${control?.width}x${control?.height} strip ${control?.stripHeight} | ` +
        `field ${box?.field.width}x${box?.field.height} left ${box?.field.left} right ${box?.field.right} | ` +
        `bubble ${box?.bubble === null || box?.bubble === undefined ? "none (the editor took its place)" : box.bubble.width} | ` +
        `player bubble ${playerBubble?.width} strip ${playerStrip?.height} | ` +
        `rows ${rows.length} handles ${rows.map((row) => row.handle).join(",")}`,
    );

    expect(control, where).not.toBeNull();
    expect(control?.label?.trim(), where).toBe("Edit");
    // The name says whose words the press changes, and what it does to the conversation.
    expect(control?.ariaLabel, where).toContain("Edit this reply");
    expect(control?.ariaLabel, where).toContain("the model reads the new words from the next turn on");
    expect(control?.title, where).toBe(control?.ariaLabel);
    // Measured from the layout: the whole target, not a class name.
    expect(control?.width, where).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    expect(control?.height, where).toBeGreaterThanOrEqual(TOUCH_MINIMUM);
    // Her strip does not wrap at 400 px: one control of the touch minimum is one row.
    expect(control?.stripHeight, where).toBeLessThanOrEqual(ONE_ROW);

    // Opened, the strip IS the editor: Save and Cancel, and nothing beside them.
    expect(buttons.map((label) => label.trim()), where).toEqual(["Save", "Cancel"]);
    expect(await page.locator('[data-handle="h2"] .swipe-controls').count(), where).toBe(0);
    expect(await page.locator('[data-handle="h2"] .regenerate-btn').count(), where).toBe(0);
    // Room to write, and the transcription of what the field holds.
    expect(form?.value, where).toBe("On the pier.");
    expect(box?.field.width, where).toBeGreaterThanOrEqual(FIELD_FLOOR);
    expect(box?.field.width, where).toBeLessThanOrEqual(PANEL_MEASURE);
    await page.click('[data-testid="message-edit-cancel"]');
    // Cancelling puts the one control back and leaves the transcript alone.
    await expect(page.locator('[data-handle="h2"] [data-testid="message-edit"]'), where).toHaveCount(1);
  }
});

test("editing her reply rewrites that row in place, and the editor closes on the row the reread returned", async ({
  page,
}) => {
  await openConversation(page);
  const before = await page.evaluate(() => window.chatProbe.transcriptRows());
  await page.evaluate(() => window.chatProbe.resetEditCalls());

  await page.click('[data-handle="h2"] [data-testid="message-edit"]');
  const opened = await page.evaluate(() => window.chatProbe.editForm("h2"));
  expect(opened?.value).toBe("On the pier.");
  // Opening is not a command.
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([]);

  await page.fill('[data-testid="message-edit-field"]', "At the pier.");
  await page.click('[data-testid="message-edit-save"]');
  // The pair the Host checks: the handle, the words, and the order this page rendered the row at.
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([
    { handle: "h2", order: 2, text: "At the pier." },
  ]);

  // In flight, the editor stays open with the words the player typed.
  await page.evaluate(() => window.chatProbe.setPending({ kind: "edit", handle: "h2" }));
  expect(await page.evaluate(() => window.chatProbe.editForm("h2"))).not.toBeNull();
  await page.evaluate(() => window.chatProbe.setPending(null));

  // The authoritative reread is what lands it, and what closes the editor.
  await page.evaluate(() => window.chatProbe.applyEditedText("h2", "At the pier."));
  await expect(page.locator('[data-handle="h2"] [data-testid="message-edit-form"]')).toHaveCount(0);
  await expect(page.locator('[data-handle="h2"] .message-bubble')).toContainText("At the pier.");

  const after = await page.evaluate(() => window.chatProbe.transcriptRows());
  console.log(
    `MEASURE journey4.2: rows ${before.length} -> ${after.length} handles ${after
      .map((row) => row.handle)
      .join(",")} row2 index ${after[2]?.index} bubbles ${after[2]?.bubbles} text ${JSON.stringify(after[2]?.text)}`,
  );
  // In place: the same handles, in the same order, one bubble each - nothing appended, nothing split.
  expect(after.map((row) => row.handle)).toEqual(before.map((row) => row.handle));
  expect(after.length).toBe(before.length);
  expect(after[2]?.index).toBe(2);
  expect(after[2]?.bubbles).toBe(1);
  // And the one control is back on the row.
  await expect(page.locator('[data-handle="h2"] [data-testid="message-edit"]')).toHaveCount(1);
});

test("with several variants on her row, the edit lands on the active one and the others are untouched", async ({
  page,
}) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.withSwipes("h2", "On the pier."));
  await page.evaluate(() => window.chatProbe.resetEditCalls());
  await expect(page.locator('[data-handle="h2"] .swipe-indicator')).toHaveText("2/3");

  await page.click('[data-handle="h2"] [data-testid="message-edit"]');
  await page.fill('[data-testid="message-edit-field"]', "At the pier.");
  await page.click('[data-testid="message-edit-save"]');
  expect(await page.evaluate(() => window.chatProbe.editCalls())).toEqual([
    { handle: "h2", order: 2, text: "At the pier." },
  ]);
  await page.evaluate(() => window.chatProbe.applyEditedText("h2", "At the pier."));
  await expect(page.locator('[data-handle="h2"] [data-testid="message-edit-form"]')).toHaveCount(0);

  // The edit did not move the row off the variant it was on, and the pager still says which one that is.
  await expect(page.locator('[data-handle="h2"] .swipe-indicator')).toHaveText("2/3");
  await expect(page.locator('[data-handle="h2"] .message-bubble')).toContainText("At the pier.");

  // Swiping to the first variant: the words the Host holds for it are its own, and the edit is not there.
  await page.evaluate(() => window.chatProbe.swipeTo("h2", 0, "By the docks."));
  await expect(page.locator('[data-handle="h2"] .swipe-indicator')).toHaveText("1/3");
  await expect(page.locator('[data-handle="h2"] .message-bubble')).toContainText("By the docks.");
  await expect(page.locator('[data-handle="h2"] .message-bubble')).not.toContainText("At the pier.");

  // And back: the active variant is the one that carries the edit.
  await page.evaluate(() => window.chatProbe.swipeTo("h2", 1, "At the pier."));
  await expect(page.locator('[data-handle="h2"] .swipe-indicator')).toHaveText("2/3");
  await expect(page.locator('[data-handle="h2"] .message-bubble')).toContainText("At the pier.");

  const rows = await page.evaluate(() => window.chatProbe.transcriptRows());
  console.log(
    `MEASURE journey4.3: rows ${rows.length} handles ${rows.map((row) => row.handle).join(",")} row2 bubbles ${
      rows[2]?.bubbles
    } text ${JSON.stringify(rows[2]?.text)}`,
  );
  expect(rows.length).toBe(5);
  expect(rows[2]?.bubbles).toBe(1);
  expect(rows.map((row) => row.handle)).toEqual(["h0", "h1", "h2", "h3", "h4"]);
});

test("the greeting carries no edit control at all, while her other rows carry one", async ({ page }) => {
  await openConversation(page);

  // The greeting is still one of HER rows - the same role as the two that are editable - so its lack of
  // a control is the surface's own decision, not a consequence of who spoke.
  await expect(page.locator('[data-handle="h0"]')).toHaveClass(/companion/);
  expect(await page.evaluate(() => window.chatProbe.editControl("h0"))).toBeNull();
  await expect(page.locator('[data-handle="h0"] [data-testid="message-edit"]')).toHaveCount(0);
  // Not even a disabled one: the affordance is absent here rather than offered and refused.
  await expect(page.locator('[data-handle="h0"] [data-testid="message-edit"][disabled]')).toHaveCount(0);

  // Her replies, on the other hand, each carry exactly one.
  expect(await page.evaluate(() => window.chatProbe.editControl("h2"))).not.toBeNull();
  expect(await page.evaluate(() => window.chatProbe.editControl("h4"))).not.toBeNull();
  await expect(page.locator('[data-handle="h2"] [data-testid="message-edit"]')).toHaveCount(1);
  await expect(page.locator('[data-handle="h4"] [data-testid="message-edit"]')).toHaveCount(1);

  const rows = await page.evaluate(() => window.chatProbe.transcriptRows());
  console.log(
    `MEASURE journey4.4: rows ${rows.length} handles ${rows.map((row) => row.handle).join(",")} opening row index ${
      rows[0]?.index
    }`,
  );
  expect(rows.map((row) => row.handle)).toEqual(["h0", "h1", "h2", "h3", "h4"]);
});

/**
 * The refusal journey's fixtures: the composed shell's own bootstrap root, with a conversation that has
 * the greeting at order 0, the player's line, and her reply - so the row the edit targets is a real one.
 */
const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const characterHandle = "D".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const greetingHandle = "G".repeat(42) + "A";
const playerHandle = "P".repeat(42) + "A";
const replyHandle = "R".repeat(42) + "A";

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira", handle: characterHandle },
    title: "Reference Game Chat",
    transcript: [
      { handle: greetingHandle, role: "companion", text: "Good morning.", locale: "und", order: 0, revision: 1 },
      { handle: playerHandle, role: "player", text: "Where are we?", locale: "und", order: 1, revision: 1 },
      { handle: replyHandle, role: "companion", text: "On the pier.", locale: "und", order: 2, revision: 1 },
    ],
    draft: { revision: 4, present: true },
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

const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat,
  game,
};

const draft = { apiVersion: 1, revision: 4, text: "A durable delegated draft." };

/** A refusal the Host sends, in the shape the client validates. */
function refusal(code: string): string {
  return JSON.stringify({
    type: "about:blank",
    title: "Message refused",
    status: 409,
    code,
    requestId: handle,
    retryable: false,
  });
}

test("a refusal keeps its own sentence, and the conversation it refused is unchanged", async ({ page }) => {
  let stateFails = false;
  let refusalCode = "chat_message_revision_conflict";
  let editRequests = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    stateFails
      ? route.fulfill({ status: 503, contentType: "application/json", body: refusal("state_unavailable") })
      : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/messages/edit", (route) => {
    editRequests += 1;
    return route.fulfill({ status: 409, contentType: "application/json", body: refusal(refusalCode) });
  });

  const startEdit = async (): Promise<void> => {
    await page.click(`[data-handle="${replyHandle}"] [data-testid="message-edit"]`);
    await page.fill('[data-testid="message-edit-field"]', "At the pier.");
  };
  // A refusal leaves the editor open with the words the player typed (it costs them the press, not the
  // rewrite), so a second refusal is driven by pressing Save again rather than by reopening the field.
  const save = async (): Promise<void> => {
    await page.click('[data-testid="message-edit-save"]');
  };
  /** Wait until the refusal has run all the way through: sent, and settled back to an idle row. */
  const settle = async (sent: number): Promise<void> => {
    await expect.poll(() => editRequests).toBe(sent);
    await expect(page.locator(`[data-handle="${replyHandle}"][data-pending="edit"]`)).toHaveCount(0);
  };
  const transcript = async (): Promise<{ rows: number; handles: string[]; words: string[] }> => ({
    rows: await page.locator("ol.message-list > li[data-handle]").count(),
    handles: await page.locator("ol.message-list > li[data-handle]").evaluateAll((rows: Element[]) =>
      rows.map((row) => row.getAttribute("data-handle") ?? ""),
    ),
    words: await page.locator("ol.message-list .message-bubble").allTextContents(),
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  // The refusal the authoritative reread can resolve: the conversation is what the player keeps, the
  // refusal does not become a sentence about a fault that did not happen, and the words are not lost.
  await expect(page.locator(`[data-handle="${replyHandle}"] [data-testid="message-edit"]`)).toHaveCount(1);
  const before = await transcript();
  await startEdit();
  await save();
  await settle(1);
  await expect(page.locator('[data-testid="message-edit-form"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="message-edit-field"]')).toHaveValue("At the pier.");
  // While the editor is open the row shows the EDITOR, not its bubble (the in-place ruling), so the
  // conversation is compared with the editor closed: Cancel brings the row's own words back, and the
  // comparison is then exactly the one this test is about - a refused edit changed nothing.
  await page.click('[data-testid="message-edit-cancel"]');
  await expect(page.locator('[data-testid="message-edit-form"]')).toHaveCount(0);
  const after = await transcript();
  console.log(
    `MEASURE journey4.5a: rows ${before.rows} -> ${after.rows} handles ${after.handles.join(",")} words ${JSON.stringify(
      after.words,
    )} alerts ${await page.getByRole("alert").count()}`,
  );
  expect(after.rows).toBe(before.rows);
  expect(after.handles).toEqual(before.handles);
  expect(after.words).toEqual(before.words);
  expect(await page.getByRole("alert").count()).toBe(0);

  // The same refusal when the reread cannot run either: now the sentence IS what the player has, and a
  // stale order says the conversation moved on rather than "something went wrong".
  stateFails = true;
  await startEdit();
  await save();
  await settle(2);
  await expect(page.getByRole("alert")).toContainText("The conversation moved");
  await expect(page.getByRole("alert")).toContainText("no longer where the page read it");
  console.log(`MEASURE journey4.5b: alert ${JSON.stringify(await page.getByRole("alert").innerText())}`);

  // The greeting's own refusal has its own sentence, and it does not borrow the stale order's words.
  // This is the code arriving at the surface, which no control on it can earn any more: the greeting
  // carries no edit control, and the Host is still the one that names what a row like this is.
  refusalCode = "chat_edit_opening_retained";
  // A fresh mount: the boot token is stripped from the fragment on the way in, so re-navigating to it is
  // a same-document fragment change and would not remount the shell.
  await page.goto("about:blank");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(`[data-handle="${replyHandle}"] [data-testid="message-edit"]`)).toHaveCount(1);
  await startEdit();
  await save();
  await settle(3);
  await expect(page.getByRole("alert")).toContainText("That is the opening");
  await expect(page.getByRole("alert")).toContainText("Characters surface");
  await expect(page.getByRole("alert")).not.toContainText("The conversation moved");
  console.log(`MEASURE journey4.5c: alert ${JSON.stringify(await page.getByRole("alert").innerText())}`);
});
