/**
 * The first viewport of every surface, in every state the product can be in on it, offers the
 * player a step forward.
 *
 * The defect family this is written against was met four times in one evening, each time by eye
 * or by a human reviewer rather than by a gate: the problem screen was a heading and a paragraph
 * with nothing to press; the Game surface with no installation registered led with a control that
 * refused on press while the picker that would have fixed it sat 722 px below a 400x800 fold; a
 * rename cleared the draft before the request, so a refused save lost the words; and a card
 * import's confirm button fell below the fold once the card list grew. Four shapes of one
 * question - *can the player do anything from where they land* - and nothing in the tree asked it
 * for a whole surface, let alone for every state of one.
 *
 * WHAT IS ASSERTED, per (surface, state), at 400x800 with the region scrolled to its top:
 *
 *   1. the state's own declared step is where the player lands: where the declaration names a
 *      control (`forwardActions`, the phase list), that control is enabled and fully inside the
 *      window; where it names a sentence instead (`wait_for_game`, `restart_gamebuddy`), the
 *      sentence is inside the window; where it names nothing at all (`terminal`), the shell's own
 *      surface switch is;
 *   2. the step actually moves something - a press that reaches no Host route and changes nothing
 *      on screen is a control that exists and does not advance the flow;
 *   3. a press the Host refuses is not the only thing the viewport offers: when the press answers
 *      4xx/5xx, another enabled control must be inside the same viewport, or the state names its
 *      own refusal and stops.
 *
 * What 3 does NOT catch, stated here so a green run is not read as more than it is: a refused step
 * whose *remedy* is below the fold while an unrelated enabled control remains above it. Closing
 * that needs the product to declare which control satisfies each refusal's missing prerequisite,
 * and it declares no such mapping today - the Game surface's own guide order is the closest thing
 * to it, and inferring the remedy from that would be this gate inventing a product decision.
 *
 * THE POPULATION IS DERIVED, in three parts, and a member added to any of them joins this gate
 * without anybody editing it:
 *
 *   - the surfaces are the shell's own route vocabulary: every exported `*_PANEL` constant of
 *     `src/composed-surface-route.ts`, whose region is that constant's `${panel}-surface`;
 *   - the shell's own states are the `kind` members of `ViewState`
 *     (`src/composed-reference-game-view.ts`, following its reference into
 *     `src/composed-problem-view.ts`), read from the declarations rather than retyped;
 *   - a surface's states are the phase population the product declares for it *with* its own
 *     fixtures - `GAME_SESSION_PHASES`/`GAME_SESSION_INPUTS` for the Game surface - and, for the
 *     conversation, the operation-availability values the browser contract declares
 *     (`TavernBrowserOperationV1Schema.availability`, read from
 *     `host/src/tavern/browser-contract/index.ts`), because that is the axis the composer's own
 *     lock is derived from.
 *
 * WHAT IT CANNOT ASSESS IS NAMED, not skipped: a shell state with no control of its own and no
 * declared way out (`loading`), and a surface whose states exist only as a TypeScript union with
 * no runtime population and no fixture (`ConnectionView`, `MemoryView`, ...) are printed as
 * `unassessed: <member> - <why>` in the run's own output. A gap the gate cannot close is a fact
 * the reader of the run learns, which is the difference between a gate and a green tick.
 *
 * red-proof: inject  deleting `ProblemView`'s action at its call site (`action={{ ... }}` -> `action={null}`
 *                    in ComposedReferenceGameApp.tsx) -> `shell/problem is a dead end: the failure screen
 *                    offers no enabled control inside the 400x800 first viewport` (dialogue-web/tests/first-viewport-forward-path.spec.ts)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { GAME_SESSION_INPUTS, GAME_SESSION_PHASES, deriveGameSessionControls } from "../src/game-lifecycle-controls";
import { PROBLEM_CODES } from "../src/reference-pipeline-api";
import * as surfaceRoute from "../src/composed-surface-route";
import { type Page, type Route, expect, test } from "./frontend-coverage";

const TESTS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TESTS_DIRECTORY, "..");
const REPOSITORY_ROOT = resolve(WEB_ROOT, "..");

/** The window every assertion is made in: the narrow phone view the project's rule names. */
const VIEWPORT = { width: 400, height: 800 } as const;

/** Every control the gate counts, in the page and in the locator that presses it. */
const CONTROL_SELECTOR = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]';

// ---------------------------------------------------------------------------------------------
// 1. The population, read out of the product's own declarations
// ---------------------------------------------------------------------------------------------

type Surface = Readonly<{ panel: string; testId: string }>;

/**
 * Every surface the shell can show.
 *
 * The shell's route module names each one as an exported constant (`CHAT_PANEL = "chat"`), and
 * `SurfaceView` renders each as `${testId}` - so the surface list and its region selector both
 * come from the one declaration, and a seventh surface is measured the first time this runs.
 */
const SURFACES: readonly Surface[] = Object.entries(surfaceRoute)
  .filter(([name, value]) => name.endsWith("_PANEL") && typeof value === "string")
  .map(([, panel]) => ({ panel: panel as string, testId: `${panel as string}-surface` }))
  .sort((left, right) => left.panel.localeCompare(right.panel));

