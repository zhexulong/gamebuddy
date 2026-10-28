import { expect, test, type Page } from "@playwright/test";
import { messages } from "../src/i18n";

/**
 * A refused authored-record save must leave the panel able to save again.
 *
 * The Host answers a stale persona/scenario/opening save with 409 `persona_conflict` /
 * `scenario_conflict` / `greeting_conflict` (`host/src/tavern-management-dialogue-web.ts`,
 * commit `99adb0b8`). The panel CASes every save on the revision it holds in local state, so a
 * refusal it only reports leaves the field pinned to the revision that already lost: every retry
 * resends the same stale number and is refused identically until the panel is remounted. Each
 * journey below is that half, end to end, for one of the three records:
 *
 *  1. the first save is refused as that record's conflict;
 *  2. the player reads the catalogue's own sentence for the code (the refusal is not swallowed)
 *     and what she typed is still in the field (a re-read must not discard her words);
 *  3. the second save carries the revision the Host holds, and lands.
 *
 * Step 3 is the assertion the panel failed: it only passes if the conflict made the panel adopt
 * the Host's revision.
 *
 * The stubs serve each record in the exact shape the client mirror validates (`hasExactKeys` in
 * `management-pipeline-api.ts`): a record with one field too many or too few is rejected whole,
 * the section then renders as `unavailable`, and the journey would be measuring the fixture
 * instead of the panel.
 */

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const composedRoot = {
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
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    chat: {
      companion: { name: "Nova", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** A validated problem, shaped exactly as the Host's `problemFor` emits one. */
const conflict = (code: string, title: string) => ({
  status: 409,
  contentType: "application/json",
  body: JSON.stringify({ type: "about:blank", title, status: 409, code, requestId: handle, retryable: false }),
});

type RecordKind = "persona" | "scenario" | "greeting";

/** The record a fresh product holds: absent, and in each projection's own exact shape. */
const absentRecord: Readonly<Record<RecordKind, unknown>> = {
  persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
  scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
  greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
};

/** The record another writer saved while this panel held the absent one: revision 2. */
const otherWriterRecord: Readonly<Record<RecordKind, unknown>> = {
  persona: { apiVersion: 1, present: true, revision: 2, name: "Another writer", description: "Theirs." },
  scenario: {
    apiVersion: 1,
    present: true,
    revision: 2,
    name: "Another writer",
    description: "Theirs.",
    preview: "Theirs.",
  },
  greeting: {
    apiVersion: 1,
    present: true,
    revision: 2,
    label: "Another writer",
    // A variant's label is either a bounded string or `null` - the mirror refuses an empty
    // string - so the fixture spells "no label" the way the wire does.
    variants: [{ label: null, text: "Theirs." }],
  },
};

const conflictCode: Readonly<Record<RecordKind, string>> = {
  persona: "persona_conflict",
  scenario: "scenario_conflict",
  greeting: "greeting_conflict",
};

const conflictTitle: Readonly<Record<RecordKind, string>> = {
  persona: "Persona revision conflict",
  scenario: "Scenario revision conflict",
  greeting: "Greeting revision conflict",
};

/** One accepted save's own command, as the panel put it on the wire. */
type Save = Readonly<{ expectedRevision: number; name?: string; description?: string; text?: string }>;

/** The record the accepted save leaves behind, in that record's exact projection shape. */
function acceptedRecord(kind: RecordKind, command: Save): unknown {
  if (kind === "persona")
    return { apiVersion: 1, present: true, revision: 3, name: command.name, description: command.description ?? null };
  if (kind === "scenario")
    return {
      apiVersion: 1,
      present: true,
      revision: 3,
      name: command.name,
      description: command.description,
      preview: command.description,
    };
  // The opening's accepted reply echoes the label the player saved, and the variant she wrote.
  return { apiVersion: 1, present: true, revision: 3, label: null, variants: [{ label: null, text: command.text }] };
}

/**
 * Serves one authored record whose revision the panel does not hold.
 *
 * The first PUT is refused as that record's conflict - and the record the Host then holds is
 * revision 2, which the panel has never read. The second PUT is accepted only at that revision,
 * so it can land only if the panel adopted it.
 */
async function serveStaleRecord(
  page: Page,
  kind: RecordKind,
  route: string,
  saves: Save[],
): Promise<void> {
  let durable: unknown = absentRecord[kind];
  await page.route(route, async (request) => {
    if (request.request().method() === "GET") {
      await request.fulfill(jsonOk(durable));
      return;
    }
    const command = request.request().postDataJSON() as Save & { variants?: readonly { text: string }[] };
    // The opening sends its words inside `variants`, not as `text`; normalizing it here keeps every
    // record's assertion reading the same field. A key is only added when there is a word to carry,
    // so each save is exactly what that record's own command put on the wire.
    const openingText = command.variants?.[0]?.text;
    const save: Save = openingText === undefined ? { ...command } : { ...command, text: openingText };
    saves.push(save);
    if (saves.length === 1) {
      // Another writer saved between the panel's read and this save.
      durable = otherWriterRecord[kind];
      await request.fulfill(conflict(conflictCode[kind], conflictTitle[kind]));
      return;
    }
    durable = acceptedRecord(kind, save);
    await request.fulfill(jsonOk(durable));
  });
}

/** Everything the Characters surface reads on mount, except the record under test. */
async function stubSurface(page: Page, record: RecordKind): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Nova", isCurrent: true }] })),
  );
  await page.route(`**/api/tavern/v1/companions/${handle}/voice`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, profileRevision: 1, characterVoice: null })),
  );
  await page.route(`**/api/tavern/v1/companions/${handle}/worldbook`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  const routes: Readonly<Record<RecordKind, string>> = {
    persona: "**/api/tavern/v1/persona",
    scenario: "**/api/tavern/v1/scenario",
    greeting: "**/api/tavern/v1/greeting",
  };
  for (const kind of ["persona", "scenario", "greeting"] as const) {
    if (kind === record) continue;
    const absent = absentRecord[kind];
    await page.route(routes[kind], (route) => route.fulfill(jsonOk(absent)));
  }
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: handle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
}

