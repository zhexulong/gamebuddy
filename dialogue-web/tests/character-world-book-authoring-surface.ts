import { type Locator, type Page, expect } from "@playwright/test";
import { draft, handle, jsonOk, root, token } from "./composed-reference-game-fixtures";

/**
 * The Characters surface around the managed World Info library, and the one write route its
 * authoring form saves through.
 *
 * The library reaches the panel through the composed snapshot's Chat half - the same read the Host
 * answers `GET /world-info` from - so the bootstrap and the state the panel re-reads serve it. The
 * item's own content is the panel's separate `world-info.detail` read, and the save route is the one
 * thing the caller reads back: every write body, in the order it was sent.
 *
 * The panel is mounted over ONE item, because that is the state the authoring form is reached in:
 * `Edit` is a row's control, and an edit carries the item's own content revision.
 */

/** The library item this surface serves, and the handle every read of it is addressed by. */
export const libraryItemHandle = `${"V".repeat(42)}A`;

/** The item's own content revision, which an update CASes on. */
export const libraryItemRevision = 3;

export const libraryItemTitle = "Pelican Town";

/** The library's projection: what the composed snapshot's Chat half carries. */
const libraryState = () => ({
  state: "selected" as const,
  revision: handle,
  items: [
    {
      handle: libraryItemHandle,
      title: libraryItemTitle,
      summary: "One square, one river, one saloon.",
      selected: false,
      pending: false,
    },
  ],
});

/** The item's content, as `world-info.detail` returns it: one entry, complete at its own revision. */
const itemContent = {
  revision: libraryItemRevision,
  publicTitle: libraryItemTitle,
  summary: "One square, one river, one saloon.",
  entries: [{ scope: "setting" as const, publicTitle: "The saloon", summary: "The only place open after dark." }],
};

const mountedRoot = () => ({
  ...root,
  chat: { ...root.chat, chat: { ...root.chat.chat, worldInfo: libraryState() } },
});

/** One write the panel sent, as it packed it. */
export type LibraryWorldBookWrite = Readonly<{
  method: string;
  body: {
    expectedRevision: string;
    itemHandle?: string;
    item?: { publicTitle: string; summary: string; expectedRevision?: number; entries: readonly unknown[] };
  };
}>;

/**
 * Stub the Characters surface over the library above, and record every write the panel sends.
 *
 * The default answer is the library re-projected after the write, which is the Host's own shape for
 * a save that landed. A journey that needs the Host to REFUSE one installs its own handler.
 */
export async function stubLibraryWorldBookSurface(page: Page): Promise<LibraryWorldBookWrite[]> {
  const writes: LibraryWorldBookWrite[] = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(mountedRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(mountedRoot())));
  // The library's binding reads the Chat half on its own route, never the aggregate: `/state`
  // refuses the whole document when the Game projection cannot be produced, and the library is a
  // surface the game has no part in (`game-projection-failure-is-not-the-chats.spec.ts`).
  await page.route("**/api/tavern/v1/state", (route) => route.fulfill(jsonOk(mountedRoot().chat)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [] })),
  );
  const characterReads = {
    persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
    scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
    greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
    "import-history": { apiVersion: 1, entries: [] },
  };
  for (const [path, body] of Object.entries(characterReads))
    await page.route(`**/api/tavern/v1/${path}`, (route) => route.fulfill(jsonOk(body)));
  await page.route(/\/api\/tavern\/v1\/world-info\/item(\?|$)/u, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill(jsonOk(itemContent));
      return;
    }
    writes.push({ method: request.method(), body: request.postDataJSON() as LibraryWorldBookWrite["body"] });
    await route.fulfill(jsonOk(libraryState()));
  });
  return writes;
}

/**
 * The Characters surface with the library's authoring form open over its one item, the way a player
 * opens it.
 */
export async function openLibraryWorldBookEditor(
  page: Page,
): Promise<Readonly<{ panel: Locator; editor: Locator }>> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
  const panel = page.locator("[data-world-book]");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: `Edit: ${libraryItemTitle}` }).click();
  const editor = panel.locator("[data-world-book-draft]");
  await expect(editor).toBeVisible();
  return { panel, editor };
}
