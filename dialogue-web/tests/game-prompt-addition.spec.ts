/**
 * The Game companion's prompt addition: a player-editable block in Settings.
 *
 * The requirement is one a silent no-op control would fail: the text must save through the
 * management client the rest of Settings uses, the field must refuse more than the Host's
 * bound, and the panel must say WHEN the text takes effect (the next game start - a game
 * already running keeps the instructions it started with). A player who typed two hundred
 * characters and saw "Saved." would otherwise reasonably believe the running game changed.
 *
 * The three readings:
 *   (i)   the group renders with its label, its when-sentence and a counter that says the
 *         limit, from the catalogue the mount is in;
 *   (ii)  a save is one PUT through the settings route, carrying the revision the read handed
 *         out and exactly the text the player typed - not a second fetch path, not a
 *         discarded draft;
 *   (iii) more than the bound is clamped to the bound, and the counter reads the clamp.
 *
 * The bound is asserted against the module's own constant rather than a literal here: the
 * number lives in one place (`MAX_GAME_PROMPT_ADDITION_CHARS`) so the textarea, the mirror's
 * validator and this test cannot drift apart.
 */
import { type Page, expect, test } from "./frontend-coverage";
import { MAX_GAME_PROMPT_ADDITION_CHARS } from "../src/management-pipeline-api";

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA";

const composedChat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
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

function json200(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(body) };
}

/** One request the panel made that carries a body: its path, body and the CSRF header. */
type PanelWrite = Readonly<{ path: string; body: Record<string, unknown>; csrf: string | null }>;

/**
 * Every route the composed shell and the Settings panels read, plus the one route under test.
 *
 * Writes are observed through `page.on("request")` rather than a catch-all route: a wide
 * `settings/**` stub would answer the panel's other reads first (Playwright runs the most
 * recently added handler), so the "no second fetch path" assertion would be measuring the
 * stub's interception order instead of the panel's calls.
 */
