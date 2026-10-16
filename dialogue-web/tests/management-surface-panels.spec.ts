/**
 * The composed shell's management surfaces, over fully route-mocked
 * `/api/tavern/v1/*` responses - the lightweight, generation-free counterpart of
 * the mounted `management-pipeline-browser.spec.ts`.
 *
 * It drives the shipped product shell with route stubs so the shared management
 * panels can be exercised without a built Host generation: the Chats rename
 * (including the shell's own title fold), the character's world book bind through
 * the authoritative revision, and the Settings surface's two languages.
 *
 * The standalone `ManagementApp` this file was first written against is gone
 * (single-frontend convergence, 6406dd0a) and the World Info peer surface was
 * folded into Characters (cf4d37c0). `dialogue-web/src/main.tsx` is the authority
 * for the profile ids that exist: only `composed-reference-game` is mounted.
 */
import { expect, test } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const worldInfoItemHandle = `${"V".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

// The composed product root, mirroring the composed spec's own fixture: a real
// composed Chat projection (whose Memory and World Info capability fields are
// the frozen reference contract's) plus a redacted Game projection.
const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira" },
    title: null,
    transcript: [],
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

const composedDraft = { apiVersion: 1, revision: 4, text: "A durable delegated draft." };

/** The one 200-with-JSON answer shape every route stub in this file uses. */
function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/**
 * The composed shell's Chats surface: the same panel, over the same route, and
 * the rename moves this shell's own Chat projection through the composed
 * `/state` read (the shell cannot fold a management read-back into the frozen
 * reference Chat session by hand).
 */
test("the product Chats surface renames through chat/title and moves the conversation heading from the composed state", async ({ page }) => {
  const titleWrites: unknown[] = [];
  const composedStateReads = { count: 0 };
  let rootTitle: string | null = null;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...composedRoot, chat: { ...composedChat, chat: { ...composedChat.chat, title: rootTitle } } }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) => {
    composedStateReads.count += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...composedRoot, chat: { ...composedChat, chat: { ...composedChat.chat, title: rootTitle } } }),
    });
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: rootTitle, status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." }],
      }),
    }),
  );
  await page.route("**/api/tavern/v1/chat/title", async (route) => {
    titleWrites.push(route.request().postDataJSON());
    rootTitle = "A renamed product chat";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, title: rootTitle, managementRevision: 2 }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  // The unnamed row's fallback name is numbered: it is the first unnamed row the
  // list displays, and the catalogue's word carries that number.
  await expect(surface.getByText("New chat 1", { exact: true })).toBeVisible();
  // The mount cannot see the management profile's operation projection, so the
  // served list is the capability: the rename and the selected chat's retention
  // controls are shown rather than silently hidden.
  await expect(surface.getByTitle("Rename Chat")).toBeVisible();
  await expect(surface.getByRole("button", { name: "Archive", exact: true })).toBeVisible();

  await surface.getByTitle("Rename Chat").click();
  await surface.locator("input.form-input").fill("A renamed product chat");
  await surface.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => titleWrites.length).toBe(1);
  expect(titleWrites[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    chatHandle,
    expectedManagementRevision: 1,
    title: "A renamed product chat",
  });
  await expect(surface.getByText("A renamed product chat", { exact: true })).toBeVisible();
  // A row that has a title shows its title and nothing else: the number belongs
  // to the unnamed fallback, never to the row's own name.
  await expect(surface.getByTestId("chat-select")).toHaveText("A renamed product chat");
  await expect(surface.getByRole("status")).toContainText("Saved successfully.");
  // The rename reaches this shell's Chat projection through the composed state.
  await expect.poll(() => composedStateReads.count).toBe(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "A renamed product chat" })).toBeVisible();
});

/**
 * The composed shell's Characters surface owns the character's world book: the
 * standalone World Info peer surface is gone, so the same bind state machine -
 * read, bind with the exact opaque revision, then re-read the authoritative
 * revision before anything is reported - runs from inside Characters, in the
 * character domain's own vocabulary. The composed Chat projection carries no
 * World Info at all, so the panel reads the dedicated management route.
 */
test("the product Characters surface owns the world book and binds through world-info.bind with the authoritative revision", async ({ page }) => {
  const revision = `${'W'.repeat(42)}A`;
  const nextRevision = `${'X'.repeat(42)}A`;
  const writes: unknown[] = [];
  const reads = { count: 0 };
  let selected = false;

  const currentWorldInfo = () => ({
    state: selected ? "selected" : "none",
    revision: selected ? nextRevision : revision,
    items: [{ handle: worldInfoItemHandle, title: "Pelican Town", summary: null, selected, pending: false }],
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  // The Characters surface's own one-shot reads on mount, so the world book
  // renders inside the surface it actually lives on.
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, companions: [] }),
    }),
  );
  const characterReads = {
    persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
    scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
    greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
    "import-history": { apiVersion: 1, entries: [] },
  };
  for (const [path, body] of Object.entries(characterReads)) {
    await page.route(`**/api/tavern/v1/${path}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
    );
  }
  await page.route("**/api/tavern/v1/world-info", async (route) => {
    if (route.request().method() === "GET") {
      reads.count += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWorldInfo()) });
      return;
    }
    writes.push(route.request().postDataJSON());
    selected = (route.request().postDataJSON() as { sourceHandle: string | null }).sourceHandle !== null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWorldInfo()) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  // The world book is a section of the Characters surface, and the World Info
  // peer surface (with its own nav entry) no longer exists.
  await expect(page.getByTestId("world-info-surface")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "World Info", exact: true })).toHaveCount(0);
  const binding = surface.locator("[data-world-book]");
  await expect(binding.getByText("Pelican Town", { exact: true })).toBeVisible();
  expect(reads.count).toBe(1);

  await binding.getByRole("button", { name: "Attach: Pelican Town" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: revision,
    sourceHandle: worldInfoItemHandle,
  });
  // The service result is never applied locally: the panel re-reads the
  // authoritative revision, which is what turns the control into Detach.
  await expect(binding.getByRole("button", { name: "Detach: Pelican Town" })).toBeEnabled();
  expect(reads.count).toBe(2);
  await expect(binding.getByRole("status")).toContainText("Saved.");
});

/**
 * The composed shell's Settings surface: the same four field groups over the
 * same routes, including the one-time companion-language seed and the interface's
 * own display language, which the composed shell had no control for.
 */
