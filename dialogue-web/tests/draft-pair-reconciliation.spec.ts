import { expect, test, type Page } from "@playwright/test";

/**
 * The shell reads the composed root and the durable draft as ONE snapshot, but they are two routes.
 *
 * `use-composed-bootstrap` (and the poll, the stream recovery, the reconcile pass and every Chat
 * reread) reads `/composed-reference-game/v1/state`, then `/api/tavern/v1/draft`, and fails closed
 * with `state_reconciliation_required` when `draft.revision` disagrees with `chat.draft.revision`.
 * The two reads are not atomic: the Host commits a player message between them during a turn, and
 * that commit consumes the draft (`chat-thread-store` bumps `tavern_drafts.revision` on acceptance).
 * So a surface watching a turn can meet a pair that disagrees while both routes are individually
 * correct - and the whole shell is replaced by the problem view.
 *
 * shots-final64 measured the consequence: driver P sent its second turn, waited its whole 180 s
 * budget (`turn settled: false null`), the DOM then had zero `li.message` rows while the Host's own
 * `/state` still served five, and drivers Q/R/S/T could not find `.app-bar-actions` at all - the
 * shell was no longer the shell.
 *
 * These tests pin the invariant at the layer that decides: ONE read pair that disagrees is a
 * transient ordering fact about two routes, not a state fault the player has to see. A pair that
 * still disagrees after the re-read is a real conflict and still fails closed.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const playerMessageHandle = "X".repeat(42) + "A";
const openedMessageHandle = "W".repeat(42) + "A";

function composedRoot(options: Readonly<{ draftRevision: number; draftPresent: boolean; transcript: readonly { role: "player" | "companion"; text: string }[] }>) {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
      csrfToken,
      browserSession: { expiresAtMs },
      operations: [{ operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" }],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: handle, generation: 1, stateRevision: handle },
      chat: {
        companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
        title: null,
        transcript: options.transcript.map((message, index) => ({
          handle: (message.role === "player" ? playerMessageHandle : openedMessageHandle) + String(index),
          role: message.role,
          text: message.text,
          locale: "und",
          order: index,
          revision: 1,
        })),
        draft: { revision: options.draftRevision, present: options.draftPresent },
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

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ type: `urn:gamebuddy:tavern:${code}`, title: code, status, code, requestId: csrfToken, retryable: false }),
});

const TRANSCRIPT = [
  { role: "companion" as const, text: "The lantern over the porch is still lit." },
  { role: "player" as const, text: "Are you there?" },
];

/**
 * Mount the shell where `chat.draft` moved between the two reads, which is exactly what a Host
 * committing the player's message mid-turn looks like from two separate routes.
 *
 * `draftRouteRevisions` is served one entry per `/draft` read: the first read is the stale pair the
 * shell used to die on, the second is the same authority caught up.
 */
async function mountShell(page: Page, options: Readonly<{ stateRevision: number; draftRouteRevisions: readonly number[] }>): Promise<void> {
  const root = composedRoot({ draftRevision: options.stateRevision, draftPresent: false, transcript: TRANSCRIPT });
  let draftReads = 0;
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => {
    const revision = options.draftRouteRevisions[Math.min(draftReads, options.draftRouteRevisions.length - 1)];
    draftReads += 1;
    route.fulfill(jsonOk({ apiVersion: 1, revision, text: null }));
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => route.fulfill(jsonOk({ apiVersion: 1, choices: [] })));
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) => route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })));
  await page.route(/\/api\/tavern\/v1\/chats(\?|$)/, (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/memory", (route) => route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: null, memories: [], chapters: [] })));
  await page.route("**/api/tavern/v1/world-info", (route) => route.fulfill(jsonOk({ state: "none", revision: null, items: [] })));
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null })),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) => route.fulfill(jsonOk({ devices: [], defaultSelectable: true })));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale: "zh-CN" })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, chat: { revision: 1, thinkingLevel: "medium" }, game: { revision: 1, thinkingLevel: "medium" }, recommendedModels: [] })),
  );
  await page.route("**/api/tavern/v1/companions", (route) => route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Mira", isCurrent: true }] })));
  await page.route("**/api/tavern/v1/persona", (route) => route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })));
  await page.route("**/api/tavern/v1/scenario", (route) => route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })));
  await page.route("**/api/tavern/v1/greeting", (route) => route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })));
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
}

const shellReading = (page: Page) =>
  page.evaluate(() => ({
    appBar: document.querySelector(".app-bar") !== null,
    rows: document.querySelectorAll(".message-list > li.message").length,
    problem: (document.querySelector(".problem-view")?.innerText ?? "").trim().slice(0, 120),
  }));

test("a draft pair that moved between the two reads does not replace the shell with a problem view", async ({ page }) => {
  // `/state` says revision 1 (the Host committed the player's message and consumed the draft); the
  // first `/draft` read still answers revision 0 because it was issued into the same commit.
  await mountShell(page, { stateRevision: 1, draftRouteRevisions: [0, 1] });
  await page.waitForTimeout(2500);
  const reading = await shellReading(page);
  console.log(`[draft-pair] after a one-read disagreement: ${JSON.stringify(reading)}`);

  expect(reading.problem, "a disagreement that is gone on the re-read is not a state fault").toBe("");
  expect(reading.appBar, "the app bar stays: the shell was never in an unreconcilable state").toBe(true);
  expect(reading.rows, "and the durable transcript is what the surface renders").toBe(TRANSCRIPT.length);
});

test("a draft pair that keeps disagreeing still fails closed with its own sentence", async ({ page }) => {
  await mountShell(page, { stateRevision: 1, draftRouteRevisions: [0] });
  await page.waitForTimeout(3000);
  const reading = await shellReading(page);
  console.log(`[draft-pair] after a persistent disagreement: ${JSON.stringify(reading)}`);

  expect(reading.appBar, "a pair that never reconciles is a real conflict and the surface must not pretend").toBe(false);
  expect(reading.problem, "the player reads the reconciliation sentence").toContain("聊天状态未能安全对齐");
});
