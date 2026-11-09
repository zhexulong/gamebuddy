/**
 * The population the draft gates are about: the surfaces, the controls, and the exemptions - read by
 * BOTH journeys rather than kept twice.
 *
 * Two questions are asked of the same product facts:
 *
 *   - `draft-survives-interruption.spec.ts` asks whether the words a player put into a control are
 *     still there after they leave the surface and come back;
 *   - `draft-declaration-coverage.spec.ts` asks whether the population that journey walks is the whole
 *     population the product renders - an editor nobody declared is an editor the first journey never
 *     sees, and a surface nobody walks is a surface it cannot see at all.
 *
 * The second question is only answerable if both journeys read the SAME table, so the table lives
 * here: one spelling of "which surfaces exist", "which controls carry the player's own input", "how an
 * editor one press away announces itself", and "which controls genuinely need no draft, and why". A
 * copy in each file would be two authorities that agree today and disagree the day one of them moves.
 *
 * The stub is here for the same reason. Every surface's fields are decided by what the Host answers,
 * so a gate that stubbed its own slightly different shell would be measuring a different product.
 */
import { type Locator, type Page, expect } from "./frontend-coverage";
import { messages } from "../src/i18n";

export const token = "A".repeat(43);
export const csrfToken = `${"C".repeat(42)}A`;
export const chatHandle = `${"B".repeat(42)}A`;
export const companionHandle = `${"D".repeat(42)}A`;
/** The one settled reply the Chat surface renders, so its in-place editor is reachable. */
export const messageHandle = `${"E".repeat(42)}A`;
export const COMPANION_LINE = "The kettle is on and the sky has not decided yet.";
export const expiresAtMs = 1_900_000_000_000;
export const projectionRevision = `${"M".repeat(42)}A`;

export const catalogue = messages("en");

/** The companion-language tag the Host already holds, so a draft that differs from it is visible. */
export const STORED_LANGUAGE = "zh-CN";
/** What the player types instead: a tag the Host has never seen, so no projection can produce it. */
export const TYPED_LANGUAGE = "ja-JP";
export const STORED_ADDITION = "Old words the Host already holds.";

export const composedRoot = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat: {
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
      companion: { name: "Nova", handle: companionHandle },
      title: null,
      // One settled reply, because the row's own editor is only reachable from a row: a transcript
      // this gate never renders is a surface walked with the player's newest field outside it.
      transcript: [
        { handle: messageHandle, role: "companion", text: COMPANION_LINE, locale: "und", order: 0, revision: 1 },
      ],
      draft: { revision: 0, present: false },
      turn: null,
      // The library's own revision, present and empty: an ABSENT projection makes the whole block
      // read as "unavailable", with no authoring control in it at all - and the gate would be
      // walking a surface whose library it never reached.
      worldInfo: { state: "none", revision: chatHandle, items: [] },
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision },
    eventStream: null,
  },
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Two providers, because the connection form renders one field group per entry: the base URL, the
 * credential requirement and the model id only exist once an entry is chosen. Choosing it is part of
 * the walk, not a hand-written field list.
 */