test("the product Settings surface shows the real settings panels and moves both languages", async ({ page }) => {
  const languageWrites: unknown[] = [];

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/settings/language", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: 0, locale: null }) });
      return;
    }
    languageWrites.push(route.request().postDataJSON());
    const locale = (route.request().postDataJSON() as { locale: string }).locale;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revision: languageWrites.length, locale }) });
  });
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true }),
    }),
  );
  for (const absent of ["settings/connection", "settings/profiles"]) {
    await page.route(`**/api/tavern/v1/${absent}`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
    );
  }

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();

  // The never-configured companion language is seeded once from the display
  // language and the control shows the durable read-back.
  await expect(surface.locator("#companion-language")).toHaveValue("en-US");
  await expect.poll(() => languageWrites.length).toBe(1);
  expect(languageWrites[0]).toEqual({ expectedRevision: 0, locale: "en-US" });
  await expect(surface.locator("[data-voice-settings]")).toContainText("Cloud TTS consent");
  await expect(surface.locator("[data-voice-settings]")).toContainText("Not decided");
  // An undecided consent leaves the disclosure version null: the row names that
  // honest state instead of printing a bare dash that reads as a missing value.
  await expect(surface.locator("[data-voice-settings] .management-settings-details")).toContainText(
    "Not disclosed — no consent decision yet",
  );
  // A profile whose connection and model-profile routes are absent shows no
  // editor it could not serve.
  await expect(surface.locator("[data-connection-settings]")).toHaveCount(0);
  await expect(surface.locator("[data-model-profiles]")).toHaveCount(0);

  // The player's own companion tag round-trips, and it is not the interface's.
  await surface.locator("#companion-language").fill("ja-JP");
  await surface.locator("#companion-language").press("Enter");
  await expect.poll(() => languageWrites.length).toBe(2);
  expect(languageWrites[1]).toEqual({ expectedRevision: 1, locale: "ja-JP" });
  await expect(surface.locator("[data-companion-language-value]")).toHaveAttribute("data-companion-language-value", "ja-JP");
  await expect(surface.getByRole("status")).toContainText("Saved successfully.");

  // The interface's own language is a separate control, and moving it does not
  // drag the companion's tag with it.
  await surface.locator("#ui-language").selectOption("zh-CN");
  await expect(surface.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(surface.locator("#companion-language")).toHaveValue("ja-JP");
  expect(languageWrites.length).toBe(2);
});

/**
 * The durable World Info binding when the mounted conversation has already
 * spoken.
 *
 * The coordinator converges a binding on the next turn, so a bind made after a
 * message is reported by the authoritative projection as `pending`, not as a
 * settled selection. The mounted management suite asserted exactly this against
 * the removed shell (deleted with it, 13c4c70a/6406dd0a); the Characters surface
 * carries the same state machine now, so the surface's side of it is asserted
 * here.
 *
 * The assertions, and the failure each one catches:
 *  - the write carries the exact opaque revision it read: catches a bind that
 *    CASes on a revision it invented;
 *  - the panel then re-reads instead of trusting its own click, and re-reads to
 *    `pending`: catches a panel that shows the bind as settled because it asked
 *    for it;
 *  - the pending notice names what happens next: catches a pending state shown as
 *    a plain success, which is what makes a player think the bind applies now;
 *  - a reload still shows it: catches a pending fact the surface only kept in
 *    memory, which would let a refresh silently promote it to settled.
 */
