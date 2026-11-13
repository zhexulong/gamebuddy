import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "./frontend-coverage";
import { messages } from "../src/i18n";

/** The labels the mounted shell reads, in the locale `playwright.config.ts` pins. */
const labels = messages("en");

/**
 * The installation panel's actions sit behind the panel's own scrollbar.
 *
 * `AGENTS.md` names this defect family: "a container must not put its primary
 * action controls behind its own scroll" / "first-viewport reachability: primary
 * action controls must remain fully visible within the baseline viewport
 * (including mobile 400x800) without requiring container scroll". The panel was
 * `max-height: min(32dvh, 300px); overflow-y: auto` with its three navigation
 * controls as the last child, so the cap cut exactly them: measured at 400x800,
 * `candidates` with one installation left 取消 26 px below the panel's own bottom
 * edge and `mod-loader-missing` left 帮我安装 SMAPI 165 px below it. The player
 * had to scroll inside a 256 px box to reach the controls that close it.
 *
 * The gate below is the invariant, not the repair: it enumerates the panel's
 * action controls from the DOM, drives every state the panel's own type union
 * declares, and asserts the controls are not clipped by any scroll container
 * between themselves and the panel - including one nobody thought of. A state
 * population is derived from `InstallationDiscoveryState` rather than written
 * down here, so a state added to the union that this gate does not drive fails
 * by name instead of being silently skipped.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const handle = "B".repeat(42) + "A";
const candidateId = "Q".repeat(22);

/** The roots the shell reads; the Game surface's own blocks are irrelevant here. */
const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs: 1_900_000_000_000 },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: handle, generation: 1, stateRevision: handle },
    chat: {
      companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: "Reference Game Chat",
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
    browserSession: { expiresAtMs: 1_900_000_000_000 },
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BOOTSTRAP_ROUTE = "**/api/composed-reference-game/v1/bootstrap";
const STATE_ROUTE = "**/api/composed-reference-game/v1/state";
const DRAFT_ROUTE = "**/api/tavern/v1/draft";
const CABINS_ROUTE = "**/api/composed-reference-game/v1/game/stardew/cabins";
const PROFILES_ROUTE = "**/api/tavern/v1/settings/profiles";
const DISCOVERY_ROUTE = "**/api/composed-reference-game/v1/game/installation/discovery";
const CONFIRM_ROUTE = `${DISCOVERY_ROUTE}/confirm`;
const RETRY_ROUTE = `${DISCOVERY_ROUTE}/retry`;
const CANCEL_ROUTE = `${DISCOVERY_ROUTE}/cancel`;
const PICKER_ROUTE = `${DISCOVERY_ROUTE}/manual-picker`;
const SMAPI_ROUTE = "**/api/composed-reference-game/v1/game/prerequisites/smapi";

const panel = (page: Page) => page.locator(".game-installation-panel");

/**
 * Every member of `InstallationDiscoveryState`, read from the union itself.
 *
 * The type is the authority for "every state the panel can be in"; a hand-written
 * list here would silently stop covering a state someone adds to it.
 */
function declaredInstallationStates(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../src/game-presentation.ts", import.meta.url)), "utf8")
    // The union's own members carry prose between them, and that prose contains the
    // punctuation a naive capture would stop on; the members are the quoted literals.
    .replace(/\/\/[^\n]*/gu, "");
  const union = /export type InstallationDiscoveryState =([\s\S]*?);/u.exec(source)?.[1];
  if (union === undefined) throw new Error("InstallationDiscoveryState is not declared in game-presentation.ts");
  const states = [...union.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
  if (states.length === 0) throw new Error("InstallationDiscoveryState declared no members");
  return states;
}

/**
 * The states nothing in the product produces, each with the reason it cannot be
 * driven. `not_configured` and `expired` are in the union but no route answers
 * with them and no control sets them, so a scenario for either would be theatre.
 */
const UNREACHABLE: Readonly<Record<string, string>> = {
  "not_configured":
    "the panel mounts in `loading` and its first read always starts; no route answers with it",
  expired: "nothing in the shipped Host expires a discovery result",
};

/** One candidate row, in the status a production reply carries. */
const candidate = (id: string, location: string | null = null) => ({
  candidateId: id,
  source: "steam-vdf",
  label: "Stardew Valley",
  hint: "Detected installation (path hidden)",
  status: "admission_required",
  ...(location === null ? {} : { location }),
});

/**
 * The ids a multi-installation machine would report.
 *
 * They are the wire's own shape - 22 canonical unpadded base64url characters, which
 * means the last character carries only four significant bits - so a handle this gate
 * invents has to end on one of the sixteen characters whose low two bits are clear.
 * An id that is merely 22 characters long is refused by the panel's own reply
 * validator, which would make this gate measure `result-unavailable` while believing
 * it was measuring a list of installations.
 */
const MANY = ["Q".repeat(22), "A".repeat(22), "AQ".repeat(11), "BA".repeat(11), `${"C".repeat(21)}A`];

type DiscoveryAnswer =
  | { kind: "body"; body: unknown }
  | { kind: "delay"; delayMs: number; body: unknown }
  | { kind: "status"; status: number; body: unknown };

/** The mutable answers every route reads, so one page can be reloaded per state. */
type Answers = {
  discovery: DiscoveryAnswer;
  confirm: DiscoveryAnswer;
  retry: DiscoveryAnswer;
  cancel: DiscoveryAnswer;
  picker: DiscoveryAnswer;
  smapi: DiscoveryAnswer;
  /** What the discovery route answers after a registration; `null` leaves it alone. */
  afterRegistration: unknown | null;
};

/**
 * A scenario names the state it drives, the Host answers that get there, and the
 * panel controls pressed after the mount.
 */
type Scenario = Readonly<{
  name: string;
  state: string;
  discovery: DiscoveryAnswer;
  confirm?: DiscoveryAnswer;
  retry?: DiscoveryAnswer;
  cancel?: DiscoveryAnswer;
  smapi?: DiscoveryAnswer;
  afterRegistration?: unknown;
  clicks?: readonly string[];
}>;

const body = (value: unknown): DiscoveryAnswer => ({ kind: "body", body: value });
const delayed = (value: unknown, delayMs = 30_000): DiscoveryAnswer => ({ kind: "delay", delayMs, body: value });

const SCENARIOS: readonly Scenario[] = [
  { name: "searching", state: "loading", discovery: delayed({ apiVersion: 1, candidates: [], diagnostics: [] }) },
  {
    name: "nothing found",
    state: "no-candidates",
    discovery: body({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] }),
  },
  {
    name: "a source could not be read",
    state: "source-unavailable",
    discovery: body({ apiVersion: 1, candidates: [], diagnostics: ["registry-unavailable"] }),
  },
  {
    // The copy Game Pass players have, in the folder the Xbox app installs without mod support: a
    // diagnostic that names a game the player owns, and the reason the panel has a state of its own
    // for it. It arrives the way the Host really sends it - beside `no-candidates`, because the
    // channel offered no row (`windows-stardew-installation-discovery/provider.ts`).
    name: "a Store copy that cannot load mods",
    state: "install-cannot-load-mods",
    discovery: body({
      apiVersion: 1,
      candidates: [],
      diagnostics: ["microsoft-store-install-not-mod-enabled", "no-candidates"],
    }),
  },
  {
    name: "one installation found",
    state: "candidates",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
  },
  {
    name: "confirming an installation",
    state: "confirming",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: delayed({ apiVersion: 1, status: "registered" }),
    clicks: [labels.gameInstallationConfirm],
  },
  {
    name: "searching again",
    state: "retrying",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    retry: delayed({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] }),
    clicks: [labels.gameInstallationFindAgain],
  },
  {
    name: "search abandoned",
    state: "cancelled",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    cancel: body({ apiVersion: 1, status: "cancelled" }),
    clicks: [labels.gameResumeCancel],
  },
  {
    name: "reply this build cannot read",
    state: "result-unavailable",
    discovery: body({ apiVersion: 1, candidates: [{ candidateId: "bad", source: "steam" }] }),
  },
  {
    name: "search refused",
    state: "error",
    discovery: { kind: "status", status: 409, body: { code: "state_unavailable" } },
  },
  {
    name: "installation without a mod loader",
    state: "mod-loader-missing",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: body({ apiVersion: 1, status: "mod_loader_missing" }),
    clicks: [labels.gameInstallationConfirm],
  },
  {
    name: "chosen folder is not Stardew",
    state: "not-stardew-installation",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: body({ apiVersion: 1, status: "not_stardew_installation" }),
    clicks: [labels.gameInstallationConfirm],
  },
  {
    name: "folder reached through a shortcut",
    state: "reparse-point",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: body({ apiVersion: 1, status: "reparse_point" }),
    clicks: [labels.gameInstallationConfirm],
  },
  {
    name: "registration refused without a cause",
    state: "selection-unavailable",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: body({ apiVersion: 1, status: "unavailable" }),
    clicks: [labels.gameInstallationConfirm],
  },
  {
    name: "installation registered",
    state: "confirmed",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: body({ apiVersion: 1, status: "registered" }),
    afterRegistration: { apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] },
    clicks: [labels.gameInstallationConfirm],
  },
  {
    name: "mod loader installed, with the Steam launch option",
    state: "confirmed",
    discovery: body({ apiVersion: 1, candidates: [candidate(candidateId)], diagnostics: [] }),
    confirm: body({ apiVersion: 1, status: "mod_loader_missing" }),
    smapi: body({ apiVersion: 1, status: "installed", steamLaunchOption: '"D:\\Games\\Stardew Valley\\StardewModdingAPI.exe" %command%' }),
    afterRegistration: { apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] },
    clicks: [labels.gameInstallationConfirm],
  },
];

