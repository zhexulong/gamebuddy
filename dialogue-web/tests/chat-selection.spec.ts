/**
 * Choosing which conversation is mounted, and what a late answer to an earlier choice does.
 *
 * The whole Chats row selects its own conversation and the row's buttons do not; clicking the
 * already-mounted chat issues no selection; a stale generation is refused rather than mounted;
 * a `turn_in_flight` answer leaves the player where they were; moving to another chat reseeds
 * the composer from that chat's own durable draft and aborts the turn being generated.
 */
import { expect, test } from "./frontend-coverage";
import { token, handle, csrfToken, draft, chat, root, jsonOk } from "./composed-reference-game-fixtures";

/**
 * Chat selection (ADR-0009, turn-level). Choosing another Chat must switch the mounted
 * conversation inside the same process while the runtime is idle, and must refuse with a reason the
 * player can act on while a turn is generating. The surface may never claim a switch it did not
 * make, and it may never leave the player with a raw code or a "restart the app" dead end.
 */
test("Chats surface switches the mounted conversation on click and refuses a stale generation", async ({ page }) => {
  const secondHandle = "C".repeat(42) + "A";
  const thirdHandle = "D".repeat(42) + "A";
  let selectRequests = 0;
  let listReads = 0;
  let selectStatus = 200;
  let selectTarget = secondHandle;
  // The Host's own mounted Chat: a real switch changes it, so the next /state read is the target's.
  let mountedHandle = handle;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      { handle: secondHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === secondHandle, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
      { handle: thirdHandle, title: "Third conversation", status: "active", managementRevision: 1, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: null },
    ],
  });
  const secondChat = {
    ...chat,
    selection: { chatHandle: secondHandle, generation: 2, stateRevision: secondHandle },
    chat: {
      ...chat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: "E".repeat(42) + "A",
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? chat : secondChat });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      listReads += 1;
      return route.fulfill(jsonOk(listOf()));
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, selectionGeneration: 1, chatHandle: selectTarget });
    if (selectStatus !== 200)
      return route.fulfill({
        status: selectStatus,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Chat selection conflict",
          status: selectStatus,
          code: "selection_conflict",
          requestId: handle,
          retryable: false,
        }),
      });
    mountedHandle = selectTarget;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The conversation the app opens on is the first chat's.
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("The game projection is read-only.");
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect(surface.getByTestId("chat-item")).toHaveCount(3);

  // The mounted chat is the selected row.
  await expect(surface.getByTestId("chat-item").first()).toHaveAttribute("data-selected", "true");
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "false");

  // Clicking the already-mounted chat is not a selection: no admission at all. It is still the
  // player choosing the conversation in front of them, so it shows it and adds the list's own step
  // back rather than swallowing the gesture.
  await surface.getByTestId("chat-item").first().getByTestId("chat-select").click();
  await page.waitForTimeout(50);
  expect(selectRequests, "selecting the mounted chat must not create a second admission").toBe(0);
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );
  await page.goBack();
  await expect(surface).toBeVisible();

  // A stale generation is a bounded refusal: the failure is reported and the list re-read.
  selectStatus = 409;
  selectTarget = thirdHandle;
  const readsBefore = listReads;
  await surface.getByTestId("chat-item").nth(2).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);
  await expect(surface.getByRole("status")).toContainText("The conversation moved on since the page read it, so your change was not applied. Reload the chat to see the current state, then try again.");
  await expect.poll(() => listReads).toBeGreaterThan(readsBefore);

  // An idle switch: the Host switches the mounted conversation in process and answers `switched`, and
  // the shell adopts the target's snapshot and brings the player to it (ADR-0010 Class A - choosing a
  // conversation is a focus transfer). No restart happens anywhere, and no "next start" promise is made.
  selectStatus = 200;
  selectTarget = secondHandle;
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(2);

  // Choosing the conversation is what shows it: the Chats list is gone and the target's transcript is
  // the conversation on screen.
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText("The game projection is read-only.");

  // Browser Back returns to the list, where the chosen row is the selected one - the move added the
  // conversation's own entry rather than replacing the list's.
  await page.goBack();
  await expect(surface.getByTestId("chat-item").nth(1)).toHaveAttribute("data-selected", "true");

  // The now-mounted chat is chosen again: still no second admission, and the click is answered -
  // the conversation it names is what the player is looking at.
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await page.waitForTimeout(50);
  expect(selectRequests, "re-selecting the mounted chat must not create a second admission").toBe(2);
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );
});


