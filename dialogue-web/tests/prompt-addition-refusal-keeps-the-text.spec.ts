import { type Locator, type Page, expect, test } from "@playwright/test";
import { messages } from "../src/i18n";

/**
 * A refused save of her extra instructions costs the attempt, never the text.
 *
 * The defect: `savePromptAddition`'s failure path re-read the record and adopted
 * `restated.addition` as the field's own value, so the operation that failed replaced what the
 * player was writing with the copy the Host still held. The comment above it stated that as the
 * rule ("the validated read-back is the only value the panel then shows"), which is exactly the
 * conflation this file exists to prevent: the read-back is the authority for the REVISION the
 * next save CASes on, and the field is the authority for the TEXT.
 *
 * Both halves are load-bearing and either alone is a half-fix:
 *  - keeping the text but not the revision leaves every retry CASing on the revision that already
 *    lost, so a conflict loops forever - the deadlock the world book's editor had;
 *  - taking the revision but the stored text (what this panel did) answers a failed save by
 *    deleting what the player typed.
 *
 * The journeys below cover every shape a failed save can take - offline, a non-retryable refusal
 * of the content, a revision conflict, and a refusal whose own re-read also fails - and each one
 * asserts the same pair: the text is still in the field, and the panel said what happened. The
 * conflict case adds the reading that makes the retry possible, and the last test pins the other
 * direction: a save that LANDS adopts the Host's read-back, so nothing is left behind after a
 * real success.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const companionHandle = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA";

const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
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

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The player's own instructions: distinctive, and the thing a failed save must not eat. */
const SENTINEL = "SENTINEL_DRAFT water the parsnips before the mines, and never the sprinklers after dusk.";

/** The record the Host held when the panel mounted. */
const stored = { revision: 1, addition: "Water first, then the mines." };

/** A validated problem, shaped exactly as the Host's `problemFor` emits one. */
const problem = (status: number, code: string, title: string, retryable: boolean) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ type: "about:blank", title, status, code, requestId: csrfToken, retryable }),
});

type Write = Readonly<{ expectedRevision: number; addition: string }>;

/**
 * The settings surface's own routes, plus the one route under test.
 *
 * `failures` is how many PUTs are refused before one is accepted, and `refusal` is the answer
 * those refusals give - a problem body, or `"offline"` for a connection that never reached the
 * Host. `rereadFails` is the other half of the offline case: the mount's own read succeeds, and
 * the re-read the refusal triggers cannot reach the Host either.
 */
async function stubSettings(
  page: Page,
  options: Readonly<{
    failures: number;
    refusal: unknown | "offline";
    rereadFails?: boolean;
    storedOnReread?: Readonly<{ revision: number; addition: string }>;
  }>,
): Promise<{ writes: Write[] }> {
  const writes: Write[] = [];
  let reads = 0;
  let durable = stored;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 3, active: null, connections: [], providers: [] })),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
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
  await page.route("**/api/tavern/v1/settings/game-prompt", async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      reads += 1;
      // Only the mount's own read is served: the re-read a refusal triggers is the second one.
      if (options.rereadFails === true && reads > 1) {
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill(jsonOk(durable));
      return;
    }
    const body = request.postDataJSON() as Write;
    writes.push(body);
    if (writes.length <= options.failures) {
      if (options.refusal === "offline") {
        await route.abort("connectionfailed");
        return;
      }
      // Another writer may have moved the record on between the panel's read and this save.
      if (options.storedOnReread !== undefined) durable = options.storedOnReread;
      await route.fulfill(options.refusal as { status: number });
      return;
    }
    durable = { revision: durable.revision + 1, addition: body.addition };
    await route.fulfill(jsonOk(durable));
  });
  return { writes };
}

async function openSettings(page: Page): Promise<{
  field: Locator;
  save: Locator;
  panel: Locator;
}> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  const panel = surface.locator("[data-game-prompt-addition]");
  return { panel, field: panel.locator("#game-prompt-addition"), save: panel.getByRole("button", { name: /save/iu }) };
}