/** Answers that only the many-installation scenario needs. */
const MANY_SCENARIO: Scenario = {
  name: "five installations found",
  state: "candidates",
  discovery: body({ apiVersion: 1, candidates: MANY.map((id) => candidate(id)), diagnostics: [] }),
};

async function mountRoutes(page: Page, answers: Answers): Promise<void> {
  const fulfil = async (route: import("@playwright/test").Route, answer: DiscoveryAnswer) => {
    if (answer.kind === "delay") await sleep(answer.delayMs);
    const payload =
      answer.kind === "status"
        ? { status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) }
        : jsonOk(answer.body);
    await route.fulfill(payload).catch(() => undefined);
  };

  await page.route(BOOTSTRAP_ROUTE, (route) => route.fulfill(jsonOk(root)));
  await page.route(STATE_ROUTE, (route) => route.fulfill(jsonOk(root)));
  await page.route(DRAFT_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })));
  await page.route(CABINS_ROUTE, (route) => route.fulfill(jsonOk({ apiVersion: 1, choices: [] })));
  await page.route(PROFILES_ROUTE, (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: { revision: 1, thinkingLevel: "medium" },
        game: { revision: 1, thinkingLevel: "medium" },
        recommendedModels: [],
      }),
    ),
  );
  await page.route(DISCOVERY_ROUTE, (route) => fulfil(route, answers.discovery));
  await page.route(CONFIRM_ROUTE, async (route) => {
    await fulfil(route, answers.confirm);
    if (answers.afterRegistration !== null) answers.discovery = body(answers.afterRegistration);
  });
  await page.route(RETRY_ROUTE, (route) => fulfil(route, answers.retry));
  await page.route(CANCEL_ROUTE, (route) => fulfil(route, answers.cancel));
  await page.route(PICKER_ROUTE, (route) => fulfil(route, answers.picker));
  await page.route(SMAPI_ROUTE, async (route) => {
    await fulfil(route, answers.smapi);
    if (answers.afterRegistration !== null) answers.discovery = body(answers.afterRegistration);
  });
}