async function stubRoutes(
  page: Page,
  options: Readonly<{ addition: string }>,
): Promise<{ writes: PanelWrite[] }> {
  const writes: PanelWrite[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" && request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/tavern/v1/")) return;
    writes.push({ body: (request.postDataJSON() ?? {}) as Record<string, unknown>, csrf: request.headers()["x-csrf-token"] ?? null, path });
  });
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(json200({ apiVersion: 1, revision: 3, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(json200({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      json200({
        revision: 1,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(json200({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      json200({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/game-prompt", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.fulfill(json200({ revision: 1, addition: options.addition }));
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    // The route's own answer IS the durable read-back: the panel adopts it, never the draft.
    await route.fulfill(json200({ revision: 2, addition: String(body.addition ?? "") }));
  });
  return { writes };
}

/** Settings, opened the way a player opens it. */
async function openSettings(page: Page, options: Readonly<{ locale?: "en" | "zh-CN" }> = {}): Promise<void> {
  if (options.locale !== undefined)
    await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), options.locale);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  await expect(page.getByTestId("settings-surface")).toBeVisible();
}

const group = (page: Page) => page.getByTestId("settings-surface").locator("[data-game-prompt-addition]");
const field = (page: Page) => group(page).locator("#game-prompt-addition");
const counter = (page: Page) => group(page).locator("[data-game-prompt-addition-count]");
const when = (page: Page) => group(page).locator("[data-game-prompt-addition-effective]");

test.describe("the player can edit the Game companion's prompt addition", () => {
  test("(i) the group renders with its limit, its counter and the when-sentence", async ({ page }) => {
    const stub = await stubRoutes(page, { addition: "Water first, then the mines." });
    await openSettings(page);

    await expect(group(page)).toBeVisible();
    await expect(field(page)).toHaveValue("Water first, then the mines.");
    // The bound is the module's own, on the field the browser enforces and in the sentence the
    // player reads: a counter that named a different number than the field would be a lie.
    await expect(field(page)).toHaveAttribute("maxlength", String(MAX_GAME_PROMPT_ADDITION_CHARS));
    await expect(counter(page)).toHaveText(
      `${"Water first, then the mines.".length} / ${MAX_GAME_PROMPT_ADDITION_CHARS} characters`,
    );
    // WHEN it takes effect, which is the sentence that makes the control honest.
    await expect(when(page)).toHaveText(/next time you start the game/iu);

    console.log(
      `[game-prompt-addition/render] ${JSON.stringify({
        value: await field(page).inputValue(),
        counter: await counter(page).textContent(),
        when: await when(page).textContent(),
        writes: stub.writes.length,
      })}`,
    );
    expect(stub.writes, "rendering the group writes nothing").toEqual([]);
  });

  test("(ii) a save is one PUT through the settings route with the revision it read", async ({ page }) => {
    const stub = await stubRoutes(page, { addition: "Old words." });
    await openSettings(page);
    await expect(field(page)).toHaveValue("Old words.");

    const typed = "Finish watering before you go mining, and say good morning to everyone.";
    await field(page).fill(typed);
    await group(page).getByRole("button", { name: /save/iu }).click();

    await expect.poll(() => stub.writes.length, "the save reached the settings route").toBe(1);
    const write = stub.writes[0]!;
    console.log(`[game-prompt-addition/save] ${JSON.stringify(write)}`);
    // One route, exactly the typed text, CASed on the revision the read handed out, carried by
    // the management client's own CSRF header - not a second, hand-rolled fetch.
    expect(write.path, "the save went through the settings route").toBe("/api/tavern/v1/settings/game-prompt");
    expect(write.body).toEqual({ expectedRevision: 1, addition: typed });
    expect(write.csrf, "the write carries the browser session's CSRF token").toBe(csrfToken);
    // And the panel adopts the Host's read-back as what it shows.
    await expect(field(page)).toHaveValue(typed);
    await expect(counter(page)).toHaveText(`${typed.length} / ${MAX_GAME_PROMPT_ADDITION_CHARS} characters`);
  });

  test("(iii) a value past the bound is clamped, and the counter says the clamp", async ({ page }) => {
    const stub = await stubRoutes(page, { addition: "" });
    await openSettings(page);
    await expect(field(page)).toHaveValue("");

    // The path `maxLength` does NOT police: an autofill, a composition, or any script-set value
    // reaches the field past the attribute, and the mount's own clamp is what keeps it inside
    // the Host's bound. Typing alone would prove only that the browser's attribute exists.
    const overlong = "x".repeat(MAX_GAME_PROMPT_ADDITION_CHARS + 200);
    await field(page).evaluate((node, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }, overlong);

    await expect(field(page)).toHaveValue("x".repeat(MAX_GAME_PROMPT_ADDITION_CHARS));
    await expect(counter(page)).toHaveText(
      `${MAX_GAME_PROMPT_ADDITION_CHARS} / ${MAX_GAME_PROMPT_ADDITION_CHARS} characters`,
    );

    // And what leaves the browser is the clamped text: an over-bound body is never sent for the
    // Host to refuse.
    await group(page).getByRole("button", { name: /save/iu }).click();
    await expect.poll(() => stub.writes.length, "the clamped save reached the settings route").toBe(1);
    const write = stub.writes[0]!;
    console.log(`[game-prompt-addition/clamp] ${JSON.stringify({ sentLength: String(write.body.addition ?? "").length })}`);
    expect(write.body).toEqual({
      expectedRevision: 1,
      addition: "x".repeat(MAX_GAME_PROMPT_ADDITION_CHARS),
    });
  });

  test("the same group speaks the Chinese catalogue, including when it takes effect", async ({ page }) => {
    await stubRoutes(page, { addition: "先浇水。" });
    await openSettings(page, { locale: "zh-CN" });
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

    await expect(group(page)).toBeVisible();
    await expect(field(page)).toHaveValue("先浇水。");
    await expect(counter(page)).toHaveText(`4 / ${MAX_GAME_PROMPT_ADDITION_CHARS} 字符`);
    await expect(when(page)).toHaveText(/下次启动游戏/iu);
    console.log(
      `[game-prompt-addition/zh] ${JSON.stringify({
        counter: await counter(page).textContent(),
        when: await when(page).textContent(),
      })}`,
    );
  });
});