export const PROVIDERS = [
  {
    providerId: "deepseek",
    label: "DeepSeek",
    setupFields: ["apiKey", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: false,
    environmentManaged: false,
  },
  {
    providerId: "local-openai",
    label: "Local OpenAI-compatible",
    setupFields: ["baseUrl", "apiShape", "apiKey", "apiKeyRequired", "modelId"],
    allowedPlayerModels: [],
    escapeHatch: true,
    environmentManaged: false,
  },
];

/**
 * Every route the surfaces read, plus the one write a journey makes fail.
 *
 * The companion language save is refused with the Host's own conflict code and its re-read answers
 * the value the Host still holds - the exact shape in which the field replaced the player's `ja-JP`
 * with `zh-CN` and looked like it had been accepted.
 *
 * Every other mutation is left unanswered, so a control a journey presses by accident (the coverage
 * gate presses each one to see what it reveals) is refused rather than allowed to change what the
 * next surface renders.
 */
export async function stubShell(page: Page): Promise<{ languageWrites: () => number }> {
  let languageWrites = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(composedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 3, active: null, connections: [], providers: PROVIDERS })),
  );
  await page.route("**/api/tavern/v1/settings/language", async (route) => {
    if (route.request().method() === "PUT") {
      languageWrites += 1;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Settings revision conflict",
          status: 409,
          code: "settings_revision_conflict",
          requestId: csrfToken,
          retryable: false,
        }),
      });
      return;
    }
    await route.fulfill(jsonOk({ revision: 1, locale: STORED_LANGUAGE }));
  });
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
    route.fulfill(jsonOk({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
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
  await page.route("**/api/tavern/v1/settings/game-prompt", (route) =>
    route.fulfill(jsonOk({ revision: 1, addition: STORED_ADDITION })),
  );
  // One row, so the notebook renders the search field as well as the authoring form: an empty
  // notebook hides the search, and a surface whose fields depend on having something in it would
  // otherwise be walked with half its controls absent.
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        projectionRevision,
        memories: [
          {
            handle: `${"R".repeat(42)}A`,
            title: "Semantic memory",
            content: "A stored memory the Host already holds.",
            category: "semantic",
            status: "active",
            origin: "player",
            pinned: false,
          },
        ],
        // One chapter, because the correction editor lives on a chapter ROW: with none the memory
        // surface renders no editor to correct, and the gate would be reporting a clean surface whose
        // newest text field it never reached.
        chapters: [
          {
            handle: `${"F".repeat(42)}A`,
            title: "The greenhouse",
            span: "a stretch of an afternoon",
            content: "A chapter the Host already sealed.",
            status: "sealed",
            editedByPlayer: false,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: companionHandle, name: "Nova", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/companions/*/voice", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, profileRevision: 4, characterVoice: null })),
  );
  // The companion's OWN world book, present with one entry. Without a book the section renders no
  // block at all, and with no entry its editor is a form with no rows: either way the gate would be
  // measuring something other than the editor the player writes in.
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 2,
        entries: [{ title: "Greenhouse", keys: ["greenhouse"], constant: false, content: "Her greenhouse." }],
      }),
    ),
  );
  // The three authored records are PRESENT and non-empty: the stored value is what a silent re-seed
  // puts back, so a field that returns holding the player's text is measurably a draft.
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 2, name: "Stored name", description: "Stored description." }),
    ),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 2,
        name: "Stored scenario",
        description: "Stored scenario description.",
        preview: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 2,
        label: "Stored opening",
        variants: [{ label: "Stored variant", text: "Stored variant text." }],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: chatHandle, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
  // ONE saved Chat, because the Chats surface opens one rename at a time: its editor takes the
  // pencil's place, so a second row would open the second editor by closing the first and the walk
  // would read that as an editor that never closed.
  await page.route("**/api/tavern/v1/chats?*", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          {
            handle: chatHandle,
            title: "A Chat the Host already named",
            status: "active",
            managementRevision: 1,
            isSelected: true,
            updatedAtMs: 1_760_000_000_000,
            preview: "A line the list already carries.",
          },
        ],
      }),
    ),
  );
  return { languageWrites: () => languageWrites };
}

/**
 * One control the surface rendered, addressed by an expression that survives its own remount.
 *
 * The address is the control's own stable identity - its `id`, else its first `data-` hook, else its
 * `data-testid`, else its accessible name, else its first class - so the same expression finds it
 * again after the subtree was destroyed and rebuilt. A control offering none of those cannot be found
 * again at all, and `enumerateControls()` says so instead of addressing "the third textarea" and
 * silently measuring a field the player never touched.
 */
export type DraftControl = Readonly<{ key: string; name: string; tag: "input" | "textarea" | "select" }>;

/** Every `<input type>` that carries something a player typed. A file is not a draft the page holds. */
export const TEXT_ENTRY_TYPES = ["text", "search", "url", "email", "password", "tel", "number"];