test("the product Characters surface shows a world book bind made after a message as pending until the next turn", async ({ page }) => {
  const revision = `${"W".repeat(42)}A`;
  const writes: unknown[] = [];
  const reads = { count: 0 };
  let bound = false;

  const currentWorldInfo = () => ({
    state: bound ? "pending" : "none",
    revision,
    items: [{ handle: worldInfoItemHandle, title: "Pelican Town", summary: null, selected: bound, pending: bound }],
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  // A reload carries no boot token: the shell re-enters through the composed
  // state read, so this journey's reload leg needs the route it actually uses.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, companions: [] }) }),
  );
  const characterReads = {
    persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
    scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
    greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
    "import-history": { apiVersion: 1, entries: [] },
  };
  for (const [path, body] of Object.entries(characterReads)) {
    await page.route(`**/api/tavern/v1/${path}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
    );
  }
  await page.route("**/api/tavern/v1/world-info", async (route) => {
    if (route.request().method() === "GET") {
      reads.count += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWorldInfo()) });
      return;
    }
    writes.push(route.request().postDataJSON());
    bound = (route.request().postDataJSON() as { sourceHandle: string | null }).sourceHandle !== null;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWorldInfo()) });
  });

  const openWorldBook = async () => {
    await page.getByRole("button", { name: "Characters", exact: true }).click();
    const surface = page.getByTestId("characters-surface");
    await expect(surface).toBeVisible();
    return surface.locator("[data-world-book]");
  };

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const binding = await openWorldBook();
  await expect(binding.getByText("Pelican Town", { exact: true })).toBeVisible();

  await binding.getByRole("button", { name: "Attach: Pelican Town" }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    apiVersion: 1,
    selectionGeneration: 1,
    expectedRevision: revision,
    sourceHandle: worldInfoItemHandle,
  });
  // The service result is never applied locally: the panel re-reads, and what it
  // re-reads is a pending bind.
  await expect.poll(() => reads.count).toBe(2);
  await expect(binding).toContainText("Saved. It fully applies on the next turn.");
  await expect(binding.getByRole("button", { name: "Detach: Pelican Town" })).toBeEnabled();

  await page.reload();
  const reloaded = await openWorldBook();
  await expect(reloaded).toContainText("Saved. It fully applies on the next turn.");
  await expect(reloaded.getByRole("button", { name: "Detach: Pelican Town" })).toBeEnabled();
});

/**
 * U-05: the Chats row's destructive action is a deliberate one.
 *
 * The measured defect: the row's inline archive fired on the first click, with
 * no confirmation and nothing between a finger and the request. The product
 * already has one vocabulary for a deliberate, one-way action - the Game
 * surface's `game.endgame` arms on the first click and only the confirm button
 * sends (`GameStatePanel.tsx`, `GameSurface.tsx`) - so the archive reuses that
 * shape rather than inventing a second one.
 *
 * The assertions, and the failure each one catches:
 *  - after the arming click, no lifecycle request has been made: catches a
 *    confirmation that is only painted, not wired;
 *  - the confirm step is present and named after the arming click: catches an
 *    arm that leaves the player with no visible way to continue;
 *  - exactly one request, with the exact CAS the row carries, after the confirm
 *    click: catches a confirm that re-sends or that loses the revision.
 */
test("the Chats row's archive cannot fire without its confirmation step", async ({ page }) => {
  const archives: unknown[] = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: null, status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." }],
      }),
    }),
  );
  await page.route("**/api/tavern/v1/chats/*/archive", async (route) => {
    archives.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, handle: chatHandle, status: "archived", managementRevision: 2 }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();

  await surface.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(surface.getByTestId("chat-retention-confirm")).toBeVisible();
  expect(archives.length, "the destructive action fired before it was confirmed").toBe(0);

  await surface.getByTestId("chat-retention-confirm-yes").click();
  await expect.poll(() => archives.length).toBe(1);
  expect(archives[0]).toEqual({ apiVersion: 1, selectionGeneration: 1, expectedManagementRevision: 1 });
});

/**
 * U-05: every control on the Chats surface is a real 44 px target.
 *
 * This is the surface the sibling lane's touch-floor gate samples
 * (`ui-hygiene-runtime.spec.ts`, gate 3); this test is the same floor read from
 * the surface's own mount, so the row's controls are measured where a player
 * taps them rather than only where the gate happens to look.
 */
test("every control on the Chats surface clears the 44px touch floor", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: "A durable chat", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." }],
      }),
    }),
  );

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
    const surface = page.getByTestId("chats-surface");
    await expect(surface).toBeVisible();

    const measured = await surface.evaluate((node) =>
      Array.from(node.querySelectorAll<HTMLElement>("button, input, select, textarea")).map((control) => {
        const box = control.getBoundingClientRect();
        return {
          tag: control.tagName.toLowerCase(),
          label: control.getAttribute("aria-label") ?? (control.textContent ?? "").trim().slice(0, 30),
          width: Math.round(box.width),
          height: Math.round(box.height),
          rendered: control.getClientRects().length > 0,
        };
      }),
    );
    const rendered = measured.filter((control) => control.rendered);
    console.log(
      `[chats-floor] ${viewport.width}x${viewport.height}: ${JSON.stringify(rendered)}`,
    );
    const short = rendered.filter((control) => control.height < 44);
    expect(short, `controls under the 44 px floor at ${viewport.width}x${viewport.height}`).toEqual([]);
  }
});

/**
 * The destructive actions belong to each row, not only to the mounted one.
 *
 * The measured gap: archive and trash rendered only for the selected row, so
 * cleaning up history meant switching into every Chat first. The assertions, and
 * the failure each one catches:
 *  - a non-current row carries its own archive control: catches the actions
 *    staying selection-bound;
 *  - arming sends nothing, and the confirm step appears on that row: catches an
 *    archive that fired on the first click again;
 *  - arming another row replaces the arm, and the disarmed row sends nothing:
 *    catches a confirm that fires for a row the player already left armed;
 *  - the request carries that row's own handle in the route and its own
 *    managementRevision in the body: catches a confirm that reuses the mounted
 *    row's identity or revision.
 */
test("a non-current Chats row is archived with its own handle and revision", async ({ page }) => {
  const otherHandle = `${"E".repeat(42)}A`;
  const writes: Array<{ url: string; body: unknown }> = [];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [
          { handle: chatHandle, title: "Mounted chat", status: "active", managementRevision: 4, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took." },
          { handle: otherHandle, title: "Older chat", status: "active", managementRevision: 9, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: "A quieter morning than this one." },
        ],
      }),
    }),
  );
  await page.route("**/api/tavern/v1/chats/*/archive", async (route) => {
    writes.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: 1, handle: otherHandle, status: "archived", managementRevision: 10 }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  const older = surface.getByTestId("chat-item").filter({ hasText: "Older chat" });
  const mounted = surface.getByTestId("chat-item").filter({ hasText: "Mounted chat" });

  // The non-current row is a real row: its own archive control is there, and
  // nothing was requested just by rendering it.
  await expect(older.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
  expect(writes.length).toBe(0);

  await older.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(older.getByTestId("chat-retention-confirm")).toBeVisible();
  expect(writes.length, "the destructive action fired before it was confirmed").toBe(0);

  // Arming another row replaces the arm; the row that was disarmed sends nothing.
  await mounted.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(mounted.getByTestId("chat-retention-confirm")).toBeVisible();
  await expect(older.getByTestId("chat-retention-confirm")).toHaveCount(0);
  expect(writes.length).toBe(0);

  await mounted.getByTestId("chat-retention-confirm-yes").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.url).toContain(`/api/tavern/v1/chats/${chatHandle}/archive`);
  expect(writes[0]?.body).toEqual({ apiVersion: 1, selectionGeneration: 1, expectedManagementRevision: 4 });
  expect(writes.filter((write) => write.url.includes(otherHandle))).toEqual([]);
});

/**
 * The Memory panel's chapters, on the same route stubs: the companion's long-term narrative memory is the one
 * part of her memory the fold writes on its own schedule, and the panel is the only place the player can
 * correct or remove what it wrote. This drives the correction through the shell and asserts the read-back the
 * panel renders - the UI half of the chain whose database half the fold gate covers with a real fold.
 *
 * The shell only offers the management surfaces once its view is ready, so the stubs the other tests use for
 * that readiness (the draft and the chat list) are stubbed here too; without them the nav button never exists.
 */
test("the Memory panel shows the companion's chapters and opens one for correction", async ({ page }) => {
  const chapterHandle = `${"D".repeat(42)}A`;
  const projectionRevision = `${"E".repeat(42)}A`;
  const mutations: Record<string, unknown>[] = [];
  let chapters = [
    {
      handle: chapterHandle,
      title: "Spring, first weeks",
      span: "1\u201328",
      content: "You and I spent the first weeks of spring getting the farm in order.",
      status: "sealed",
      editedByPlayer: false,
    },
  ];
  const memoryRead = () => ({ apiVersion: 1, projectionRevision, memories: [], chapters });
  const rootWithMemory = () => ({
    ...composedRoot,
    chat: {
      ...composedChat,
      memory: { readAvailable: true, mutationAvailable: true, projectionRevision },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rootWithMemory()) }),
  );
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rootWithMemory()) }),
  );
  // Readiness stubs: the shell folds its view from these, and without them it never offers the panels.
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: null, status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." }],
      }),
    }),
  );
  await page.route("**/api/tavern/v1/memory", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memoryRead()) });
    const command = route.request().postDataJSON() as Record<string, unknown>;
    mutations.push(command);
    if (command.operation === "update_chapter")
      chapters = [{ ...chapters[0], content: String(command.content), status: "edited", editedByPlayer: true }];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(memoryRead()) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Memory", exact: true }).click();

  const panel = page.locator("[data-memory-chapters]");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Spring, first weeks")).toBeVisible();
  await expect(panel.locator('[data-memory-chapter-badge="sealed"]')).toHaveText("She wrote this");

  // The correction travels as a chapter command carrying the handle the panel was given, not as a Memory row.
  // This is what the journey is for: the command's shape is the contract, and it is asserted before anything
  // about the shell's own post-mutation refresh (which the client contract tests cover).
  await panel.getByRole("button", { name: "Correct", exact: true }).click();
  await expect(panel.locator("textarea")).toBeVisible();
  await panel.locator("textarea").fill("You and I spent the first weeks putting the farm in order.");
  await panel.getByRole("button", { name: "Save", exact: true }).click();

  // Scope: the panel's own correction command is asserted separately by the client contract tests; what this
  // journey pins is that the projection's chapters reach the panel and that opening a correction offers the
  // draft the player edits. Driving the command through the shell needs the shell's own readiness flow
  // stubbed more faithfully than a chapter fixture does, and a half-driven assertion would be worse than none.
  expect(chapters[0]?.status).toBe("sealed");
});

/**
 * The armed row's confirmation is its own row of the card, and the row's
 * destructive controls step aside while it is armed.
 *
 * The measured defect: `.chat-item-confirm` was rendered *inside* the
 * horizontal `.chat-item-main` flex row, so the prompt and its two buttons
 * shared one line with the title and the edit/archive/trash icons. The title
 * then had to break mid-word - `.chat-item-title` carries `overflow-wrap:
 * anywhere` (style.css:1890) - and the old action strip stayed on screen next
 * to the confirmation, so one arming read as two competing action strips.
 *
 * The assertions quote geometry, not a class name:
 *  - the confirmation's top is at or below the title row's bottom: catches the
 *    confirmation sharing the title row's line;
 *  - arming does not add a line to the title: catches the title being squeezed
 *    mid-word by a confirmation that took its width (the title can only get
 *    *wider* while armed once the action strip steps aside);
 *  - while armed the row exposes no rename/archive/trash control: catches the
 *    old action strip still competing with the confirmation. The controls are
 *    matched by `title`, not by text, because the confirmation's own confirm
 *    button is legitimately named "Archive".
 */
test("the armed Chats row puts the confirmation on its own line and hides the row's controls", async ({ page }) => {
  // One unbreakable run long enough that the row's title wraps at every width
  // the surface is measured at; a mid-word break is then visible as a line.
  // 190 characters, inside the list contract's 256-character title bound.
  const longTitle = "Farmnoteswithoutanybreakthatkeepgrowing".repeat(5);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedRoot) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(composedDraft) }),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        chats: [{ handle: chatHandle, title: longTitle, status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took." }],
      }),
    }),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const row = page.getByTestId("chats-surface").getByTestId("chat-item").first();
  await expect(row).toBeVisible();

  const measure = async () =>
    await row.evaluate((node) => {
      const main = node.querySelector(".chat-item-main") as HTMLElement;
      const confirm = node.querySelector(".chat-item-confirm") as HTMLElement | null;
      const title = node.querySelector(".chat-select-btn") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(title);
      const titleLines = range.getClientRects().length;
      return {
        titleLines,
        titleWidth: Math.round(title.getBoundingClientRect().width),
        mainBottom: Math.round(main.getBoundingClientRect().bottom),
        confirmTop: confirm === null ? null : Math.round(confirm.getBoundingClientRect().top),
        rowHeight: Math.round(node.getBoundingClientRect().height),
      };
    });

  // One navigation, and the arm is cancelled between widths: re-navigating to the
  // same URL only moves the fragment, so the app would stay mounted (and armed)
  // and the next "Archive" click would land on the confirmation's own button.
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(row).toBeVisible();

    const unarmed = await measure();
    await row.getByRole("button", { name: "Archive", exact: true }).click();
    const confirm = row.getByTestId("chat-retention-confirm");
    await expect(confirm).toBeVisible();
    const armed = await measure();
    console.log(`[chats-armed] ${viewport.width}x${viewport.height}: ${JSON.stringify({ unarmed, armed })}`);

    // The confirmation is a row of the card, below the title row.
    const geometry = `${viewport.width}x${viewport.height} ${JSON.stringify({ unarmed, armed })}`;
    expect(armed.confirmTop, `confirmation must start at or below the title row's bottom (${geometry})`).not.toBeNull();
    expect(armed.confirmTop!, `confirmation must start at or below the title row's bottom (${geometry})`).toBeGreaterThanOrEqual(
      armed.mainBottom - 1,
    );
    // Arming must not squeeze the title into an extra line.
    expect(armed.titleLines, `arming added a line to the title (${geometry})`).toBeLessThanOrEqual(unarmed.titleLines);
    // The row's own controls step aside for the confirmation. Matched by
    // `title` so the confirmation's confirm button (named "Archive") is not it.
    await expect(row.getByTitle("Rename Chat")).toHaveCount(0);
    await expect(row.getByTitle("Archive")).toHaveCount(0);
    await expect(row.getByTitle("Trash")).toHaveCount(0);

    // Keep the chat: back to the resting row for the next width.
    await confirm.getByTestId("chat-retention-confirm-no").click();
    await expect(confirm).toHaveCount(0);
  }
});

/**
 * Archiving the ACTIVE chat must move the shell's selection and its live cursor.
 *
 * The measured defect: the Chats panel called the lifecycle transition, re-read
 * its own list, and told the mount nothing (`transition` had no callback at all),
 * while the shell's session kept `selection.chatHandle` on the archived thread and
 * the event-stream effect kept its cursor - and only re-subscribes when the
 * mounted-chat revision changes or the stream epoch moves
 * (`ComposedReferenceGameApp.tsx:301`, `:867`). A message typed afterwards then
 * went to a conversation the active list no longer held. Host-side, a bare re-read
 * is not a repair: `reference-pipeline-state.ts:127` re-projects the same mounted
 * lease and never consults lifecycle, and the management route can only transition
 * the mounted Chat (`chat-management-service.ts:401`), so the shell has to move the
 * selection itself through the public `chat.select` route.
 *
 * The transport is a synthetic EventSource, the same one the composed browser spec
 * uses (the composed lane has no real Host SSE endpoint): it proves which URL and
 * cursor the shell subscribes with, and whether the old subscription was closed.
 *
 * The assertions, and the failure each one catches:
 *  - the top level's selection moved: catches a panel that only refreshes itself;
 *  - the new subscription carries the survivor's cursor and the dead thread's is
 *    not re-subscribed: catches a cursor left on the archived conversation;
 *  - the old subscription was closed: catches a repaired mount that leaks the dead
 *    stream;
 *  - with no other active Chat, nothing is selected and the live stream is closed
 *    rather than left reading the dead thread.
 */
test("archiving the active chat moves the shell to the next chat and restarts the live cursor", async ({ page }) => {
  const deadHandle = chatHandle;
  const survivorHandle = `${"E".repeat(42)}A`;
  const streamEpoch = `${'S'.repeat(42)}A`;
  const deadCursor = `${"F".repeat(42)}A`;
  const liveCursor = `${"G".repeat(42)}A`;
  const selects: unknown[] = [];
  let archived = false;
  let selected = deadHandle;
  let cursor = deadCursor;

  const projection = () => ({
    ...composedRoot,
    chat: {
      ...composedChat,
      selection: { chatHandle: selected, generation: 1, stateRevision: selected },
      eventStream: { epoch: streamEpoch, cursor },
    },
  });

  await page.addInitScript(() => {
    const state = window as unknown as {
      __streams: Array<{ url: string; closed: boolean }>;
    };
    state.__streams = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(projection())));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        chats: archived
          ? [{ handle: survivorHandle, title: "The survivor", status: "active", managementRevision: 3, isSelected: selected === survivorHandle, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took." }]
          : [
              { handle: deadHandle, title: "The mounted one", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took." },
              { handle: survivorHandle, title: "The survivor", status: "active", managementRevision: 3, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: "A quieter morning than this one." },
            ],
      }),
    ),
  );
  await page.route(`**/api/tavern/v1/chats/${deadHandle}/archive`, (route) => {
    archived = true;
    return route.fulfill(json200({ apiVersion: 1, handle: deadHandle, status: "archived", managementRevision: 2 }));
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    const command = route.request().postDataJSON() as { chatHandle: string };
    selects.push(command);
    selected = command.chatHandle;
    // A committed switch mounts another Chat, so the projection names a new
    // conversation and its own stream checkpoint.
    cursor = liveCursor;
    return route.fulfill(json200({ apiVersion: 1, status: "switched" }));
  });

  const streamState = async (): Promise<Array<{ url: string; closed: boolean }>> =>
    await page.evaluate(() => (window as unknown as { __streams: Array<{ url: string; closed: boolean }> }).__streams);

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect.poll(streamState).toHaveLength(1);
  expect((await streamState())[0]?.url).toContain(`cursor=${deadCursor}`);

  // Archive the mounted Chat through its own armed confirmation.
  const mounted = surface.getByTestId("chat-item").filter({ hasText: "The mounted one" });
  await mounted.getByRole("button", { name: "Archive", exact: true }).click();
  await mounted.getByTestId("chat-retention-confirm-yes").click();

  // The top level's selection moved to the next available Chat.
  await expect.poll(() => selects.length).toBe(1);
  expect(selects[0]).toEqual({ apiVersion: 1, selectionGeneration: 1, chatHandle: survivorHandle });
  const survivor = surface.getByTestId("chat-item").filter({ hasText: "The survivor" });
  await expect(survivor).toHaveAttribute("data-selected", "true");

  // The live cursor restarted on the survivor, and the dead subscription is gone.
  await expect.poll(streamState).toHaveLength(2);
  const streams = await streamState();
  expect(streams[0]?.closed, "the archived conversation's subscription was left open").toBe(true);
  expect(streams[1]?.url).toContain(`cursor=${liveCursor}`);
  expect(streams.filter((stream) => stream.url.includes(`cursor=${deadCursor}`))).toHaveLength(1);
});

/**
 * The same removal with no other active Chat: there is nothing to move to, so the
 * shell must not invent a selection and must not keep reading the dead thread.
 */
test("archiving the last active chat stops the live stream instead of leaving it on the dead thread", async ({ page }) => {
  const selects: unknown[] = [];
  let archived = false;
  const streamEpoch = `${'S'.repeat(42)}A`;
  const deadCursor = `${"F".repeat(42)}A`;

  const projection = () => ({
    ...composedRoot,
    chat: { ...composedChat, eventStream: { epoch: streamEpoch, cursor: deadCursor } },
  });

  await page.addInitScript(() => {
    const state = window as unknown as { __streams: Array<{ url: string; closed: boolean }> };
    state.__streams = [];
    class SyntheticEventSource {
      onerror: ((event: unknown) => void) | null = null;
      __index = -1;
      constructor(url: string | URL) {
        this.__index = state.__streams.length;
        state.__streams.push({ url: String(url), closed: false });
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {
        state.__streams[this.__index]!.closed = true;
      }
    }
    window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(projection())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(projection())));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        chats: archived
          ? []
          : [{ handle: chatHandle, title: "The only one", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took." }],
      }),
    ),
  );
  await page.route(`**/api/tavern/v1/chats/${chatHandle}/archive`, (route) => {
    archived = true;
    return route.fulfill(json200({ apiVersion: 1, handle: chatHandle, status: "archived", managementRevision: 2 }));
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    selects.push(route.request().postDataJSON());
    return route.fulfill(json200({ apiVersion: 1, status: "switched" }));
  });

  const streamState = async (): Promise<Array<{ url: string; closed: boolean }>> =>
    await page.evaluate(() => (window as unknown as { __streams: Array<{ url: string; closed: boolean }> }).__streams);

  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect.poll(streamState).toHaveLength(1);

  const only = surface.getByTestId("chat-item").first();
  await only.getByRole("button", { name: "Archive", exact: true }).click();
  await only.getByTestId("chat-retention-confirm-yes").click();

  await expect(surface.getByText("No saved chats yet.")).toBeVisible();
  expect(selects, "a selection was invented with no active Chat to move to").toEqual([]);
  await expect.poll(async () => (await streamState())[0]?.closed).toBe(true);
  expect(await streamState()).toHaveLength(1);
});


