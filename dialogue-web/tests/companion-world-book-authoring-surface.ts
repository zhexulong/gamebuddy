import { type Locator, type Page, expect } from "@playwright/test";
import { hostWorldBookReply } from "./host-world-book-reply";

/**
 * The Characters surface around her own world book, and the save route it writes through.
 *
 * Two journeys state what the authoring form says and how tall it is, and both need the same six
 * reads the surface performs on mount. They are stubbed once here, with the book under test, and the
 * save route is the one thing the caller reads back: every PUT body, in the order it was sent.
 *
 * Every reply is checked by `hostWorldBookReply`, so a fixture that is not a book the Host could
 * serve fails at the line that stubs it instead of five seconds later as a missing attribute.
 */

export const companionWorldBookToken = "A".repeat(43);
export const companionWorldBookCsrf = `${"C".repeat(42)}A`;
export const companionWorldBookHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken: companionWorldBookCsrf,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: companionWorldBookHandle, generation: 1, stateRevision: companionWorldBookHandle },
    chat: {
      companion: { name: "琥珀", handle: `${"D".repeat(42)}A` },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: { state: "none", revision: companionWorldBookHandle, items: [] },
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken: companionWorldBookCsrf,
    browserSession: { expiresAtMs },
    game: {
      prerequisites: { status: "unknown", detectedGame: null },
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
  },
};

/** One `companion.worldbook.update` body, as the surface packed it. */
export type CompanionWorldBookSave = Readonly<{
  expectedRevision: number;
  entries: readonly Record<string, unknown>[];
}>;

/** The world book route's own pattern, so a journey can answer the save itself. */
export const companionWorldBookRoute = /\/api\/tavern\/v1\/companions\/[^/]+\/worldbook/u;

/**
 * Stub the surface and serve `book` from her own world book's read.
 *
 * The returned array is filled by the default save handler, which answers with the list it was sent
 * at the next revision - the Host's own shape for a save that landed. A journey that needs the Host
 * to REFUSE installs its own handler afterwards and answers the PUT itself (`route.fallback()`
 * leaves the read to this one).
 */
export async function stubCompanionWorldBookSurface(
  page: Page,
  book: unknown,
): Promise<CompanionWorldBookSave[]> {
  const served = hostWorldBookReply(book);
  const saves: CompanionWorldBookSave[] = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: companionWorldBookHandle, name: "琥珀", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/u, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route(companionWorldBookRoute, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.fulfill(jsonOk(served));
      return;
    }
    const body = route.request().postDataJSON() as CompanionWorldBookSave;
    saves.push(body);
    await route.fulfill(
      jsonOk(
        hostWorldBookReply({
          ...served,
          revision: (served.revision ?? 0) + 1,
          entries: body.entries,
        }),
      ),
    );
  });
  return saves;
}

/** The editor, opened the way a player opens it. */
export async function openCompanionWorldBookEditor(
  page: Page,
): Promise<Readonly<{ block: Locator; editor: Locator }>> {
  await page.goto(`/#profile=composed-reference-game&boot=${companionWorldBookToken}&panel=characters`);
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  const block = surface.locator("[data-companion-world-book]");
  await block.locator("[data-companion-world-book-edit]").click();
  const editor = block.locator("[data-companion-world-book-draft]");
  await expect(editor).toBeVisible();
  return { block, editor };
}