/** Every visible, enabled control inside `region` that carries the player's own input. */
export async function enumerateControls(region: Locator): Promise<DraftControl[]> {
  return await region.evaluate((root, types) => {
    const wanted = new Set(types as string[]);
    const carriesInput = (element: Element): boolean => {
      const tag = element.tagName.toLowerCase();
      if (tag === "textarea" || tag === "select") return true;
      if (tag !== "input") return false;
      return wanted.has((element.getAttribute("type") ?? "text").toLowerCase());
    };
    const controls: { key: string; name: string; tag: "input" | "textarea" | "select" }[] = [];
    for (const element of root.querySelectorAll("textarea, input, select")) {
      if (!carriesInput(element)) continue;
      // The browser's own answer to "can the player reach this?", which is the one that knows about
      // a closed `<details>`: the box still measures there, but nobody can type into it.
      if (
        !element.checkVisibility({
          contentVisibilityAuto: true,
          opacityProperty: true,
          visibilityProperty: true,
          checkVisibilityCSS: true,
        })
      )
        continue;
      const field = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (field.disabled || (element instanceof HTMLInputElement && element.readOnly)) continue;
      const id = element.getAttribute("id");
      const aria = element.getAttribute("aria-label");
      const testId = element.getAttribute("data-testid");
      const className = element.classList.item(0);
      const tag = element.tagName.toLowerCase() as "input" | "textarea" | "select";
      /*
       * A data hook wins over the accessible name: an `aria-label` is a sentence from the catalogue
       * and moves with the locale, while the hook is the control's own frozen identity. Then `id`,
       * then the first class - and only a control with none of those falls back to its name.
       */
      const hooks = [...element.attributes]
        .map((attribute) => attribute.name)
        .filter((name) => name.startsWith("data-"));
      const key =
        id !== null && id !== ""
          ? `#${id}`
          : hooks.length > 0
            ? `${tag}[${hooks[0]}]`
            : testId !== null && testId !== ""
              ? `${tag}[data-testid=${JSON.stringify(testId)}]`
              : aria !== null && aria !== ""
                ? `${tag}[aria-label=${JSON.stringify(aria)}]`
                : className !== null && className !== ""
                  ? `${tag}.${className}`
                  : "";
      const name = aria ?? (id !== null && id !== "" ? id : (hooks[0] ?? className ?? tag));
      if (key === "") {
        throw new Error(`${name} has no id, aria-label, data-testid or class, so a draft in it cannot be found again`);
      }
      controls.push({ key, name, tag });
    }
    return controls;
  }, TEXT_ENTRY_TYPES);
}

/** The text controls only: the two questions here are about words, not about a `<select>`'s choice. */
export function textControls(controls: readonly DraftControl[]): DraftControl[] {
  return controls.filter((control) => control.tag !== "select");
}

/**
 * Open every editor the product declares, so its fields are in the population before they are read.
 *
 * A field inside an editor the player has to open is invisible to an enumeration that never opens it,
 * and the walk would then report a surface as covered while the player's own editor sat outside the
 * population - the silent narrowing this file exists to avoid. The product marks the control that
 * opens such an editor with `data-draft-revealer`, so the set comes from the product's declaration
 * rather than from a list of locators somebody has to remember to extend.
 *
 * Opening an editor REPLACES the control that opened it. That is the premise the loop rests on: it is
 * why the count falls to zero, and why each press waits for its own control to go before the next -
 * pressing one whose editor has not rendered yet would open a fresh empty draft over the entries the
 * walk had already filled.
 */
export async function revealEditors(region: Locator): Promise<void> {
  const revealers = region.locator("[data-draft-revealer]");
  for (let open = await revealers.count(); open > 0; open -= 1) {
    await revealers.first().click();
    await expect(revealers).toHaveCount(open - 1);
  }
}

/**
 * Open every closed disclosure, so the fields behind a `<summary>` are in the population.
 *
 * A disclosure is the other way a field hides, and it is NOT a revealer: the summary stays on screen
 * and toggles, so `revealEditors()`'s "the opener replaces itself" premise is false for it and
 * pressing it in that loop would never reach zero. It is idempotent, so pressing every closed one
 * once leaves the surface with all of its disclosures open.
 */
export async function openDisclosures(region: Locator): Promise<void> {
  const closed = region.locator("details:not([open]) > summary");
  for (let remaining = await closed.count(); remaining > 0; remaining -= 1) await closed.first().click();
}

/**
 * Controls that genuinely must NOT keep a draft, each with the reason it must not.
 *
 * Asserted to be a subset of what the walks found, so an entry here that no longer names a real
 * control fails the run rather than quietly protecting nothing.
 */
export const CONTROL_EXEMPTIONS: Readonly<Record<string, string>> = {
  "input[data-memory-search]":
    "a filter over rows already in hand: it selects nothing and authors nothing, so re-typing it costs one keystroke rather than work",
  "#connection-api-key":
    "a write-only credential the product deliberately does not retain past the attempt; holding it across surfaces would keep a secret in page memory, which is not a decision this gate may make",
  "#ui-language":
    "the interface's own display language: choosing it takes effect immediately and the mount persists it, so there is no unsaved draft - and holding one would leave the interface in one language and the field in another",
  "#voice-output-device":
    "each choice commits through its own mutation the moment it is made, so the projection that comes back IS the draft",
  "#voice-persona":
    "each choice commits through its own mutation the moment it is made, so the projection that comes back IS the draft",
};

/**
 * Openers that reveal a text field without declaring themselves a draft editor, each with the reason.
 *
 * A second table rather than a second meaning for the first one: a control exemption says "this FIELD
 * needs no draft", an opener exemption says "this PRESS opens a field the journey already reaches".
 * The two are found by different walks (the control enumeration and the press-every-opener pass), so
 * an entry in the wrong table would be a claim nothing checks.
 *
 * Every entry is asserted against what the gate really pressed, so an exemption that stops being
 * needed fails the run instead of quietly protecting nothing.
 */