async function openCharacters(page: Page): Promise<void> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

/** The catalogue's own sentence for every compare-and-set refusal. */
const conflictSentence = messages("en").problemRevisionConflictDetail;

test("a persona conflict re-reads the record, keeps the typed text, and the next save lands", async ({ page }) => {
  const saves: Save[] = [];
  await stubSurface(page, "persona");
  await serveStaleRecord(page, "persona", "**/api/tavern/v1/persona", saves);
  await openCharacters(page);

  const editor = page.getByTestId("characters-surface").locator("[data-persona-editor]");
  const nameField = editor.locator("#persona-name");
  await nameField.fill("My farmer");
  const save = editor.getByRole("button", { name: "Save persona", exact: true });

  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]?.expectedRevision).toBe(0);
  // The refusal is worded, not swallowed, and the field still carries what she wrote.
  await expect(editor.getByRole("status")).toHaveText(conflictSentence);
  await expect(nameField).toHaveValue("My farmer");

  // The half that was broken: the second save CASes on the revision she read back, and lands.
  await save.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toEqual({ apiVersion: 1, expectedRevision: 2, name: "My farmer" });
  await expect(editor.getByRole("status")).toHaveText("Saved.");
  await expect(editor).toContainText("Saved");
});

test("a scenario conflict re-reads the record, keeps the typed text, and the next save lands", async ({ page }) => {
  const saves: Save[] = [];
  await stubSurface(page, "scenario");
  await serveStaleRecord(page, "scenario", "**/api/tavern/v1/scenario", saves);
  await openCharacters(page);

  const editor = page.getByTestId("characters-surface").locator("[data-scenario-editor]");
  const nameField = editor.locator("#scenario-name");
  const descriptionField = editor.locator("#scenario-description");
  await nameField.fill("Pelican Town");
  await descriptionField.fill("The first week of spring.");
  const save = editor.getByRole("button", { name: "Save scenario", exact: true });

  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]?.expectedRevision).toBe(0);
  await expect(editor.getByRole("status")).toHaveText(conflictSentence);
  await expect(nameField).toHaveValue("Pelican Town");
  await expect(descriptionField).toHaveValue("The first week of spring.");

  await save.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]).toEqual({
    apiVersion: 1,
    expectedRevision: 2,
    name: "Pelican Town",
    description: "The first week of spring.",
  });
  await expect(editor.getByRole("status")).toHaveText("Saved.");
});

test("an opening conflict re-reads the record, keeps the typed text, and the next save lands", async ({ page }) => {
  const saves: Save[] = [];
  await stubSurface(page, "greeting");
  await serveStaleRecord(page, "greeting", "**/api/tavern/v1/greeting", saves);
  await openCharacters(page);

  const editor = page.getByTestId("characters-surface").locator("[data-opening-editor]");
  const firstVariant = editor.locator("#opening-variant-0-text");
  await firstVariant.fill("The town has not woken up yet.");
  const save = editor.getByRole("button", { name: "Save opening", exact: true });

  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]?.expectedRevision).toBe(0);
  await expect(editor.getByRole("status")).toHaveText(conflictSentence);
  await expect(firstVariant).toHaveValue("The town has not woken up yet.");

  await save.click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]?.expectedRevision).toBe(2);
  expect(saves[1]?.text).toBe("The town has not woken up yet.");
  await expect(editor.getByRole("status")).toHaveText("Saved.");
});
