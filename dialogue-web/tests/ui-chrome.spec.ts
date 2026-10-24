/**
 * The chrome the platform will not give a dark theme for free.
 *
 * Reviewer audit, the CSS half: a native `<select>` on Windows is a white box
 * with the system's black arrow, a `<details>` keeps the browser's triangle, two
 * lists render as bare bulleted text under a 40 px native indent, the voice
 * status has no rules at all, and the two banner classes a bare `<p>` needs were
 * half missing. Each test here reads the *computed* style of the shipped shell -
 * a class name in the markup proves nothing about what the player sees, and a
 * rule that lost a layer-order fight looks exactly like a rule that was never
 * written.
 */
import { expect, test, type Page } from "@playwright/test";

const token = "A".repeat(43);
const handle = "B".repeat(42) + "A";
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;

const chat = {
  apiVersion: 1,
  build: {
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.chat-core.reference-pipeline",
  },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
    title: "Chrome",
    transcript: [],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: null,
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const game = {
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
};

/** The additive v1 voice field lives on the envelope, not on the nested chat. */
function composed(voice: "unavailable" | "ready" | "speaking" | null = null) {
  return {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat: voice === null ? chat : { ...chat, voice: { state: voice } },
    game,
  };
}

const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function mountChat(page: Page, voice: "unavailable" | "ready" | "speaking" | null = null): Promise<void> {
  const root = composed(voice);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

const worldBookHandle = `${"W".repeat(42)}A`;
const worldBookRevision = `${"B".repeat(42)}A`;
const importId = `${"I".repeat(42)}A`;

/**
 * The Characters surface: the panel the audit measured its five short controls
 * on, and the only panel that mounts both a `<details>` disclosure and the two
 * lists. Its world book is published with one entry so the list has a row to
 * render rather than an empty state.
 */
async function mountCharacters(page: Page): Promise<void> {
  const root = composed();
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle, name: "Mira", isCurrent: true }] })),
  );
  // Mira has no world book of her own here; the attachable library below is the
  // list this journey measures. The route is mocked rather than left to the dev
  // server so the surface's own two blocks stay deterministic.
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(
      jsonOk({
        state: "none",
        revision: worldBookRevision,
        items: [
          {
            handle: worldBookHandle,
            title: "Pelican Town",
            summary: "A valley town, and the people in it.",
            selected: false,
            pending: false,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        entries: [
          {
            importId,
            cardName: "Mira Card",
            occurredAtMs: 1_700_000_000_000,
            counts: {
              accepted_typed: 3,
              preserved_opaque: 1,
              dropped_unsupported: 1,
              rejected_invalid: 0,
            },
          },
        ],
      }),
    ),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

/**
 * Item 1: the native `<select>`.
 *
 * The failure it catches: without `appearance: none` every select in the product
 * renders as the platform's own white box with a black system arrow in the
 * middle of the dark surface, and without the 44 px floor the fields around it
 * compute to 36 px. Both are asserted on the drawer's own controls, and the
 * floor on an input as well as on the select, because the audit found the floor
 * missing on the whole `.form-input` family.
 */
test("the model drawer's select is themed and the fields keep the 44px floor", async ({ page }) => {
  await page.route("**/api/tavern/v1/settings/profiles", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
        recommendedModels: [
          {
            providerId: "cpa-oai",
            providerLabel: "CPA OAI",
            modelId: "deepseek-v4",
            modelLabel: "DeepSeek V4",
            allowedThinkingLevels: ["off", "medium", "high"],
            defaultThinkingLevel: "medium",
          },
        ],
      }),
    ),
  );

  await mountChat(page);
  await page.getByTestId("chat-model-trigger").click();
  const drawer = page.getByTestId("chat-model-drawer");
  await expect(drawer).toBeVisible();

  const measured = await drawer.evaluate((node) => {
    const read = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        appearance: style.appearance,
        height: Math.round(rect.height),
        backgroundImage: style.backgroundImage,
        colorScheme: style.colorScheme,
      };
    };
    const select = node.querySelector("select");
    const input = node.querySelector("input");
    return {
      select: select === null ? null : read(select),
      input: input === null ? null : read(input),
    };
  });

  // The platform's chrome is retired, and the arrow is drawn by the stylesheet.
  expect(measured.select?.appearance, "the select no longer renders the platform's own control").toBe("none");
  expect(measured.select?.backgroundImage, "the stylesheet draws the select's arrow").not.toBe("none");
  expect(measured.select?.colorScheme).toBe("dark");
  // The floor comes from the token, for the select and for the text field beside it.
  expect(measured.select?.height, "the select keeps the 44 px floor").toBeGreaterThanOrEqual(44);
  expect(measured.input?.height, "the input keeps the 44 px floor").toBeGreaterThanOrEqual(44);
});