export const OPENER_EXEMPTIONS: Readonly<Record<string, string>> = {
  "button[data-world-book-entry-add]":
    "it adds a ROW to the book the editor already drafts whole, and it stays on screen rather than replacing itself, so it cannot be a revealer: the row's title, summary and keys are the same `characters.world-book-item` draft the row above them is",
};

/**
 * Surfaces this gate does not walk, with the reason.
 *
 * Asserted to be a subset of the app bar's own entries, so a surface that disappears from the product
 * cannot leave a stale exemption behind.
 *
 * The Chats surface used to be listed here: its only text field is a one-shot rename of one existing
 * Chat, answered by Save or Close. What that reason missed is that the field outlives NEITHER the
 * row's own render nor a trip to another surface, and the player types a whole title into it - so the
 * premise moved and the surface is walked like the rest.
 */
export const SURFACE_EXEMPTIONS: Readonly<Record<string, string>> = {
  [catalogue.presetsPanel]:
    "the surface is read-only by design: a preset is imported once and read from then on (design/architecture/tavern-preset-compatibility.md §2.1), so it renders no text field at all - this gate measures 0 - and there is no draft a player could type and lose",
  [catalogue.gamePanel]:
    "every field the Game surface renders is inside its own creation form, which is a disclosure the player opens deliberately and answers with one Create; the creation form's binding id is the one text field there and is gated by game-presentation, not by a draft that outlives a surface",
};

/** The surfaces the retention journey walks, in the order it visits them. */
export const WALKED_SURFACES = [
  { name: "chat", label: catalogue.chatPanel, testId: "chat-surface" },
  { name: "chats", label: catalogue.chatsPanel, testId: "chats-surface" },
  { name: "characters", label: catalogue.charactersPanel, testId: "characters-surface" },
  { name: "settings", label: catalogue.settingsPanel, testId: "settings-surface" },
  { name: "memory", label: catalogue.memoryPanel, testId: "memory-surface" },
] as const;

export type Surface = (typeof WALKED_SURFACES)[number];

/** Open one surface through the app bar the player uses, and return its region. */
export async function openSurface(page: Page, surface: Readonly<{ label: string; testId: string }>): Promise<Locator> {
  await page.getByRole("button", { name: surface.label, exact: true }).click();
  const region = page.getByTestId(surface.testId);
  await expect(region).toBeVisible();
  return region;
}

/** The state a surface needs before the fields this gate is about exist at all. */
export async function prepareSurface(
  page: Page,
  surface: Readonly<{ name: string }>,
  region: Locator,
): Promise<void> {
  void page;
  if (surface.name === "characters") {
    // The companion's performance directive is absent until the player asks for an editor for it:
    // a cleared directive reads as absent rather than as an empty box by design. The disclosure is a
    // DRAFT, so a second mount of this surface arrives with the editor already open and the control
    // that opened it already gone - which is why this is guarded rather than pressed again.
    if ((await region.locator("#character-voice-text").count()) === 0) {
      await region.locator("[data-character-voice-add]").click();
    }
    await expect(region.locator("#character-voice-text")).toBeVisible();
  }
  if (surface.name === "chats") {
    // The list is a READ, and the rename editor lives on a ROW: while the route is still in flight
    // the surface renders no text field and no revealer at all, and the pencil then turns up during
    // the opener walk - reported as an editor nobody declared, although the control carries its own
    // `data-draft-revealer` the whole time. Read on 2026-11-06 from the same tree: one run mounted
    // faster than the route answered and read `chats: pressing button[data-draft-revealer] reveals
    // input[data-testid], which no declared editor reaches` with `onArrival=0`, the next read
    // `input[data-testid] -> declared (on arrival)`. Faster than the route answers is not a surface
    // with no editor: waiting for the row the list renders is the surface's own answer to "do the
    // fields this gate is about exist yet", and no timer has to guess it.
    await expect(region.getByTestId("chat-item").first()).toBeVisible();
  }
  if (surface.name === "memory") {
    // Manual authoring is the one control a player has to open, so the surface reads as the
    // companion's notebook rather than as a form. Guarded for the same reason as above.
    if ((await region.locator("[data-memory-authoring] textarea").count()) === 0) {
      await region.locator("[data-memory-authoring-toggle]").click();
    }
    await expect(region.locator("[data-memory-authoring] textarea")).toBeVisible();
  }
}