/** The sentence the panel prints for a refusal, wherever the mount puts it. */
const refusalStatus = (page: Page): Locator => page.getByTestId("settings-surface").locator(".error-banner");

const catalogue = messages("en");

test.describe("a refused save of her extra instructions", () => {
  test("refused for a revision conflict: the text stays, the revision moves, and the retry lands", async ({ page }) => {
    // Another tab saved while this one held revision 1: the refusal is a conflict, and the record
    // the re-read finds is revision 2.
    const stub = await stubSettings(page, {
      failures: 1,
      refusal: problem(409, "settings_revision_conflict", "Settings revision conflict", false),
      storedOnReread: { revision: 2, addition: "Saved from another tab." },
    });
    const { field, save } = await openSettings(page);
    await expect(field).toHaveValue(stored.addition);

    await field.fill(SENTINEL);
    await save.click();
    await expect.poll(() => stub.writes.length).toBe(1);
    expect(stub.writes[0]).toEqual({ expectedRevision: 1, addition: SENTINEL });

    // The field still holds what she wrote - NOT the other tab's text the re-read returned.
    await expect(field).toHaveValue(SENTINEL);
    // …and the failure is named with the catalogue's own sentence for that code.
    await expect(refusalStatus(page)).toHaveText(catalogue.problemRevisionConflictDetail);

    // The reading that makes the retry possible: the second save CASes on the revision the
    // re-read found, so it is not refused for the same reason again.
    await save.click();
    await expect.poll(() => stub.writes.length).toBe(2);
    expect(stub.writes[1]).toEqual({ expectedRevision: 2, addition: SENTINEL });
    // The save landed, so the Host's read-back is what the field shows: her words, at revision 3.
    await expect(field).toHaveValue(SENTINEL);
    expect(await field.inputValue()).toBe(SENTINEL);
  });

  test("refused for the text itself: the text stays, and the revision does not move", async ({ page }) => {
    const stub = await stubSettings(page, {
      failures: 1,
      refusal: problem(400, "invalid_request", "Invalid request", false),
    });
    const { field, save } = await openSettings(page);

    await field.fill(SENTINEL);
    await save.click();
    await expect.poll(() => stub.writes.length).toBe(1);

    await expect(field).toHaveValue(SENTINEL);
    await expect(refusalStatus(page)).toBeVisible();
    // Everything the field kept is still editable and still sendable.
    await expect(field).toBeEnabled();
    await save.click();
    await expect.poll(() => stub.writes.length).toBe(2);
    expect(stub.writes[1]).toEqual({ expectedRevision: 1, addition: SENTINEL });
  });

  test("lost before the Host answered, and the re-read fails too: the text stays in an open field", async ({ page }) => {
    const stub = await stubSettings(page, { failures: 1, refusal: "offline", rereadFails: true });
    const { field, save, panel } = await openSettings(page);

    await field.fill(SENTINEL);
    await save.click();
    await expect.poll(() => stub.writes.length).toBe(1);

    // The old code replaced the whole group with its "unavailable" sentence when the re-read
    // failed, which is the same loss by another route: the field and her text went with it.
    await expect(panel.locator("#game-prompt-addition")).toHaveValue(SENTINEL);
    await expect(field).toBeEnabled();
    await expect(refusalStatus(page)).toBeVisible();
  });

  test("a save that lands adopts the Host's read-back, so nothing is left behind", async ({ page }) => {
    const stub = await stubSettings(page, { failures: 0, refusal: problem(500, "storage_unavailable", "x", true) });
    const { field, save } = await openSettings(page);

    await field.fill(SENTINEL);
    await save.click();
    await expect.poll(() => stub.writes.length).toBe(1);
    await expect(field).toHaveValue(SENTINEL);
    // The counter follows the field, so the two cannot disagree about what the store holds.
    await expect(page.getByTestId("settings-surface").locator("[data-game-prompt-addition-count]")).toHaveText(
      `${SENTINEL.length} / 2000 characters`,
    );
    await expect(page.getByTestId("settings-surface").locator(".success-banner")).toHaveText(catalogue.success);
  });
});