/** The shell's own view vocabulary, and the problem view it hands to `ProblemView`. */
const SHELL_VIEW_FILES = ["src/components/composed-reference-game-view.ts", "src/composed-problem-view.ts"] as const;

/** The contract that declares what an operation's availability may be. */
const CONTRACT_FILE = "host/src/tavern/browser-contract/index.ts";

function parse(path: string): ts.SourceFile {
  const source = readFileSync(path, "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * The string-literal members of a `kind` property, for one named type, across a set of files.
 *
 * A shell state is a `kind` discriminant (`{ kind: "loading" }`), and a union member may be an
 * identifier for an alias in the same file (`ReadyView`) or in another (`ProblemViewState`), so
 * the walk follows type references as well as literal members. A kind the walk cannot see is a
 * kind the gate does not measure, which is why the caller refuses an empty answer instead of
 * treating it as "no states".
 */
function declaredKinds(files: readonly string[], rootType: string): readonly string[] {
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  for (const file of files) {
    for (const statement of parse(resolve(WEB_ROOT, file)).statements)
      if (ts.isTypeAliasDeclaration(statement)) aliases.set(statement.name.text, statement);
  }
  const kinds = new Set<string>();
  const walked = new Set<string>();
  const walkType = (name: string): void => {
    if (walked.has(name)) return;
    walked.add(name);
    const alias = aliases.get(name);
    if (alias === undefined) return;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertySignature(node) && node.name.getText() === "kind" && node.type !== undefined) {
        const collect = (inner: ts.Node): void => {
          if (ts.isLiteralTypeNode(inner) && ts.isStringLiteral(inner.literal)) kinds.add(inner.literal.text);
          ts.forEachChild(inner, collect);
        };
        collect(node.type);
      }
      if (ts.isTypeReferenceNode(node)) walkType(node.typeName.getText());
      ts.forEachChild(node, visit);
    };
    visit(alias.type);
  };
  walkType(rootType);
  return [...kinds].sort();
}

/** Every string literal a named schema property is declared from, e.g. a `Type.Union` of literals. */
function contractLiterals(declarationName: string, propertyName: string): readonly string[] {
  const values = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === declarationName) {
      const findProperty = (inner: ts.Node): void => {
        if (ts.isPropertyAssignment(inner) && inner.name.getText() === propertyName) {
          const collect = (leaf: ts.Node): void => {
            if (ts.isStringLiteral(leaf)) values.add(leaf.text);
            ts.forEachChild(leaf, collect);
          };
          collect(inner.initializer);
        }
        ts.forEachChild(inner, findProperty);
      };
      findProperty(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(resolve(REPOSITORY_ROOT, CONTRACT_FILE)));
  return [...values].sort();
}

const SHELL_VIEW_KINDS = declaredKinds(SHELL_VIEW_FILES, "ViewState");
/**
 * `ProblemViewState` now carries its own step, so the walk above reaches `ProblemStep`'s four kinds
 * too. They are the failure's answer vocabulary, not states of the shell, so they are subtracted
 * here - derived from the same declaration rather than listed by hand, so a fifth step kind joins
 * this reading the moment the product declares it.
 */
const PROBLEM_STEP_KINDS = declaredKinds(["src/composed-problem-view.ts"], "ProblemStep");
const SHELL_STATE_KINDS = SHELL_VIEW_KINDS.filter((kind) => !PROBLEM_STEP_KINDS.includes(kind));
const SUBMIT_AVAILABILITY = contractLiterals("TavernBrowserOperationV1Schema", "availability");

