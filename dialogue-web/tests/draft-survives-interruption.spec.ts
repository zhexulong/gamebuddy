import { type Locator, type Page, expect, test } from "@playwright/test";
import { messages } from "../src/i18n";

/**
 * Leaving a surface and coming back costs the player nothing they typed.
 *
 * This is the fourth time the family "player input is destroyed by something the player did not
 * do" has been fixed instance by instance - a refused send (`1af99e73`), a refused memory write, a
 * save that overwrote a draft - and every fix so far named one field. So this file asks the
 * question the family actually poses, of the DOM rather than of a list somebody remembered:
 *
 *   For every control a surface renders that carries the player's own input, put the player's own
 *   value into it, leave for another surface, come back, and require that value to still be there.
 *
 * The population is DISCOVERED, not listed. `discover()` reads the surface region and returns each
 * visible, enabled `textarea`, text-entry `input` and `select`; it repeats until nothing new
 * appears, so a control that only exists once another is answered - the connection form's base URL,
 * which appears once a provider is chosen - is inside the population rather than quietly outside
 * it. A sixth field added to any of these surfaces is covered the day it lands.
 *
 * Each control is then checked ON ITS OWN, on a fresh page, with only the steps that revealed it
 * replayed first. That matters more than it looks: answering one control can hide another (the
 * connection form's `apiKeyRequired` control removes the credential field when it is set to
 * `none`), so a single walk that fills everything at once would report a field missing that the
 * player never lost, and would attribute one control's answer to another's draft.
 *
 * What IS written down is the EXCLUSION list - a control that genuinely must not keep a draft -
 * and it is asserted to be a subset of what the walk found, so an exclusion for a control that no
 * longer exists fails instead of silently protecting nothing.
 *
 * What the interruption is, exactly:
 *
 *  - one surface switch away and one back, through the app bar the player uses. That is the
 *    measured case: `ComposedReferenceGameApp` renders each of these surfaces conditionally
 *    (`shownSurface === …`), so leaving unmounts the whole subtree and every `useState` inside it.
 *    Only the Chat composer survived, and only because its text was lifted into the shell.
 *  - the switch blurs whatever field holds focus. One field here commits on blur - the companion
 *    language tag - so this stub REFUSES that save and keeps answering the value the Host still
 *    holds. That is deliberate, and it is the second half of the family: a draft a failed save eats
 *    is the same defect as a draft a switch eats. A stub that accepted the write would hide it
 *    behind an authority that now agrees with the player.
 *
 * What this file does NOT cover, said plainly rather than implied: a control that only exists after
 * the player acts on one stored row (a Chat's rename, a row's Edit, a chapter correction). Those
 * are one-shot editors, absent from the DOM when the player arrives, and the specs that own them
 * already gate their failing-save behaviour (`memory-authoring-keeps-the-words`,
 * `prompt-addition-refusal-keeps-the-text`, `world-book-conflict-retry`,
 * `failed-send-keeps-the-words`). `prepare()` is how a surface opts such a field INTO this gate.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;
const projectionRevision = `${"M".repeat(42)}A`;

const catalogue = messages("en");

/** The companion-language tag the Host already holds, so a draft that differs from it is visible. */
const STORED_LANGUAGE = "zh-CN";
/** What the player types instead: a tag the Host has never seen, so no projection can produce it. */
const TYPED_LANGUAGE = "ja-JP";
const STORED_ADDITION = "Old words the Host already holds.";

const composedRoot = {
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
      transcript: [],
      draft: { revision: 0, present: false },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision },
    eventStream: null,
  },
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * Two providers, because the connection form renders one field group per entry: the base URL, the
 * credential requirement and the model id only exist once an entry is chosen. Choosing it is part
 * of this gate's walk, not a hand-written field list.
 */