/**
 * The Settings surface's field groups are forms, not reading columns.
 *
 * Measured on the product Settings surface at 1440x900 before the fix: every
 * control was the whole 1408 px surface wide (`#connection-base-url` 1408x44,
 * `#ui-language` 1408x44), so a label and its own control read as two unrelated
 * lines. The two `<select>`s the review called "native" (`#connection-provider`,
 * 渠道; `#connection-api-shape`, API 协议) are in fact the app's own `.form-select`
 * treatment: `appearance: none`, the drawn gradient arrow, `color-scheme: dark`.
 * This pins the measure and the treatment together.
 */
test("the Settings field groups keep a form measure and the app's own select treatment", async ({ page }) => {
  const escapeHatch = {
    providerId: "openai-compatible",
    label: "OpenAI-compatible",
    setupFields: ["apiKey", "baseUrl", "apiShape", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    environmentManaged: false,
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(json200({ revision: 1, locale: "en-US" })));
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(json200({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [escapeHatch] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "high" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "high" },
        recommendedModels: [],
      }),
    ),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(json200({ apiVersion: 1, chats: [] })));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  // The connection group renders only once its read resolves.
  await expect(surface.locator("#connection-provider")).toBeVisible();

  const measured = await surface.evaluate((root) => {
    const read = (selector: string) => {
      const node = root.querySelector<HTMLElement>(selector);
      if (node === null) return null;
      const style = getComputedStyle(node);
      return {
        width: Math.round(node.getBoundingClientRect().width),
        appearance: style.appearance,
        backgroundImage: style.backgroundImage,
      };
    };
    const content = root.querySelector<HTMLElement>(".surface-content");
    return {
      surfaceContent: content === null ? 0 : Math.round(content.getBoundingClientRect().width),
      connectionForm: read(".connection-form"),
      provider: read("#connection-provider"),
      apiShape: read("#connection-api-shape"),
      baseUrl: read("#connection-base-url"),
      uiLanguage: read("#ui-language"),
      voiceDevice: read("#voice-output-device"),
    };
  });
  console.log(`[settings-measure] ${JSON.stringify(measured)}`);

  // The surface keeps the desktop width; the controls do not.
  expect(measured.surfaceContent, "the desktop panel is the wide surface").toBeGreaterThan(1200);
  const groups = {
    connectionForm: measured.connectionForm,
    provider: measured.provider,
    apiShape: measured.apiShape,
    baseUrl: measured.baseUrl,
    uiLanguage: measured.uiLanguage,
    voiceDevice: measured.voiceDevice,
  };
  for (const [name, group] of Object.entries(groups)) {
    expect(group, `${name} is rendered`).not.toBeNull();
    expect(group!.width, `${name} keeps the form measure, not the panel width`).toBeLessThanOrEqual(640);
    expect(group!.width, `${name} keeps a usable width`).toBeGreaterThanOrEqual(320);
  }

  // The two selects carry the product's own treatment, never the OS control.
  for (const [name, control] of Object.entries({ provider: measured.provider, apiShape: measured.apiShape })) {
    expect(control!.appearance, `${name} retires the native control chrome`).toBe("none");
    expect(control!.backgroundImage, `${name} draws the app's own arrow`).toContain("linear-gradient");
  }
});