function answersFor(scenario: Scenario): Answers {
  return {
    discovery: scenario.discovery,
    confirm: scenario.confirm ?? body({ apiVersion: 1, status: "registered" }),
    retry: scenario.retry ?? body({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] }),
    cancel: scenario.cancel ?? body({ apiVersion: 1, status: "cancelled" }),
    picker: body({ apiVersion: 1, status: "cancelled" }),
    smapi: scenario.smapi ?? body({ apiVersion: 1, status: "installed", steamLaunchOption: "StardewModdingAPI.exe %command%" }),
    afterRegistration: scenario.afterRegistration ?? null,
  };
}

/** Opens the Game surface the way a player does, including after a reload. */
async function openGameSurface(page: Page): Promise<void> {
  const surface = page.getByTestId("game-surface");
  const entry = page.getByRole("button", { name: labels.gamePanel, exact: true });
  await expect(entry).toBeVisible();
  if (!(await surface.isVisible())) await entry.click();
  await expect(surface).toBeVisible();
}

/**
 * The action controls the panel renders, their boxes, and the scroll containers
 * between each of them and the panel - read from the layout, never from a list
 * written in this file.
 */
const MEASURE = () => {
  const node = document.querySelector<HTMLElement>(".game-installation-panel");
  if (node === null) return null;
  const round = (value: number) => Math.round(value);
  const rect = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  const borderTop = Number.parseFloat(style.borderTopWidth);
  const borderLeft = Number.parseFloat(style.borderLeftWidth);
  // The panel's client box: what it actually paints, scrolled content clipped to it.
  const client = {
    top: rect.top + borderTop,
    bottom: rect.top + borderTop + node.clientHeight,
    left: rect.left + borderLeft,
    right: rect.left + borderLeft + node.clientWidth,
  };
  const controls = [...node.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea")]
    .filter((control) => control.getClientRects().length > 0)
    .map((control) => {
      const box = control.getBoundingClientRect();
      // Every container between this control and the panel that scrolls its own
      // content: the ones nobody enumerated, which is the point of asking.
      const clippedBy: { selector: string; scrollHeight: number; clientHeight: number }[] = [];
      for (let ancestor = control.parentElement; ancestor !== null && ancestor !== node; ancestor = ancestor.parentElement) {
        const computed = getComputedStyle(ancestor);
        if (
          (computed.overflowY === "auto" || computed.overflowY === "scroll") &&
          ancestor.scrollHeight > ancestor.clientHeight + 1
        )
          clippedBy.push({
            selector: `.${ancestor.className.toString().split(/\s+/u)[0] || ancestor.tagName.toLowerCase()}`,
            scrollHeight: ancestor.scrollHeight,
            clientHeight: ancestor.clientHeight,
          });
      }
      return {
        name: (control.getAttribute("aria-label") ?? control.textContent ?? "").replace(/\s+/gu, " ").trim(),
        row: control.closest(".installation-candidate") !== null,
        top: round(box.top),
        bottom: round(box.bottom),
        left: round(box.left),
        right: round(box.right),
        width: round(box.width),
        height: round(box.height),
        insidePanel:
          box.top >= client.top - 1 &&
          box.bottom <= client.bottom + 1 &&
          box.left >= client.left - 1 &&
          box.right <= client.right + 1,
        inViewport: box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.left >= -1,
        outsidePanelBy: round(Math.max(0, box.top - client.bottom, client.top - box.bottom)),
        clippedBy,
      };
    });
  return {
    state: node.getAttribute("data-state"),
    rows: node.querySelectorAll(".installation-candidate").length,
    hasGuidance: node.querySelector('[data-testid="game-mod-loader-guidance"]') !== null,
    hasInstallCard: node.querySelector('[data-testid="game-mod-loader-install"]') !== null,
    panel: { top: round(rect.top), height: round(rect.height), width: round(rect.width) },
    client: { top: round(client.top), bottom: round(client.bottom), height: node.clientHeight },
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    controls,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
};

type Reading = NonNullable<Awaited<ReturnType<Page["evaluate"]>>>;

/** Brings the panel into the window once, so the measurement is about the panel. */
async function measurePanel(page: Page) {
  await panel(page).evaluate((node) => node.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(120);
  const reading = (await page.evaluate(MEASURE)) as unknown as {
    state: string | null;
    rows: number;
    hasGuidance: boolean;
    hasInstallCard: boolean;
    panel: { top: number; height: number; width: number };
    client: { top: number; bottom: number; height: number };
    scrollHeight: number;
    clientHeight: number;
    viewport: { width: number; height: number };
    controls: {
      name: string;
      row: boolean;
      top: number;
      bottom: number;
      left: number;
      right: number;
      width: number;
      height: number;
      insidePanel: boolean;
      inViewport: boolean;
      outsidePanelBy: number;
      clippedBy: { selector: string; scrollHeight: number; clientHeight: number }[];
    }[];
  };
  if (reading === null) throw new Error("the Game surface renders no installation panel");
  return reading;
}

/**
 * The controls the panel must render in this reading, derived from the DOM in
 * front of it: one Confirm per rendered candidate row, the state's own action
 * when its card is present, and the navigation row the panel always closes with.
 *
 * Written as a multiset rather than a count so a control that disappears and one
 * that appears both fail, and the message names which.
 */
function expectedControlNames(reading: { rows: number; hasGuidance: boolean; hasInstallCard: boolean }): string[] {
  return [
    ...Array.from({ length: reading.rows }, () => labels.gameInstallationConfirm),
    labels.gameInstallationChooseFolder,
    labels.gameInstallationFindAgain,
    labels.gameResumeCancel,
  ].sort();
}

/** Every reading taken, so one red run names every state and control at once. */
const EVIDENCE: string[] = [];
const record = (line: string) => {
  EVIDENCE.push(line);
  console.log(`[panel-actions] ${line}`);
};

/**
 * Judges one reading and returns every way it falls short, rather than throwing on
 * the first: a defect in one state must not hide the same defect in the next, and a
 * red run has to name every state and control that failed.
 */
function judgeReading(
  scenario: Scenario,
  viewport: string,
  reading: Awaited<ReturnType<typeof measurePanel>>,
): string[] {
  const where = `${scenario.name} (${scenario.state}) at ${viewport}`;
  const failures: string[] = [];

  // The enumerated set is the DOM's: a state may not pass by rendering fewer controls.
  const rendered = reading.controls.map((control) => control.name).sort();
  const expected = expectedControlNames(reading);
  if (JSON.stringify(rendered) !== JSON.stringify(expected))
    failures.push(
      `${where}: the panel renders ${JSON.stringify(rendered)}, and its own DOM implies ${JSON.stringify(expected)}`,
    );

  // The panel fits the window: a box taller than the viewport cannot show its own foot.
  if (reading.panel.height > reading.viewport.height)
    failures.push(
      `${where}: the panel's ${reading.panel.height} px box does not fit the ${reading.viewport.height} px window`,
    );

  // The rule: no control sits behind a scroll container between itself and the panel.
  // A candidate row's own control may be scrolled by the candidate list - that is the
  // list using the space it was given - but nothing else may be, and the list may not
  // be the panel itself.
  for (const control of reading.controls.filter((entry) => entry.clippedBy.length > 0)) {
    const clipping = control.clippedBy.map((entry) => entry.selector);
    if (!control.row || clipping.some((selector) => selector !== ".installation-candidates"))
      failures.push(
        `${where}: ${JSON.stringify(control.name)} sits behind ${JSON.stringify(control.clippedBy)}`,
      );
  }

  // Every control that is not one of the scrolling list's own rows must be inside
  // both the panel's box and the window, and must not be behind any scroll at all.
  const panelActions = reading.controls.filter((control) => !control.row);
  const namedPanelActions = panelActions.map((control) => control.name).sort();
  const expectedPanelActions = [
    labels.gameInstallationChooseFolder,
    labels.gameInstallationFindAgain,
    labels.gameResumeCancel,
  ].sort();
  if (JSON.stringify(namedPanelActions) !== JSON.stringify(expectedPanelActions))
    failures.push(
      `${where}: the panel's own actions are ${JSON.stringify(namedPanelActions)}, and its DOM implies ${JSON.stringify(expectedPanelActions)}`,
    );
  for (const control of panelActions) {
    if (!control.insidePanel)
      failures.push(
        `${where}: ${JSON.stringify(control.name)} is outside the panel's own box (panel bottom ${reading.client.bottom}, control bottom ${control.bottom}, ${control.outsidePanelBy} px clear of it)`,
      );
    if (!control.inViewport)
      failures.push(
        `${where}: ${JSON.stringify(control.name)} is outside the ${reading.viewport.height} px window (top ${control.top}, bottom ${control.bottom})`,
      );
    if (control.clippedBy.length > 0)
      failures.push(`${where}: ${JSON.stringify(control.name)} is behind ${JSON.stringify(control.clippedBy)}`);
  }

  // The panel itself never scrolls: the scrolling region, if any, is inside it.
  if (reading.scrollHeight > reading.clientHeight + 1)
    failures.push(
      `${where}: the panel scrolls its own content (scrollHeight ${reading.scrollHeight} / clientHeight ${reading.clientHeight})`,
    );

  record(
    `${viewport} ${scenario.name}: state=${reading.state} panel=${reading.panel.height}px client=${reading.clientHeight} scroll=${reading.scrollHeight} ` +
      `controls=${reading.controls.length} clipped=${reading.controls.filter((control) => control.clippedBy.length > 0).length} ` +
      `outsidePanel=${panelActions.filter((control) => !control.insidePanel).length} failures=${failures.length}`,
  );
  return failures;
}

/** Judges one reading and fails on it, naming every state's failures together. */
function assertReading(scenario: Scenario, viewport: string, reading: Awaited<ReturnType<typeof measurePanel>>): void {
  expect(reading.state, `the scenario reached ${scenario.state} at ${viewport}`).toBe(scenario.state);
  expect(judgeReading(scenario, viewport, reading), `${scenario.name} at ${viewport}`).toEqual([]);
}

/** Where the panel sits on a fresh mount, and how far the window must scroll to it. */
async function measureFreshMount(page: Page) {
  return (await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="game-surface"]');
    const node = surface?.querySelector<HTMLElement>(".game-installation-panel") ?? null;
    if (node === null) return null;
    const content = surface?.querySelector<HTMLElement>(".surface-content") ?? null;
    const round = (value: number) => Math.round(value);
    const rect = node.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      top: round(rect.top),
      height: round(rect.height),
      // How far the surface's own scroller must travel to bring the panel's top up.
      scrollTopRequired: content === null ? null : round(rect.top - content.getBoundingClientRect().top + content.scrollTop),
    };
  })) as unknown as {
    viewport: { width: number; height: number };
    top: number;
    height: number;
    scrollTopRequired: number | null;
  } | null;
}