/**
 * The row's own click, when the row IS the mounted Chat. The Host has nothing to switch to and no
 * selection may be admitted - a second admission for the Chat the runtime already holds is exactly
 * what the mounted-handle guard stops - but the gesture is still the player choosing the
 * conversation in front of them.
 *
 * The defect this pins: `selectChat` returned early on the mounted handle, so the click did nothing
 * at all. The list showed a title button, the player pressed it, and neither the surface moved nor
 * was the gesture acknowledged, while every other row moved them to its conversation.
 *
 * The assertions, and the failure each one catches:
 *  - no `chat/select` request is issued: catches the no-op turned into a request, admitting a
 *    selection for a Chat the runtime already has mounted;
 *  - the Chat surface is the shown one, carrying the mounted conversation's own heading and
 *    transcript: catches the silent no-op this test exists for;
 *  - Browser Back returns to the Chats list with that row still selected: catches a move that
 *    replaced the list's own history entry instead of adding the conversation's.
 */
test("clicking the already-mounted Chat shows it and issues no selection", async ({ page }) => {
  let selectRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
          { handle: `${'C'.repeat(42)}A`, title: "Second conversation", status: "active", managementRevision: 1, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: "She is already on the porch with the lantern." },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selectRequests += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The journey starts where the player does: the conversation, not the list.
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);
  const mountedRow = chats.getByTestId("chat-item").first();
  await expect(mountedRow).toHaveAttribute("data-selected", "true");
  await expect(mountedRow.getByTestId("chat-select")).toBeEnabled();

  await mountedRow.getByTestId("chat-select").click();

  // The click is a choice, not a selection request.
  await page.waitForTimeout(50);
  expect(selectRequests, "the already-mounted Chat must not create a selection admission").toBe(0);
  // And the choice is answered: the conversation is what the player is looking at, and it is the
  // one the row named.
  const conversation = page.getByTestId("chat-surface");
  await expect(conversation).toBeVisible();
  await expect(chats).toHaveCount(0);
  await expect(conversation.locator(".timeline-heading h1")).toHaveText("Reference Game Chat");
  await expect(conversation.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );

  // The move added the conversation's own history entry, so the list is one step back.
  await page.goBack();
  await expect(page.getByTestId("chats-surface").getByTestId("chat-item").first()).toHaveAttribute(
    "data-selected",
    "true",
  );
});


/**
 * The row is a select control across its whole surface, not only across its title.
 *
 * The measured defect: only the title line is inside `[data-testid="chat-select"]`,
 * while the preview and the stamp - the rest of the row's area, and almost all of it
 * on a phone - are outside it, so a thumb that lands on the preview does nothing at
 * all. The row's own surface now carries the same gesture its title does, and the
 * row's action buttons stop the event rather than the row wrapping them in a button
 * that would nest one control inside another.
 *
 * The assertions, and the failure each one catches:
 *  - the mounted row's preview opens the conversation with no `chat/select` request:
 *    catches the dead preview and a preview that admits a selection for the Chat the
 *    runtime already holds;
 *  - another row's preview sends the selection naming *that* row's Chat: catches a
 *    surface that selects the wrong conversation, or none;
 *  - a row's action button still only arms its own confirmation and sends no
 *    selection: catches the new surface swallowing the buttons that live inside it;
 *  - the armed confirmation is outside the surface: catches a press on the
 *    confirmation's own words selecting the Chat behind it.
 */