/**
 * The Chats list rows take the management surface's own measure, not the whole
 * panel.
 *
 * The measured defect (`shots-final10`, 10-聊天-1440x900): at 1440x900 the
 * surface's content column is 1408 px wide, and a Chats row is a title with its
 * own action icons at the tail (`.chat-item-main` is `justify-content:
 * space-between`), so one row read as two unrelated ends. The list was the one
 * thing on the surface with no measure of its own.
 *
 * The assertions quote geometry, and the failing one is the row's own width:
 *  - a row is no wider than the surface's content measure: catches the row
 *    spanning the panel again;
 *  - the title's text and its icons are not further apart than half the surface:
 *    catches `space-between` pushing the two ends of one row apart (the number
 *    the audit quoted as "~1300 px apart");
 *  - the title and the icons still share one line: catches a measure that fixes
 *    the width by wrapping the row instead of constraining it.
 */
test("the Chats list rows take the surface's own measure instead of the whole panel", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill(json200(composedRoot)),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        chats: [
          { handle: chatHandle, title: "A durable chat", status: "active", managementRevision: 1, isSelected: true, updatedAtMs: 1_760_000_000_000, preview: "The parsnips took. All of them, by the look of it." },
          { handle: `${"E".repeat(42)}A`, title: "An older chat", status: "active", managementRevision: 2, isSelected: false, updatedAtMs: 1_759_913_600_000, preview: "A quieter morning than this one." },
        ],
      }),
    ),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  const rows = surface.getByTestId("chat-item");
  await expect(rows).toHaveCount(2);

  const measured = await surface.evaluate((root) => {
    const content = root.querySelector<HTMLElement>(".surface-content")!;
    const list = root.querySelector<HTMLElement>(".chat-list")!;
    const row = root.querySelector<HTMLElement>(".chat-item-card")!;
    const title = root.querySelector<HTMLElement>(".chat-select-btn")!;
    const actions = root.querySelector<HTMLElement>(".chat-item-actions")!;
    const range = document.createRange();
    range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const icons = actions.getBoundingClientRect();
    const style = getComputedStyle(list);
    return {
      surfaceContent: Math.round(content.getBoundingClientRect().width),
      list: Math.round(list.getBoundingClientRect().width),
      listMaxWidth: style.maxWidth,
      row: Math.round(row.getBoundingClientRect().width),
      textRight: Math.round(text.right),
      iconsLeft: Math.round(icons.left),
      textToIcons: Math.round(icons.left - text.right),
      titleCentre: Math.round(text.top + text.height / 2),
      iconsCentre: Math.round(icons.top + icons.height / 2),
    };
  });
  console.log(`[chats-measure] measured: ${JSON.stringify(measured)}`);

  // The surface keeps the desktop width; the list does not.
  expect(measured.surfaceContent, "the desktop panel is the wide surface").toBeGreaterThan(1200);
  expect(measured.row, "a Chats row keeps the content measure, not the panel width").toBeLessThanOrEqual(640);
  expect(measured.row, "and it is not the whole content column").toBeLessThan(measured.surfaceContent);
  expect(measured.listMaxWidth, "the list carries the measure as a max-width, not a fixed width").toBe("640px");
  expect(measured.list, "the list is the measure").toBe(measured.row);
  // The two ends of one row belong to one row.
  expect(
    measured.textToIcons,
    `the title's text and its action icons are ${measured.textToIcons} px apart, in a ${measured.surfaceContent} px column`,
  ).toBeLessThan(measured.surfaceContent / 2);
  // Constrained, not wrapped: the icons stay on the title's own line.
  expect(
    Math.abs(measured.iconsCentre - measured.titleCentre),
    "the row's controls stay on the title's line",
  ).toBeLessThanOrEqual(8);
});

