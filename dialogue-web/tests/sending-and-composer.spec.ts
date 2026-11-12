/**
 * The composer: sending, stopping, and the row the player's own words become.
 *
 * A sent line is visible immediately, marked pending, and collapses into the Host's
 * authoritative message for the same key - never a duplicate, and never a second shape of row.
 * Stop hands the composer back when the stream stays silent and the reread is the only settle,
 * an armed reply stops durably across a reload, and a Class B action mid-turn reaches its route
 * without disturbing the running turn.
 */
import { expect, test } from "./frontend-coverage";
import {
  token,
  handle,
  csrfToken,
  draft,
  chat,
  root,
  jsonOk,
  readPlayerRow,
} from "./composed-reference-game-fixtures";

/**
 * The first draft (owner's item C).
 *
 * The failure this catches: Save/Discard used to render only when the Host
 * already held a durable draft, so the one case where a player most needs to
 * keep what they typed - a chat with no draft yet - offered no way to save it.
 * Four things are asserted, in the order they can go wrong:
 *
 * 1. with no draft and no text the row offers neither action at all;
 * 2. typing offers Save, and not Discard, which no draft exists to honour;
 * 3. activating it issues the same `draft.save` command the existing path
 *    issues, and what the surface then shows is the Host's read-back - the
 *    "saved" state and the revision the next command CASes on both come from
 *    the Host's answer, not from the click;
 * 4. a refused save is reported in the row and never reads as saved - the row
 *    is still there to say so, because a failure is what keeps it alive.
 */
test("a chat with no durable draft lets the player save the first one from the composer", async ({ page }) => {
  const draftWrites: Readonly<{ method: string; body: unknown }>[] = [];
  let snapshotDraft: Readonly<{ revision: number; present: boolean }> = { revision: 0, present: false };
  let durable: Readonly<{ apiVersion: number; revision: number; text: string | null }> = {
    apiVersion: 1,
    revision: 0,
    text: null,
  };
  let refuseNextSave = false;

  const submittable = {
    ...root,
    // `chat.submit` published, exactly as the reference profile declares it: the
    // composer's own enablement is a projection of the nested Chat snapshot, so
    // a journey that has to type publishes the operation rather than working
    // around a disabled field.
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
    },
  };
  // The nested Chat projection and the draft route are read together and
  // cross-checked (`rereadChat` fails closed when they disagree), so both sides
  // of the fixture move together.
  const composed = () => ({
    ...submittable,
    chat: { ...submittable.chat, chat: { ...submittable.chat.chat, draft: snapshotDraft } },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composed()) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composed()) }),
  );
  await page.route("**/api/tavern/v1/draft", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(durable) });
      return;
    }
    const body = route.request().postDataJSON() as { text?: string };
    draftWrites.push({ method: route.request().method(), body });
    if (refuseNextSave || route.request().method() === "DELETE") {
      // A refused save, and the authoritative re-read that follows it: the
      // durable draft the surface must take instead is older and empty.
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Draft revision conflict",
            status: 409,
            code: "draft_conflict",
            requestId: handle,
            retryable: false,
          }),
        });
      durable = { apiVersion: 1, revision: 3, text: null };
      snapshotDraft = { revision: 3, present: false };
      return;
    }
    // The Host answers with its own revision, which is not the revision the
    // client asked under: only the read-back can be the surface's truth.
    durable = { apiVersion: 1, revision: 9, text: body.text ?? null };
    snapshotDraft = { revision: 9, present: durable.text !== null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(durable) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  const composer = chatSurface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();
  const row = chatSurface.locator(".composer-draft");
  const save = row.getByRole("button", { name: "Save", exact: true });
  const discard = row.getByRole("button", { name: "Discard", exact: true });

  // 1. Nothing to save and nothing to discard: no row.
  await expect(row).toHaveCount(0);

  // 2. Typing offers Save and only Save.
  await composer.fill("A first draft.");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Unsaved draft");
  await expect(save).toBeVisible();
  await expect(discard).toHaveCount(0);

  // 3. The same command, under the revision the Host gave this mount.
  await save.click();
  await expect.poll(() => draftWrites.length).toBe(1);
  expect(draftWrites[0]).toEqual({
    method: "PUT",
    body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: 0, text: "A first draft." },
  });
  // The click itself cannot do this: `durable` comes from the Host's answer, so
  // "Saved draft", Discard and the success line all appear only because the
  // read-back was taken as the truth.
  await expect(row).toContainText("Saved draft");
  await expect(discard).toBeVisible();
  await expect(row.getByRole("status")).toContainText("Saved successfully.");

  // 4. A refused save is reported, and the row never claims it was saved. The
  // command carries revision 9 - the revision the Host answered with in step 3,
  // which no local rule could have derived from the 0 this mount started at.
  refuseNextSave = true;
  await composer.fill("A draft the Host will refuse.");
  await save.click();
  await expect.poll(() => draftWrites.length).toBe(2);
  expect(draftWrites[1]).toEqual({
    method: "PUT",
    body: { apiVersion: 1, selectionGeneration: 1, expectedRevision: 9, text: "A draft the Host will refuse." },
  });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Unsaved draft");
  await expect(row.getByRole("status")).toContainText("The conversation moved on since the page read it, so your change was not applied. Reload the chat to see the current state, then try again.");
  await expect(row).not.toContainText("Saved draft");
  await expect(discard).toHaveCount(0);
});