test("the whole Chats row selects its conversation: the preview and stamp too, never the row's own buttons", async ({
  page,
}) => {
  const secondHandle = "C".repeat(42) + "A";
  const selections: string[] = [];
  let mountedHandle = handle;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      { handle: secondHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === secondHandle, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
    ],
  });
  const secondChat = {
    ...chat,
    selection: { chatHandle: secondHandle, generation: 2, stateRevision: secondHandle },
    chat: {
      ...chat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: "E".repeat(42) + "A",
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? chat : secondChat });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => route.fulfill(jsonOk(listOf())));
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    const body = route.request().postDataJSON() as { chatHandle: string };
    selections.push(body.chatHandle);
    mountedHandle = body.chatHandle;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);
  const first = chats.getByTestId("chat-item").first();
  const second = chats.getByTestId("chat-item").nth(1);
  await expect(first).toHaveAttribute("data-selected", "true");

  // The preview is most of the row and it is inside the surface now, so choosing the
  // mounted conversation needs no admission - exactly as choosing its title does not.
  await first.getByTestId("chat-item-preview").click();
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(chats).toHaveCount(0);
  expect(selections, "the mounted Chat must not create a selection admission").toEqual([]);
  await page.goBack();
  await expect(first).toBeVisible();

  // Another row's preview names that row's conversation, and moves to it.
  await second.getByTestId("chat-item-preview").click();
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toBe(secondHandle);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );
  await page.goBack();
  await expect(first).toBeVisible();
  expect(selections.length, "returning to the list selects nothing").toBe(1);

  // The row's own action button still does only its own action: it arms the
  // confirmation in place and admits no selection.
  await first.getByRole("button", { name: "Archive", exact: true }).click();
  const confirm = first.getByTestId("chat-retention-confirm");
  await expect(confirm).toBeVisible();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  expect(selections, "the Archive button must not also select the conversation").toHaveLength(1);

  // …and the confirmation it opened is outside the surface: its own words are not a
  // second way to select the Chat behind it.
  await confirm.locator(".chat-item-confirm-prompt").click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  expect(selections, "the armed confirmation must not be inside the click surface").toHaveLength(1);
});


/**
 * Selecting a Chat is a focus transfer: the conversation it names is what the
 * player is looking at next (ADR-0010 Class A - "click another conversation and
 * it shows immediately", the behaviour ChatGPT, Claude and SillyTavern all have).
 *
 * The measured defect this pins: the row's click moved the mount, the selected
 * cursor and the live stream, but the shell stayed on the Chats list, so the
 * player had to find the Chat entry in the app bar and click it by hand to see
 * the conversation they had just chosen.
 *
 * The assertions, and the failure each one catches:
 *  - after the `switched` answer the Chat surface is the shown one and the Chats
 *    list is gone: catches a selection that only moved the cursor;
 *  - the conversation's own title and transcript are what the player sees:
 *    catches a switch that showed the Chat surface but kept the previous
 *    conversation mounted in it;
 *  - Browser Back returns to the Chats list with the chosen row selected:
 *    catches a surface move that replaced the list's history entry instead of
 *    adding the conversation's own.
 */
test("selecting a chat from the Chats list shows that conversation", async ({ page }) => {
  const secondHandle = "C".repeat(42) + "A";
  let mountedHandle = handle;
  let selectRequests = 0;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      {
        handle: secondHandle,
        title: "Second conversation",
        status: "active",
        managementRevision: 1,
        isSelected: mountedHandle === secondHandle,
        updatedAtMs: 1_760_086_400_000,
        preview: "She is already on the porch with the lantern.",
      },
    ],
  });
  const secondChat = {
    ...chat,
    selection: { chatHandle: secondHandle, generation: 2, stateRevision: secondHandle },
    chat: {
      ...chat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: "E".repeat(42) + "A",
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? chat : secondChat });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") return route.fulfill(jsonOk(listOf()));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    const body = route.request().postDataJSON() as { chatHandle: string };
    mountedHandle = body.chatHandle;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);

  await chats.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);

  // The chosen conversation is what the player is now looking at.
  const conversation = page.getByTestId("chat-surface");
  await expect(conversation).toBeVisible();
  await expect(chats).toHaveCount(0);
  await expect(conversation.locator(".timeline-heading h1")).toHaveText("Second conversation");
  await expect(conversation.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );

  // The list is a real step back, not a replaced entry.
  await page.goBack();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await expect(page.getByTestId("chats-surface").getByTestId("chat-item").nth(1)).toHaveAttribute(
    "data-selected",
    "true",
  );
});


/**
 * The other side of the focus transfer: a `turn_in_flight` answer is not a switch.
 * The Host deliberately stayed where it was (ADR-0010's narrow `accepted_queued`
 * window, where there is no cancel migration to abort with and the mount cannot be
 * torn down), so the shell must not move the region either - the player keeps the
 * list, the recorded selection stays durable, and the refusal is stated rather than
 * silently ignored.
 *
 * The assertions, and the failure each one catches:
 *  - the refusal notice is what the surface shows: catches a `turn_in_flight` answer
 *    being reported as a completed switch;
 *  - the Chats list is still the shown surface and no Chat surface was mounted:
 *    catches a surface move keyed on the click rather than on the Host's answer.
 */