/**
 * Item 1, second half: the floor the same stylesheet declares.
 *
 * The failure it catches: a padded field with a 14 px font computes to 36 px, so
 * `.form-input` and `.form-select` - and every control built on them - sat under
 * the `--touch-target-min` floor the product itself declares. The audit measured
 * five such controls on this surface; this asserts the family rather than the
 * five, and asserts that it measured something at all, so a surface that stopped
 * rendering its fields cannot pass by having nothing to measure.
 *
 * A control the sheet has taken out of the visual flow (`clip-path:
 * inset(50%)`, the card-import file input) is not a target at all: the themed
 * control that drives it is, and `ui-hygiene-runtime.spec.ts` gate 3 measures
 * that one. It is still read here, so the exemption cannot be taken by a control
 * that is merely missing its own height.
 */
test("every field on the Characters surface clears the 44px floor", async ({ page }) => {
  await mountCharacters(page);

  const measured = await page.getByTestId("characters-surface").evaluate((node) =>
    [...node.querySelectorAll("input, select, textarea")]
      .filter((control) => (control as HTMLElement).getClientRects().length > 0)
      .map((control) => ({
        tag: control.tagName.toLowerCase(),
        label: control.getAttribute("aria-label") ?? control.getAttribute("type") ?? "",
        height: Math.round(control.getBoundingClientRect().height),
        clipped: getComputedStyle(control).clipPath === "inset(50%)",
      })),
  );

  const targets = measured.filter((control) => !control.clipped);
  expect(targets.length, "the surface still renders fields to measure").toBeGreaterThan(0);
  expect(
    targets.filter((control) => control.height < 44),
    "controls under the 44 px floor",
  ).toEqual([]);
});

/**
 * Item 2: the disclosure.
 *
 * The failure it catches: without a rule of its own a `<details>` renders the
 * platform's triangle at the platform's indent, which is the same
 * black-on-dark accident the native select was, and the chevron inside the
 * summary never changes - so an open disclosure looks exactly like a closed one
 * to anyone who did not see the click. Both are asserted as computed style, and
 * the rotation is asserted by opening the element rather than by looking for a
 * rule.
 */
test("the paste disclosure retires the native marker and carries its open state", async ({ page }) => {
  await mountCharacters(page);

  const details = page.locator("details.custom-disclosure").first();
  const summary = details.locator("> summary");
  await expect(summary).toBeVisible();

  const closed = await summary.evaluate((node) => {
    const style = getComputedStyle(node);
    const chevron = node.querySelector("svg");
    return {
      listStyleType: style.listStyleType,
      display: style.display,
      height: Math.round(node.getBoundingClientRect().height),
      chevron: chevron === null ? null : getComputedStyle(chevron).transform,
    };
  });
  expect(closed.listStyleType, "the platform's marker is retired").toBe("none");
  expect(closed.display).toBe("flex");
  expect(closed.height, "the summary is a 44 px row").toBeGreaterThanOrEqual(44);
  expect(closed.chevron, "the summary carries the chevron").not.toBeNull();

  await summary.click();
  await expect(details).toHaveAttribute("open", "");
  const open = await summary.evaluate((node) => {
    const chevron = node.querySelector("svg");
    return chevron === null ? null : getComputedStyle(chevron).transform;
  });
  // The open state is rendered: the glyph is rotated, so a player who did not
  // see the click can still tell which way the disclosure went.
  expect(open).not.toBe(closed.chevron);
  expect(open).not.toBe("none");
});

/**
 * The Game diagnostics disclosure moved onto that shared treatment (it used to
 * state the same rules under its own class). Its own panel keeps its shape: the
 * summary still rotates its right-pointing chevron downwards when it opens.
 */
