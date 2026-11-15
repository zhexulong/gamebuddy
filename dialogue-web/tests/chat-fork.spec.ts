/**
 * Branching the conversation from a message, mounted in the shipped shell.
 *
 * The route has been live since `94b1faaa` and proved at the mount layer (`88cc17ee`), and no control drew
 * it: `POST /api/tavern/v1/chats/fork` lives on the `/chats` family while the pane a player reads messages on
 * posts `/messages/*`. So the entry sits on the MESSAGE, where the player is (reaching the route through the
 * management client this shell already mounts), and it is not a new control in the strip: a fork and a rewind
 * are the same question asked two ways - read on from this message, or cut back to it - so they are two
 * answers behind the entry the row already had. A sixth action in that strip is what stranded a control at
 * 520x900 (`style.css`), and this lane may not spend that invariant.
 *
 * The five things this file pins, and the failure each one catches:
 *
 * 1. `forks from the row it names and lands on the branch` - the entry, the choice, and then the branch is
 *    the conversation on screen. Catches an entry that posts nothing, or one that mints a Chat and leaves the
 *    player reading the origin.
 * 2. `the choice carries the two facts` - this chat keeps every later message, and both chats are one
 *    conversation to her memory (a fork copies the continuity), next to what the rewind would do instead.
 *    Catches the swing that ships a fork as a harmless "new view" and surprises the player later.
 * 3. `a running turn is refused by name, and no branch is created` - the Host answers `chat_fork_turn_active`,
 *    the sentence says to wait, and no `chat/select` is issued. Catches a control that hides itself instead of
 *    answering, and one that switches on a refusal.
 * 4. `one key per attempted fork` - a key held while the attempt has no answer (a retried attempt must land on
 *    the branch it may already have made), and a new key once a named refusal stated nothing ran. Catches a
 *    second, identical branch: the defect the Host's derived identity exists to stop.
 * 5. `the entry is one control, and never one the Host would refuse` - the greeting carries none, and the
 *    transcript's newest row carries none either (a rewind there would remove nothing, and the entry is one
 *    control for both answers). Catches the strip growing a sixth target.
 */
import { expect, test, type Page, type Route } from "./frontend-coverage";
import { token, handle, csrfToken, draft, chat, root, jsonOk } from "./composed-reference-game-fixtures";
import { messages } from "../src/i18n";

