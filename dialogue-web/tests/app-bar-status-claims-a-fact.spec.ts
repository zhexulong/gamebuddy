import { type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

/**
 * The app bar claims "online" only when this shell knows a reply can reach a model.
 *
 * Measured defect: `statusLabel={turnInFlight ? labels().generating : labels().online}` - the bar said
 * 在线 for every state that was not generating. On a fresh install, with no connection and no model,
 * the surface therefore claimed a reachability nothing had established. The word was the product's
 * one claim about whether a turn can go anywhere, and it was made unconditionally.
 *
 * What the shell actually knows, established rather than assumed:
 *
 *  - `chat.submit`'s availability is NOT a configuration fact. `projectOperations`
 *    (`host/src/tavern/reference-pipeline-state.ts`) projects `available` exactly when no turn
 *    exists and `busy` otherwise, so the operations list cannot tell "configured" from "ready".
 *  - The one fact about whether a reply can reach a model is `chatModelRoute`, derived by
 *    `chat-model-route.ts` from the two settings projections: an active saved connection
 *    (`connection`), nothing activated (`none`), or a read that did not answer (`unknown`).
 *  - There is no health probe and no reachability fact in this shell at all. A mount that is `ready`
 *    got its snapshot from the Host moments earlier, which is the only sense in which anything here
 *    is reachable - and that is what 在线 may mean, no more.
 *
 * So the four words this file pins, one per fact:
 *
 *  - a turn in flight → the generating word (the only state that was already honest);
 *  - an active connection → 在线;
 *  - no connection/model → a word about THIS conversation, not about a settings row (so never the
 *    connection panel's own "Not configured", which answers a different question);
 *  - a route read that did not answer → a word that admits it, never 在线: an answer that did not
 *    arrive is not evidence that one would.
 *
 * The dot beside the word is the same claim in the other channel, and at ≤480 px it is the only
 * channel left (`style.css` hides `.app-bar-status-label` there). Measured defect D5: the tone was
 * binary - `progress` or `idle` - so every state that was not generating painted the shared
 * `.status-dot`, whose own rule is `--success`. A cold start with no connection, no key and the
 * Bridge offline glowed green. So each reading below pairs its word with the dot's computed
 * `background-color`, measured against the same page's resolved `var(--success)`.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const connectionId = `${"E".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const catalogue = messages("en");

const chat = {
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
    title: "A status claim",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null as null | Readonly<{ handle: string; state: string; projectionRevision: number; canCancel: boolean }>,
    worldInfo: { state: "none", revision: chatHandle, items: [] },
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

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The two projections `chat-model-route.ts` reads, as the settings panel serves them. */
const ACTIVE_CONNECTION = {
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
};

/** The row the active selection must name - the projection is refused when it names none of them. */
const ACTIVE_CONNECTION_ROW = {
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
};

const MODEL_PROFILES = {
  apiVersion: 1,
  recommendedModels: [],
  chat: { revision: 0, thinkingLevel: "high" },
  game: { revision: 0, thinkingLevel: "high" },
};

async function stubShell(
  page: Page,
  options: Readonly<{ active: boolean | "unknown"; turn?: typeof chat.chat.turn }>,
): Promise<void> {
  const projection = { ...root, chat: { ...chat, chat: { ...chat.chat, turn: options.turn ?? null } } };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  if (options.active === "unknown") return;
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: options.active ? ACTIVE_CONNECTION : null,
        connections: options.active ? [ACTIVE_CONNECTION_ROW] : [],
        providers: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) => route.fulfill(jsonOk(MODEL_PROFILES)));
}

const statusWord = async (page: Page): Promise<string | null> =>
  await page.locator(".app-bar-status").getAttribute("aria-label");

/**
 * What the status dot is painted, and what the success paint is on this page.
 *
 * Measured as the computed `background-color`, because that is the claim the eye reads at 400 px,
 * where `style.css` retires `.app-bar-status-label` and the dot is the whole of the badge. The
 * success paint is resolved from `var(--success)` by the same engine rather than transcribed here,
 * so this reading cannot drift from the token the shared `.status-dot` rule uses.
 */
async function dotPaint(page: Page): Promise<Readonly<{ dot: string | null; success: string }>> {
  return await page.evaluate(() => {
    const dot = document.querySelector<HTMLElement>(".app-bar-status .status-dot");
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--success)";
    document.body.appendChild(probe);
    const success = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { dot: dot === null ? null : getComputedStyle(dot).backgroundColor, success };
  });
}

test.describe("the app bar's status is a fact about this conversation", () => {
  test("with no connection and no model it does not claim to be online", async ({ page }) => {
    await stubShell(page, { active: false });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    await expect.poll(() => statusWord(page)).toBe(catalogue.statusNotReady);
    expect(await statusWord(page), "no word about a settings row stands in for this conversation").not.toBe(
      catalogue.connectionReadinessUnconfigured,
    );
    expect(await statusWord(page), "and nothing claims reachability").not.toBe(catalogue.online);
    // The dot is the same claim in the other channel, and at 400 px it is the only channel left:
    // a cold start with no connection painted it `--success`, so the strip glowed green over a
    // conversation that could not send anything.
    const paint = await dotPaint(page);
    expect(paint.dot, "the badge still draws a dot").not.toBeNull();
    expect(paint.dot, "no connection and no model is not painted as reachable").not.toBe(paint.success);
    // The surface already says why, where the player is looking - the bar is the summary, not the
    // only statement.
    await expect(page.getByTestId("chat-surface")).toContainText(catalogue.chatNoModelTitle);
  });

  test("a route read that did not answer is stated as unknown, never as online", async ({ page }) => {
    await stubShell(page, { active: "unknown" });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    await expect.poll(() => statusWord(page)).toBe(catalogue.statusUnknown);
    expect(await statusWord(page), "an answer that did not arrive is not evidence one would").not.toBe(
      catalogue.online,
    );
    // And the dot makes no claim either: neither the success paint (which would be the "online"
    // this reading just refused to say) nor the neutral one, which asserts the opposite fact - that
    // there is no route. Nothing is known, so nothing is drawn; the word above is the whole report.
    expect((await dotPaint(page)).dot, "a route read that did not answer draws no dot at all").toBeNull();
  });

  test("an active connection is online", async ({ page }) => {
    await stubShell(page, { active: true });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    await expect.poll(() => statusWord(page)).toBe(catalogue.online);
    // The control for the two readings above: this is the one state whose dot is the success paint,
    // so an assertion that the other two differ from it cannot pass by the paint being unreadable.
    const paint = await dotPaint(page);
    expect(paint.dot, "an active connection paints the dot as the reachable one").toBe(paint.success);
  });

  test("a turn in flight is still the generating word", async ({ page }) => {
    await stubShell(page, {
      active: false,
      turn: { handle: turnHandle, state: "running", projectionRevision: 2, canCancel: true },
    });
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    await expect(page.getByTestId("chat-surface")).toBeVisible();

    // The turn outranks the route: whatever the configuration says, what the player is watching is a
    // reply being written. This must not regress - it is the one state that was ever right.
    await expect.poll(() => statusWord(page)).toBe(catalogue.generating);
    const dot = page.locator(".app-bar-status .status-dot");
    await expect(dot).toHaveAttribute("data-tone", "progress");
  });
});