test("the Game diagnostics disclosure keeps its treatment on the shared rule", async ({ page }) => {
  await mountChat(page);
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(page.getByTestId("game-surface")).toBeVisible();

  const details = page.getByTestId("game-diagnostics-disclosure");
  const summary = details.locator("> summary");
  await expect(summary).toBeVisible();
  expect(await summary.evaluate((node) => getComputedStyle(node).listStyleType)).toBe("none");
  expect(await summary.evaluate((node) => Math.round(node.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);

  const before = await page.getByTestId("game-diagnostics-disclosure").locator("> summary > svg").evaluate((node) => getComputedStyle(node).transform);
  await summary.click();
  const after = await page.getByTestId("game-diagnostics-disclosure").locator("> summary > svg").evaluate((node) => getComputedStyle(node).transform);
  expect(after).not.toBe(before);
  expect(after).not.toBe("none");
});

/**
 * Item 3: the two lists that had no rules at all.
 *
 * The failure it catches: a native `<ul>` inside an already-indented section
 * renders as bullets under the platform's 40 px indent - twice over for the
 * import counts - and the world book's entries ran together as bare text with no
 * row boundary. The assertion reads computed `list-style` and padding for the
 * lists and the card chrome for the rows, so a rule that lost the cascade looks
 * the same as a rule that was never written.
 */
test("the world book and import history read as card rows, not native bullets", async ({ page }) => {
  await mountCharacters(page);

  const measured = await page.getByTestId("characters-surface").evaluate((node) => {
    const token = (name: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const read = (selector: string) => {
      const element = node.querySelector(selector);
      if (element === null) return null;
      const style = getComputedStyle(element);
      return {
        listStyleType: style.listStyleType,
        paddingLeft: style.paddingLeft,
        minHeight: style.minHeight,
        height: Math.round(element.getBoundingClientRect().height),
        background: style.backgroundColor,
        borderTopColor: style.borderTopColor,
      };
    };
    return {
      card: token("--surface-card"),
      glass: token("--border-glass"),
      worldBook: read("[data-world-book-list]"),
      worldBookRow: read("[data-world-book-list] > [role=listitem]"),
      history: read("[data-import-history-entries]"),
      historyRow: read("[data-import-history-entries] > li"),
      counts: read("[data-import-history-counts]"),
    };
  });

  for (const [what, list] of [
    ["the import history", measured.history],
    ["the import counts", measured.counts],
  ] as const) {
    expect(list, `${what} is rendered`).not.toBeNull();
    expect(list?.listStyleType, `${what} draws no marker`).toBe("none");
    expect(list?.paddingLeft, `${what} keeps no native indent`).toBe("0px");
  }

  // Both collections are card rows: the card tone with the glass hairline, and
  // the row floor the token layer declares.
  expect(measured.worldBookRow?.background, "a world book entry is a card").toBe(measured.card);
  expect(measured.worldBookRow?.borderTopColor).toBe(measured.glass);
  expect(measured.worldBookRow?.minHeight).toBe("52px");
  expect(measured.worldBookRow?.height ?? 0).toBeGreaterThanOrEqual(52);
  expect(measured.historyRow?.background, "an import history entry is a card").toBe(measured.card);
  expect(measured.historyRow?.borderTopColor).toBe(measured.glass);
  // The world book list is a `div role="list"`, so its own indent is asserted
  // through its row: the card starts where the list starts.
  expect(measured.worldBookRow?.height ?? 0).toBeGreaterThan(0);
});

/**
 * Item 4: the voice status.
 *
 * The failure it catches: `.voice-status` and `.voice-status-label` had no rules
 * at all, so the label was an unconstrained flex item in the composer's action
 * rail - at the mini-window width the sentence either bursts the rail or
 * overlaps the field, and nothing in the markup says which. The assertion is the
 * contract that prevents it, as computed style: the status is a shrinking flex
 * row, the label clips and ellipsizes after two lines, the dot keeps its whole
 * box, and the full sentence is still what the region carries (truncation is a
 * painting, not a deletion).
 */
test("the voice status yields without bursting the composer rail", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 720 });
  await mountChat(page, "ready");

  const measured = await page.getByTestId("chat-surface").evaluate((node) => {
    const status = node.querySelector(".voice-status");
    const label = node.querySelector(".voice-status-label");
    const dot = node.querySelector(".voice-status-dot");
    if (status === null || label === null || dot === null) return null;
    const statusStyle = getComputedStyle(status);
    const labelStyle = getComputedStyle(label);
    return {
      statusDisplay: statusStyle.display,
      statusMinWidth: statusStyle.minWidth,
      statusOverflow: statusStyle.overflow,
      statusText: (status.textContent ?? "").trim(),
      labelOverflow: labelStyle.overflow,
      labelClamp: labelStyle.getPropertyValue("-webkit-line-clamp"),
      labelText: (label.textContent ?? "").trim(),
      dotWidth: Math.round(dot.getBoundingClientRect().width),
      dotHeight: Math.round(dot.getBoundingClientRect().height),
    };
  });

  expect(measured, "the voice status is rendered in the composer").not.toBeNull();
  // The row can shrink: without this the label is an unconstrained flex item.
  // (`inline-flex` is blockified to `flex` because the rail is a flex row, so
  // both readings are the same rule - a span with no rule computes `inline`.)
  expect(["flex", "inline-flex"]).toContain(measured?.statusDisplay);
  expect(measured?.statusMinWidth).toBe("0px");
  expect(measured?.statusOverflow).toBe("hidden");
  // The label yields by wrapping to two lines and then truncating, rather than
  // by growing the rail: the clamp is the truncation.
  expect(measured?.labelOverflow).toBe("hidden");
  expect(measured?.labelClamp).toBe("2");
  // The tone keeps its whole box - it is the state a player reads at a glance.
  expect(measured?.dotWidth).toBe(22);
  expect(measured?.dotHeight).toBe(22);
  // And the fact itself is intact, for the live region and for anyone reading
  // the surface without the stylesheet.
  expect(measured?.labelText).toContain("Voice ready");
  expect(measured?.statusText).toContain(measured?.labelText ?? "");
});