/**
 * The unified action rule (ADR-0010), Class B: state, configuration and metadata writes never abort,
 * block or refuse a running generation - they take effect on the next turn. Two members are driven
 * here, the surface's own model parameters and another Chat's title, both while a turn generates.
 *
 * The assertions, and the failure each one catches:
 *  - Both writes reach their routes: catches a Class B action withheld because a turn runs.
 *  - The app bar still reports the generation after each write: catches a Class B write that tore the
 *    running turn down - the same defect family as the greyed-out Chats rows.
 *  - The durable read-backs are what the surfaces show (the saved model, the renamed title): catches
 *    a write that only looked applied locally.
 *  - The authoritative state after the turn settles is a COMPLETED turn carrying the reply: catches a
 *    Class B write that silently cancelled or parked the generation instead of letting it finish.
 *  - The model editor still reads the chosen value back after that settlement: catches a value the
 *    surface only kept locally, which the next turn would then not start from.
 */
test("a Class B action mid-turn reaches its route and leaves the running turn alone", async ({ page }) => {
  const targetHandle = "C".repeat(42) + "A";
  const replyText = "A reply that finished while the settings changed.";
  const renamedTitle = "Second conversation, renamed";
  const recommendedModels = [
    {
      providerId: "cpa-oai",
      providerLabel: "CPA OAI",
      modelId: "deepseek-v4",
      modelLabel: "DeepSeek V4",
      allowedThinkingLevels: ["off", "medium", "high"],
      defaultThinkingLevel: "medium",
    },
  ];
  let turnSettled = false;
  // The durable title the list projects: the rename route's read-back is the only thing that moves it.
  let targetTitle = "Second conversation";
  let targetTitleRevision = 1;
  // A profile names the level its surface reasons at: the model belongs to the active connection.
  let chatProfile = { revision: 1, thinkingLevel: "medium" };
  const gameProfile = { revision: 1, thinkingLevel: "medium" };
  const profileWrites: unknown[] = [];
  const titleWrites: unknown[] = [];
  const projected = () => ({
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" },
      ],
      chat: {
        ...chat.chat,
        transcript: turnSettled
          ? [
              ...chat.chat.transcript,
              { handle: "G".repeat(42) + "A", role: "companion", text: replyText, locale: "und", order: 1, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: turnSettled
          ? { handle: "F".repeat(42) + "A", state: "completed", projectionRevision: 2, canCancel: false }
          : { handle: "F".repeat(42) + "A", state: "running", projectionRevision: 1, canCancel: true },
      },
    },
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projected())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projected())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/settings/profiles", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill(
        jsonOk({ apiVersion: 1, chat: chatProfile, game: gameProfile, recommendedModels }),
      );
    const body = route.request().postDataJSON() as { thinkingLevel: string };
    profileWrites.push(route.request().postDataJSON());
    chatProfile = { revision: chatProfile.revision + 1, thinkingLevel: body.thinkingLevel };
    return route.fulfill(jsonOk({ apiVersion: 1, chat: chatProfile, game: gameProfile, recommendedModels }));
  });
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chats: [
            { handle, title: "First conversation", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
            { handle: targetHandle, title: targetTitle, status: "active", managementRevision: targetTitleRevision, isSelected: false, updatedAtMs: 1_760_086_400_000, preview: "She is already on the porch with the lantern." },
          ],
        }),
      );
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/title", (route) => {
    titleWrites.push(route.request().postDataJSON());
    targetTitle = renamedTitle;
    targetTitleRevision = 2;
    return route.fulfill(
      jsonOk({ apiVersion: 1, handle: targetHandle, title: renamedTitle, managementRevision: 2 }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  // The turn really is generating before either Class B write.
  await expect(page.getByText("Thinking…")).toBeVisible();

  // Class B, member one: this surface's model parameters.
  const chatSurface = page.getByTestId("chat-surface");
  await expect(chatSurface).toBeVisible();
  await chatSurface.getByTestId("chat-model-trigger").click();
  const popout = page.getByRole("dialog", { name: "Chat model settings" });
  await expect(popout).toBeVisible();
  await popout.getByLabel("Thinking level").selectOption("high");
  await popout.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => profileWrites.length).toBe(1);
  expect(profileWrites[0]).toEqual({
    apiVersion: 1,
    surface: "chat",
    expectedRevision: 1,
    thinkingLevel: "high",
  });
  // The durable read-back is what the editor shows, and the generation is untouched.
  await expect(popout.locator('[data-model-notice="saved"]')).toBeVisible();
  await expect(popout.getByLabel("Thinking level")).toHaveValue("high");
  await expect(page.getByText("Thinking…")).toBeVisible();
  // The drawer's own close control, not Escape: the Save that just ran disabled itself and dropped
  // focus to <body>, so this asserts the surface's close affordance rather than a keyboard accident.
  await popout.getByRole("button", { name: "Close", exact: true }).click();
  await expect(popout).toHaveCount(0);

  // Class B, member two: another Chat's title.
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  // Every row carries the pencil now (`chat.rename` names its target by the row's own handle), and
  // the two names stay apart: the buttons answer to "Rename Chat" and the field they open answers to
  // "Chat title", so a surface-wide lookup for either name resolves to exactly what it means.
  const renameRow = surface.getByTestId("chat-item").nth(1);
  await expect(surface.getByRole("button", { name: "Rename Chat" })).toHaveCount(2);
  await renameRow.getByRole("button", { name: "Rename Chat" }).click();
  const titleField = renameRow.getByLabel("Chat title");
  await expect(titleField).toBeVisible();
  await expect(surface.getByLabel("Chat title")).toHaveCount(1);
  await titleField.fill(renamedTitle);
  await surface.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => titleWrites.length).toBe(1);
  expect(titleWrites[0]).toEqual({
    apiVersion: 1,
    chatHandle: targetHandle,
    expectedManagementRevision: 1,
    title: renamedTitle,
  });
  // The durable read-back is what the list shows, and the generation survived the rename.
  await expect(surface.getByTestId("chat-item").nth(1)).toContainText(renamedTitle);
  await expect(page.getByText("Thinking…")).toBeVisible();

  // The turn reaches its own settlement: the authoritative state is a COMPLETED turn whose reply is
  // in the transcript, so no Class B write cancelled or parked the generation.
  turnSettled = true;
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(replyText);
  await expect(page.getByText("Thinking…")).toHaveCount(0);

  // The value the next turn starts from is the one the player chose mid-turn: re-opening this
  // surface's own model settings reads it back from the Host, never from anything the surface kept
  // locally through the switch and the completion.
  await page.getByTestId("chat-surface").getByTestId("chat-model-trigger").click();
  await expect(page.getByRole("dialog", { name: "Chat model settings" }).getByLabel("Thinking level")).toHaveValue(
    "high",
  );
});




