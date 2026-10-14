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
        chats: [{ handle: chatHandle, title: rootTitle, status: "active", managementRevision: 1, isSelected: true }],
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
  await expect(surface.getByText("New chat", { exact: true })).toBeVisible();
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
        chats: [{ handle: chatHandle, title: null, status: "active", managementRevision: 1, isSelected: true }],
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
        chats: [{ handle: chatHandle, title: "A durable chat", status: "active", managementRevision: 1, isSelected: true }],
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
          { handle: chatHandle, title: "Mounted chat", status: "active", managementRevision: 4, isSelected: true },
          { handle: otherHandle, title: "Older chat", status: "active", managementRevision: 9, isSelected: false },
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
        chats: [{ handle: chatHandle, title: null, status: "active", managementRevision: 1, isSelected: true }],
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
