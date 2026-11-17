import { expect, test, type Locator, type Page } from "./frontend-coverage";

/**
 * A press on one of her profile forms says WHAT is missing, instead of greying the control out.
 *
 * The defect: four presses on the Characters surface were `disabled` on the draft's own
 * completeness - `creating || createName.value.trim().length === 0`,
 * `voiceSaving || voiceText.value.trim().length === 0` (twice, once per directive editor),
 * `personaSaving || personaName.value.trim().length === 0`, and the scenario's two fields - and
 * each handler returned early on the same predicate. So a player who cleared the one required field
 * was offered a dead control, no sentence, no `aria-invalid`, the keyboard on `<body>`, and a press
 * that sent nothing at all. Nothing on screen named which field it meant.
 *
 * The rule is unchanged and is still the durable validator's own required set: a companion needs a
 * display name, a directive needs its words, a persona needs a display name (its description is
 * optional), a scenario needs a name and a setting. What changed is where it is enforced - on the
 * press, out loud - so the assertions below are the facts the silence had: the control is offered,
 * every field that is missing something is named one by one (red edge, and a sentence under that
 * field), the keyboard lands on the first of them, and nothing is sent.
 *
 * The four forms share one rule, not a copy of it: `firstFieldAtFault` in
 * `src/components/field-error.ts` answers which field the press lands on, and `fieldError` produces
 * the `aria-invalid` / `aria-describedby` / message-id triple the sentence is announced through.
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
      companion: { name: "Nova", handle },
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

/** One write the surface sent, as it packed it. */
type Write = Readonly<{ method: string; path: string; body: Record<string, unknown> }>;

/**
 * The Characters surface as a fresh product serves it: one companion in play, a directive she has
 * already been given, and no persona, scenario or opening yet - the state every press below is
 * reached in. Every write is recorded, in the order it was sent.
 */
async function stubCharactersSurface(page: Page): Promise<Write[]> {
  const writes: Write[] = [];
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", async (route) => {
    const request = route.request();
    const companions = { apiVersion: 1, companions: [{ handle, name: "Nova", isCurrent: true }] };
    if (request.method() === "GET") {
      await route.fulfill(jsonOk(companions));
      return;
    }
    writes.push({ method: request.method(), path: request.url(), body: request.postDataJSON() as Record<string, unknown> });
    await route.fulfill(jsonOk({ apiVersion: 1, handle, name: "Nova", isCurrent: true }));
  });
  await page.route("**/api/tavern/v1/companions/*/voice", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill(
        jsonOk({ apiVersion: 1, profileRevision: 1, characterVoice: { source: "card", text: "Speak plainly." } }),
      );
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    writes.push({ method: request.method(), path: request.url(), body });
    await route.fulfill(jsonOk({ apiVersion: 1, profileRevision: 2, characterVoice: { source: "card", text: body.text } }));
  });
  await page.route("**/api/tavern/v1/companions/*/examples", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, profileRevision: 1, examples: [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  const absentRecords: Readonly<Record<string, unknown>> = {
    persona: { apiVersion: 1, present: false, revision: null, name: null, description: null },
    scenario: { apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null },
    greeting: { apiVersion: 1, present: false, revision: null, label: null, variants: [] },
  };
  for (const [path, absent] of Object.entries(absentRecords)) {
    await page.route(`**/api/tavern/v1/${path}`, async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill(jsonOk(absent));
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), path: request.url(), body });
      // The Host's own read-back: the record it now holds, at the revision it minted.
      await route.fulfill(
        jsonOk(
          path === "scenario"
            ? { apiVersion: 1, present: true, revision: 1, name: body.name, description: body.description, preview: body.description }
            : { apiVersion: 1, present: true, revision: 1, name: body.name, description: body.description ?? null },
        ),
      );
    });
  }
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: handle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
  return writes;
}

async function openCharacters(page: Page): Promise<Locator> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  const surface = page.getByTestId("characters-surface");
  await expect(surface).toBeVisible();
  return surface;
}

/**
 * What the press left on screen: how many sentences it named, and whether the keyboard is on a field
 * inside the surface's own scroller rather than above the fold.
 */
type Landing = Readonly<{ id: string; inside: boolean; box: unknown; band: unknown }>;

async function landing(page: Page): Promise<Landing> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const scroller = document.querySelector<HTMLElement>(".surface-content");
    const band = scroller?.getBoundingClientRect();
    const box = active?.getBoundingClientRect();
    return {
      id: active?.id ?? "",
      inside: band === undefined || box === undefined ? false : box.top >= band.top && box.bottom <= band.bottom,
      box: box === undefined ? null : { top: Math.round(box.top), bottom: Math.round(box.bottom) },
      band: band === undefined ? null : { top: Math.round(band.top), bottom: Math.round(band.bottom) },
    };
  });
}

/** `aria-invalid` and the sentence `aria-describedby` resolves to, as the browser reports them. */
async function associationOf(field: Locator): Promise<Readonly<{ invalid: string | null; description: string }>> {
  return field.evaluate((element: HTMLElement) => {
    const describedBy = element.getAttribute("aria-describedby");
    const target = describedBy === null ? null : element.ownerDocument.getElementById(describedBy);
    return { invalid: element.getAttribute("aria-invalid"), description: (target?.textContent ?? "").trim() };
  });
}

