import { expect, test, type Page } from "@playwright/test";

/**
 * The Memory notebook follows the conversation that writes into it.
 *
 * The owner's report: the Memory panel showed "还没有记下什么" even after a Chat turn had created
 * memories, and the player had to press Refresh Memory to see them. The panel read the Host's
 * projection once, on mount, and a turn settling does not change the panel's own props - so a
 * settlement during the very session the player is watching never reached it.
 *
 * The rows are not the shell's to hand over: they come from the panel's own `memory.read` route,
 * and the composed root carries no Memory projection at all. What the shell does own is the
 * committed turn, so that is what the panel is told - which turn and where it is - and any change
 * to that pair is the same one read the panel takes on mount. No timer, and no second copy of the
 * rows: nothing but the route ever produces a row.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const connectionId = `${"F".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;
const replyHandle = `${"Q".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const memoryHandle = `${"N".repeat(42)}A`;
const projectionRevision = `${"E".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const playerText = "Keep the watering can by the door.";
const memoryContent = "The farmer keeps a spare watering can by the door.";

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The composed root over one committed Chat state: `turnDone` is the settlement this pins. */
function composedRoot(options: Readonly<{ submitted: boolean; turnDone: boolean }>) {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: options.submitted && !options.turnDone ? "busy" : "available",
          routeId: "chat.submit",
        },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle, generation: 1, stateRevision: chatHandle },
      chat: {
        companion: { name: "Mira", handle: companionHandle },
        title: null,
        transcript: options.submitted
          ? [
              { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 0, revision: 1 },
              ...(options.turnDone
                ? [{ handle: replyHandle, role: "companion", text: "Noted.", locale: "und", order: 1, revision: 1 }]
                : []),
            ]
          : [],
        draft: { revision: 4, present: true },
        turn: options.submitted
          ? options.turnDone
            ? { handle: turnHandle, state: "completed", projectionRevision: 1, canCancel: false }
            : { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true }
          : null,
        worldInfo: null,
      },
      memory: { readAvailable: true, mutationAvailable: true, projectionRevision },
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

/**
 * The Host behind the shell. `memories` is what `GET /memory` answers, so a journey makes the
 * Host hold a written memory and then asserts what the panel shows without pressing Refresh.
 */
async function stubHost(
  page: Page,
  state: {
    submitted: boolean;
    turnDone: boolean;
    memories: readonly unknown[];
  },
): Promise<{ memoryReads: () => number }> {
  let memoryReads = 0;
  const root = () => composedRoot({ submitted: state.submitted, turnDone: state.turnDone });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root())));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/memory", (route) => {
    memoryReads += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, projectionRevision, memories: state.memories, chapters: [] }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    state.submitted = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 0, revision: 1 },
        turn: { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true },
      }),
    });
  });
  // The submission status settles with the turn, so the shell's fallback poll keeps running
  // while the turn is in flight and stops once it is done - the shape the real Host has.
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: state.turnDone ? "terminal" : "accepted" })),
  );
  // A saved, ready connection: the conversation's send path resolves to it, so the composer is
  // usable and this journey is about the notebook rather than about a surface with nowhere to send.
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: {
          connectionId,
          label: "DeepSeek",
          providerLabel: "DeepSeek",
          modelId: "deepseek-v4-pro",
          modelLabel: "DeepSeek V4 Pro",
          thinkingLevel: "high",
          readiness: "ready",
          baseUrl: null,
          failure: null,
          lastCheckedAtMs: null,
        },
        connections: [
          {
            connectionId,
            label: "DeepSeek",
            providerId: "deepseek",
            providerLabel: "DeepSeek",
            configured: true,
            readiness: "ready",
            active: true,
            modelId: "deepseek-v4-pro",
            modelLabel: "DeepSeek V4 Pro",
            thinkingLevel: "high",
            allowedThinkingLevels: ["high", "max"],
            modelIds: null,
            baseUrl: null,
            failure: null,
            lastCheckedAtMs: null,
          },
        ],
        providers: [
          {
            providerId: "deepseek",
            label: "DeepSeek",
            setupFields: ["apiKey", "modelId"],
            allowedPlayerModels: [
              {
                modelId: "deepseek-v4-pro",
                modelLabel: "DeepSeek V4 Pro",
                allowedThinkingLevels: ["high", "max"],
                defaultThinkingLevel: "high",
              },
            ],
            escapeHatch: false,
            environmentManaged: false,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        recommendedModels: [],
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    ),
  );
  return { memoryReads: () => memoryReads };
}

test("a turn that settles while the Memory surface is open reaches the notebook, without pressing Refresh", async ({
  page,
}) => {
  const state = { submitted: false, turnDone: false, memories: [] as readonly unknown[] };
  const host = await stubHost(page, state);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  const chat = page.getByTestId("chat-surface");
  await expect(chat).toBeVisible();
  await chat.locator("textarea").fill(playerText);
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chat.locator(".message-list")).toContainText(playerText);

  // The player opens the notebook while the reply is still being written. Nothing is in it yet.
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  const surface = page.getByTestId("memory-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator("[data-memory-state=empty]")).toBeVisible();
  await expect(surface.locator("[data-memory-notebook]")).toContainText("Nothing written down yet (0 so far)");
  const readsAtMount = host.memoryReads();
  expect(readsAtMount).toBe(1);

  // The turn completes, and the Host now holds the memory it wrote. The shell settles the turn on
  // its fallback poll, which is the event this panel mirrors.
  state.turnDone = true;
  state.memories = [
    {
      handle: memoryHandle,
      title: "Semantic memory",
      content: memoryContent,
      category: "semantic",
      status: "active",
      origin: "player",
      pinned: false,
    },
  ];

  // The row appears on its own: no Refresh Memory press anywhere in this journey. Before the
  // settlement read this failed - the panel kept the empty notebook and `memoryReads()` stayed at
  // `readsAtMount`.
  await expect(surface.locator(`[data-memory-handle="${memoryHandle}"]`)).toBeVisible();
  await expect(surface.getByText(memoryContent, { exact: true })).toBeVisible();
  await expect(surface.locator("[data-memory-state=empty]")).toHaveCount(0);
  await expect(surface.locator("[data-memory-notebook]")).toContainText("1 memories written down so far");
  // A second read of the route, and only one: the settlement caused exactly one re-read.
  expect(host.memoryReads()).toBe(readsAtMount + 1);
});
