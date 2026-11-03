import { expect, test, type Page } from "./frontend-coverage";

/**
 * The shell reads the composed root and the durable draft it carries as ONE snapshot.
 *
 * The defect this file used to pin: the root published `chat.draft` as `{revision, present}` only,
 * so the shell read `/api/tavern/v1/draft` for the body and compared the two answers - while the
 * Host commits between them. Accepting a player message consumes the draft (`chat-thread-store`:
 * `UPDATE tavern_drafts SET revision = revision + 1, draft_content = NULL` inside the acceptance
 * transaction), so a pair read during a turn disagreed while each route was individually correct,
 * and the whole shell became the problem view. Measured in `shots-final64`: driver P sent its second
 * turn and read zero `li.message` rows while `/state` still served five; drivers Q/R/S/T then could
 * not find `.app-bar-actions` at all.
 *
 * The root now carries the body in the read that already carried the revision, so there is no
 * second route left to disagree with: the first test is that the body arrives, from that one read,
 * while a `/draft` route is wired to answer a different revision - the exact input that used to end
 * the shell. The second is the one failure this path still owns: a root with no Chat half is not a
 * shell it can build.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const playerMessageHandle = "X".repeat(42) + "A";
const openedMessageHandle = "W".repeat(42) + "A";

function composedRoot(options: Readonly<{
  draft: Readonly<{ revision: number; present: boolean; text?: string | null }> | null;
  transcript: readonly { role: "player" | "companion"; text: string }[];
}>) {
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
      chat:
        options.draft === null
          ? null
          : {
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
              draft: options.draft,
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

const TRANSCRIPT = [
  { role: "companion" as const, text: "The lantern over the porch is still lit." },
  { role: "player" as const, text: "Are you there?" },
];
const DRAFT_TEXT = "A half-written line the player left behind.";

/**
 * Mount the shell with the Host's root serving `draft` and a `/draft` route wired to answer a
 * DIFFERENT revision - the input a Host committing the player's message mid-turn really produces.
 * The route is counted, because "the shell needed a second read to get the body" is the defect.
 */
async function mountShell(
  page: Page,
  options: Readonly<{
    draft: Readonly<{ revision: number; present: boolean; text?: string | null }> | null;
    draftRoute?: Readonly<{ revision: number; text: string | null }>;
  }>,
): Promise<{ draftReads: () => number }> {
  const root = composedRoot({ draft: options.draft, transcript: TRANSCRIPT });
  let draftReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => {
    draftReads += 1;
    route.fulfill(jsonOk({ apiVersion: 1, revision: options.draftRoute?.revision ?? 0, text: options.draftRoute?.text ?? null }));
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
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale: "en-US" })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 1, chat: { revision: 1, thinkingLevel: "medium" }, game: { revision: 1, thinkingLevel: "medium" }, recommendedModels: [] })),
  );
  await page.route("**/api/tavern/v1/companions", (route) => route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Mira", isCurrent: true }] })));
  await page.route("**/api/tavern/v1/persona", (route) => route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })));
  await page.route("**/api/tavern/v1/scenario", (route) => route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })));
  await page.route("**/api/tavern/v1/greeting", (route) => route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })));
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  return { draftReads: () => draftReads };
}

const shellReading = (page: Page) =>
  page.evaluate(() => ({
    appBar: document.querySelector(".app-bar") !== null,
    rows: document.querySelectorAll(".message-list > li.message").length,
    composer: (document.querySelector(".composer-section textarea") as HTMLTextAreaElement | null)?.value ?? null,
    problem: (document.querySelector(".problem-view")?.innerText ?? "").trim().slice(0, 120),
  }));

test("the draft body arrives in the snapshot's own read, so no second route can disagree with it", async ({ page }) => {
  // The root says revision 5 with the body; the draft route beside it answers revision 6 with none -
  // exactly what a Host that consumed the draft between two reads looks like from two routes.
  const host = await mountShell(page, {
    draft: { revision: 5, present: true, text: DRAFT_TEXT },
    draftRoute: { revision: 6, text: null },
  });
  await page.waitForTimeout(2500);
  const reading = await shellReading(page);
  console.log(`[draft-pair] one read carrying the body: ${JSON.stringify(reading)} draftReads=${host.draftReads()}`);

  expect(reading.problem, "a pair that cannot disagree never becomes a state fault").toBe("");
  expect(reading.appBar, "the shell stays the shell").toBe(true);
  expect(reading.rows, "and the durable transcript is what the surface renders").toBe(TRANSCRIPT.length);
  expect(reading.composer, "the player's unsent draft is what the Host confirmed, from the same read").toBe(DRAFT_TEXT);
  expect(host.draftReads(), "no second request for a fact the root already carried").toBe(0);
});

test("a root with no Chat half is a shell it cannot build, and still says so", async ({ page }) => {
  await mountShell(page, { draft: null });
  await page.waitForTimeout(3000);
  const reading = await shellReading(page);
  console.log(`[draft-pair] no Chat half: ${JSON.stringify(reading)}`);

  expect(reading.appBar, "there is no shell to keep: the root carries no conversation").toBe(false);
  expect(reading.problem, "the player reads the reconciliation sentence").toContain("The chat state could not be safely reconciled.");
});