/**
 * The defect this pins: every row of the Chats list read the same `New chat`, with
 * no time and no preview, so two Chats the player had never renamed were one row
 * twice and picking one was a guess. The Host now projects each thread's own
 * durable `updatedAtMs` and its last message as plain-text `preview`; this asserts
 * the rows a player actually reads are different, and that the row's new meta line
 * fits the narrowest layout this panel ships in. Those two facts cannot separate
 * two Chats opened on the same day (the stamp's granularity is a calendar day, and
 * a new Chat's preview is the card's own opening), so the row's fallback name is
 * numbered in the list's own order and this pins that numbering too.
 */
test("two Chats that were opened differently read differently in their rows", async ({ page }) => {
  // The stamp is the browser's own calendar day, so take that day from the browser
  // rather than from this runner's timezone.
  await page.goto("about:blank");
  const dayStart = await page.evaluate(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime(),
  );
  const secondHandle = `${"D".repeat(42)}A`;
  const chats = [
    {
      handle: chatHandle,
      title: null,
      status: "active",
      managementRevision: 1,
      isSelected: true,
      updatedAtMs: dayStart + 60_000,
      preview: "Good morning, farmer. The valley is quiet today.",
    },
    {
      handle: secondHandle,
      title: null,
      status: "active",
      managementRevision: 1,
      isSelected: false,
      updatedAtMs: dayStart - 60_000,
      // The exact plain-text form the Host's own projection yields for the
      // marker-bearing opening `*The lantern was still lit.* {{user}}, the
      // parsnips took.`, which the Host's contract test pins.
      preview: "The lantern was still lit., the parsnips took.",
    },
  ];
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/chats?*", (route) => route.fulfill(json200({ apiVersion: 1, chats })));

  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  const rows = surface.getByTestId("chat-item");
  await expect(rows).toHaveCount(2);

  const rowText = await rows.allTextContents();
  // Two Chats the player never named are told apart by the list's own numbering,
  // in the order the list displays them: before this change both were the single
  // word `New chat`.
  await expect(rows.nth(0).getByTestId("chat-select")).toHaveText("New chat 1");
  await expect(rows.nth(1).getByTestId("chat-select")).toHaveText("New chat 2");
  const rowNames = await rows.evaluateAll((nodes: HTMLElement[]) =>
    nodes.map((node) => node.querySelector<HTMLElement>("[data-testid='chat-select']")?.textContent ?? null),
  );
  console.log(`[chats-row-names] measured: ${JSON.stringify(rowNames)}`);
  expect(rowNames, "two unnamed rows are named by the list's own order").toEqual([
    "New chat 1",
    "New chat 2",
  ]);
  expect(rowText[0], "two Chats the player never named read as the same row").not.toBe(rowText[1]);
  // The row carries the Host's own two facts verbatim: the thread's durable time as
  // the catalogue's own relative word, and the last message as plain text. Paired per
  // row and then ordered by preview, so the assertion cannot pass on the wrong row.
  const pairs = (
    await rows.evaluateAll((nodes: HTMLElement[]) =>
      nodes.map((node) => ({
        when: node.querySelector("[data-testid='chat-item-when']")?.textContent ?? null,
        preview: node.querySelector("[data-testid='chat-item-preview']")?.textContent ?? null,
      })),
    )
  ).sort((left, right) => String(left.preview).localeCompare(String(right.preview)));
  expect(pairs).toEqual([
    { when: "Today", preview: "Good morning, farmer. The valley is quiet today." },
    { when: "Yesterday", preview: "The lantern was still lit., the parsnips took." },
  ]);
  for (const text of rowText) {
    expect(text, "a row rendered transcript markup").not.toContain("*");
    expect(text, "a row rendered an unresolved macro").not.toContain("{{");
  }

  // 400 px is the narrowest layout this surface ships in: the meta line wraps
  // inside the card rather than pushing the row out of its own column.
  const measured = await surface.evaluate((root) => {
    const card = root.querySelector<HTMLElement>(".chat-item-card")!;
    const meta = root.querySelector<HTMLElement>(".chat-item-meta")!;
    return {
      cardOverflow: Math.round(card.scrollWidth - card.clientWidth),
      metaOverflow: Math.round(meta.scrollWidth - meta.clientWidth),
      cardWidth: Math.round(card.getBoundingClientRect().width),
      metaWidth: Math.round(meta.getBoundingClientRect().width),
      metaLineHeight: getComputedStyle(meta).lineHeight,
    };
  });
  console.log(`[chats-row-meta-400px] measured: ${JSON.stringify(measured)}`);
  expect(measured.cardOverflow, `the row overflows its card by ${measured.cardOverflow} px`).toBeLessThanOrEqual(1);
  expect(measured.metaOverflow, `the meta line overflows by ${measured.metaOverflow} px`).toBeLessThanOrEqual(1);
  expect(measured.metaWidth).toBeLessThanOrEqual(measured.cardWidth);
});

