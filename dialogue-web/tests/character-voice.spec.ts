import { expect, test, type Page } from "@playwright/test";

/**
 * The third law of the owner's `system_prompt` ruling, from the player's side.
 *
 * `host/src/identity-profile.ts` carries the imported card's own performance
 * directive as `characterVoice { text, source }` (`source` = `"card"` while the
 * text is exactly what the card supplied, `"player"` once the player edited it).
 * This suite holds the two player-facing halves of that ruling:
 *
 *   - the imported directive is VISIBLE on the Characters surface with its
 *     provenance, edits it, and can be cleared in one click;
 *   - a cleared directive is ABSENT - the editor is not rendered at all rather
 *     than left as an empty box (design/26 §1) - and a later re-import of the
 *     same card does not resurrect it.
 *
 * A companion the card wrote no directive for renders nothing here, which is
 * what "absent, not disabled" means for this control.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const currentHandle = "B".repeat(42) + "A";
const importIdHandle = "D".repeat(42) + "A";

const CHAT_HANDLE = "E".repeat(42) + "A";

const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: {
      browserContract: "tavern_browser_api/v1",
      profileId: "gamebuddy.chat-core.reference-pipeline",
    },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: CHAT_HANDLE, generation: 1, stateRevision: CHAT_HANDLE },
    chat: {
      companion: { name: "Nova" },
      title: "Reference Game Chat",
      transcript: [],
      draft: { revision: 1, present: true },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const draft = { apiVersion: 1, revision: 1, text: "A durable draft." };

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** The voice the Host would hold for the mounted companion, mutated by the stub. */
type VoiceState = { profileRevision: number; characterVoice: { text: string; source: "card" | "player" } | null };

/**
 * The GET routes the Characters surface reads on mount plus the companion voice
 * read/update pair. The voice stub is stateful so a save or clear is visible to
 * the next read-back exactly as a durable Host write would be.
 */
async function stubCharactersSurface(
  page: Page,
  voice: VoiceState,
  calls: { puts: Array<{ method: string; csrf: string | undefined; body: unknown }> },
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: currentHandle, name: "Nova", isCurrent: true }] })),
  );
  await page.route(`**/api/tavern/v1/companions/${currentHandle}/voice`, async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as
        | { expectedProfileRevision: number; text: string }
        | { expectedProfileRevision: number; clear: true };
      calls.puts.push({ method: request.method(), csrf: request.headers()["x-csrf-token"], body });
      voice.profileRevision = body.expectedProfileRevision + 1;
      voice.characterVoice =
        "clear" in body ? null : { text: body.text, source: "player" };
    }
    await route.fulfill(jsonOk({ apiVersion: 1, profileRevision: voice.profileRevision, characterVoice: voice.characterVoice }));
  });
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: CHAT_HANDLE, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
}

async function openCharactersSurface(page: Page): Promise<void> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

test("the imported directive is visible on the character with its provenance", async ({ page }) => {
  const calls = { puts: [] as Array<{ method: string; csrf: string | undefined; body: unknown }> };
  await stubCharactersSurface(
    page,
    { profileRevision: 7, characterVoice: { text: "Open every reply with a *micro-action*.", source: "card" } },
    calls,
  );
  await openCharactersSurface(page);

  const voice = page.getByTestId("characters-surface").locator("[data-character-voice]");
  await expect(voice).toBeVisible();
  // The card's own text is shown, and its provenance says the card authored it.
  await expect(voice.locator("#character-voice-text")).toHaveValue("Open every reply with a *micro-action*.");
  await expect(voice.locator("[data-character-voice-source]")).toHaveText("From the card");
});

test("editing the directive issues the update route and flips the provenance to the player", async ({ page }) => {
  const calls = { puts: [] as Array<{ method: string; csrf: string | undefined; body: unknown }> };
  await stubCharactersSurface(
    page,
    { profileRevision: 3, characterVoice: { text: "From the card.", source: "card" } },
    calls,
  );
  await openCharactersSurface(page);

  const voice = page.getByTestId("characters-surface").locator("[data-character-voice]");
  await expect(voice.locator("[data-character-voice-source]")).toHaveText("From the card");
  await voice.locator("#character-voice-text").fill("Mine now: keep it close to the farm.");
  await voice.locator("[data-character-voice-save]").click();

  // The durable update route carries the exact profile revision read back and
  // the exact text; the Host re-reads the written record, so provenance flips.
  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0]?.body).toEqual({
    apiVersion: 1,
    expectedProfileRevision: 3,
    text: "Mine now: keep it close to the farm.",
  });
  expect(calls.puts[0]?.csrf).toBe(csrfToken);
  await expect(voice.locator("[data-character-voice-source]")).toHaveText("Edited by you");
});

test("one-click clear removes the field, and a re-import of the same card does not resurrect it", async ({ page }) => {
  const calls = { puts: [] as Array<{ method: string; csrf: string | undefined; body: unknown }> };
  await stubCharactersSurface(
    page,
    { profileRevision: 2, characterVoice: { text: "Keep it terse.", source: "card" } },
    calls,
  );
  const cardText = JSON.stringify({
    spec: "chara_card_v3",
    data: { name: "Nova", description: "A quiet astronomer.", system_prompt: "Keep it terse." },
  });
  let imports = 0;
  await page.route("**/api/tavern/v1/imports", async (route) => {
    imports += 1;
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        importId: importIdHandle,
        name: "Nova",
        candidateRevision: 1,
        fields: [
          { field: "name", eligibility: "profile_eligible_after_explicit_review", chars: 4 },
          { field: "system_prompt", eligibility: "profile_eligible_after_explicit_review", chars: 14 },
        ],
        dispositions: [],
      }),
    );
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, importId: importIdHandle, reviewedFields: ["name", "system_prompt"], approvedAtMs: 1 })),
  );
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" })),
  );
  await openCharactersSurface(page);

  const surface = page.getByTestId("characters-surface");
  const voice = surface.locator("[data-character-voice]");
  await expect(voice).toBeVisible();
  await voice.locator("[data-character-voice-clear]").click();

  // One action clears the field; the durable read-back is empty, so the editor
  // is absent rather than left behind as an empty box (design/26 §1).
  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0]?.body).toEqual({ apiVersion: 1, expectedProfileRevision: 2, clear: true });
  await expect(surface.locator("#character-voice-text")).toHaveCount(0);
  await expect(surface.locator("[data-character-voice-notice]")).toHaveText("Cleared.");

  // Re-importing the same card must not bring the cleared field back: the
  // player's "cleared" is player intent, and no import writes into the mounted
  // companion's own profile.
  await surface.locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(cardText, "utf8"),
  });
  await expect.poll(() => imports).toBe(1);
  await expect(surface.locator("[data-card-import-result=created]")).toContainText("Imported Nova.");
  await expect(surface.locator("#character-voice-text")).toHaveCount(0);
});