// ---------------------------------------------------------------------------------------------
// 2. The fixtures: the product's own projections, one per state
// ---------------------------------------------------------------------------------------------

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const connectionId = `${"E".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** The frozen problem shape: what the Host answers when it refuses a route. */
const problem = (status: number, code: string) => ({
  status,
  contentType: "application/problem+json",
  body: JSON.stringify({ type: "about:blank", title: code, status, code, requestId: `${"R".repeat(42)}A`, retryable: false }),
});

/**
 * One state of one surface, as the composed root that produces it.
 *
 * `submit` is the conversation's own availability axis and `game` the Game half's projection;
 * both are the facts the shell derives its controls from, so a state is a projection and not a
 * class name.
 */
type StateFixture = Readonly<{
  id: string;
  /** The composed root's Game half: a full envelope, or `null` for "the Host published none". */
  game: unknown | null;
  /** The conversation's `chat.submit` availability, and the turn the Host publishes with it. */
  submit: string;
}>;

/**
 * The Game projection a first-run player meets, taken from the product's own pre-activation fixture
 * (`GAME_SESSION_INPUTS`) rather than retyped here: the envelope is this gate's to build, the
 * projection is the product's to state.
 */
function firstRunGameProjection(): unknown {
  const envelope = GAME_SESSION_INPUTS.pre_activation.game;
  if (envelope === null) throw new Error("GAME_SESSION_INPUTS.pre_activation publishes no Game projection");
  return envelope.game;
}

const GAME_PROJECTION = firstRunGameProjection();

/** The Game half's envelope around one projection: transport facts, then the projection itself. */
function gameEnvelope(projection: unknown): unknown {
  return projection === null
    ? null
    : {
        apiVersion: 1,
        build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
        csrfToken,
        browserSession: { expiresAtMs },
        game: projection,
      };
}

/** The conversation half: the Host's own snapshot shape, with the availability under test. */
function chatSnapshot(fixture: StateFixture): unknown {
  const running = fixture.submit === "busy";
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [
      { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: fixture.submit, routeId: "chat.submit" },
      ...(running
        ? [{ operationId: "chat.cancel", labelKey: "tavern.operation.cancel", availability: "available", routeId: "chat.cancel" }]
        : []),
    ],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle, generation: 1, stateRevision: chatHandle },
    chat: {
      companion: { name: "Mira", handle: companionHandle },
      title: null,
      transcript: [],
      draft: { revision: 0, present: false },
      turn: running ? { handle: turnHandle, state: "running", projectionRevision: 1, canCancel: true } : null,
      worldInfo: null,
    },
    memory: { readAvailable: true, mutationAvailable: true, projectionRevision: null },
    eventStream: null,
  };
}

function composedRoot(fixture: StateFixture): unknown {
  return {
    apiVersion: 1,
    build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
    chat: chatSnapshot(fixture),
    game: gameEnvelope(fixture.game),
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Mounting and reading one state
// ---------------------------------------------------------------------------------------------

/** Every route the shell and its four management surfaces read, answered for one fixture. */
async function stubRoutes(page: Page, fixture: StateFixture): Promise<void> {
  const root = composedRoot(fixture);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  // The Game surface's own commands and reads, answered the way a healthy Host answers them. A
  // press whose route nobody stubbed answers 404, and a 404 is indistinguishable from a refusal in
  // this gate - so an unstubbed route would make "the press was refused" a fact about the fixture
  // rather than about the product.
  for (const path of ["lifecycle/activate", "game/prerequisites/setup", "game/launch", "game/stop", "game/disconnect"])
    await page.route(`**/api/composed-reference-game/v1/${path}`, (route) =>
      route.fulfill({ status: 204, contentType: "text/plain", body: "" }),
    );
  const gameAnswer = (body: unknown) => (route: Route) => route.fulfill(jsonOk(body));
  await page.route("**/api/composed-reference-game/v1/game/resume", gameAnswer({ apiVersion: 1, status: "accepted" }));
  await page.route("**/api/composed-reference-game/v1/game/reopen", gameAnswer({ apiVersion: 1, status: "reopened" }));
  await page.route(
    "**/api/composed-reference-game/v1/game/resume/cancel",
    gameAnswer({ apiVersion: 1, status: "cancelled" }),
  );
  await page.route(
    "**/api/composed-reference-game/v1/game/create",
    gameAnswer({ apiVersion: 1, status: "accepted", gameSessionId: "session_one" }),
  );
  await page.route("**/api/composed-reference-game/v1/game/endgame", gameAnswer({ apiVersion: 1, status: "gameended" }));
  await page.route("**/api/composed-reference-game/v1/game/stardew/settings", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 0,
        families: [],
        advanceDayMinimumOnlineFarmers: 1,
        appliesToRunningGame: {
          actionPolicy: "within_seconds",
          advanceDayMinimumOnlineFarmers: "next_world_load",
          windowMode: "within_seconds",
          deniedActions: "within_seconds",
        },
      }),
    ),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  await page.route("**/api/composed-reference-game/v1/game/installation/discovery/retry", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, candidates: [], diagnostics: [] })),
  );
  for (const path of ["confirm", "cancel", "manual-picker"])
    await page.route(`**/api/composed-reference-game/v1/game/installation/discovery/${path}`, (route) =>
      route.fulfill(jsonOk({ apiVersion: 1, status: "accepted" })),
    );
  await page.route("**/api/composed-reference-game/v1/game/prerequisites/smapi", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, status: "current", steamLaunchOption: "-applaunch 413150" })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  // The conversation's model route is a read of the player's own connection: `unavailable` is the
  // no-model state a first-run player meets, so it is the one that carries the standing sentence.
  const connected = fixture.submit !== "unavailable";
  await page.route("**/api/tavern/v1/settings/connection", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        revision: 3,
        active: connected
          ? {
              connectionId,
              label: "DeepSeek",
              providerLabel: "DeepSeek",
              modelId: "deepseek-v4-pro",
              modelLabel: "DeepSeek V4 Pro",
              thinkingLevel: "high",
              readiness: "ready",
              baseUrl: null,
              failure: null,
              lastCheckedAtMs: null,
            }
          : null,
        connections: connected
          ? [
              {
                connectionId,
                label: "DeepSeek",
                providerId: "deepseek",
                providerLabel: "DeepSeek",
                configured: true,
                readiness: "ready",
                active: true,
                modelId: "deepseek-v4-pro",
                modelLabel: "DeepSeek V4 Pro",
                thinkingLevel: "high",
                allowedThinkingLevels: ["high"],
                modelIds: null,
                baseUrl: null,
                failure: null,
                lastCheckedAtMs: null,
              },
            ]
          : [],
        providers: [
          {
            providerId: "deepseek",
            label: "DeepSeek",
            setupFields: ["apiKey", "modelId"],
            allowedPlayerModels: [
              {
                modelId: "deepseek-v4-pro",
                modelLabel: "DeepSeek V4 Pro",
                allowedThinkingLevels: ["high"],
                defaultThinkingLevel: "high",
              },
            ],
            escapeHatch: false,
            environmentManaged: false,
          },
        ],
      }),
    ),
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
  await page.route("**/api/tavern/v1/settings/language", (route) => route.fulfill(jsonOk({ revision: 1, locale: "en-US" })));
  await page.route("**/api/tavern/v1/settings/delivery", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, thinkingLevel: "high" })),
  );
  await page.route("**/api/tavern/v1/settings/game-prompt", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, addition: null, effective: null })),
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
    route.fulfill(jsonOk({ devices: [{ id: "waveout:1", name: "Speakers" }], defaultSelectable: true })),
  );
  await page.route("**/api/tavern/v1/chats?*", (route) => route.fulfill(jsonOk({ apiVersion: 1, chats: [] })));
  await page.route("**/api/tavern/v1/chats", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        chat: {
          handle: chatHandle,
          title: null,
          status: "active",
          managementRevision: 1,
          isSelected: true,
          updatedAtMs: 1_760_000_000_000,
          preview: null,
        },
        opening: null,
      }),
    ),
  );
  await page.route("**/api/tavern/v1/memory", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, projectionRevision: chatHandle, memories: [], chapters: [] })),
  );
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: companionHandle, name: "Mira", isCurrent: true }] })),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/profile", (route) =>
    route.fulfill(
      jsonOk({
        apiVersion: 1,
        name: "Mira",
        revision: 1,
        persona: { present: false, core: null, interactionStyle: null, expressionStyle: null },
        scenario: { present: false, name: null, description: null },
        greetings: { present: false, label: null, variants: [] },
        worldBook: { apiVersion: 1, present: false, revision: null, entries: [] },
      }),
    ),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
}

type ControlReading = Readonly<{
  index: number;
  name: string;
  testId: string | null;
  tag: string;
  disabled: boolean;
  top: number;
  bottom: number;
  width: number;
  height: number;
  painted: boolean;
  inViewport: boolean;
}>;

type LineReading = Readonly<{ testId: string | null; text: string; inViewport: boolean }>;

type ViewportReading = Readonly<{
  mounted: boolean;
  controls: readonly ControlReading[];
  /** The region's own words, for the "did the press move anything" comparison. */
  text: string;
  /** Every standing sentence the region shows, with where it sits: a refusal lands here. */
  lines: readonly LineReading[];
  /** The shell's own problem card, when the whole surface was replaced by one. */
  problemCard: boolean;
}>;

/**
 * What the first viewport holds, read off the browser's own layout.
 *
 * The region's scroller is reset to its top first, because the first viewport is the landing view
 * and not wherever the browser restored: a control 722 px down the region is below the fold even
 * if a previous test scrolled to it. `region` is null for the shell's problem card, which is not a
 * surface region but the whole window.
 */
async function readRegion(page: Page, region: string | null): Promise<ViewportReading> {
  return await page.evaluate(
    ({ regionSelector, controlSelector }) => {
      const element = document.querySelector<HTMLElement>(regionSelector ?? ".problem-view");
      if (element === null) return { mounted: false, controls: [], text: "", lines: [], problemCard: false };
      const scroller = element.querySelector<HTMLElement>(".surface-content");
      if (scroller !== null) scroller.scrollTop = 0;
      const inside = (rect: DOMRect): boolean =>
        rect.top >= -1 && rect.bottom <= window.innerHeight + 1 && rect.left >= -1 && rect.right <= window.innerWidth + 1;
      // `painted` is the browser's own answer (`checkVisibility`), not geometry: a child of a closed
      // `<details>` keeps a layout box in Chromium, so a rect alone counts a control the player cannot
      // see - and the refused-press half of this gate would then be satisfied by an invisible remedy.
      const controls = [...element.querySelectorAll<HTMLElement>(controlSelector)].map((node, index) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          index,
          name: (node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 60),
          testId: node.getAttribute("data-testid"),
          tag: node.tagName.toLowerCase(),
          disabled: node.matches(":disabled") || node.getAttribute("aria-disabled") === "true",
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          painted: node.checkVisibility() && style.display !== "none" && rect.width > 0 && rect.height > 0,
          inViewport: inside(rect),
        };
      });
      const lines = [...element.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')].map((node) => ({
        testId: node.getAttribute("data-testid"),
        text: (node.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 140),
        inViewport: inside(node.getBoundingClientRect()),
      }));
      const text = (element.innerText ?? "").replace(/\s+/gu, " ").trim();
      return {
        mounted: true,
        controls,
        text: text.slice(0, 600),
        lines,
        problemCard: element.classList.contains("problem-view"),
      };
    },
    { regionSelector: region, controlSelector: CONTROL_SELECTOR },
  );
}

/** One surface's region, as the shell renders it. */
const readFirstViewport = (page: Page, testId: string): Promise<ViewportReading> =>
  readRegion(page, `[data-testid="${testId}"]`);

/** The controls the first viewport actually offers: painted, enabled and wholly inside the window. */
const forwardOf = (reading: ViewportReading): readonly ControlReading[] =>
  reading.controls.filter((control) => control.painted && !control.disabled && control.inViewport);

/** One control, as a sentence a failure can name it by. */
const describeControl = (control: ControlReading): string =>
  `<${control.tag}${control.testId === null ? "" : ` data-testid="${control.testId}"`}> "${control.name}"` +
  ` at y ${control.top}..${control.bottom}${control.disabled ? " (disabled)" : ""}${control.inViewport ? "" : " (below the fold)"}`;

/**
 * The declared step of every Game phase, as the control the panel draws for it.
 *
 * `null` is a step that is not a control on this page at all, and each one is a decision the
 * product already states: `terminal` is the shell's surface switch (the phase has no step of its
 * own), `wait_for_game` is the game's own progress, and `restart_gamebuddy` is a fresh GameBuddy.
 * Those three must instead *state* themselves inside the viewport, which is what the caller
 * asserts. A step added to `GameSessionForwardAction` with no entry here is named by the gate as
 * drift rather than silently skipped.
 */
const GAME_STEP_CONTROL: Readonly<Record<string, string | null>> = {
  activate: "game-activate",
  setup: "game-setup",
  launch: "game-launch",
  reopen: "game-reopen",
  stop: "game-stop",
  disconnect: "game-disconnect",
  endgame: "game-endgame-open",
  resume: "game-resume",
  retry_resume: "game-resume",
  cancel_resume: "game-resume-cancel",
  create: "game-create",
  // `game_not_read`: the Host could not read the instance row, so the panel's own reread is the
  // step - the same `data-testid="game-reread"` control `GameStatePanel` draws for it.
  reread_game: "game-reread",
  terminal: null,
  wait_for_game: null,
  restart_gamebuddy: null,
};

/** The standing sentence a non-control step is, and the line the panel draws it as. */
const GAME_STEP_STATEMENT: Readonly<Record<string, string | null>> = {
  terminal: null,
  wait_for_game: "game-waiting-for-game",
  restart_gamebuddy: "game-launch-quarantined",
};

// ---------------------------------------------------------------------------------------------
// 4. The states of each surface
// ---------------------------------------------------------------------------------------------

type StateUnderTest = Readonly<{
  surface: Surface;
  state: StateFixture;
  /** The control the state's own declaration names as its step, when it names one. */
  declaredControlTestId: string | null;
  /** The sentence the state owes when its step is not a control on this page. */
  declaredStatementTestId: string | null;
}>;

/**
 * The Game surface's states: the product's own phase list, each with the projection it declares.
 *
 * `deriveGameSessionControls` is the real derivation the panel reads, so the step asserted here is
 * the one the surface itself would offer - not a second opinion about the same projection.
 */
function gameStates(surface: Surface): readonly StateUnderTest[] {
  return GAME_SESSION_PHASES.map((phase) => {
    const input = GAME_SESSION_INPUTS[phase];
    const controls = deriveGameSessionControls(input);
    const step = controls.forwardActions[0];
    if (step === undefined) throw new Error(`game phase ${phase} declares no forward action`);
    if (!(step in GAME_STEP_CONTROL))
      throw new Error(
        `game phase ${phase} offers "${step}", which this gate has no control for - declare its control in ` +
          "GAME_STEP_CONTROL (or null when it is not a control on this page)",
      );
    return {
      surface,
      state: { id: phase, game: input.game === null ? null : input.game.game, submit: "available" },
      declaredControlTestId: GAME_STEP_CONTROL[step] ?? null,
      declaredStatementTestId: GAME_STEP_CONTROL[step] === null ? (GAME_STEP_STATEMENT[step] ?? null) : null,
    };
  });
}

/** The conversation's states: the availability values the contract declares for an operation. */
function chatStates(surface: Surface): readonly StateUnderTest[] {
  if (SUBMIT_AVAILABILITY.length === 0)
    throw new Error(`the contract declares no availability values for an operation (${CONTRACT_FILE})`);
  return SUBMIT_AVAILABILITY.map((availability) => ({
    surface,
    state: { id: `submit:${availability}`, game: GAME_PROJECTION, submit: availability },
    declaredControlTestId: null,
    declaredStatementTestId: null,
  }));
}

/**
 * A surface with no declared state population of its own: the projection a first-run player meets.
 *
 * It is one state, and it is the one that matters most, because it is what a fresh install lands
 * on. The surface's richer view states (`ConnectionView` and its siblings in
 * `src/components/management-panels.tsx`) exist only as TypeScript unions with no runtime
 * population and no fixture, so they are reported as unassessed below instead of being invented
 * here.
 */
function freshState(surface: Surface): readonly StateUnderTest[] {
  return [
    {
      surface,
      state: { id: "fresh", game: GAME_PROJECTION, submit: "available" },
      declaredControlTestId: null,
      declaredStatementTestId: null,
    },
  ];
}

/**
 * Which states each surface is measured in.
 *
 * The surface population itself is derived; this record only binds a surface to the *source* of
 * its states, which is knowledge a fixture cannot derive. A surface the shell grows without an
 * entry here is a named failure, not a silent pass - and the conversation and the Game surface
 * are looked up by their own route constants, not by a retyped string.
 */
const STATE_SOURCES: Readonly<Record<string, (surface: Surface) => readonly StateUnderTest[]>> = {
  [surfaceRoute.CHAT_PANEL]: chatStates,
  [surfaceRoute.GAME_PANEL]: gameStates,
  [surfaceRoute.CHATS_PANEL]: freshState,
  [surfaceRoute.CHARACTERS_PANEL]: freshState,
  [surfaceRoute.SETTINGS_PANEL]: freshState,
  [surfaceRoute.MEMORY_PANEL]: freshState,
  // The preset readout has no command of its own (presets are imported once and read from then on), so its step
  // forward is the shell's surface switch, exactly like the other read-only management surfaces above.
  [surfaceRoute.PRESETS_PANEL]: freshState,
};

function statesOf(surface: Surface): readonly StateUnderTest[] {
  const source = STATE_SOURCES[surface.panel];
  if (source === undefined)
    throw new Error(
      `surface "${surface.panel}" is declared by src/composed-surface-route.ts and has no state source here - ` +
        "bind it in STATE_SOURCES (freshState is the first-run projection) so its first viewport is measured",
    );
  return source(surface);
}

// ---------------------------------------------------------------------------------------------
// 5. The assertions
// ---------------------------------------------------------------------------------------------

/**
 * Mount one state and measure it.
 *
 * `page.on("response")` is how "the press reached the Host" is decided: a control that answers
 * nothing is inert, whatever it looks like. The 4xx/5xx half of the same reading is what makes a
 * refusal a different fact from a step.
 */
async function mount(page: Page, under: StateUnderTest): Promise<Readonly<{ requests: string[]; responses: number[] }>> {
  const requests: string[] = [];
  const responses: number[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => responses.push(response.status()));
  await page.setViewportSize(VIEWPORT);
  await stubRoutes(page, under.state);
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=${under.surface.panel}`);
  // The region must exist before anything about it can be measured. A state that never mounts is
  // reported with what the page does show, because "the surface is absent" is a different defect
  // from "the surface offers nothing" and the reader has to be able to tell them apart.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await readFirstViewport(page, under.surface.testId)).mounted) return { requests, responses };
    await page.waitForTimeout(250);
  }
  const shown = await page.evaluate(() => (document.body.innerText ?? "").replace(/\s+/gu, " ").slice(0, 600));
  throw new Error(
    `${under.surface.panel}/${under.state.id}: the region [data-testid="${under.surface.testId}"] never mounted; ` +
      `the page reads: ${shown}`,
  );
}