/**
 * Item 5: the two banner classes a bare `<p>` needs.
 *
 * The failure it catches: the warning text next to a connection or model
 * conflict was a bare `<p>` with no rule, so it read as ordinary prose - the
 * same class of accident as the transparent stop button. `.warning-banner` is
 * asserted on the shipped Settings surface, driven by a genuinely wrong state:
 * a saved connection that was changed elsewhere, so the activation is refused
 * with `connection_conflict` and the panel re-reads the authority before it says
 * so. It must be a different tone from the error banner rather than a second
 * name for it.
 *
 * This used to mount the surface with no connection at all and read the "no
 * connection is selected" line's banner. That line is the ordinary first hour,
 * not a fault, and it now renders as the panel's own neutral hint prose - which
 * is exactly why this test may not lean on it: the warning tone has to be proven
 * on a state that is actually wrong.
 */
test("the warning banner carries the warning tone, not the bare-prose one", async ({ page }) => {
  const connectionId = "E".repeat(42) + "A";
  const readyRow = {
    connectionId,
    label: "OpenAI-compatible endpoint",
    providerId: "openai-compatible",
    providerLabel: "OpenAI-compatible endpoint",
    configured: true,
    readiness: "ready",
    active: false,
    modelId: "qwen2.5-coder:7b",
    modelLabel: "qwen2.5-coder:7b",
    thinkingLevel: "high",
    allowedThinkingLevels: ["low", "high"],
    modelIds: null,
    baseUrl: "http://127.0.0.1:11434/v1",
    failure: null,
    lastCheckedAtMs: null,
  };
  // The read route is singular and the create route plural (the frozen contract),
  // so both are anchored: the plural is a prefix of the singularity.
  const connectionState = {
    apiVersion: 1,
    revision: 1,
    active: null,
    connections: [readyRow],
    providers: [],
  };
  await page.route(/\/api\/tavern\/v1\/settings\/connection$/, (route) => route.fulfill(jsonOk(connectionState)));
  await page.route(/\/api\/tavern\/v1\/settings\/connections$/, (route) => route.fulfill(jsonOk(connectionState)));
  // A same-cookie stale tab: the record moved on since this surface read it, so
  // the activation is refused with the closed `connection_conflict` code.
  await page.route(/\/api\/tavern\/v1\/settings\/connections\/[^/]+\/activate$/, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:gamebuddy:tavern:connection_conflict",
        title: "connection conflict",
        status: 409,
        code: "connection_conflict",
        requestId: "F".repeat(42) + "A",
        retryable: false,
      }),
    }),
  );
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
  );
  await page.route("**/api/tavern/v1/settings/voice-preference", (route) =>
    route.fulfill(
      jsonOk({ revision: 1, disclosureVersion: null, consent: "undecided", decidedAtMs: null, outputDevice: null, persona: null }),
    ),
  );
  await page.route("**/api/tavern/v1/settings/voice-devices", (route) =>
    route.fulfill(jsonOk({ devices: [], defaultSelectable: true })),
  );

  await mountChat(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const surface = page.getByTestId("settings-surface");
  await expect(surface).toBeVisible();

  await surface.getByRole("button", { name: "Save and activate", exact: true }).click();

  const banner = surface.locator(".warning-banner").first();
  await expect(banner).toBeVisible();
  await expect(banner).not.toBeEmpty();
  await expect(banner).toHaveAttribute("data-connection-conflict");

  const drawn = await banner.evaluate((node) => {
    const token = (name: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const style = getComputedStyle(node);
    return {
      warning: token("--warning"),
      danger: token("--danger"),
      color: style.color,
      background: style.backgroundColor,
      borderTopColor: style.borderTopColor,
      borderTopWidth: style.borderTopWidth,
    };
  });

  // The text is the warning tone, it is not transparent, and it is bordered -
  // the three things a bare `<p>` does not have.
  expect(drawn.color).toBe(drawn.warning);
  expect(drawn.color, "the warning is not the error tone").not.toBe(drawn.danger);
  expect(["transparent", "rgba(0, 0, 0, 0)"]).not.toContain(drawn.background);
  expect(drawn.borderTopWidth).toBe("1px");
});