test("creating a companion names the display name instead of withdrawing the press", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = await stubCharactersSurface(page);
  const surface = await openCharacters(page);
  const name = surface.locator("#new-companion-name");
  const create = surface.locator("[data-new-companion-create]");

  const before = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("[data-new-companion-create]");
    return {
      disabled: button?.disabled ?? null,
      problems: document.querySelectorAll("[data-character-field-problem]").length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
    };
  });
  console.log(`[characters-create-press/before] ${JSON.stringify(before)}`);

  // Nothing is red before the press: the sentences are what a press says, not a live validation of
  // work in progress.
  await expect(surface.locator("[data-character-field-problem]")).toHaveCount(0);
  await expect(create, "a draft with no name is still offered a press").toBeEnabled();
  await create.click();

  const problem = surface.locator("[data-character-field-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText("Give her a display name before creating her.");
  const marked = await associationOf(name);
  console.log(`[characters-create-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe("Give her a display name before creating her.");
  const landed = await landing(page);
  console.log(`[characters-create-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe("new-companion-name");
  expect(landed.inside, `the field it focused is on screen (${JSON.stringify(landed)})`).toBe(true);
  expect(writes, "an incomplete draft is not sent at all").toHaveLength(0);

  // The sentence is derived from the draft, so it clears as the field is filled - not on the next
  // press, which would leave a red edge on a field that is no longer wrong.
  await name.fill("Nova");
  await expect(problem).toHaveCount(0);
  create.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.method).toBe("POST");
  expect(writes[0]?.body).toEqual({ apiVersion: 1, name: "Nova" });
});

test("saving a directive names the words instead of withdrawing the press", async ({ page }) => {
  const writes = await stubCharactersSurface(page);
  const surface = await openCharacters(page);
  const editor = surface.locator("[data-character-voice]");
  const directive = editor.locator("#character-voice-text");
  const save = editor.locator("[data-character-voice-save]");

  await expect(save, "a cleared directive is still offered a press").toBeEnabled();
  await directive.fill("");
  await save.click();

  const problem = editor.locator("[data-character-field-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText("Write the direction before saving it.");
  const marked = await associationOf(directive);
  console.log(`[characters-voice-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe("Write the direction before saving it.");
  const landed = await landing(page);
  console.log(`[characters-voice-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe("character-voice-text");
  expect(writes).toHaveLength(0);

  await directive.fill("Speak plainly, and never about the mayor.");
  await expect(problem).toHaveCount(0);
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({
    apiVersion: 1,
    expectedProfileRevision: 1,
    text: "Speak plainly, and never about the mayor.",
  });
});

test("saving a persona names the display name, and its optional description is never demanded", async ({ page }) => {
  const writes = await stubCharactersSurface(page);
  const surface = await openCharacters(page);
  const editor = surface.locator("[data-persona-editor]");
  const name = editor.locator("#persona-name");
  const save = editor.locator("[data-persona-save]");

  await expect(save, "an incomplete persona is still offered a press").toBeEnabled();
  await save.click();

  const problem = editor.locator("[data-character-field-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText("Your persona needs a display name before it can be kept.");
  const marked = await associationOf(name);
  console.log(`[characters-persona-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe("Your persona needs a display name before it can be kept.");
  const landed = await landing(page);
  console.log(`[characters-persona-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe("persona-name");
  expect(writes).toHaveLength(0);

  // The description is optional in the validator, so a persona with only a name is complete: the
  // press sends exactly what the command carries, with no description key at all.
  await name.fill("My farmer");
  await expect(problem).toHaveCount(0);
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({ apiVersion: 1, expectedRevision: 0, name: "My farmer" });
});

test("saving a scenario names both of its fields in reading order, then sends the complete one once", async ({
  page,
}) => {
  const writes = await stubCharactersSurface(page);
  const surface = await openCharacters(page);
  const editor = surface.locator("[data-scenario-editor]");
  const name = editor.locator("#scenario-name");
  const description = editor.locator("#scenario-description");
  const save = editor.locator("[data-scenario-save]");

  await expect(save, "an incomplete scenario is still offered a press").toBeEnabled();
  await save.click();

  const problems = editor.locator("[data-character-field-problem]");
  await expect(problems).toHaveCount(2);
  await expect(problems.nth(0)).toHaveText("This scenario needs a name before it can be kept.");
  await expect(problems.nth(1)).toHaveText("This scenario needs its setting before it can be kept.");
  const landed = await landing(page);
  console.log(`[characters-scenario-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id, "the press lands on the field it reads first").toBe("scenario-name");
  expect(writes).toHaveLength(0);

  await name.fill("Pelican Town");
  await expect(problems).toHaveCount(1);
  await description.fill("The first week of spring.");
  await expect(problems).toHaveCount(0);
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.body).toEqual({
    apiVersion: 1,
    expectedRevision: 0,
    name: "Pelican Town",
    description: "The first week of spring.",
  });
});
