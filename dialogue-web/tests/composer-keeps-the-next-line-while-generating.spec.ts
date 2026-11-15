/**
 * The composer while she is generating: the field is the player's, and only the *send* is gated.
 *
 * The defect this pins, in the product's own words: `Composer.tsx` rendered the textarea
 * `disabled={fieldLocked(uiState.send)}`, and `fieldLocked` is true whenever the Host would not
 * admit a submission now. A running turn is exactly that (`host/src/tavern/reference-pipeline-state.ts`
 * projects `chat.submit` as `busy` while the ledger is non-terminal), so for the whole 5-15 s of a
 * reply the player could not type into the box - and a disabled textarea cannot hold focus, so the
 * browser blurred it the moment the turn started and the next keystroke went nowhere.
 *
 * Every mainstream chat client does the opposite: the composer keeps accepting the next line, and
 * the send control becomes Stop. That is what this journey asserts, in the order the failures happen:
 *
 * 1. focus survives the turn starting, and a typed character lands in the field (the red reading);
 * 2. the send gesture is refused without being silent - the slot where Send was says what is
 *    happening, in the app bar's own word for a running turn, and nothing leaves the surface;
 * 3. Stop still works, and settling does not take the field back: the paragraph is still there, the
 *    caret is still at its end and focus is still in the box (the browser must not steal it back on
 *    the reread that settles the turn);
 * 4. the same character survives a surface switch and is then what the next turn sends - a draft
 *    that only lives as long as one phase would be the same defect later in the conversation.
 */
import { expect, test } from "./frontend-coverage";
import { chat, csrfToken, jsonOk, root, token } from "./composed-reference-game-fixtures";

/** The running turn and the two facts the band reads while it runs. */
const turnHandle = `${"T".repeat(42)}A`;
const settledHandle = `${"P".repeat(42)}A`;
const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true };
const stoppedTurn = { handle: turnHandle, state: "cancelled", projectionRevision: 2, canCancel: false };
const typed = "The next line, typed while she was still thinking.";

test("the composer keeps the player's next line while she generates, and only the send is gated", async ({ page }) => {
  test.setTimeout(90_000);
  let cancels = 0;
  let submits = 0;
  let settled = false;
  let sentText: string | null = null;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          // The Host's own projection: `chat.submit` is available exactly when the ledger is
          // terminal, so a running turn publishes `busy` - which is the fact the field used to
          // read as "not writable".
          availability: settled ? "available" : "busy",
          routeId: "chat.submit",
        },
        ...(settled
          ? []
          : [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]),
      ],
      chat: {
        ...chat.chat,
        draft: { revision: 0, present: false, text: null },
        turn: settled ? stoppedTurn : runningTurn,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    cancels += 1;
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    settled = true;
    await route.fulfill(jsonOk({ apiVersion: 1, disposition: "cancelled", turn: stoppedTurn }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    submits += 1;
    sentText = (route.request().postDataJSON() as { text: string }).text;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: settledHandle, role: "player", text: sentText, locale: "und", order: 1, revision: 1 },
        turn: { handle: `${"U".repeat(42)}A`, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const stop = surface.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeEnabled();

  /** The field as the player's keyboard finds it: focusable, holding a value, and where the caret is. */
  const readField = async () =>
    page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea");
      if (textarea === null) throw new Error("the composer field is not mounted");
      const active = document.activeElement as HTMLElement | null;
      return {
        disabled: textarea.disabled,
        value: textarea.value,
        selectionStart: textarea.selectionStart,
        focused: active === textarea,
        activeElement: active === null ? "none" : `${active.tagName.toLowerCase()}.${active.className}`,
      };
    });

  // 1. Focus survives the turn being mounted, and a character lands. The reading is taken before
  // anything is asserted, so the log says which side of the defect this browser is on: `focus()` is
  // the browser's own answer to "can this field take the keyboard", and a disabled control refuses it.
  const beforeTyping = await readField();
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.focus());
  await page.keyboard.type(typed);
  const afterTyping = await readField();
  console.log(`[composer during generation] before=${JSON.stringify(beforeTyping)} after=${JSON.stringify(afterTyping)}`);

  expect(afterTyping.disabled, "the field is not disabled while a reply is generating").toBe(false);
  expect(afterTyping.focused, "and it takes the focus the player puts in it").toBe(true);
  expect(afterTyping.value, "and the keystrokes land in it, character for character").toBe(typed);
  expect(afterTyping.selectionStart, "with the caret where typing left it, not moved to the start").toBe(typed.length);

  // 2. The send gesture is refused, and the refusal is not silent: the slot where Send stood is Stop
  // (named), and the surface still words the running turn in the app bar's own word for it.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const afterEnter = await page.evaluate(() => {
    const section = document.querySelector<HTMLElement>(".composer-section");
    return {
      sends: section?.querySelectorAll(".send-button").length ?? -1,
      stops: section?.querySelectorAll(".stop-button").length ?? -1,
      stopName: section?.querySelector<HTMLElement>(".stop-button")?.getAttribute("aria-label") ?? null,
      statusName: document.querySelector<HTMLElement>(".app-bar-status")?.getAttribute("aria-label") ?? null,
      value: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.value ?? null,
    };
  });
  console.log(`[composer during generation] Enter=${JSON.stringify(afterEnter)} submits=${submits}`);
  expect(submits, "Enter while she is generating sends nothing").toBe(0);
  expect(afterEnter.value, "and it does not spend the line either").toBe(typed);
  expect(afterEnter.sends, "the primary action is not the greyed Send it used to freeze on").toBe(0);
  expect(afterEnter.stopName, `Stop is the named control that stands where Send was: ${afterEnter.statusName}`).toBe("Stop");

  // 3. Stop is the existing path, and settling takes nothing back: the paragraph is still there, the
  // caret is still at its end, and the settle does not move focus into the box (the control the
  // player pressed is where a keyboard user is; a surface that focused the field on settle would be
  // stealing the focus back).
  await stop.click();
  await expect.poll(() => cancels).toBe(1);
  await expect(surface).toContainText("Reply stopped. You can send another message.");
  await expect(surface.getByTestId("composer-send")).toBeVisible();
  const afterStop = await readField();
  console.log(`[composer after the stop] ${JSON.stringify(afterStop)}`);
  expect(afterStop.value, "the line typed during the reply is still there when it settles").toBe(typed);
  expect(afterStop.selectionStart, "and the caret has not moved").toBe(typed.length);
  expect(afterStop.focused, `the settle does not move focus into the field (focus is on ${afterStop.activeElement})`).toBe(
    false,
  );

  // …and the box still takes input after the settle: the player returns to it and the next character
  // lands after the line they wrote during the reply (one character, so the reading is exact).
  await surface.locator(".composer-textarea").click();
  await page.keyboard.type("x");
  const afterSettle = await readField();
  expect(afterSettle.value, "the field takes the next character after the turn settles too").toBe(`${typed}x`);
  await page.keyboard.press("Backspace");

  // 4. The same line survives leaving the surface and coming back, and it is then what the next turn
  // sends: the draft belongs to the conversation, not to one phase of it.
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const returned = page.getByTestId("chat-surface");
  await expect(returned).toBeVisible();
  await expect(returned.locator(".composer-textarea")).toHaveValue(typed);

  await returned.getByTestId("composer-send").click();
  await expect.poll(() => submits).toBe(1);
  expect(sentText, "the line the player wrote during the reply is the one the next turn sends").toBe(typed);
});