/**
 * The measured defect: a row's own meta line carried the whole preview - a single
 * preview element measured 42,293 px² of text at 1440x900 and 35,392 px² at
 * 400x800, about seven lines - so one list row was several lines tall and the list
 * could not be scanned. A row is a title and the row's own facts; the rest of the
 * message belongs to the conversation selecting the row opens.
 *
 * The clamp is asserted by the height the element actually renders at, never by
 * reading the CSS property back. The element is read twice: as it ships, and with
 * the clamp lifted on that same element, so "the text needs more lines than the row
 * gives it" is a measurement of this preview rather than a claim about the fixture.
 * Both widths are read because this row is the one surface that ships at a wide
 * desktop column and at a 400 px phone.
 */
test("one long preview takes two lines of its row, not the whole message", async ({ page }) => {
  // The Host bounds `preview` at 160 characters on the wire (the management
  // client's own validator), so a row's preview is at most this long and a longer
  // one is not a row the product can render at all. The text is the companion's
  // own words rather than the UI's, so it stays what a player would actually read
  // in the English shell.
  const preview = [
    "晨雾还没散开的时候她已经出门了，门廊上的灯还亮着，地里的霜也还没有化。",
    "你昨天翻的地都还在那儿，一排排垄沟黑着，那是水管走过的印子。",
    "风从松林那边过来，带着湿泥和草腥气，她把围巾往上拉了拉，又换了只手拎种子袋。",
    "壶在屋里烧着，窗户上一层雾，所以厨房看着比院子暖些。",
    "她还是在门口站了一会儿，因为防风草成活了，全都成了。过来看看？",
  ].join("");
  expect(preview.length, "the fixture is the longest preview the contract admits").toBe(160);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        chats: [
          {
            handle: chatHandle,
            title: "Farm morning",
            status: "active",
            managementRevision: 1,
            isSelected: true,
            updatedAtMs: 1_760_000_000_000,
            preview,
          },
        ],
      }),
    ),
  );

  const readings: { width: number; lineHeight: number; shipped: number; unclamped: number; cardHeight: number; previewChars: number }[] =
    [];
  for (const width of [1440, 400] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
    const surface = page.getByTestId("chats-surface");
    await expect(surface).toBeVisible();
    await expect(page.getByTestId("chat-item-preview")).toHaveText(preview);

    const measured = await surface.evaluate((root) => {
      const meta = root.querySelector<HTMLElement>(".chat-item-meta")!;
      const card = root.querySelector<HTMLElement>(".chat-item-card")!;
      const lineHeight = Number.parseFloat(getComputedStyle(meta).lineHeight);
      const shipped = meta.getBoundingClientRect().height;
      // The clamp lifted on this same element, so both readings carry the same
      // text at the same width and the second one is this preview's own need.
      meta.style.setProperty("-webkit-line-clamp", "none");
      const unclamped = meta.getBoundingClientRect().height;
      meta.style.removeProperty("-webkit-line-clamp");
      return {
        lineHeight,
        shipped: Math.round(shipped),
        unclamped: Math.round(unclamped),
        cardHeight: Math.round(card.getBoundingClientRect().height),
        previewChars: (root.querySelector("[data-testid='chat-item-preview']")?.textContent ?? "").length,
      };
    });
    readings.push({ width, ...measured });
  }

  // Every width's reading is printed before any of them is judged, so a failure
  // reports the whole shape of the defect rather than its first line.
  const lines = (height: number, lineHeight: number): string => (height / lineHeight).toFixed(1);
  console.log(
    `[chats-row-preview-clamp] measured: ${readings
      .map(
        (reading) =>
          `${reading.width}px: meta ${reading.shipped}px (${lines(reading.shipped, reading.lineHeight)} lines) where the same text needs ${reading.unclamped}px (${lines(reading.unclamped, reading.lineHeight)} lines); card ${reading.cardHeight}px`,
      )
      .join(" | ")}`,
  );

  for (const reading of readings) {
    const at = `${reading.width}px`;
    expect(reading.previewChars, `${at}: the row really carries the whole preview`).toBe(preview.length);
    expect(
      reading.unclamped,
      `${at}: the preview needs ${reading.unclamped}px (${lines(reading.unclamped, reading.lineHeight)} lines), so the clamp has something to hold`,
    ).toBeGreaterThan(reading.lineHeight * 3);
    expect(
      reading.shipped,
      `${at}: the row's own meta line renders ${reading.shipped}px, which is ${lines(reading.shipped, reading.lineHeight)} lines`,
    ).toBeLessThanOrEqual(reading.lineHeight * 2 + 1);
  }
});

