import { expect, test, type Page } from "./frontend-coverage";

/**
 * The boot card names the cause it was handed, and offers the step that helps.
 *
 * Measured before this file existed (the frontend lane's own readings, 2026-11-18): a `/state` refused
 * with `409 state_unavailable` and a `/state` answered with no Chat half produced the SAME screen - the
 * whole window was `.problem-view`, no app bar, no Game surface, one pressable control reading
 * "Read it again". Both sentences were about something else: the 409 read as `gameProblemStateUnavailable`
 * ("The game is not available right now ... Reload the game page"), a game this page does not show, and
 * the answer with no Chat half read as `problemReconciliationFailedDetail` ("The chat state could not be
 * safely reconciled"), which is what a disagreeing pair of reads used to mean - not "this root has no
 * conversation in it". Neither offered anything a press could change, because the press re-asks the same
 * Host the same question.
 *
 * So this journey is per cause, not per screen: it forces each answer the mount can be given, reads the
 * card's own words and controls, and holds them to three rules - the sentence names what is missing (the
 * chats, never the game), it does not claim a network or service fault where the cause is a durable
 * state, and its step is the one that helps (a fresh GameBuddy) rather than a read that cannot.
 *
 * The last cause is the one that must NOT change: a transient refusal where re-reading really is the
 * answer keeps the card's own control, so the fix is a classification and not the removal of a retry.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "D".repeat(42) + "A";

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
    title: "A conversation the page could not open",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
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

/** The same root with the Chat half absent: a well-formed aggregate that holds no conversation. */
const rootWithoutChat = { ...root, chat: { ...chat, chat: null } };

/** A root this build cannot read: the composed contract's own identity is not the one it declares. */
const unreadableRoot = {
  ...root,
  build: { browserContract: "composed_reference_game_browser_api/v2", profileId: "gamebuddy.composed.reference-game" },
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ code }),
});

/** The card's own reading: its words, its step line and the controls standing in it. */
const readCard = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(".problem-view");
    const card = view?.querySelector<HTMLElement>(".problem-card") ?? null;
    return {
      windowIsTheCard: view !== null,
      appBar: document.querySelectorAll(".app-bar").length,
      gameSurface: document.querySelectorAll('[data-testid="game-surface"]').length,
      title: (card?.querySelector("h1")?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      detail: Array.from(card?.querySelectorAll("p") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\s+/gu, " ").trim())
        .filter((line) => line.length > 0),
      controls: [...(card?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])].map((control) =>
        (control.getAttribute("aria-label") ?? control.textContent ?? "").replace(/\s+/gu, " ").trim(),
      ),
    };
  });

/** Mounts the shell over one forced answer to the mount's own read, and reads the card. */
async function mountOver(
  page: Page,
  answer: (route: Parameters<Parameters<Page["route"]>[1]>[0]) => Promise<void> | void,
): Promise<Awaited<ReturnType<typeof readCard>>> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => void answer(route));
  await page.route("**/api/composed-reference-game/v1/state", (route) => void answer(route));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.locator(".problem-view")).toBeVisible();
  const reading = await readCard(page);
  console.log(`[boot-card] ${JSON.stringify(reading)}`);
  return reading;
}

/** The step line the card draws when its step is not the card's own read. */
const stepLineOf = (reading: Awaited<ReturnType<typeof readCard>>): string =>
  reading.detail.filter((line) => line.startsWith("The step is") || line.startsWith("Nothing")).join(" ");

test("a /state the Host cannot project names the chats and does not offer the read again", async ({ page }) => {
  const reading = await mountOver(page, (route) => route.fulfill(problem(409, "state_unavailable")));

  // The card still covers the window: this lane keeps the boot card, it only stops it lying.
  expect(reading.windowIsTheCard, "the boot card is no longer the whole window").toBe(true);
  expect(reading.appBar, "a surface the mount could not open may not stand behind the card").toBe(0);
  expect(reading.gameSurface, "no Game surface belongs behind a mount that has no session").toBe(0);

  // What is unavailable is the chats, and the words are not the game panel's.
  expect(reading.title).toContain("chats");
  expect(reading.detail.join(" ")).not.toMatch(/\bgame\b/u);
  // Not "the chat state could not be safely reconciled", and not an internal-error code: the Host
  // answered this one, so it is a state of this GameBuddy rather than a transport fault.
  expect(reading.detail.join(" ")).not.toContain("internal error");
  expect(reading.detail.join(" ")).not.toMatch(/[a-z]+_[a-z]+/u);

  // The read again is NOT the step: the same read asks the same Host the same question.
  expect(reading.controls, "a read that cannot help is still offered").not.toContain("Read it again");
  expect(reading.controls, "the card offers a control that does not help it").toEqual([]);
  expect(stepLineOf(reading), "the card leaves no step at all").toContain("GameBuddy");
  expect(reading.detail.join(" "), "the step does not name where GameBuddy is started from").toContain("tray icon");
});

test("a root with no Chat half says so, instead of reporting a failed reconciliation", async ({ page }) => {
  const reading = await mountOver(page, (route) => route.fulfill(jsonOk(rootWithoutChat)));

  expect(reading.windowIsTheCard).toBe(true);
  expect(reading.title).toMatch(/no chat/iu);
  expect(reading.detail.join(" ")).not.toContain("reconciled");
  expect(reading.controls).not.toContain("Read it again");
  expect(stepLineOf(reading)).toContain("GameBuddy");
});

test("a Host that is not answering is named as such, not as an internal error", async ({ page }) => {
  const reading = await mountOver(page, (route) => route.abort());

  expect(reading.windowIsTheCard).toBe(true);
  expect(reading.title).toMatch(/not answering/iu);
  expect(reading.detail.join(" ")).not.toContain("internal error");
  expect(reading.detail.join(" ")).not.toContain("network_error");
  // The step is a fresh GameBuddy, from the tray: a read of a Host that is not there cannot land.
  expect(reading.controls).not.toContain("Read it again");
  expect(reading.detail.join(" ")).toContain("tray icon");
});

test("a page and a Host that disagree are said to disagree", async ({ page }) => {
  const reading = await mountOver(page, (route) => route.fulfill(jsonOk(unreadableRoot)));

  expect(reading.windowIsTheCard).toBe(true);
  expect(reading.title).toMatch(/do not match/iu);
  expect(reading.detail.join(" ")).not.toContain("internal error");
  expect(reading.controls).not.toContain("Read it again");
});

test("a transient refusal keeps the read again, because that press is the one that helps", async ({ page }) => {
  const reading = await mountOver(page, (route) => route.fulfill(problem(503, "storage_unavailable")));

  expect(reading.windowIsTheCard).toBe(true);
  expect(reading.title, "a service that is temporarily unavailable is not a durable state").toMatch(
    /not available/iu,
  );
  expect(reading.controls, "the one cause where re-reading is the step lost its control").toEqual(["Read it again"]);
});