/**
 * The optimistic send (design/26 §6): the input cleared and then nothing happened for the seconds
 * the Host spends thinking - the "anxiety wait". The sent text must be visible in the reading flow
 * immediately, marked pending, and must collapse into the Host's authoritative message for the same
 * idempotency key. It must never duplicate, and a re-read that no longer carries the key must leave
 * no ghost.
 */
test("sending shows the player's text immediately with a pending marker, then collapses into the authoritative message", async ({ page }) => {
  const playerText = "Meet me at the mine entrance.";
  const playerHandle = "P".repeat(42) + "A";
  const turnHandle = "T".repeat(42) + "A";
  let submitted = false;
  const submittable = {
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
      chat: { ...chat.chat, draft: { revision: 0, present: false } },
    },
  };
  const projection = () => ({
    ...submittable,
    chat: {
      ...submittable.chat,
      chat: {
        ...submittable.chat.chat,
        transcript: submitted
          ? [
              ...chat.chat.transcript,
              { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: submitted ? { handle: turnHandle, state: "completed", projectionRevision: 1, canCancel: false } : null,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/messages", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Hold the submit so the optimistic entry is observable before the Host answers.
    await new Promise((resolve) => setTimeout(resolve, 300));
    submitted = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await surface.locator(".composer-textarea").fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();

  // Before any Host response: the sent text is visible and marked pending, while the authoritative
  // transcript does not yet carry it.
  const optimistic = surface.getByTestId("optimistic-player-message");
  await expect(optimistic).toBeVisible();
  await expect(optimistic).toHaveAttribute("data-pending", "true");
  await expect(optimistic).toContainText(playerText);
  await expect(surface.locator(".message-list > li", { hasText: playerText })).toHaveCount(0);
  // The optimistic line IS the conversation's first message, so the zero state
  // yields to it: the conversation the player just started is not still showing
  // the invitation to start one.
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);

  // …and it is already **the row** the authoritative message will be, not a
  // second shape of one: same avatar, same bubble tone and radius, same measure.
  // The defect this pins: the pending text used to be a grey box of its own, so
  // sending made the player's own line jump into a wine bubble on landing.
  const pendingRow = await readPlayerRow(optimistic);

  // The authoritative message lands: the pair collapses to exactly one message and the optimistic
  // entry is gone (never a duplicate).
  await expect(optimistic).toHaveCount(0);
  const settled = surface.locator(".message-list > li", { hasText: playerText });
  await expect(settled).toHaveCount(1);
  const settledRow = await readPlayerRow(settled);
  console.log(`[optimistic row] pending=${JSON.stringify(pendingRow)} settled=${JSON.stringify(settledRow)}`);
  expect(pendingRow.isPlayerRow, "the pending line is a player row").toBe(true);
  expect(pendingRow.hasAvatar, "and it carries the same monogram the settled row does").toBe(settledRow.hasAvatar);
  expect(pendingRow.bubbleBackground, "the bubble is the same tone before and after").toBe(settledRow.bubbleBackground);
  expect(pendingRow.bubbleRadius, "and the same shape").toBe(settledRow.bubbleRadius);
  expect(pendingRow.bubbleFontSize, "and the same type").toBe(settledRow.bubbleFontSize);
  expect(
    Math.abs(pendingRow.bubbleRight - settledRow.bubbleRight),
    `and the same right edge (${pendingRow.bubbleRight} vs ${settledRow.bubbleRight})`,
  ).toBeLessThanOrEqual(8);
  expect(
    Math.abs(pendingRow.bubbleWidth - settledRow.bubbleWidth),
    `and the same measure (${pendingRow.bubbleWidth} vs ${settledRow.bubbleWidth})`,
  ).toBeLessThanOrEqual(8);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);

  // A reload re-reads the authoritative transcript and leaves no optimistic ghost.
  await page.reload();
  const reloaded = page.getByTestId("chat-surface");
  await expect(reloaded).toBeVisible();
  await expect(reloaded.getByTestId("optimistic-player-message")).toHaveCount(0);
  await expect(reloaded.locator(".message-list > li", { hasText: playerText })).toHaveCount(1);
});


/**
 * The Chat surface's own Stop control, end to end on the product shell.
 *
 * The mounted reference journey that asserted this ("reference browser stops an
 * armed response, reloads its durable cancellation, and sends again") went with
 * the reference shell. The capability is this surface's own - the stop control,
 * the durable cancelled turn it rereads, and the composer it hands back - so the
 * journey is asserted here rather than lost with the shell.
 *
 * The assertions, and the failure each one catches:
 *  - Stop is offered only for a turn the Host published `chat.cancel` for:
 *    catches a stop control offered for a turn the Host never offered to cancel;
 *  - the click posts exactly one `chat.cancel`, with this session's csrf token
 *    and the mounted generation: catches a double-submitted stop and a stop aimed
 *    at a generation the Host is not serving;
 *  - the notice is what the authoritative reread says, not what the click hoped:
 *    catches a surface that prints "stopped" for a cancellation nobody confirmed;
 *  - a reload still shows it: catches a stop the surface only kept in memory;
 *  - the player can send again afterwards: catches a stopped conversation left
 *    permanently locked.
 */
test("the mounted conversation stops an armed reply, keeps the stop durable across a reload, and sends again", async ({ page }) => {
  test.setTimeout(60_000);
  const turnHandle = `${"T".repeat(42)}A`;
  const nextTurnHandle = `${"U".repeat(42)}A`;
  const stoppedTurn = { handle: turnHandle, state: "cancelled", projectionRevision: 2, canCancel: false };
  const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true };
  const nextMessage = {
    handle: `${'P'.repeat(42)}A`,
    role: "player",
    text: "A second message after Stop",
    locale: "und",
    order: 1,
    revision: 1,
  };
  let turn: Readonly<{ handle: string; state: string; projectionRevision: number; canCancel: boolean }> = runningTurn;
  let cancels = 0;
  let sends = 0;
  let sent = false;
  let stateReads = 0;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
        ...(turn.canCancel
          ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
          : []),
      ],
      chat: {
        ...chat.chat,
        transcript: sent ? [...chat.chat.transcript, nextMessage] : chat.chat.transcript,
        turn: sent ? { handle: nextTurnHandle, state: "running", projectionRevision: 1, canCancel: true } : turn,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads += 1;
    return route.fulfill(jsonOk(projection()));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    cancels += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, selectionGeneration: 1 });
    turn = stoppedTurn;
    await route.fulfill(jsonOk({ apiVersion: 1, disposition: "cancelled", turn: stoppedTurn }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sends += 1;
    sent = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: nextMessage,
        turn: { handle: nextTurnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "terminal" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  const stop = surface.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeEnabled();

  await stop.click();
  await expect.poll(() => cancels).toBe(1);
  // The notice is the reread's fact, and the control goes with the cancellable
  // turn: both come from the authoritative projection, not from the click.
  await expect(surface).toContainText("Reply stopped. You can send another message.");
  await expect(stop).toHaveCount(0);
  await expect(composer).toBeEnabled();
  expect(stateReads).toBe(1);
  expect(cancels).toBe(1);

  await page.reload();
  const reloaded = page.getByTestId("chat-surface");
  await expect(reloaded).toBeVisible();
  await expect(reloaded).toContainText("Reply stopped. You can send another message.");

  await reloaded.locator(".composer-textarea").fill("A second message after Stop");
  await reloaded.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  await expect(reloaded.locator(".message-list")).toContainText("A second message after Stop");
});


/**
 * Stop's own reread is the composer's only release when the event stream is up
 * but silent.
 *
 * The failure this catches: the terminal-settle rule - an authoritative read that
 * sees a terminal turn spends the content-free pending record - applied at every
 * place the turn is read *except* `rereadChat`, which is exactly the read Stop
 * performs. The event stream is open (a live stream is what keeps the fallback
 * poll from hopping) but never delivers the terminal frame, so Stop's reread is
 * the one read that can hand the field back. A `rereadChat` that preserved
 * `pending` left the composer disabled forever behind a cancelled turn.
 */
test("Stop hands the composer back when the stream stays silent and the reread is the only settle", async ({ page }) => {
  test.setTimeout(90_000);
  const streamEpoch = `${'E'.repeat(42)}A`;
  const streamCursor = `${'F'.repeat(42)}A`;
  const turnHandle = `${'T'.repeat(42)}A`;
  const playerHandle = `${'P'.repeat(42)}A`;
  const runningTurn = { handle: turnHandle, state: "running", projectionRevision: 2, canCancel: true };
  const stoppedTurn = { handle: turnHandle, state: "cancelled", projectionRevision: 3, canCancel: false };
  const playerMessage = {
    handle: playerHandle,
    role: "player",
    text: "Wait for me here",
    locale: "und",
    order: 1,
    revision: 1,
  };
  // `idle` -> the player sends; `running` -> the Host admits the turn; `stopped`
  // -> the cancel is durable. The stream never delivers the terminal turn, so
  // only an authoritative read can move the composer out of `running`.
  let phase: "idle" | "running" | "stopped" = "idle";
  let sends = 0;
  let cancels = 0;

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
        ...(phase !== "idle"
          ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
          : []),
      ],
      chat: {
        ...chat.chat,
        transcript: phase === "idle" ? chat.chat.transcript : [...chat.chat.transcript, playerMessage],
        turn: phase === "running" ? runningTurn : phase === "stopped" ? stoppedTurn : null,
      },
    },
  });

  await page.addInitScript(() => {
    const state = window as unknown as {
      __streams: Array<{ url: string; closed: boolean }>;
      __streamHandlers: Array<Map<string, Array<(raw: unknown) => void>>>;
      __emit: (index: number, type: string, data: string, id: string) => void;
    };
    state.__streams = [];
    state.__streamHandlers = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
        state.__streamHandlers.push(new Map());
      }
      addEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, [...(entry.get(type) ?? []), handler]);
      }
      removeEventListener(type: string, handler: (raw: unknown) => void): void {
        const entry = state.__streamHandlers[this.__index]!;
        entry.set(type, (entry.get(type) ?? []).filter((candidate) => candidate !== handler));
      }
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
    state.__emit = (index, type, data, id) => {
      const handlers = state.__streamHandlers[index]?.get(type) ?? [];
      for (const handler of handlers) handler({ data, lastEventId: id, type });
    };
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/messages", async (route) => {
    sends += 1;
    phase = "running";
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, disposition: "accepted", message: playerMessage, turn: runningTurn }),
    });
  });
  await page.route("**/api/tavern/v1/turns/*/cancel", async (route) => {
    cancels += 1;
    phase = "stopped";
    await route.fulfill(jsonOk({ apiVersion: 1, disposition: "cancelled", turn: stoppedTurn }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  const stop = surface.getByRole("button", { name: "Stop", exact: true });
  // The stream is open before the send: a live, silent stream is what keeps the
  // fallback poll from hopping, so Stop's reread stays the only settle.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __streams: unknown[] }).__streams.length))
    .toBe(1);

  await composer.fill("Wait for me here");
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
  // The send published the pending record: the field is held until a settle.
  await expect(composer).toBeDisabled();

  // The Host admits the turn. The frame carries it, and the authoritative read
  // behind the frame publishes the `chat.cancel` offer.
  await page.evaluate(
    (input: { epoch: string; turn: unknown; id: string }) => {
      (window as unknown as { __emit: (i: number, t: string, d: string, e: string) => void }).__emit(
        0,
        "turn.state_changed",
        JSON.stringify({
          apiVersion: 1,
          epoch: input.epoch,
          sequence: 1,
          selectionGeneration: 1,
          eventType: "turn.state_changed",
          payload: input.turn,
        }),
        input.id,
      );
    },
    { epoch: streamEpoch, turn: runningTurn, id: `${'H'.repeat(42)}A` },
  );

  await expect(stop).toBeEnabled();
  await expect(composer).toBeDisabled();

  await stop.click();
  await expect.poll(() => cancels).toBe(1);

  // The cancelled turn is the authoritative fact, and Stop's own reread is what
  // carries it into the shell: no stream frame ever did. The composer must be
  // usable again, not left disabled behind a spent pending record.
  await expect(surface).toContainText("Reply stopped. You can send another message.");
  await expect(composer).toBeEnabled();
});