test.describe("installation panel: its actions are never behind its own scroll", () => {
  test("every state the panel declares leaves its actions reachable, at 400x800 and 1440x900", async ({ page }) => {
    test.setTimeout(240_000);
    const states = declaredInstallationStates();
    const driven = new Set(SCENARIOS.map((scenario) => scenario.state));
    // Coverage is derived: a state the union declares that no scenario reaches, and
    // that is not named as unproducible with a reason, is a hole in this gate.
    expect(
      states.filter((state) => !driven.has(state) && !(state in UNREACHABLE)),
      `every InstallationDiscoveryState is driven by a scenario or named as unproducible (union: ${states.join(", ")})`,
    ).toEqual([]);
    expect(
      Object.keys(UNREACHABLE).filter((state) => !states.includes(state)),
      "the unproducible list names only states the union still declares",
    ).toEqual([]);

    const answers = answersFor(SCENARIOS[0]!);
    await mountRoutes(page, answers);
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`http://127.0.0.1:4173/#profile=composed-reference-game&boot=${token}`);

    // Every state is judged, not just the first failing one: a red run has to name
    // every state and control that puts an action out of reach.
    const failures: string[] = [];
    let first = true;
    for (const viewport of [
      { width: 400, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      const at = `${viewport.width}x${viewport.height}`;
      for (const scenario of SCENARIOS) {
        Object.assign(answers, answersFor(scenario));
        if (first) {
          await page.goto(`http://127.0.0.1:4173/#profile=composed-reference-game&boot=${token}`);
          first = false;
        } else {
          await page.reload();
        }
        await openGameSurface(page);
        await expect(panel(page)).toBeVisible();
        if (scenario.clicks !== undefined) {
          for (const name of scenario.clicks) {
            await panel(page).getByRole("button", { name, exact: true }).first().click();
            await page.waitForTimeout(250);
          }
        }
        await expect(panel(page)).toHaveAttribute("data-state", scenario.state, { timeout: 15_000 });
        await page.waitForTimeout(150);
        failures.push(...judgeReading(scenario, at, await measurePanel(page)));
      }
    }

    console.log(`[panel-actions] readings: ${EVIDENCE.length}, states declared: ${states.length}, driven: ${driven.size}`);
    expect(failures, "no state puts a control outside the panel, the window, or behind a scroll").toEqual([]);
    expect(EVIDENCE.length, "every scenario was measured at both widths").toBe(SCENARIOS.length * 2);
  });

  /**
   * A machine with five installations. The list is the one region allowed to
   * scroll, and it must be the *only* thing that scrolls: the panel's own actions
   * keep their place while the rows move under the pointer.
   */
  test("a long candidate list scrolls the rows, never the actions", async ({ page }) => {
    test.setTimeout(120_000);
    const answers = answersFor(MANY_SCENARIO);
    await mountRoutes(page, answers);
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`http://127.0.0.1:4173/#profile=composed-reference-game&boot=${token}`);
    await openGameSurface(page);
    await expect(panel(page)).toHaveAttribute("data-state", "candidates", { timeout: 15_000 });
    await measurePanel(page);

    const reading = await measurePanel(page);
    assertReading(MANY_SCENARIO, "400x800", reading);
    expect(reading.rows, "the reply's five installations are all rendered").toBe(5);
    // The list really does scroll its rows - otherwise the cap would not have bought
    // anything and the rows would push the panel down the page instead.
    const list = (await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(".game-installation-panel .installation-candidates");
      if (node === null) return null;
      return {
        overflowY: getComputedStyle(node).overflowY,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        tabIndex: node.tabIndex,
      };
    })) as { overflowY: string; scrollHeight: number; clientHeight: number; tabIndex: number } | null;
    expect(list, "the candidate list is the panel's scrolling region").not.toBeNull();
    expect(list!.overflowY, "the list scrolls its own overflow").toBe("auto");
    expect(list!.scrollHeight, "five rows exceed the list's own box").toBeGreaterThan(list!.clientHeight + 1);
    // A scroll region a keyboard cannot focus is unreachable with Tab alone
    // (axe: scrollable-region-focusable), so the cap and the focus stop travel together.
    expect(list!.tabIndex, "the scrolling list is a keyboard focus stop").toBeGreaterThanOrEqual(0);

    // Scrolling the list to a row brings that row's control inside the panel's box:
    // the rows are usable, they are just not all visible at once.
    const lastRow = reading.controls.filter((control) => control.row).at(-1)!;
    expect(lastRow.clippedBy, "the last row starts behind the list's scroll").not.toEqual([]);
    const afterScroll = (await page.evaluate(() => {
      const listNode = document.querySelector<HTMLElement>(".game-installation-panel .installation-candidates");
      const rows = listNode?.querySelectorAll<HTMLElement>(".installation-candidate") ?? [];
      const last = rows[rows.length - 1] ?? null;
      if (last === null || listNode === null) return null;
      last.scrollIntoView({ block: "nearest" });
      const panelNode = document.querySelector<HTMLElement>(".game-installation-panel")!;
      const borderTop = Number.parseFloat(getComputedStyle(panelNode).borderTopWidth);
      const panelRect = panelNode.getBoundingClientRect();
      const box = last.querySelector("button")!.getBoundingClientRect();
      return {
        controlTop: Math.round(box.top),
        controlBottom: Math.round(box.bottom),
        clientTop: Math.round(panelRect.top + borderTop),
        clientBottom: Math.round(panelRect.top + borderTop + panelNode.clientHeight),
        panelScrollTop: panelNode.scrollTop,
      };
    })) as { controlTop: number; controlBottom: number; clientTop: number; clientBottom: number; panelScrollTop: number } | null;
    expect(afterScroll, "the list can be scrolled to its last row").not.toBeNull();
    expect(afterScroll!.controlTop, "the last row's control is inside the panel once the list is scrolled").toBeGreaterThanOrEqual(
      afterScroll!.clientTop - 1,
    );
    expect(afterScroll!.controlBottom, "and its bottom is too").toBeLessThanOrEqual(afterScroll!.clientBottom + 1);
    expect(afterScroll!.panelScrollTop, "the panel itself never scrolled to get there").toBe(0);
  });

  /**
   * The panel's position on a fresh mount, recorded rather than asserted.
   *
   * While no installation is registered the panel leads the surface's content, so
   * this reading is what says it still does: the number that matters is not the
   * panel's own height but how far the surface's scroller has to travel to reach it.
   * Kept as a record beside the first-viewport gate below, so a change that pushes
   * the panel back under the guide shows up in a printed reading as well as in a
   * failed assertion.
   */
  test("records where the panel sits on a fresh mount", async ({ page }) => {
    // The scenario is named by its state, not by its place in the list: an inserted scenario
    // used to move this reading onto a different Host answer, and the gate reported a layout
    // defect that was really an index.
    const answers = answersFor(SCENARIOS.find((scenario) => scenario.state === "candidates")!);
    await mountRoutes(page, answers);
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`http://127.0.0.1:4173/#profile=composed-reference-game&boot=${token}`);
    await openGameSurface(page);
    await expect(panel(page)).toHaveAttribute("data-state", "candidates", { timeout: 15_000 });
    const wide = await measureFreshMount(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
    const desktop = await measureFreshMount(page);
    console.log(`[panel-actions] fresh mount position: ${JSON.stringify({ wide, desktop })}`);
    expect(wide, "the panel is laid out on a fresh mount").not.toBeNull();
    expect(desktop, "the panel is laid out on a fresh desktop mount").not.toBeNull();
    record(
      `fresh mount: 400x800 top=${wide!.top}px (${(wide!.top / wide!.viewport.height).toFixed(2)} viewports), scrollTop ${wide!.scrollTopRequired}; ` +
        `1440x900 top=${desktop!.top}px, scrollTop ${desktop!.scrollTopRequired}`,
    );
  });

  /**
   * A fresh session's first viewport has to hold a step that can succeed.
   *
   * Measured at 400x800 before this change, in the state a first run opens in (the
   * Host holds no installation, so its projection reads `prerequisites: unknown` and
   * the scan finds nothing): the guide led, its second control `Activate companion`
   * sat at y=270..314 inside the 800 px window, and pressing it was refused - "Companion
   * play needs a Stardew Valley installation set up for this session, and none is yet".
   * The one control that can act in that state, the panel's `Choose game folder`, sat at
   * y=1502..1546: 702 px below the fold and 1188 px below the control that refused. The
   * first viewport therefore offered two controls that could only fail and none that could
   * work - `AGENTS.md`'s "zero forward path", on the product's first screen.
   *
   * The gate asks the layout, not a list written here: which enabled controls are fully
   * inside the window on a fresh mount, and is the step the guide leads with painted after
   * the step it depends on. A control added, moved or newly disabled changes the answer
   * without this file changing.
   */
  test("a fresh session's first viewport holds the step that can succeed", async ({ page }) => {
    const answers = answersFor(SCENARIOS.find((scenario) => scenario.state === "no-candidates")!);
    // The folder picker is the step this state's first viewport must offer, and registering
    // through it is what "advances the flow" means: the panel states the registration and
    // hands the surface the admitted installation.
    answers.picker = body({ apiVersion: 1, status: "registered" });
    await mountRoutes(page, answers);
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto(`http://127.0.0.1:4173/#profile=composed-reference-game&boot=${token}`);
    await openGameSurface(page);
    await expect(panel(page)).toHaveAttribute("data-state", "no-candidates", { timeout: 15_000 });
    await page.waitForTimeout(150);

    const reading = await page.evaluate(() => {
      const round = (value: number) => Math.round(value);
      const surface = document.querySelector<HTMLElement>('[data-testid="game-surface"]');
      const content = surface?.querySelector<HTMLElement>(".surface-content");
      const install = document.querySelector<HTMLElement>(".game-installation-panel");
      const guide = document.querySelector<HTMLElement>('[data-testid="game-start-guide"]');
      const name = (node: HTMLElement) =>
        (node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/gu, " ").trim();
      const box = (node: Element | null) => {
        if (node === null) return null;
        const rect = node.getBoundingClientRect();
        return { top: round(rect.top), bottom: round(rect.bottom) };
      };
      // Every control the player can press on this surface, and whether it is wholly inside
      // the first viewport. Disabled controls are not steps: they cannot advance anything.
      const enabled = [...(content?.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea") ?? [])]
        .filter((control) => control.getClientRects().length > 0)
        .filter((control) => !("disabled" in control) || control.disabled !== true)
        .map((control) => {
          const rect = control.getBoundingClientRect();
          return {
            name: name(control),
            inInstallationPanel: install !== null && install.contains(control),
            inFirstViewport: rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && rect.left >= -1,
            top: round(rect.top),
            bottom: round(rect.bottom),
          };
        });
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        viewportHeight: window.innerHeight,
        enabled,
        installation: box(install),
        guideTop: box(guide)?.top ?? null,
      };
    });
    record(
      `first viewport: ${reading.enabled.filter((control) => control.inFirstViewport).length} enabled control(s) inside 0..${reading.viewportHeight}, ` +
        `installation top=${reading.installation?.top ?? "absent"}, guide top=${reading.guideTop ?? "absent"}`,
    );
    console.log(`[panel-actions] first viewport ${JSON.stringify(reading)}`);

    // The step before any other: the panel that registers the installation is on the surface.
    expect(reading.installation, "the installation panel is laid out").not.toBeNull();
// The install card is gone from the product and must not come back: SMAPI belongs to its own project, so this
// panel guides the player to install it rather than offering to write it into their game folder.
expect(reading.hasInstallCard, "the install card is not offered").toBe(false);
    expect(reading.guideTop, "the guide is laid out").not.toBeNull();

    // 1. The first viewport holds at least one control that can act, and it is the
    //    installation step's own - not a control the Host will refuse for the missing
    //    registration.
    const actionable = reading.enabled.filter((control) => control.inFirstViewport && control.inInstallationPanel);
    expect(
      actionable.map((control) => control.name),
      `an enabled control of the installation step is inside the ${reading.viewportHeight} px viewport (read: ${JSON.stringify(reading.enabled)})`,
    ).not.toEqual([]);

    // 2. The step that depends on the registration is not offered before it: the guide,
    //    whose step 1 is "enable companion play", is painted after the panel.
    expect(
      reading.guideTop!,
      `the guide leads at y=${reading.guideTop} over an installation step at y=${reading.installation!.top}`,
    ).toBeGreaterThan(reading.installation!.top);

    // 3. And the control really acts: pressing it registers the folder and the panel says so.
    const picker = panel(page).getByRole("button", { name: labels.gameInstallationChooseFolder, exact: true });
    await expect(picker).toBeEnabled();
    await picker.click();
    await expect(panel(page)).toHaveAttribute("data-state", "confirmed", { timeout: 15_000 });
    await expect(panel(page).locator(".installation-state").first()).toHaveText(labels.gameInstallationConfirmed);
  });

  /**
   * The folder picker's wait, as the player reads it.
   *
   * The dialog opened by `Choose game folder` can land behind the browser, and the Host publishes
   * nothing while the helper's dialog is alive (`host/src/windows-stardew-folder-picker/index.ts:198-213`),
   * so the panel's only fact is that its own request is outstanding. Before this, that fact was
   * rendered as nothing at all: the panel kept the scan's sentence, went quiet while the dialog was
   * up, and a scan settling behind the dialog cleared the pending flag and re-enabled the button over
   * a window the player had not closed.
   *
   * The gates, per viewport: the wait is stated in the catalogue's own words; the picker does not
   * invite a second dialog (disabled, and exactly one request); the scan settling behind the dialog
   * leaves both alone; the wait and the panel's actions stay inside the panel's own box and inside the
   * window; and the wait ends with the request, leaving the scan's answer where it was.
   *
   * red-proof: run against the panel before this change (`git show HEAD:` of the component) ->
   *   `400x800 folder picker pending: state=loading pickerDisabled=true waitLine=absent panel="Game
   *    installation Looking for your Stardew Valley installation… Choose game folder Find again Cancel"`
   *   and, once the scan settled behind the dialog,
   *   `400x800 scan settled behind the dialog: state=no-candidates pickerDisabled=false waitLine=absent
   *    requests=1` - the panel said nothing about the window and had already re-enabled the button over
   *   it. Three failures per viewport, named above the assertion below.
   */
  test("the wait for the folder window is stated, cannot be clicked twice, and ends with the request", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const failures: string[] = [];
    for (const viewport of [
      { width: 400, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      const at = `${viewport.width}x${viewport.height}`;
      // Both Host answers are held open, so the order the test needs is the order it gets: the picker
      // is pressed while the scan is still out, and the scan then settles behind the dialog.
      let settleScan!: () => void;
      let closeDialog!: () => void;
      const scanHeld = new Promise<void>((resolve) => (settleScan = resolve));
      const dialogHeld = new Promise<void>((resolve) => (closeDialog = resolve));
      const scenario = SCENARIOS.find((entry) => entry.state === "no-candidates")!;
      const answers = answersFor(scenario);
      const pickerRequests: string[] = [];
      await mountRoutes(page, answers);
      // Registered after `mountRoutes`, so these handlers own their routes: Playwright runs the most
      // recently added handler first, and one that fulfils stops the chain.
      await page.route(DISCOVERY_ROUTE, async (route) => {
        await scanHeld;
        await route
          .fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: ["no-candidates"] }))
          .catch(() => undefined);
      });
      await page.route(PICKER_ROUTE, async (route) => {
        pickerRequests.push(route.request().url());
        await dialogHeld;
        await route.fulfill(jsonOk({ apiVersion: 1, status: "cancelled" })).catch(() => undefined);
      });

      await page.setViewportSize(viewport);
      await page.goto(`http://127.0.0.1:4173/#profile=composed-reference-game&boot=${token}`);
      await openGameSurface(page);
      await expect(panel(page)).toBeVisible();

      const picker = panel(page).getByRole("button", { name: labels.gameInstallationChooseFolder, exact: true });
      await expect(picker, `${at}: the picker is offered while the scan is still out`).toBeEnabled();
      await picker.click();

      // 1. The wait is stated, in the catalogue's own words.
      const waitLine = panel(page).getByTestId("game-installation-picker-wait");
      const waitVisible = await waitLine
        .waitFor({ state: "visible", timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      const duringWait = await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>(".game-installation-panel");
        const picker = [...(node?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Choose game folder",
        );
        return {
          state: node?.getAttribute("data-state") ?? null,
          text: (node?.innerText ?? "").replace(/\s+/gu, " ").trim(),
          pickerDisabled: picker?.disabled ?? null,
        };
      });
      record(
        `${at} folder picker pending: state=${duringWait.state} pickerDisabled=${duringWait.pickerDisabled} ` +
          `waitLine=${waitVisible ? "shown" : "absent"} panel=${JSON.stringify(duringWait.text)}`,
      );
      if (!waitVisible) failures.push(`${at}: nothing on the panel says the folder window is waiting to be closed`);
      else
        expect(await waitLine.innerText(), `${at}: the wait is the catalogue's sentence`).toBe(
          labels.gameInstallationPickerWaiting,
        );

      // 2. A second press is not invited, and does not reach the Host twice.
      expect(await picker.isDisabled(), `${at}: the picker invites a second dialog while one is open`).toBe(true);

      // 3. The scan settling behind the dialog is a different fact: it must not clear the wait, and it
      //    must not re-enable the button over a window the player has not closed.
      settleScan();
      await expect(panel(page), `${at}: the scan's own answer arrives behind the dialog`).toHaveAttribute(
        "data-state",
        "no-candidates",
        { timeout: 15_000 },
      );
      await page.waitForTimeout(250);
      const afterScan = await page.evaluate(() => {
        const node = document.querySelector<HTMLElement>(".game-installation-panel");
        const picker = [...(node?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Choose game folder",
        );
        return {
          state: node?.getAttribute("data-state") ?? null,
          waitShown: node?.querySelector('[data-testid="game-installation-picker-wait"]') !== null,
          pickerDisabled: picker?.disabled ?? null,
        };
      });
      record(
        `${at} scan settled behind the dialog: state=${afterScan.state} pickerDisabled=${afterScan.pickerDisabled} ` +
          `waitLine=${afterScan.waitShown ? "shown" : "absent"} requests=${pickerRequests.length}`,
      );
      if (!afterScan.waitShown)
        failures.push(`${at}: the scan settling behind the dialog erased the wait for a window that is still open`);
      if (afterScan.pickerDisabled !== true)
        failures.push(`${at}: the scan settling re-enabled the picker over a dialog that is still open`);
      expect(pickerRequests.length, `${at}: the picker reached the Host once, and only once`).toBe(1);

      // 4. The wait and the panel's actions stay inside the panel's own box and inside the window.
      failures.push(...judgeReading(scenario, at, await measurePanel(page)));

      // 5. The wait ends with the request, and the sentence the panel had is the one it keeps: a
      //    dismissed dialog is not an answer to a scan that had already answered.
      closeDialog();
      await expect(waitLine, `${at}: the wait ends when the request does`).toHaveCount(0, { timeout: 15_000 });
      await expect(picker, `${at}: and the picker is offered again`).toBeEnabled();
      await expect(panel(page), `${at}: a dismissed dialog leaves the scan's answer alone`).toHaveAttribute(
        "data-state",
        "no-candidates",
      );
      await expect(panel(page).locator(".installation-state").first()).toHaveText(labels.gameInstallationNoCandidates);
    }
    expect(failures, "the folder picker's wait is legible without claiming more than the panel knows").toEqual([]);
  });
});