for (const surface of SURFACES) {
  for (const under of statesOf(surface)) {
    test(`${surface.panel} / ${under.state.id}: the first viewport offers a step forward`, async ({ page }) => {
      const host = await mount(page, under);
      const reading = await readFirstViewport(page, surface.testId);
      const forward = forwardOf(reading);
      console.log(
        `[forward-path] ${surface.panel}/${under.state.id} forward=${JSON.stringify(forward.map(describeControl))} ` +
          `all=${JSON.stringify(reading.controls.map(describeControl))}`,
      );

      // 1. The state's own declaration decides what "a step forward" is here. Where it names a
      //    control, that control is what the first viewport must carry; where it names a sentence
      //    (`wait_for_game`, `restart_gamebuddy`), the sentence is what the player needs; where it
      //    names nothing at all (`terminal`), the step is the shell's own surface switch.
      if (under.declaredControlTestId !== null) {
        const declared = reading.controls.find((control) => control.testId === under.declaredControlTestId);
        expect(
          declared === undefined
            ? "absent"
            : `${declared.disabled ? "disabled" : "enabled"}/${declared.inViewport ? "in viewport" : `at y ${declared.top}`}`,
          `${surface.panel}/${under.state.id} declares "${under.declaredControlTestId}" as its step, and the first viewport ` +
            `must offer it enabled and wholly inside the ${VIEWPORT.width}x${VIEWPORT.height} window. Everything the ` +
            `region holds: ${reading.controls.map(describeControl).join(", ") || "(nothing)"}`,
        ).toBe("enabled/in viewport");
        // The viewport is not a wall: whatever else is true, something in it is pressable.
        expect(
          forward.length,
          `${surface.panel}/${under.state.id} offers no enabled control inside the ${VIEWPORT.width}x${VIEWPORT.height} ` +
            `first viewport. Everything the region holds: ${reading.controls.map(describeControl).join(", ") || "(nothing)"}`,
        ).toBeGreaterThan(0);
      } else if (under.declaredStatementTestId !== null) {
        const line = reading.lines.find((entry) => entry.testId === under.declaredStatementTestId);
        expect(
          line === undefined ? "absent" : line.inViewport ? "in viewport" : "below the fold",
          `${surface.panel}/${under.state.id} has no control of its own, so it owes the step in words ` +
            `("${under.declaredStatementTestId}") inside the first viewport; the region reads: ${reading.text}`,
        ).toBe("in viewport");
      } else {
        // `terminal`: the phase's step is the shell's surface switch, which is chrome outside the
        // region - so the bar is what has to offer a way off this surface.
        const chrome = await readRegion(page, ".app-bar");
        const switches = forwardOf(chrome);
        expect(
          switches.length,
          `${surface.panel}/${under.state.id} has no step of its own, so the shell's surface switch must be inside the ` +
            `first viewport; the app bar offers: ${chrome.controls.map(describeControl).join(", ") || "(nothing)"}`,
        ).toBeGreaterThan(0);
      }

      // 2. The step actually moves something: a press that reaches no route and changes nothing on
      //    screen is a control that exists and does not advance the flow.
      const target = under.declaredControlTestId ?? null;
      const chosen =
        target === null
          ? forward[0]
          : forward.find((control) => control.testId === target) ?? forward[0];
      if (chosen === undefined) return;
      const requestsBefore = host.requests.length;
      const responsesBefore = host.responses.length;
      const textBefore = reading.text;
      const controlHandle = await page.evaluateHandle(
        ({ regionSelector, controlSelector, index }) =>
          document.querySelector(regionSelector)?.querySelectorAll(controlSelector)[index] ?? null,
        { regionSelector: `[data-testid="${surface.testId}"]`, controlSelector: CONTROL_SELECTOR, index: chosen.index },
      );
      const control = controlHandle.asElement();
      expect(control === null, `${surface.panel}/${under.state.id}: ${describeControl(chosen)} is no longer on the page`).toBe(false);
      if (control === null) return;
      // "Press" is the interaction the player performs on this kind of control, not a click on all of
      // them: a text field advances by taking text (that is how a message starts), and a picker by
      // choosing an option - a native click on either opens no dropdown in a headless browser and
      // would measure the harness instead of the surface.
      let takenByInteraction = false;
      if (chosen.tag === "select") {
        const options = await control.evaluate((node) => (node instanceof HTMLSelectElement ? node.options.length : 0));
        expect(
          options,
          `${surface.panel}/${under.state.id}: ${describeControl(chosen)} offers no choice to make`,
        ).toBeGreaterThan(1);
        await control.selectOption({ index: 1 });
      } else if (chosen.tag === "input" || chosen.tag === "textarea") {
        await control.fill("A first line.");
        takenByInteraction = (await control.inputValue()) === "A first line.";
      } else {
        await control.click();
      }
      await page.waitForTimeout(500);
      const after = await readFirstViewport(page, surface.testId);
      const pressedResponses = host.responses.slice(responsesBefore);
      const advanced = takenByInteraction || host.requests.length > requestsBefore || after.text !== textBefore || !after.mounted;
      console.log(
        `[forward-path] ${surface.panel}/${under.state.id} pressed=${describeControl(chosen)} ` +
          `requests=${host.requests.length - requestsBefore} responses=${JSON.stringify(pressedResponses)} ` +
          `moved=${String(after.text !== textBefore)}`,
      );
      expect(
        advanced,
        `${surface.panel}/${under.state.id}: pressing ${describeControl(chosen)} reached no Host route and changed ` +
          "nothing on screen, so the first viewport offers no step that advances the flow",
      ).toBe(true);

      // 3. A refused press is not a step out. If the Host said no, the player needs something else
      //    to press in the same viewport - otherwise the state names its own refusal and stops.
      const refused = pressedResponses.some((status) => status >= 400);
      if (!refused) return;
      const remaining = forwardOf(after).filter((control) => control.index !== chosen.index);
      console.log(
        `[forward-path] ${surface.panel}/${under.state.id} refused=${JSON.stringify(pressedResponses)} ` +
          `remaining=${JSON.stringify(remaining.map(describeControl))} ` +
          `lines=${JSON.stringify(after.lines.map((line) => line.text))}`,
      );
      expect(
        remaining.length,
        `${surface.panel}/${under.state.id}: the press of ${describeControl(chosen)} was refused ` +
          `(${JSON.stringify(pressedResponses)}) and the first viewport offers nothing else to press. ` +
          `The refusal reads: ${after.lines.map((line) => line.text).join(" | ") || after.text}`,
      ).toBeGreaterThan(0);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 6. The shell's own states, and what this gate cannot assess
// ---------------------------------------------------------------------------------------------

/**
 * The shell's states, from its own `ViewState` union.
 *
 * `ready` is the surfaces above; the other members are the whole-window states, and each one is
 * measured here or named as a gap.
 */
test("the shell's own states are each measured or named as a gap", async ({ page }) => {
  expect(
    SHELL_STATE_KINDS.length,
    `src/components/composed-reference-game-view.ts declares no ViewState kinds, so this gate's shell population is empty`,
  ).toBeGreaterThan(0);

  const assessed: string[] = [];
  const unassessed: string[] = [];
  if (PROBLEM_STEP_KINDS.length > 0)
    unassessed.push(
      `${PROBLEM_STEP_KINDS.join("/")} - reached through ProblemViewState's step, and not a state of the shell: ` +
        "`tools/check-fail-closed-forward-path.mjs` owns that vocabulary",
    );

  for (const kind of SHELL_STATE_KINDS) {
    if (kind === "ready") {
      assessed.push(`${kind} (the ${SURFACES.length} surfaces above)`);
      continue;
    }
    if (kind === "loading") {
      // The shell draws a placeholder and no control at all, and it declares no way out: the state
      // ends when the read answers. Naming that is the honest reading - inventing a control here
      // would be inventing a product decision.
      unassessed.push(`loading - the shell declares no control for this state; it ends when the read answers`);
      continue;
    }
    if (kind === "problem") {
      await page.setViewportSize(VIEWPORT);
      await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
        route.fulfill(problem(503, "storage_unavailable")),
      );
      await page.goto(`/#profile=composed-reference-game&boot=${token}`);
      await expect(page.locator(".problem-view")).toBeVisible();
      const reading = await readRegion(page, null);
      const forward = forwardOf(reading);
      console.log(
        `[forward-path] shell/problem forward=${JSON.stringify(forward.map(describeControl))} ` +
          `all=${JSON.stringify(reading.controls.map(describeControl))}`,
      );
      expect(
        forward.length,
        `shell/problem is a dead end: the failure screen offers no enabled control inside the ` +
          `${VIEWPORT.width}x${VIEWPORT.height} first viewport. Everything it holds: ` +
          `${reading.controls.map(describeControl).join(", ") || "(nothing)"}`,
      ).toBeGreaterThan(0);
      assessed.push(`${kind} (${forward.map((control) => `"${control.name}"`).join(", ")})`);
      continue;
    }
    unassessed.push(`${kind} - this gate has no fixture for it`);
  }

  // The four management surfaces' richer view states are declared only as types. Each union is
  // named, with the file it lives in, so the gap is a line in the report rather than a silence.
  for (const [name, typeName] of [
    ["settings", "ConnectionView"],
    ["settings", "LanguageView"],
    ["settings", "ModelProfilesView"],
    ["settings", "VoiceView"],
    ["memory", "MemoryView"],
  ] as const)
    unassessed.push(
      `${name}/${typeName} - declared only as a TypeScript union in src/components/management-panels.tsx, ` +
        "with no runtime population and no fixture in this gate",
    );

  console.log(
    `[forward-path] population surfaces=${SURFACES.length} ` +
      `states=${SURFACES.map((surface) => `${surface.panel}:${statesOf(surface).length}`).join(" ")}`,
  );
  for (const entry of assessed) console.log(`[forward-path] assessed: ${entry}`);
  for (const entry of unassessed) console.log(`[forward-path] unassessed: ${entry}`);
});

/**
 * Every refusal the tavern contract can answer with, on the card that shows it, at 400x800.
 *
 * The defect this is written against is the card's own history: one button for all sixty-six codes,
 * so `turn_busy`, `session_expired` and `payload_too_large` each offered a re-read that could not
 * help, and a reader could not tell a step they could take from one they could not. The answer is
 * now the failure's own `step` (`src/composed-problem-view.ts`), and the card renders it as it is: a
 * button when the step is the card's own read, and otherwise a sentence naming what to do instead.
 *
 * So the assertion is the shape a player needs, not a list of expected words: per code, either an
 * enabled control inside the window or a non-empty step line inside it. A `no_step` refusal is
 * covered by the same rule - its line is what says the request cannot be carried out, and an empty
 * or absent line is exactly the dead end this exists to catch.
 *
 * The population is the contract mirror's own closed union, so a code added to the contract is
 * measured the first time this runs.
 */
test("every tavern problem code leaves a step in the first viewport", async ({ page }) => {
  test.setTimeout(300_000);
  expect(
    PROBLEM_CODES.length,
    "src/reference-pipeline-api.ts declares no problem codes, so this gate's population is empty",
  ).toBeGreaterThan(0);

  // One handler, switched per code: re-registering a route per iteration would stack handlers and
  // answer with whichever was registered last rather than with the code under test.
  let underTest = "";
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(problem(403, underTest)));

  const deadEnds: string[] = [];
  for (const code of PROBLEM_CODES) {
    underTest = code;
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/#profile=composed-reference-game&boot=${token}`);
    const card = page.locator(".problem-view");
    await expect(card, `${code}: the problem card never mounted`).toBeVisible();

    const control = page.locator(".problem-view button");
    const controls = await control.count();
    const enabled = controls > 0 ? (await control.first().isEnabled()) && (await control.first().boundingBox()) : null;
    const inWindow = enabled !== null && enabled.y >= -1 && enabled.y + enabled.height <= VIEWPORT.height + 1;

    const stepLine = page.locator('.problem-view [data-testid="problem-step"]');
    const lines = await stepLine.count();
    const text = lines > 0 ? ((await stepLine.first().textContent()) ?? "").trim() : "";
    const lineBox = lines > 0 ? await stepLine.first().boundingBox() : null;
    const lineInWindow = lineBox !== null && lineBox.y >= -1 && lineBox.y + lineBox.height <= VIEWPORT.height + 1;

    const reads = (await card.innerText()).replace(/\s+/gu, " ").trim();
    if (!((inWindow && enabled !== null) || (text.length > 0 && lineInWindow)))
      deadEnds.push(
        `${code}: controls ${controls}, step lines ${lines} ("${text}"), card reads: ${reads}`,
      );
  }

  console.log(`[forward-path] problem codes measured: ${PROBLEM_CODES.length}, dead ends: ${deadEnds.length}`);
  expect(
    deadEnds.length,
    `${deadEnds.length} of ${PROBLEM_CODES.length} refusals leave the player nothing to act on inside the ` +
      `${VIEWPORT.width}x${VIEWPORT.height} first viewport:\n${deadEnds.join("\n")}`,
  ).toBe(0);
});
