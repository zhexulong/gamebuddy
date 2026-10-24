/**
 * The third guide step states one order, and the cabin handoff under it states the
 * same one.
 *
 * Measured on the build before this change: the step said "选一间农舍，同伴就住进去。"
 * ("choose a farmhouse, and the companion moves in") while the handoff under it said
 * "先完成上面第 1、2 步；伴侣住进农舍后，可确认的小屋会出现在这里。" ("finish steps 1
 * and 2 above: the cabins to confirm appear here once the companion has moved in").
 * One of the two had the order backwards, and a player reading them together was told
 * both that choosing the cabin moves her in and that the cabins only appear after she
 * has already moved in - which is a loop with no first move in it.
 *
 * Which one the product's own mechanism says, quoted from the code rather than chosen:
 *
 *  1. The cabin exists BEFORE any player choice, and the Mod makes it. `ModEntry.OnSaveLoaded`
 *     runs `this.EnsureCompanionCabin()` as the first post-load act - "a Player Host world
 *     with no usable cabin could only ever refuse, so making it able to host the companion
 *     is the first post-load act, not a later repair"
 *     (`integrations/stardew/ModEntry.cs`), and `CompanionCabinProvisioning.EnsureCompanionCabin`
 *     answers `NoUsableCabin` by building one through the engine's own path:
 *     `farm.buildStructure(building, tile, Game1.player, skipSafetyChecks: true)`.
 *  2. The list the panel shows is READ from a launched, loaded world, and only while that
 *     Player Host is awaiting attestation: `readCabinChoices` throws
 *     `stardew_cabin_handoff_unavailable` unless `activationState ===
 *     "awaiting_player_host_attestation"` (`host/src/stardew-production-lifecycle-coordinator.internal.ts`).
 *  3. Confirming a choice is what moves her in: `confirmCabinChoice` calls
 *     `handoffCoordinator.confirmAndAdmit(handle.choice.selection, { confirmed: true })`,
 *     then `aiClientLaunch(...)`, then consumes the Farmhand bridge connection - the
 *     attachment the surface reads as "in the farm".
 *
 * So the order is: the game provisions a cabin on the loaded farm, the player confirms
 * which one is hers, and the attachment follows. The step is the choice; the handoff is
 * the list that choice is made from; and the cabins are there before she is.
 *
 * SillyTavern has no cabin - nothing in it is provisioned into a player's own world by
 * the game, so there is no equivalent behaviour to copy. The authority here is this
 * product's own mechanism, which is why the assertions below are about the order the two
 * sentences state rather than about matching upstream copy.
 */
import { expect, test, type Page } from "@playwright/test";

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * A fresh install that has done nothing yet: no Player Host instance, so the cabin read
 * answers the way the Host does with no session (`stardew_cabin_handoff_unavailable`) and
 * the third step renders its own sentence under its own line of copy.
 */
function composedRoot() {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: {
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
        companion: { name: "Mira", handle: "D".repeat(42) + "A" },
        title: "Reference Game Chat",
        transcript: [
          {
            handle: "D".repeat(42) + "A",
            role: "companion",
            text: "The morning light comes over the ridge.",
            locale: "en",
            order: 0,
            revision: 1,
          },
        ],
        draft: { revision: 0, present: false },
        turn: null,
        worldInfo: null,
      },
      memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
      eventStream: null,
    },
    game: {
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
    },
  };
}

/** Mounts the real shell over the real routes, every one mocked on this origin. */
async function mountGame(page: Page, locale: "en" | "zh-CN"): Promise<void> {
  const root = composedRoot();
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), locale);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  // The Host's own answer with no Player Host instance launched.
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_handoff_unavailable" }),
    }),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/retry", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/cancel", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "cancelled" })),
  );
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: "P".repeat(42) + "A", memories: [], chapters: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: "W".repeat(42) + "A", items: [] })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({
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
    route.fulfill(jsonOk({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: locale === "zh-CN" ? "zh-CN" : "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        game: { revision: 1, modelId: "deepseek-v4", thinkingLevel: "medium" },
        recommendedModels: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "GameBuddy Companion", isCurrent: true }] })),
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
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  const entry = page.getByRole("button", { name: locale === "zh-CN" ? "游戏" : "Game", exact: true });
  const surface = page.getByTestId("game-surface");
  if (!(await surface.isVisible())) await entry.click();
  await expect(surface).toBeVisible();
}

