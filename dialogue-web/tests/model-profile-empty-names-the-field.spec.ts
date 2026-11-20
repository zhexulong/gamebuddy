/**
 * A thinking level nobody typed says so when the press is made, instead of the press being withheld.
 *
 * The defect, measured on the owner's own screen: clearing the field greyed Save out. No sentence, no
 * red edge, the keyboard stayed where it was, and nothing was written - so the player could not tell
 * which field the control wanted, or that it wanted one at all. The reason existed in the catalogue
 * (`modelProfilesLevelRequired`, "Enter a thinking level.") attached to the Host's `invalid_request`
 * answer, which this form can never receive: the only press that could send it was the press the empty
 * field withdrew.
 *
 * The rule is unchanged - a profile is saved at a thinking level - and where it is enforced moved: the
 * press is offered, the field is named (red edge and the sentence under it), the keyboard lands on it,
 * and nothing is sent until the field says something. It is the same cure the Memory editors and the
 * world book's two forms already carry (`useRequiredField` + `fieldError`), which is why the assertions
 * are the same shape rather than a second opinion about what "naming the field" means.
 *
 * `tests/disabled-controls-name-their-refusal-gate.test.mjs` is the class gate behind this file: it
 * asks every withheld press in the tree the same question, so the next site is caught by a gate rather
 * than by the owner.
 */
import { type Locator, type Page, expect, test } from "./frontend-coverage";
import { messages } from "../src/i18n";

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const chatHandle = "B".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

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
      companion: { name: "Mira", handle: "D".repeat(42) + "A" },
      title: null,
      transcript: [],
      draft: { revision: 4, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const recommendedModels = [
  {
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    modelId: "deepseek-v4",
    modelLabel: "DeepSeek V4",
    allowedThinkingLevels: ["off", "low", "high", "max"],
    defaultThinkingLevel: "low",
  },
];

const json200 = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The Settings surface with a mutable profile store behind the profiles route, and every write it took. */
async function stubProfiles(page: Page): Promise<Array<Record<string, unknown>>> {
  const store: Record<string, { revision: number; thinkingLevel: string }> = {
    chat: { revision: 1, thinkingLevel: "low" },
    game: { revision: 1, thinkingLevel: "low" },
  };
  const writes: Array<Record<string, unknown>> = [];
  const profiles = () => ({ apiVersion: 1, chat: store.chat, game: store.game, recommendedModels });
  await page.addInitScript(() => localStorage.setItem("gamebuddy.tavern.ui-locale", "en"));
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(json200(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(json200({ apiVersion: 1, revision: 4, text: null })));
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(json200({ revision: 1, locale: "en-US" })));
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
    route.fulfill(json200({ devices: [], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "unavailable" }) }),
  );
  await page.route("**/api/tavern/v1/settings/profiles", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(json200(profiles()));
      return;
    }
    const command = route.request().postDataJSON() as { surface: "chat" | "game"; thinkingLevel: string };
    writes.push(command);
    store[command.surface] = { revision: store[command.surface].revision + 1, thinkingLevel: command.thinkingLevel };
    await route.fulfill(json200(profiles()));
  });
  return writes;
}

async function openSettings(page: Page): Promise<Locator> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=settings`);
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();
  return surface;
}

function chatEditor(surface: Locator): Locator {
  return surface.locator('.model-profile-editor[data-model-profile-surface="chat"]');
}

const catalogue = messages("en");

/** `aria-invalid` and the sentence `aria-describedby` resolves to, as the browser reports them. */
async function associationOf(field: Locator): Promise<Readonly<{ invalid: string | null; description: string }>> {
  return field.evaluate((element: HTMLElement) => {
    const describedBy = element.getAttribute("aria-describedby");
    const target = describedBy === null ? null : element.ownerDocument.getElementById(describedBy);
    return { invalid: element.getAttribute("aria-invalid"), description: (target?.textContent ?? "").trim() };
  });
}

test("an empty thinking level names the field instead of withdrawing the press", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const writes = await stubProfiles(page);
  const surface = await openSettings(page);
  const editor = chatEditor(surface);
  const field = editor.locator("#model-profile-level-chat");
  const save = editor.getByRole("button", { name: "Save Chat", exact: true });
  await expect(field).toHaveValue("low");

  // The state the old control went dead in: the player cleared the field, and the keyboard is
  // elsewhere (the heading), so where the press sends it is a reading rather than an assumption.
  await field.fill("");
  await editor.locator("h3").click();
  const before = await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Save Chat",
    );
    return {
      disabled: button?.disabled ?? null,
      problems: document.querySelectorAll("[data-model-profile-level-problem]").length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      active: document.activeElement instanceof HTMLElement ? document.activeElement.id : "",
    };
  });
  console.log(`[model-level-press/before] ${JSON.stringify(before)}`);
  await expect(editor.locator("[data-model-profile-level-problem]")).toHaveCount(0);
  await expect(save, "an empty thinking level is still offered a press").toBeEnabled();
  await save.click();

  const problem = editor.locator("[data-model-profile-level-problem]");
  await expect(problem).toHaveCount(1);
  await expect(problem).toHaveText(catalogue.modelProfilesLevelRequired);
  const marked = await associationOf(field);
  console.log(`[model-level-press/marked] ${JSON.stringify(marked)}`);
  expect(marked.invalid).toBe("true");
  expect(marked.description).toBe(catalogue.modelProfilesLevelRequired);
  const landed = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return { id: active?.id ?? "", tag: active?.tagName.toLowerCase() ?? "" };
  });
  console.log(`[model-level-press/landed] ${JSON.stringify(landed)}`);
  expect(landed.id).toBe("model-profile-level-chat");
  expect(writes, "an empty thinking level is not sent at all").toHaveLength(0);

  // The sentence leaves as she types, and the press then sends exactly what the field holds.
  await field.fill("high");
  await expect(problem).toHaveCount(0);
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ apiVersion: 1, surface: "chat", expectedRevision: 1, thinkingLevel: "high" });
});

/**
 * The press is not withheld because nothing changed.
 *
 * The `dirty` half of the old predicate had the same defect in a quieter form: a press that was never
 * offered, for a reason the player could not read. The control says "Save", so a press with an
 * unchanged field saves the level it holds - measured here as one write carrying that level, rather
 * than a press that silently does nothing.
 */
test("a press with nothing changed saves the level the field holds", async ({ page }) => {
  const writes = await stubProfiles(page);
  const surface = await openSettings(page);
  const editor = chatEditor(surface);
  const save = editor.getByRole("button", { name: "Save Chat", exact: true });
  await expect(editor.locator("#model-profile-level-chat")).toHaveValue("low");
  await expect(save, "an unchanged field is still offered a press").toBeEnabled();
  await save.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ apiVersion: 1, surface: "chat", expectedRevision: 1, thinkingLevel: "low" });
});
