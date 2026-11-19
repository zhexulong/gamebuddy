/**
 * A Chat switch reads the Chat half, and only the Chat half.
 *
 * The claim this file settles: `/api/composed-reference-game/v1/state` answers the whole aggregate -
 * the conversation AND a Game projection beside it - and the Host refuses the whole document when the
 * Game half cannot be read (`{code: "state_unavailable", cause: "game_projection_failed"}`, a 409).
 * The shell's switch (row click, creation, fork, a removal's successor - every path that adopts a
 * successor mount) read through that route and used one half of the answer, so a Game fault the
 * switch does not read aborted the switch: the Host had already committed the new selection and made
 * the Chat durable, and the player was left outside the conversation, on the Chats list, with the
 * task's own line unproven - `the opening the player chose is the one the Chat opened on: false`
 * (`frontend--r7.stage/logs/capture.log`, driver `m`).
 *
 * The Chat half has a route of its own - `GET /api/tavern/v1/state`, the same TavernStateSnapshotV1
 * the composed root carries under `chat` - and the Chat half is the only thing a switch needs: the
 * Game half is the view's, kept as it stands (`withChatHalf`). So the switch reads `/api/tavern/v1/state`
 * and a Game fault cannot reach it.
 *
 * The second journey is the residual: a switch whose own Chat read fails must SAY so where the player
 * is, instead of the shell reporting the creation as if the player had landed in it.
 */
import { expect, type Page, test } from "./frontend-coverage";
import { chat, csrfToken, draft, handle, jsonOk, root, token } from "./composed-reference-game-fixtures";

const secondHandle = "C".repeat(42) + "A";

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

const listOf = (mountedHandle: string) => ({
  apiVersion: 1,
  chats: [
    {
      handle,
      title: "First conversation",
      status: "active",
      managementRevision: 1,
      isSelected: mountedHandle === handle,
      updatedAtMs: 1_760_000_000_000,
      preview: "The parsnips took. All of them, by the look of it.",
    },
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

/** The Host's own refusal for the half that broke, verbatim (`readComposedRoot`). */
const gameProjectionRefusal = {
  status: 409,
  contentType: "application/json",
  body: JSON.stringify({ code: "state_unavailable", cause: "game_projection_failed" }),
};

/**
 * The fixture mount. `chatHalf` answers the route that carries the conversation alone, so a journey
 * can break one half and leave the other answering - the two routes are one projection on the Host
 * (`composed-reference-game-static-shell-composition.test.ts` pins the same CSRF token on both).
 */
async function mountWithABrokenGameHalf(
  page: Page,
  options: Readonly<{ chatHalf: () => { status: number; contentType: string; body: string } }>,
) {
  let mountedHandle = handle;
  let selectRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // The aggregate, refused for the Game half - the state the switch is driven in.
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(gameProjectionRefusal));
  await page.route("**/api/tavern/v1/state", (route) => route.fulfill(options.chatHalf()));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET") return route.fulfill(jsonOk(listOf(mountedHandle)));
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selectRequests += 1;
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(route.request().postDataJSON()).toEqual({
      apiVersion: 1,
      selectionGeneration: 1,
      chatHandle: secondHandle,
    });
    // The Host committed the switch: the mounted Chat is the target from here on.
    mountedHandle = secondHandle;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });
  return { selectRequests: () => selectRequests, mountedRoot: () => ({ ...root, chat: mountedHandle === handle ? chat : secondChat }) };
}

/** Which surface the URL says takes the region (`useSurfaceRoute`; the conversation is `chat`). */
const shownPanel = (page: Page) =>
  page.evaluate(() => new URLSearchParams(window.location.hash.slice(1)).get("panel"));

test("a Chat switch lands while the Game half of the aggregate is unreadable", async ({ page }) => {
  const fixture = await mountWithABrokenGameHalf(page, {
    chatHalf: () => jsonOk(fixture.mountedRoot().chat),
  });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );

  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface.getByTestId("chat-item")).toHaveCount(2);
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(fixture.selectRequests).toBe(1);

  // The player lands in the conversation the Host switched to: the region is the conversation, the
  // transcript is the target's, and the window followed the selection the Host committed.
  await expect(page.getByTestId("chats-surface")).toHaveCount(0);
  await expect.poll(() => shownPanel(page)).toBe("chat");
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "This is the second conversation.",
  );
  await expect(page.getByRole("region", { name: "Chat transcript" })).not.toContainText(
    "The game projection is read-only.",
  );
});

test("a switch this window could not follow says so instead of reporting the switch", async ({ page }) => {
  const fixture = await mountWithABrokenGameHalf(page, {
    // The conversation itself cannot be read: the one failure a switch cannot land through.
    chatHalf: () => ({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "The runtime is not available",
        status: 503,
        code: "runtime_unavailable",
        requestId: handle,
        retryable: true,
      }),
    }),
  });
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface.getByTestId("chat-item")).toHaveCount(2);
  await surface.getByTestId("chat-item").nth(1).getByTestId("chat-select").click();
  await expect.poll(fixture.selectRequests).toBe(1);

  // The Host switched; this window did not follow. The player is told that, on the surface they are
  // standing on, and is not handed a success for a move that did not happen.
  await expect(surface).toBeVisible();
  await expect(surface.getByRole("status")).toContainText(
    "The chat switched, but this window could not follow it. Open it again from Chats.",
  );
});
