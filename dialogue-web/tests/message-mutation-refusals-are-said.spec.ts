import { expect, test, type Page } from "./frontend-coverage";

/**
 * A message mutation the Host refuses is SAID, not swallowed.
 *
 * The defect: every message-level mutation in the composed shell - the rewind, the delete, the
 * in-place edit, the regenerate, the swipe and the opening variant - ends in an authoritative
 * reread, and that reread is what made the silence invisible. `catch (error) { await rereadChat()
 * }` restores the transcript the Host still holds, so a refused press simply flickered and
 * reverted: the row the player asked to cut came back, the words they saved were not there, and
 * the page said nothing about the press they had made. Only if the reread ALSO failed did
 * anything reach them, and then it was the whole surface's problem page.
 *
 * Two facts have to hold, and either alone is a half-fix: the player is told what happened, in the
 * Host's own words for that refusal, and the conversation stays readable underneath - a refusal is
 * a fact about one press, never a reason to replace the screen. The edit's editor is the same rule
 * in a form: a refused save leaves the field open on the words the player typed, so the sentence
 * and the text they can fix stand together.
 *
 * The last one is why this file mounts the real shell rather than the presentation probe
 * (`tests/chat-surface-probe.html`): the swallow lives in the shell's handlers, not in a row.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

/** One canonical handle per row: 43 base64url characters, the last of them 4-bit clear. */
const messageHandle = (prefix: string): string => `${prefix}${"A".repeat(43 - prefix.length)}`;

const companionHandle = messageHandle("D");
const greetings = messageHandle("G");
const playerHandle = messageHandle("P");
const replyHandle = messageHandle("R");

/** The opening, the player's own line, and the reply that answered it. */
const TRANSCRIPT = [
  { handle: greetings, role: "companion", text: "An opening greet.", locale: "und", order: 0, revision: 1 },
  { handle: playerHandle, role: "player", text: "Where are we?", locale: "und", order: 1, revision: 1 },
  { handle: replyHandle, role: "companion", text: "On the pier.", locale: "und", order: 2, revision: 1 },
];

const chat = {
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
    companion: { name: "Mira", handle: companionHandle },
    title: "A refused message mutation",
    transcript: TRANSCRIPT,
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: handle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * The four mutations this file drives, each with the refusal the Host really produces for it and
 * that refusal's own sentence from the catalogue (`composed-problem-view.ts`).
 */
const REFUSALS = [
  {
    name: "rewind",
    route: "**/api/tavern/v1/messages/rewind",
    code: "chat_rewind_turn_active",
    sentence: "Stop the reply that is in flight, then rewind.",
  },
  {
    name: "delete",
    route: "**/api/tavern/v1/messages/delete",
    code: "chat_delete_turn_active",
    sentence: "Wait for the reply to finish, then delete the message.",
  },
  {
    name: "edit",
    route: "**/api/tavern/v1/messages/edit",
    code: "chat_edit_turn_active",
    sentence: "Wait for the reply to finish, then edit the message.",
  },
  {
    name: "regenerate",
    route: "**/api/tavern/v1/messages/regenerate",
    code: "chat_message_revision_conflict",
    sentence: "This message is no longer where the page read it. Reload the page and try again.",
  },
] as const;

/** Mounts the shell on one transcript, with `refusal` answering the operation under test. */
async function mount(page: Page, refusal: (typeof REFUSALS)[number]): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route(refusal.route, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      // The frozen RFC-9457 document the tavern boundary validates (`reference-pipeline-api.ts`,
      // `PROBLEM_KEYS`): a bare `{code}` is an opaque protocol failure, not the refusal it names.
      body: JSON.stringify({
        type: "about:blank",
        title: "The command was refused",
        status: 409,
        code: refusal.code,
        requestId: handle,
        retryable: false,
      }),
    }),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

/** The row the press belongs to. */
const row = (page: Page, messageHandleOfRow: string) => page.locator(`li[data-handle='${messageHandleOfRow}']`);

/** Presses the mutation, from the row's own strip, exactly as a player does. */
async function press(page: Page, refusal: (typeof REFUSALS)[number]): Promise<void> {
  const player = row(page, playerHandle);
  const reply = row(page, replyHandle);
  switch (refusal.name) {
    case "rewind":
      await player.locator('[data-testid="message-rewind"]').click();
      await page.locator('[data-testid="message-rewind-confirm-yes"]').click();
      return;
    case "delete":
      await reply.locator('[data-testid="message-delete"]').click();
      await page.locator('[data-testid="message-delete-confirm-yes"]').click();
      return;
    case "edit":
      await player.locator('[data-testid="message-edit"]').click();
      await player.locator('[data-testid="message-edit-field"]').fill("Where were we?");
      await player.locator('[data-testid="message-edit-save"]').click();
      return;
    case "regenerate":
      await reply.getByRole("button", { name: "Regenerate" }).click();
      return;
  }
}

test.describe("a message mutation the Host refuses is said out loud", () => {
  for (const refusal of REFUSALS) {
    test(`${refusal.name}: the refusal's own sentence stands beside the transcript it did not change`, async ({
      page,
    }) => {
      await mount(page, refusal);
      await press(page, refusal);

      const surface = page.getByTestId("chat-surface");
      const notice = surface.locator(".reference-turn-notice");
      await expect(
        notice,
        `a refused ${refusal.name} says nothing: the reread restored the transcript and the player was told no reason`,
      ).toHaveCount(1);
      await expect(notice).toBeVisible();
      const said = (await notice.innerText()).replace(/\s+/gu, " ").trim();
      console.log(`[message-mutation-refusal/${refusal.name}] ${JSON.stringify(said)}`);
      // The refusal's own words, which name what the player can do about it - not a generic
      // "something went wrong", and never the wire code.
      await expect(notice).toContainText(refusal.sentence);
      await expect(notice).not.toContainText(refusal.code);

      // The refusal did not become the page: the conversation stays readable, and the rows are
      // exactly the ones the Host still holds.
      await expect(page.locator(".problem-view")).toHaveCount(0);
      await expect(surface.locator(".message-list > li")).toHaveCount(TRANSCRIPT.length);
      await expect(row(page, replyHandle)).toContainText("On the pier.");

      // The edit is the one press whose input the player must still be able to change: the field
      // stays open on the words they typed, next to the sentence that says why they are there.
      if (refusal.name === "edit") {
        await expect(row(page, playerHandle).locator('[data-testid="message-edit-field"]')).toHaveValue("Where were we?");
      }
    });
  }
});