/** The two sentences the third step renders: its own line of copy, and the handoff's. */
async function readStepThree(page: Page) {
  const step = page.locator('[data-guide-step="3"]');
  await expect(step).toBeVisible();
  return await step.evaluate((node) => {
    const detail = node.querySelector<HTMLElement>(".game-guide-step-detail");
    const handoff = node.querySelector<HTMLElement>(".stardew-cabin-handoff");
    const status = handoff?.querySelector<HTMLElement>("[role=status]") ?? null;
    const squash = (value: string | null | undefined): string => (value ?? "").replace(/\s+/gu, " ").trim();
    return {
      title: squash(node.querySelector<HTMLElement>(".game-guide-step-title")?.textContent),
      detail: squash(detail?.textContent),
      handoff: squash(status?.textContent),
      handoffKind: handoff?.getAttribute("data-connection-settings") ?? null,
    };
  });
}

/**
 * The reversed order, in the words each catalogue had used for it: "after she has moved
 * in, the cabins appear". A sentence matching this states the loop.
 */
const REVERSED_ORDER = {
  en: /(?:once|after)\s+(?:she|the companion|your companion)\s+(?:has\s+)?(?:moved|moves|settled)\s+in/iu,
  "zh-CN": /(?:住进|搬进|住进去)(?:农舍|小屋)?之后|伴侣住进农舍后|同伴住进农舍后/u,
} as const;

/**
 * The forward order, stated as the fix states it: the confirmation is what moves her in.
 * The two clauses have to appear in one sentence, in either reading order, tied together -
 * which is what "choosing the cabin is the step that moves her in" means.
 */
const FORWARD_ORDER = {
  en: /(?:confirm|choose)[^.]*?(?:moves?|settle)\w*\s+(?:her\s+)?in[^.]*|(?:moves?|settle)\w*\s+(?:her\s+)?in[^.]*?(?:you\s+)?confirm/iu,
  "zh-CN": /(?:确认|挑|选)[^。]*?住进[^。]*|住进[^。]*?确认/u,
} as const;

test.describe("the third step and its cabin handoff state one order", () => {
  test("zh-CN: the choice comes first, and nothing says the cabins appear after she moves in", async ({ page }) => {
    await mountGame(page, "zh-CN");
    const reading = await readStepThree(page);
    console.log(`[game-guide-cabin-order/zh] ${JSON.stringify(reading)}`);

    expect(reading.title, "step 3 is the step where she moves in").toContain("住进");
    // The step's own line: the choice is the act that moves her in.
    expect(reading.detail, "the step's line names the order as choice-then-move-in").toMatch(FORWARD_ORDER["zh-CN"]);
    expect(reading.detail, "the step's line is not the reversed order").not.toMatch(REVERSED_ORDER["zh-CN"]);

    // The handoff under it: the cabins are read from the loaded farm and confirmed BEFORE
    // the attachment, so its sentence may not claim they appear after she has moved in.
    expect(reading.handoff, "the handoff renders its own sentence in this state").not.toBe("");
    expect(
      reading.handoff,
      `the handoff states the order backwards: ${JSON.stringify(reading.handoff)}`,
    ).not.toMatch(REVERSED_ORDER["zh-CN"]);
    expect(
      reading.handoff,
      "the handoff names the confirmation as the step that moves her in, in the same order as step 3",
    ).toMatch(FORWARD_ORDER["zh-CN"]);
  });

  test("en: the same two readings, from that catalogue's own sentences", async ({ page }) => {
    await mountGame(page, "en");
    const reading = await readStepThree(page);
    console.log(`[game-guide-cabin-order/en] ${JSON.stringify(reading)}`);

    expect(reading.title, "step 3 is the step where she moves in").toMatch(/moves? in/iu);
    expect(reading.detail, "the step's line names the order as choice-then-move-in").toMatch(FORWARD_ORDER.en);
    expect(reading.detail, "the step's line is not the reversed order").not.toMatch(REVERSED_ORDER.en);

    expect(reading.handoff, "the handoff renders its own sentence in this state").not.toBe("");
    expect(
      reading.handoff,
      `the handoff states the order backwards: ${JSON.stringify(reading.handoff)}`,
    ).not.toMatch(REVERSED_ORDER.en);
    expect(
      reading.handoff,
      "the handoff names the confirmation as the step that moves her in, in the same order as step 3",
    ).toMatch(FORWARD_ORDER.en);
  });
});
