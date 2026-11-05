/**
 * The shell's own read of the Chat list can disagree with the panel's decision, and when it
 * does the removed conversation must not stay on screen.
 *
 * The Chats panel owns the owner's rule "the active list never reaches zero": a removal that
 * would empty it creates the successor first and switches to it, and a removal that leaves
 * another Chat reports the mounted one gone so the shell moves to a survivor. The shell then
 * reads the list for itself to choose that survivor, and until this journey existed the branch
 * where its own read named none did exactly what the old defect did: it closed the live stream
 * and returned, leaving the shell rendering a conversation the active list no longer held - no
 * composer that could send, no cursor, and nothing saying either.
 *
 * Measured here on the shipped shell over route-mocked answers: the panel's re-read leaves a
 * survivor, so it reports the removal and never empties the list itself; the shell's own read
 * answers with the removed Chat alone. The authority the shell then reads is the mounted
 * conversation the Host really holds, and that is what the Chat surface must show.
 */
import { expect, test } from "./frontend-coverage";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const deadHandle = `${"B".repeat(42)}A`;
const survivorHandle = `${"E".repeat(42)}A`;
const deadRowHandle = `${"K".repeat(42)}A`;
const survivorRowHandle = `${"L".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const DEAD_TEXT = "The parsnips took. All of them, by the look of it.";
const SURVIVOR_TEXT = "A quieter morning than this one.";

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: deadHandle, generation: 1, stateRevision: deadHandle },
  chat: {
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
    title: "The mounted one",
    transcript: [{ handle: deadRowHandle, role: "companion", text: DEAD_TEXT, locale: "und", order: 0, revision: 1 }],
    draft: { revision: 4, present: true },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const composedGame = {
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

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: composedChat,
  game: composedGame,
};

const deadEntry = {
  handle: deadHandle,
  title: "The mounted one",
  status: "active",
  managementRevision: 1,
  isSelected: true,
  updatedAtMs: 1_760_000_000_000,
  preview: DEAD_TEXT,
};

const survivorEntry = {
  handle: survivorHandle,
  title: "The survivor",
  status: "active",
  managementRevision: 3,
  isSelected: false,
  updatedAtMs: 1_759_913_600_000,
  preview: SURVIVOR_TEXT,
};

test("a shell read that names no survivor still leaves the authority's conversation on screen", async ({ page }) => {
  const listReads: string[] = [];
  const stateReads: string[] = [];
  const selects: unknown[] = [];
  let removed = false;

  // The projection the Host publishes once the removal committed: the survivor is the
  // mounted conversation, and the removed Chat is not in it at all.
  const projection = () =>
    removed
      ? {
          ...composedRoot,
          chat: {
            ...composedChat,
            selection: { chatHandle: survivorHandle, generation: 2, stateRevision: survivorHandle },
            chat: {
              ...composedChat.chat,
              title: "The survivor",
              transcript: [
                { handle: survivorRowHandle, role: "companion", text: SURVIVOR_TEXT, locale: "und", order: 0, revision: 1 },
              ],
            },
          },
        }
      : composedRoot;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    stateReads.push(removed ? "after-removal" : "before-removal");
    return route.fulfill(jsonOk(projection()));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  /**
   * The two reads of one URL, in the order they happen.
   *
   * The first after the removal is the panel's own reconciliation, and it leaves the survivor -
   * which is what makes the panel report the mounted Chat gone instead of reporting a failure.
   * The second is the shell's, and it answers with the removed Chat alone: the shape where the
   * shell has nothing to move to and must read the authority instead of stopping.
   */
  await page.route("**/api/tavern/v1/chats?*", (route) => {
    const read = removed ? "after-removal" : "before-removal";
    listReads.push(read);
    const chats = removed ? (listReads.filter((entry) => entry === "after-removal").length === 1 ? [survivorEntry] : [deadEntry]) : [deadEntry, survivorEntry];
    return route.fulfill(jsonOk({ apiVersion: 1, chats }));
  });
  await page.route(`**/api/tavern/v1/chats/${deadHandle}/archive`, (route) => {
    removed = true;
    return route.fulfill(jsonOk({ apiVersion: 1, handle: deadHandle, status: "archived", managementRevision: 2 }));
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selects.push(route.request().postDataJSON());
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const chats = page.getByTestId("chats-surface");
  await expect(chats).toBeVisible();
  const mounted = chats.getByTestId("chat-item").filter({ hasText: "The mounted one" });
  await mounted.getByRole("button", { name: "Archive", exact: true }).click();
  await mounted.getByTestId("chat-retention-confirm-yes").click();

  // The shell never named a survivor, because its own read held none: what it must not do is
  // stop there with the removed conversation still mounted.
  await expect.poll(() => listReads.filter((entry) => entry === "after-removal").length).toBeGreaterThan(1);
  expect(selects, "the shell's read named no survivor to select").toEqual([]);
  expect(
    stateReads.filter((entry) => entry === "after-removal").length,
    "the shell stopped at its own list read instead of reading the authority",
  ).toBeGreaterThan(0);

  // The player's conversation is the one the Host holds, read from the authority.
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const conversation = page.getByTestId("chat-surface");
  await expect(conversation).toBeVisible();
  await expect(conversation).toContainText(SURVIVOR_TEXT);
  await expect(conversation.locator(".message-list > li"), "the removed conversation is still mounted").toHaveCount(1);
  await expect(conversation, "the removed Chat is still what the shell shows").not.toContainText(DEAD_TEXT);
  await expect(page.locator(".problem-view")).toHaveCount(0);
});