const PROVIDERS = [
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
 * Every route the four surfaces read, plus the one write this gate makes fail.
 *
 * The companion language save is refused with the Host's own conflict code and its re-read answers
 * the value the Host still holds - the exact shape in which the field replaced the player's
 * `ja-JP` with `zh-CN` and looked like it had been accepted.
 */
async function stubShell(page: Page): Promise<{ languageWrites: () => number }> {
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
        chapters: [],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: companionHandle, name: "Nova", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/companions/*/voice", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, profileRevision: 4, characterVoice: null })),
  );
  // The three authored records are PRESENT and non-empty: the stored value is what a silent
  // re-seed puts back, so a field that returns holding the player's text is measurably a draft.
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
  return { languageWrites: () => languageWrites };
}

/**
 * One control the surface rendered, addressed by an expression that survives its own remount.
 *
 * The address is the control's own stable identity - its `id`, else its accessible name, else its
 * `data-testid`, else its first class - so the same expression finds it again after the subtree was
 * destroyed and rebuilt. A control offering none of those cannot be found again at all, and
 * `enumerate()` says so instead of addressing "the third textarea" and silently measuring a field
 * the player never touched.
 */
type DraftControl = Readonly<{ key: string; name: string; tag: "input" | "textarea" | "select" }>;

/** Every `<input type>` that carries something a player typed. A file is not a draft the page holds. */
const TEXT_ENTRY_TYPES = ["text", "search", "url", "email", "password", "tel", "number"];

/** Every visible, enabled control inside `region` that carries the player's own input. */
async function enumerate(region: Locator): Promise<DraftControl[]> {
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

/**
 * Controls that genuinely must NOT keep a draft, each with the reason it must not.
 *
 * Asserted to be a subset of what the walk found, so an entry here that no longer names a real
 * control fails the run rather than quietly protecting nothing.
 */
const EXCLUSIONS: Readonly<Record<string, string>> = {
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
 * Surfaces this gate does not walk, with the reason.
 *
 * Asserted to be a subset of the app bar's own entries, so a surface that disappears from the
 * product cannot leave a stale exemption behind.
 */
const EXCLUDED_SURFACES: Readonly<Record<string, string>> = {
  [catalogue.gamePanel]:
    "every field on the Game surface commits as it is changed (the thinking level, the co-op floor, the window mode), and the rest belongs to a creation form the player opens deliberately",
  [catalogue.chatsPanel]:
    "the only text field is a one-shot rename of one existing Chat, opened deliberately on its row and answered by Save or Close",
};

/** The four surfaces this gate walks, in the order it visits them. */
const SURFACES = [
  { name: "chat", label: catalogue.chatPanel, testId: "chat-surface" },
  { name: "characters", label: catalogue.charactersPanel, testId: "characters-surface" },
  { name: "settings", label: catalogue.settingsPanel, testId: "settings-surface" },
  { name: "memory", label: catalogue.memoryPanel, testId: "memory-surface" },
] as const;

type Surface = (typeof SURFACES)[number];

/** One distinct value per control, so a restored neighbour's text can never pass for this one's. */
const SENTINEL_PREFIX = "SENTINEL-of";

/**
 * The player's own value for one control, put there the way they would.
 *
 * Returns what the field now holds, which is what the switch has to preserve - a `select` clamps to
 * the options it has, and a `maxLength` may clamp a long sentinel, so the expectation is read back
 * from the DOM rather than assumed.
 */
async function typeInto(region: Locator, control: DraftControl, position: number): Promise<string> {
  const field = region.locator(control.key);
  if (control.tag === "select") {
    // The choice furthest from what is already selected, so it can never be mistaken for a value
    // the panel preselected on its own.
    const options = await field.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== ""),
    );
    const current = await field.inputValue();
    const choice = [...options].reverse().find((value) => value !== current);
    if (choice === undefined) throw new Error(`${control.key} offers no choice other than ${current}`);
    await field.selectOption(choice);
    return await field.inputValue();
  }
  // The language tag is the one field whose typed value the Host also has an opinion about, and the
  // one whose save this stub refuses - so its sentinel is a tag no projection could return.
  const sentinel =
    control.key === "#companion-language"
      ? TYPED_LANGUAGE
      : `${SENTINEL_PREFIX}-${control.name.replace(/\s+/gu, "-")}-${position + 1}`;
  await field.fill(sentinel);
  return await field.inputValue();
}

/** One control, and the value the player put into it. */
type Filled = Readonly<{ control: DraftControl; value: string }>;

/**
 * Fill every control the surface renders, to a fixed point.
 *
 * The walk repeats until nothing new appears: the connection form's base URL and its model field
 * exist only after a provider is chosen, and a single pass would leave every such field outside the
 * population - which is the silent narrowing this gate exists to avoid. Each control gets its own
 * distinct value, read back from the DOM (a `select` clamps to its options), so the check after the
 * switch compares each field against what that field really held.
 */
async function fillEverything(region: Locator): Promise<Filled[]> {
  const filled = new Map<string, Filled>();
  for (;;) {
    const fresh = [...(await enumerate(region)).filter((control) => !filled.has(control.key))];
    if (fresh.length === 0) return [...filled.values()];
    for (const control of fresh) {
      // An excluded control is recorded (so the exclusion list can be checked against what really
      // exists) but never typed into: `#ui-language` would change the interface's language out from
      // under the walk, and the credential is a secret this gate does not keep.
      if (EXCLUSIONS[control.key] !== undefined) {
        filled.set(control.key, { control, value: "" });
        continue;
      }
      // Answering an earlier control in this same batch can hide this one (the connection form's
      // credential requirement removes the credential field), so presence is re-checked rather
      // than assumed from the enumeration that found it.
      if ((await region.locator(control.key).count()) !== 1) continue;
      filled.set(control.key, { control, value: await typeInto(region, control, filled.size) });
    }
  }
}

async function open(page: Page, surface: Surface): Promise<Locator> {
  await page.getByRole("button", { name: surface.label, exact: true }).click();
  const region = page.getByTestId(surface.testId);
  await expect(region).toBeVisible();
  return region;
}

/** The state a surface needs before the fields this gate is about exist at all. */
async function prepare(page: Page, surface: Surface, region: Locator): Promise<void> {
  void page;
  if (surface.name === "characters") {
    // The companion's performance directive is absent until the player asks for an editor for it:
    // a cleared directive reads as absent rather than as an empty box by design.
    await region.locator("[data-character-voice-add]").click();
    await expect(region.locator("#character-voice-text")).toBeVisible();
  }
  if (surface.name === "memory") {
    // Manual authoring is the one control a player has to open, so the surface reads as the
    // companion's notebook rather than as a form.
    await region.locator("[data-memory-authoring-toggle]").click();
    await expect(region.locator("[data-memory-authoring] textarea")).toBeVisible();
  }
}

test.describe("a draft survives the player leaving its surface and coming back", () => {
  for (const [index, surface] of SURFACES.entries()) {
    const next = SURFACES[(index + 1) % SURFACES.length]!;
    test.setTimeout(180_000);

    test(`${surface.name}: every field the surface renders keeps what the player put there`, async ({ page }) => {
      const stub = await stubShell(page);

      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      await expect(page.getByTestId("chat-surface")).toBeVisible();

      // The app bar's own entries are what the surface exemptions are asserted against: a surface
      // this gate does not walk must still be a surface the product offers.
      const entries = await page
        .locator(".app-bar-actions .nav-button")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
      for (const [label, reason] of Object.entries(EXCLUDED_SURFACES)) {
        expect(entries, `an excluded surface (${reason}) is still one the bar offers`).toContain(label);
      }
      for (const walked of SURFACES) {
        expect(entries, `the bar offers the ${walked.name} surface this gate walks`).toContain(walked.label);
      }

      const region = await open(page, surface);
      await prepare(page, surface, region);
      expect((await enumerate(region)).length, `${surface.name} renders fields this gate is about`).toBeGreaterThan(0);
      const typed = (await fillEverything(region)).filter((entry) => EXCLUSIONS[entry.control.key] === undefined);      expect(typed.length, `${surface.name} has fields this gate requires a draft from`).toBeGreaterThan(0);

      // The interruption, exactly as a player performs it: this surface is unmounted, another one
      // takes the region, and then this one comes back.
      await open(page, next);
      const returned = await open(page, surface);

      const failures: string[] = [];
      const readings: { key: string; typed: string; back: string | null }[] = [];
      for (const { control, value } of typed) {
        const back = returned.locator(control.key);
        /*
         * Auto-retrying assertions, not one-shot reads: the returning surface re-reads its
         * projections on mount, and a field that only renders once its read lands (the persona
         * editor while the record is still loading) would otherwise be reported lost a moment
         * before it is drawn. The wait cannot hide a real loss: what it settles on is the value
         * the field holds afterwards.
         */
        const present = await back
          .first()
          .waitFor({ state: "attached", timeout: 5_000 })
          .then(() => true)
          .catch(() => false);
        if (!present) {
          readings.push({ key: control.key, typed: value, back: null });
          failures.push(`${control.key} (${control.name}) is gone after the switch`);
          continue;
        }
        const held = await back.inputValue();
        readings.push({ key: control.key, typed: value, back: held });
        if (held !== value) failures.push(`${control.key} (${control.name}) came back as ${JSON.stringify(held)}`);
      }

      console.log(
        `MEASURE ${surface.name}: typed=${typed.length} lost=${failures.length} ${JSON.stringify({ failures, readings })}`,
      );
      expect(failures, `every value put into ${surface.name} survived the switch and the way back`).toEqual([]);

      if (surface.name === "settings") {
        // The language tag commits on blur, so leaving the surface attempted that write. It was
        // refused, and it is the refused text - not the stored `zh-CN` - that must come back.
        expect(stub.languageWrites(), "a language save the switch attempted was refused, not accepted").toBeGreaterThan(
          0,
        );
      }
    });
  }
});

test("the exclusion list names controls that really exist", async ({ page }) => {
  test.setTimeout(180_000);
  await stubShell(page);
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();

  const found = new Set<string>();
  for (const surface of SURFACES) {
    const region = await open(page, surface);
    await prepare(page, surface, region);
    for (const { control } of await fillEverything(region)) found.add(control.key);
  }

  const stale = Object.keys(EXCLUSIONS).filter((key) => !found.has(key));
  console.log(
    `MEASURE exclusions: found=${found.size} excluded=${Object.keys(EXCLUSIONS).length} stale=${JSON.stringify(stale)}`,
  );
  expect(
    stale,
    "every exclusion names a control the enumeration found - an exclusion for a control that no longer exists protects nothing",
  ).toEqual([]);
  for (const [key, reason] of Object.entries(EXCLUSIONS)) {
    expect(reason.length, `the exclusion for ${key} states a reason`).toBeGreaterThan(0);
  }
});