test("a turn_in_flight selection answer leaves the player on the Chats list", async ({ page }) => {
  const secondHandle = "C".repeat(42) + "A";
  let selectRequests = 0;
  const listOf = () => ({
    apiVersion: 1,
    chats: [
      { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
      {
        handle: secondHandle,
        title: "Second conversation",
        status: "active",
        managementRevision: 1,
        isSelected: false,
        updatedAtMs: 1_760_086_400_000,
        preview: "She is already on the porch with the lantern.",
      },
    ],
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") return route.fulfill(jsonOk(listOf()));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selectRequests += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "turn_in_flight" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await chats.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);

  // The refusal is stated, and the player is still where they were.
  await expect(chats.getByRole("status")).toContainText("runtime stayed where it is");
  await expect(page.getByTestId("chats-surface")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toHaveCount(0);
});


/**
 * A Chat switch reseeds the composer from the target chat's own durable draft.
 *
 * The failure this catches: the field-seeding rule keyed only on the durable
 * revision and a local dirty flag, both of which are chat-local. Text typed in
 * one chat (or a revision that happens to match the other chat's) survived the
 * switch and sat in the new chat's box as a message the player never wrote
 * there. The field belongs to the mounted conversation, so a switch takes the
 * target's own draft as its truth - never a dirty flag from the chat just left.
 */
test("switching chats reseeds the composer from the target chat's own durable draft", async ({ page }) => {
  const secondHandle = `${'C'.repeat(42)}A`;
  const secondDraft = { apiVersion: 1, revision: 7, text: "The second chat's own draft." };
  let mountedHandle = handle;
  let selectRequests = 0;
  let sentText = "";

  const firstChat = {
    ...chat,
    operations: [
      { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
    ],
  };
  const secondChat = {
    ...firstChat,
    selection: { chatHandle: secondHandle, generation: 2, stateRevision: secondHandle },
    chat: {
      ...firstChat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: `${'E'.repeat(42)}A`,
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
      draft: { revision: secondDraft.revision, present: secondDraft.text !== null, text: secondDraft.text },
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? firstChat : secondChat });
  const mountedDraft = () => (mountedHandle === handle ? draft : secondDraft);

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(mountedDraft())));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
          {
            handle: secondHandle,
            title: "Second conversation",
            status: "active",
            managementRevision: 1,
            isSelected: mountedHandle === secondHandle,
            updatedAtMs: 1_760_086_400_000,
            preview: "She is already on the porch with the lantern.",
          },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    const body = route.request().postDataJSON() as { chatHandle: string };
    mountedHandle = body.chatHandle;
    await route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sentText = (route.request().postDataJSON() as { text: string }).text;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: `${'P'.repeat(42)}A`, role: "player", text: sentText, locale: "und", order: 1, revision: 1 },
        turn: { handle: `${'T'.repeat(42)}A`, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  // The first chat seeds its own durable draft.
  await expect(composer).toHaveValue("A durable delegated draft.");

  // The player types something the Host has not been told about.
  await composer.fill("Unsaved line typed in the first chat");

  // Switch to the second conversation. Choosing it shows it (ADR-0010 Class A), so the composer
  // asserted below belongs to the conversation that was just mounted, not to the list.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const chats = page.getByTestId("chats-surface");
  await expect(chats.getByTestId("chat-item")).toHaveCount(2);
  await chats.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(1);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");

  // The box shows the target chat's own draft, not the text typed in the chat
  // the player just left.
  await expect(composer).toHaveValue("The second chat's own draft.");
  await expect(composer).not.toHaveValue("Unsaved line typed in the first chat");

  // And what is sent is that draft, not the leaked text.
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sentText).toBe("The second chat's own draft.");
});


/**
 * The unified action rule (ADR-0010), Class A: selecting another Chat is a focus transfer, and a
 * focus transfer is never withheld. While a turn is generating the rows stay ENABLED, the click
 * reaches the selection route, the Host aborts the running turn through the same cancel path an
 * explicit Stop uses, the outcome is `switched`, and the conversation the app shows is the
 * target's.
 *
 * The assertions, and the failure each one catches:
 *  - `chat-select` is enabled with no `chat-select-blocked` notice: catches the grey-out, which held
 *    the player's attention hostage while another conversation was one click away.
 *  - The selection route is reached exactly once: catches a control that silently swallows the
 *    click.
 *  - `chat-select-pending` while the request is out, gone once it lands: catches a click that looks
 *    ignored - the acknowledgement is a request, never a refusal.
 *  - The Chats list giving way to the target's transcript: catches a Host answer that refuses the
 *    switch (the old `turn_in_flight` reading) instead of performing it, and a switch that moved the
 *    mount but left the player on the list.
 *  - The interrupted turn's produced text present again after switching back, with its Stop gone:
 *    catches an abort that throws away the part of the reply the player had already been shown.
 */
test("clicking another chat while a turn generates aborts that turn and switches", async ({ page }) => {
  let selectRequests = 0;
  let mountedHandle = handle;
  const targetHandle = "C".repeat(42) + "A";
  const runningTurnHandle = "F".repeat(42) + "A";
  // What the interrupted turn had already produced: aborting it to switch must keep this text, not
  // discard the part of the reply the player had already been shown.
  const producedText = "And then she said, before the switch interrupted her,";
  let selectTarget = targetHandle;
  let selectGeneration = 1;
  // A generating turn on the first conversation. The switch aborts it; its produced text stays.
  let turnRunning = true;
  const firstChat = () => ({
    ...chat,
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    operations: turnRunning
      ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
      : [],
    chat: {
      ...chat.chat,
      transcript: [
        ...chat.chat.transcript,
        {
          handle: runningTurnHandle,
          role: "companion",
          text: producedText,
          locale: "und",
          order: 1,
          revision: 1,
        },
      ],
      turn: turnRunning
        ? { handle: runningTurnHandle, state: "running", projectionRevision: 1, canCancel: true }
        : null,
    },
  });
  const targetChat = {
    ...chat,
    selection: { chatHandle: targetHandle, generation: 2, stateRevision: targetHandle },
    chat: {
      ...chat.chat,
      title: "Second conversation",
      transcript: [
        {
          handle: "E".repeat(42) + "A",
          role: "companion",
          text: "This is the second conversation.",
          locale: "und",
          order: 0,
          revision: 1,
        },
      ],
      turn: null,
    },
  };
  const mountedRoot = () => ({ ...root, chat: mountedHandle === handle ? firstChat() : targetChat });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chats: [
            { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === handle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
            { handle: targetHandle, title: "Second conversation", status: "active", managementRevision: 1, isSelected: mountedHandle === targetHandle, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
          ],
        }),
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    selectRequests += 1;
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, selectionGeneration: selectGeneration, chatHandle: selectTarget });
    // Hold the answer so the transient acknowledgement is observable, exactly as a Host that has to
    // abort and settle a running turn before it can switch.
    await new Promise((resolve) => setTimeout(resolve, 300));
    turnRunning = false;
    mountedHandle = selectTarget;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The turn really is generating, and it has already produced text the abort must preserve.
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(chatSurface.getByRole("region", { name: "Chat transcript" })).toContainText(producedText);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect(surface.getByTestId("chat-item")).toHaveCount(2);

  const target = surface.getByTestId("chat-item").nth(1).getByTestId("chat-select");
  // Nothing is greyed out and no "stop first" reason is posted: the gesture is available.
  await expect(target).toBeEnabled();
  await expect(surface.getByTestId("chat-select-blocked")).toHaveCount(0);

  await target.click();
  // The click is acknowledged while the request is out - a request, never a refusal.
  await expect(surface.getByTestId("chat-select-pending")).toContainText("Switching");
  await expect.poll(() => selectRequests).toBe(1);

  // The switched answer moved the mount and brought the player to it: the transcript is the target's,
  // not the first chat's, and the list is gone. The reply was held 300 ms while the aborted turn
  // settled, so this also catches a switch that claimed to happen before the abort settled.
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("This is the second conversation.");
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText("The game projection is read-only.");

  // The interrupted turn's produced text survived the abort, and that turn is no longer running:
  // switching back shows both. This catches an abort that throws away what the turn had written.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  selectTarget = handle;
  selectGeneration = 2;
  await surface.getByTestId("chat-item").first().getByTestId("chat-select").click();
  await expect.poll(() => selectRequests).toBe(2);
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(producedText);
  await expect(chatSurface.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});