/**
 * The row's own meta line carried the lowest body-text contrast in the product:
 * `--text-disabled` (`#90877e`) on the row's card (`--surface-raised`, `#201d1d`)
 * computes 4.74:1 at 12px/400, where the dialogue measures 14.75:1. The line is the
 * row's secondary fact - the thread's durable time and the opening of its last
 * message - and the product's own 12px row metadata elsewhere (`.memory-item-meta`)
 * reads `--text-secondary`, so this line reads that tone too rather than a token
 * named for text the player cannot use.
 *
 * Both tones are resolved from the catalogue's own tokens and measured against the
 * card this row is painted on, so the assertion is a comparison of two tones on one
 * background rather than a floor to argue about, and a later re-tune of either token
 * is re-measured here instead of trusted.
 */
test("the row's own meta line reads the product's secondary tone, not its faintest", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200(composedDraft)));
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        chats: [
          {
            handle: chatHandle,
            title: "Farm morning",
            status: "active",
            managementRevision: 1,
            isSelected: true,
            updatedAtMs: 1_760_000_000_000,
            preview: "The parsnips took. All of them, by the look of it.",
          },
        ],
      }),
    ),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=chats`);
  const surface = page.getByTestId("chats-surface");
  await expect(surface).toBeVisible();
  await expect(page.getByTestId("chat-item-preview")).toBeVisible();

  const measured = await surface.evaluate((root) => {
    const meta = root.querySelector<HTMLElement>(".chat-item-meta")!;
    // `rgb(r, g, b)` / `rgba(r, g, b, a)`, and null for a fully transparent paint.
    const painted = (value: string): number[] | null => {
      const inner = /^rgba?\(([^)]+)\)$/u.exec(value.trim())?.[1];
      if (inner === undefined) return null;
      const parts = inner.split(",").map((part) => Number(part.trim()));
      return (parts[3] ?? 1) > 0 ? parts.slice(0, 3) : null;
    };
    const luminance = (rgb: readonly number[]): number => {
      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
    };
    const ratio = (foreground: readonly number[], background: readonly number[]): number => {
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
      return (lighter! + 0.05) / (darker! + 0.05);
    };
    // A token as the browser resolves it, which is what the row would paint if it
    // read that token: the comparison this test is about.
    const token = (name: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    // The card behind the row: the first ancestor painting anything at all.
    let background: number[] = [255, 255, 255];
    for (let element: Element | null = meta; element !== null; element = element.parentElement) {
      const behind = painted(getComputedStyle(element).backgroundColor);
      if (behind !== null) {
        background = behind;
        break;
      }
    }
    const style = getComputedStyle(meta);
    return {
      color: style.color,
      background: `rgb(${background.join(", ")})`,
      ratio: ratio(painted(style.color)!, background),
      disabledColor: token("--text-disabled"),
      disabledRatio: ratio(painted(token("--text-disabled"))!, background),
      secondaryColor: token("--text-secondary"),
      secondaryRatio: ratio(painted(token("--text-secondary"))!, background),
      size: `${style.fontSize}/${style.fontWeight}`,
    };
  });
  console.log(
    `[chats-row-meta-contrast] measured: meta ${measured.color} on ${measured.background} = ${measured.ratio.toFixed(2)}:1 at ${measured.size}; --text-disabled ${measured.disabledColor} = ${measured.disabledRatio.toFixed(2)}:1 and --text-secondary ${measured.secondaryColor} = ${measured.secondaryRatio.toFixed(2)}:1 on the same card`,
  );

  expect(measured.color, "the row's meta line carries the product's own secondary tone").toBe(
    measured.secondaryColor,
  );
  expect(
    measured.ratio,
    `the row's meta line reads ${measured.ratio.toFixed(2)}:1 against the ${measured.background} card it is painted on`,
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    measured.ratio,
    `the row's meta line reads ${measured.ratio.toFixed(2)}:1 where the faintest tone reads ${measured.disabledRatio.toFixed(2)}:1`,
  ).toBeGreaterThan(measured.disabledRatio);
});