/** Opaque, canonical unpadded base64url handles - the only shape the document accepts. */
const openingHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"E".repeat(42)}A`;
const replyHandle = `${"F".repeat(42)}A`;
const forkedHandle = `${"G".repeat(42)}A`;
const forkedReplyHandle = `${"H".repeat(42)}A`;

const OPENING = "Welcome to the tavern.";
const PLAYER_LINE = "Evening.";
const REPLY_LINE = "Evening to you.";
const BRANCH_LINE = "Let us go the other way.";

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    type: "about:blank",
    title: "Chat fork refused",
    status,
    code,
    requestId: handle,
    retryable: false,
  }),
});

/** The origin conversation: an opening, the player's line, and her reply to it. */
const originTranscript = [
  { handle: openingHandle, role: "companion" as const, text: OPENING, locale: "und" as const, order: 0, revision: 1 },
  { handle: playerHandle, role: "player" as const, text: PLAYER_LINE, locale: "und" as const, order: 1, revision: 1 },
  { handle: replyHandle, role: "companion" as const, text: REPLY_LINE, locale: "und" as const, order: 2, revision: 1 },
];

/** The branch the Host answers with: the SAME conversation up to the player's line, as a second Chat. */
const branchTranscript = originTranscript.slice(0, 2);

const submitOperation = {
  operationId: "chat.submit",
  labelKey: "tavern.operation.submit",
  availability: "available" as const,
  routeId: "chat.submit",
};

const originChat = {
  ...chat,
  operations: [submitOperation],
  chat: { ...chat.chat, title: "Origin conversation", transcript: originTranscript },
};

const branchChat = {
  ...chat,
  operations: [submitOperation],
  selection: { chatHandle: forkedHandle, generation: 2, stateRevision: forkedHandle },
  chat: { ...chat.chat, title: "Branch conversation", transcript: branchTranscript },
};

type ForkCall = Readonly<{ idempotencyKey: string; body: unknown; csrfToken: string | undefined }>;

/**
 * Mounts the shell with one origin conversation and one branch behind the fork route.
 *
 * `answerFork` decides what the route does with each attempt, so the journeys differ only in what the Host
 * says: a created branch, a named refusal, or nothing at all.
 */
async function mountShell(
  page: Page,
  answerFork: (route: Route, call: ForkCall, attempt: number) => Promise<void> | void,
): Promise<{ forkCalls: ForkCall[]; selections: string[]; sent: string[] }> {
  const forkCalls: ForkCall[] = [];
  const selections: string[] = [];
  const sent: string[] = [];
  let mounted = handle;
  let accepted: string | null = null;

  const mountedRoot = () => {
    if (mounted !== handle) {
      // The branch, plus whatever this journey's own Send has already had accepted: the authoritative read
      // is what the surface shows, so a transcript that grew is the proof the send landed in it.
      const transcript =
        accepted === null
          ? branchTranscript
          : [
              ...branchTranscript,
              { handle: forkedReplyHandle, role: "player" as const, text: accepted, locale: "und" as const, order: 2, revision: 1 },
            ];
      return { ...root, chat: { ...branchChat, chat: { ...branchChat.chat, transcript } } };
    }
    return { ...root, chat: originChat };
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "GET")
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chats: [
            { handle, title: "Origin conversation", status: "active", managementRevision: 1, isSelected: mounted === handle, updatedAtMs: 1_760_000_000_000, preview: REPLY_LINE },
            { handle: forkedHandle, title: "Branch conversation", status: "active", managementRevision: 1, isSelected: mounted === forkedHandle, updatedAtMs: 1_760_086_400_000, preview: PLAYER_LINE },
          ],
        }),
      );
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "not_found" }) });
  });
  await page.route("**/api/tavern/v1/chats/fork", async (route) => {
    const call: ForkCall = {
      idempotencyKey: route.request().headers()["idempotency-key"] ?? "",
      body: route.request().postDataJSON(),
      csrfToken: route.request().headers()["x-csrf-token"],
    };
    forkCalls.push(call);
    await answerFork(route, call, forkCalls.length);
  });
  await page.route("**/api/tavern/v1/chat/select", async (route) => {
    const body = route.request().postDataJSON() as { chatHandle: string };
    selections.push(body.chatHandle);
    mounted = body.chatHandle;
    await route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    const text = (route.request().postDataJSON() as { text: string }).text;
    sent.push(text);
    accepted = text;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: forkedReplyHandle, role: "player", text, locale: "und", order: 2, revision: 1 },
        turn: { handle: `${"T".repeat(42)}A`, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toContainText(OPENING);
  return { forkCalls, selections, sent };
}

/** The branch, as the Host answers a fork that committed. */
const createdBranch = {
  apiVersion: 1,
  chat: {
    handle: forkedHandle,
    title: "Branch conversation",
    status: "active",
    managementRevision: 1,
    isSelected: false,
    updatedAtMs: 1_760_086_400_000,
    preview: PLAYER_LINE,
  },
};

/** The fork entry: one control, one press (it takes nothing away, so it takes no arm). */
async function pressFork(page: Page): Promise<void> {
  await page.locator(`[data-handle="${playerHandle}"]`).getByTestId("message-fork").click();
}

test("the two entries are two controls, absent where the Host would refuse, and the strip still ends at five", async ({
  page,
}) => {
  await mountShell(page, (route) => route.fulfill(jsonOk(createdBranch)));

  // The greeting carries neither entry: the Host refuses both acts there, so there is no press to offer.
  await expect(page.locator(`[data-handle="${openingHandle}"] [data-testid="message-rewind"]`)).toHaveCount(0);
  await expect(page.locator(`[data-handle="${openingHandle}"] [data-testid="message-fork"]`)).toHaveCount(0);
  // The cut back to this row is its own control again (owner ruling 2026-11-16): its name states the point and
  // the count it would remove. The fork is a separate button beside it, and its name states the two facts it
  // does NOT take away - this chat keeps every later message, and both chats are one conversation to her
  // memory - because a one-press control has no prompt above it to carry them.
  const rewind = page.locator(`[data-handle="${playerHandle}"] [data-testid="message-rewind"]`);
  await expect(rewind).toHaveCount(1);
  await expect(rewind).toHaveAttribute("aria-label", messages("en").rewindHereName.replace("{{count}}", "1"));
  const fork = page.locator(`[data-handle="${playerHandle}"] [data-testid="message-fork"]`);
  await expect(fork).toHaveCount(1);
  await expect(fork).toHaveAttribute("aria-label", messages("en").forkFromHereName);
  // Her reply is the newest row: a rewind there would remove nothing and a fork of nothing is not a branch, so
  // neither entry is offered - the newest message is branched from by choosing the row BEFORE it.
  await expect(page.locator(`[data-handle="${replyHandle}"] [data-testid="message-rewind"]`)).toHaveCount(0);
  await expect(page.locator(`[data-handle="${replyHandle}"] [data-testid="message-fork"]`)).toHaveCount(0);
  // And the strip is still four targets here (five on the paged reply, where the pager joins them): Edit left the
  // strip in the same ruling that gave Fork a slot, so the count the width arithmetic depends on did not move.
  const strip = await page.evaluate(
    (selector) => [...document.querySelector(selector)!.children].map((child) => child.getAttribute("data-testid") ?? child.className),
    `[data-handle="${playerHandle}"] .message-actions`,
  );
  expect(strip).toEqual(["message-copy", "message-rewind", "message-fork", "message-delete"]);
});

test("forking from a message lands on the branch, and the player can write into it", async ({ page }) => {
  const { forkCalls, selections, sent } = await mountShell(page, (route) => route.fulfill(jsonOk(createdBranch)));

  // The fork is ONE press now: it mints the branch and changes nothing in this conversation. The two facts the
  // player is owed before either branch exists are in the control's own name, and reading it sends nothing.
  const fork = page.getByTestId("message-fork");
  await expect(fork).toHaveAttribute("title", messages("en").forkFromHereName);
  expect(forkCalls, "reading the control sends nothing").toEqual([]);

  // Its neighbour is still the destructive one, and it still makes the player say so: arming the rewind
  // touches nothing, and cancelling it is a way out with nothing sent.
  await page.locator(`[data-handle="${playerHandle}"]`).getByTestId("message-rewind").click();
  const confirm = page.getByTestId("message-rewind-confirm");
  await expect(confirm).toContainText(messages("en").rewindConfirmPrompt);
  await expect(page.getByTestId("message-rewind-confirm-yes")).toHaveAttribute(
    "aria-label",
    messages("en").rewindHereName.replace("{{count}}", "1"),
  );
  await expect(page.getByTestId("message-fork")).toHaveCount(0);
  await page.getByTestId("message-rewind-confirm-no").click();
  await expect(page.getByTestId("message-rewind-confirm")).toHaveCount(0);
  expect(forkCalls).toEqual([]);
  await expect(page.getByTestId("chat-surface")).toContainText(REPLY_LINE);

  // The fork press sends the row it sits on, with this mount's generation and its token.
  await pressFork(page);
  await expect.poll(() => forkCalls.length).toBe(1);
  expect(forkCalls[0]?.body).toEqual({ apiVersion: 1, selectionGeneration: 1, messageHandle: playerHandle });
  expect(forkCalls[0]?.csrfToken).toBe(csrfToken);
  expect(forkCalls[0]?.idempotencyKey, "a fork is always keyed").toMatch(/^[A-Za-z0-9_-]{22}$/u);

  // The Host does not select what it mints, so the switch is the shell's own second operation - and the
  // branch, not the origin, is what the player is reading afterwards.
  await expect.poll(() => selections.length).toBe(1);
  expect(selections[0]).toBe(forkedHandle);
  await expect(page.getByTestId("chat-surface")).toContainText("Branch conversation");
  await expect(page.getByTestId("chat-surface")).not.toContainText(REPLY_LINE);

  // And it is a conversation they can write into: the composer's Send reaches the Host from the branch.
  const composer = page.getByTestId("chat-surface").locator(".composer-textarea");
  await composer.fill(BRANCH_LINE);
  await page.getByTestId("chat-surface").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => sent).toEqual([BRANCH_LINE]);
  await expect(page.getByTestId("chat-surface")).toContainText(BRANCH_LINE);
  await expect(page.getByTestId("chat-surface")).not.toContainText(REPLY_LINE);
});

test("a fork refused because a reply is being written is named, and creates no branch", async ({ page }) => {
  const { forkCalls, selections } = await mountShell(page, (route) =>
    route.fulfill(problem(409, "chat_fork_turn_active")),
  );

  await pressFork(page);
  await expect.poll(() => forkCalls.length).toBe(1);

  // The refusal is SAID, in the words the catalogue gives that code: the notice line is the sentence the
  // player can act on ("wait, then branch"), never a generic failure - which is what a catch that dropped
  // the code would leave here.
  const surface = page.getByTestId("chat-surface");
  const notice = surface.locator(".reference-turn-notice");
  await expect(notice).toHaveText("Wait for the reply to finish, then branch from here.");
  await expect(notice).not.toHaveText(messages("en").failure);
  // Nothing was switched, and the conversation the player was reading is still the one on screen.
  expect(selections, "a refused fork must not switch the mount").toEqual([]);
  await expect(surface).toContainText(REPLY_LINE);

  // The refusal spent the press, not the entry: the fork is still on the row it named.
  await expect(page.locator(`[data-handle="${playerHandle}"] [data-testid="message-fork"]`)).toBeVisible();
});

test("one key per attempted fork: held while the answer is unknown, new after a named refusal", async ({ page }) => {
  const { forkCalls, selections } = await mountShell(page, (route, _call, attempt) => {
    // The first attempt gets no answer at all: the connection drops after the Host may already have
    // committed, which is exactly the case the key exists for.
    if (attempt === 1) return route.abort("failed");
    // The second is a named refusal: the Host states it did not run the fork.
    if (attempt === 2) return route.fulfill(problem(404, "chat_fork_target_not_found"));
    return route.fulfill(jsonOk(createdBranch));
  });

  await pressFork(page);
  await expect.poll(() => forkCalls.length).toBe(1);

  // The retry of an attempt whose outcome nobody knows carries the SAME key: a new one would mint a
  // second identical branch of this conversation.
  await pressFork(page);
  await expect.poll(() => forkCalls.length).toBe(2);
  expect(forkCalls[1]?.idempotencyKey, "a retried attempt replays its own identity").toBe(forkCalls[0]?.idempotencyKey);

  // A named refusal stated nothing ran, so the next press is a NEW attempt and gets its own key.
  await pressFork(page);
  await expect.poll(() => forkCalls.length).toBe(3);
  expect(
    forkCalls[2]?.idempotencyKey,
    "an attempt the Host refused by name is spent, so a new press is a new attempt",
  ).not.toBe(forkCalls[0]?.idempotencyKey);

  // …and that attempt is the one that lands.
  await expect.poll(() => selections.length).toBe(1);
  await expect(page.getByTestId("chat-surface")).toContainText("Branch conversation");
});
