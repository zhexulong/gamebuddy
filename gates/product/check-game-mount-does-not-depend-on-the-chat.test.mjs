/**
 * The falsifiers for `check-game-mount-does-not-depend-on-the-chat.mjs`.
 *
 * Each case builds a small tree whose files have the SHAPE the product has - the root schema with its two
 * halves, a module that renders the shell, the module that names the platform routes - and asks the gate for
 * its verdict. The claims:
 *
 *   1. THE TREE PASSES, with the populations printed: the schema's two members both optional, the shell's five
 *      subjects, the Chat-half comparisons, the Host's four declared platform routes with a browser client each.
 *   2. A REQUIRED CHAT MEMBER IS RED, naming BOTH members and both shapes - the schema the PLATFORMSPLIT lane
 *      was written against, where a missing Chat half was a root the broker refuses.
 *   3. A SHELL CONDITION ON THE CHAT HALF IS RED AT ITS OWN LINE, naming the AppBar and the Game surface the
 *      condition withholds.
 *   4. A FALLBACK THE GAME HALF ALSO ANSWERS IS NOT A CHAT-HALF CONDITION: the same guard over
 *      `chatSession?.snapshot.csrfToken ?? view.root.game?.csrfToken ?? null` stays green, because the Game half
 *      can answer it alone.
 *   5. THE FAMILY IS THE BROWSER'S ONLY SOURCE: a Chat-half spelling that came back is
 *      `platform_fact_read_through_the_chat_half` at its own line; a declared route nobody reads is
 *      `platform_route_unread`; a `/api/platform/v1/...` route the Host's declaration does not name is
 *      `platform_route_unjudged`.
 *   6. ZERO POPULATION BLOCKS: an empty tree, a tree with no shell subject, and a tree where nothing reads the
 *      Chat half are each blocked with the population named.
 *
 * red-proof: history  `chat: TavernStateSnapshotV1Schema` beside the optional `game` ->
 *   `root_half_optionality_differs` naming `chat` REQUIRED and `game` optional (the shape HEAD carried)
 * red-proof: inject   `{mountedChat !== null && (<><AppBar /><main className="app-main-content"><GameSurface />`
 *   -> `game_mount_is_gated_on_the_chat_half` at the condition's line, naming app-bar, shell-region and
 *   game-surface; the same guard over a token the Game half also answers is green
 *   (gates/product/check-game-mount-does-not-depend-on-the-chat.test.mjs)
 * red-proof: inject   a browser read of `/api/tavern/v1/settings/appearance` after the platform route took it over
 *   -> `platform_fact_read_through_the_chat_half` naming the concern and the route that replaced it; a declared
 *   route with no browser caller -> `platform_route_unread`; `/api/platform/v1/status` with no declaration ->
 *   `platform_route_unjudged` (gates/product/check-game-mount-does-not-depend-on-the-chat.test.mjs)
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import {
  checkTheGameMountDoesNotDependOnTheChat,
  PLATFORM_ROUTE_DECLARATION,
  ROOT_SCHEMA,
  SHELL_COMPONENTS,
} from "./check-game-mount-does-not-depend-on-the-chat.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);
const WEB_SOURCES = "dialogue-web/src";
const SHELL_FILE = `${SHELL_COMPONENTS}/ComposedReferenceGameApp.tsx`;
const ROUTES_FILE = `${WEB_SOURCES}/management-pipeline-api.ts`;

const CHAT_OPTIONAL = "chat: Type.Optional(Type.Union([TavernStateSnapshotV1Schema, Type.Null()])),";
const GAME_OPTIONAL = "game: Type.Optional(Type.Union([GameBrowserStateV1Schema, Type.Null()])),";

/**
 * The Host's own declaration of the platform's route family, as the root schema module publishes it.
 *
 * It lives in the same file as the root schema because that is where the product declares it
 * (`COMPOSED_PLATFORM_ROUTES_V1` in `host/src/composed-browser-contract/index.ts`), so a case that moves a route
 * changes one file and the gate reads the declaration rather than a second list.
 */
const platformRoutes = ({
  appearance = "/api/platform/v1/appearance",
  locale = "/api/platform/v1/locale",
  replacesAppearance = ["/api/tavern/v1/settings/appearance"],
  replacesLocale = ["/api/tavern/v1/settings/ui-language"],
} = {}) => `
export const ${PLATFORM_ROUTE_DECLARATION} = Object.freeze([
  Object.freeze({ concern: "appearance" as const, method: "GET" as const, path: "${appearance}", replaces: Object.freeze([${replacesAppearance.map((entry) => `"${entry}"`).join(", ")}]) }),
  Object.freeze({ concern: "appearance" as const, method: "PUT" as const, path: "${appearance}", replaces: Object.freeze([${replacesAppearance.map((entry) => `"${entry}"`).join(", ")}]) }),
  Object.freeze({ concern: "locale" as const, method: "GET" as const, path: "${locale}", replaces: Object.freeze([${replacesLocale.map((entry) => `"${entry}"`).join(", ")}]) }),
  Object.freeze({ concern: "locale" as const, method: "PUT" as const, path: "${locale}", replaces: Object.freeze([${replacesLocale.map((entry) => `"${entry}"`).join(", ")}]) }),
]);
`;

/** The root schema as its own declaration, with the two members a case supplies. */
const schema = ({ chat = CHAT_OPTIONAL, game = GAME_OPTIONAL } = {}) => `
export const ComposedReferenceGameBrowserRootV1Schema = strictObject({
  apiVersion: Type.Literal(1),
  build: strictObject({ profileId: Type.String() }),
  ${chat}
  ${game}
});
${platformRoutes()}
`;

/**
 * The browser's side: it reads the platform's four wire shapes and no Chat-half spelling of either concern.
 *
 * A case that wants a Chat-half read back, or a declared route nobody asks for, changes one line here.
 */
const routes = (lines = []) => `
export const readAppearance = () => fetch("/api/platform/v1/appearance");
export const writeAppearance = () => fetch("/api/platform/v1/appearance", { method: "PUT" });
export const readLocale = () => fetch("/api/platform/v1/locale");
export const writeLocale = () => fetch("/api/platform/v1/locale", { method: "PUT" });
${lines.join("\n")}
`;

/** A shell whose subjects are peers of the Chat half: the guard is a token either half can answer. */
const SHELL_PEERS = `export function ComposedReferenceGameApp({ view }) {
  const chatSession = view.kind === "ready" ? view.session : null;
  const shellCsrfToken = chatSession?.snapshot.csrfToken ?? view.root.game?.csrfToken ?? null;
  return (
    <div className="tavern-app-shell">
      {view.kind === "ready" && shellCsrfToken !== null && (
        <>
          <AppBar entries={[]} />
          <main className="app-main-content">
            <GameSurface game={view.root.game} />
          </main>
        </>
      )}
      {chatSession !== null && <ChatSurface />}
    </div>
  );
}
`;

/** The shell as it stood at HEAD: the bar, the region and the Game surface inside a condition on the Chat half. */
const SHELL_GATED = `export function ComposedReferenceGameApp({ view }) {
  const chatSession = view.kind === "ready" ? view.session : null;
  const mountedChat = chatSession === null ? null : chatSession.snapshot.chat;
  return (
    <div className="tavern-app-shell">
      {mountedChat !== null && (
        <>
          <AppBar entries={[]} />
          <main className="app-main-content">
            <GameSurface game={view.root.game} />
          </main>
        </>
      )}
    </div>
  );
}
`;

/** A shell with no Chat-half condition anywhere: nothing for reading 2 to judge. */
const SHELL_WITHOUT_A_CHAT_CONDITION = `export function Shell({ view }) {
  return (
    <div className="tavern-app-shell">
      <AppBar entries={[]} />
      <GameSurface game={view.root.game} />
    </div>
  );
}
`;

/** A component module with no shell subject in it at all. */
const PANEL = `export function Panel({ view }) {
  return <div className="panel">{view.kind}</div>;
}
`;

/** The line a needle sits on, derived from the fixture's own text rather than counted here. */
const lineOfSource = (source, needle) => source.slice(0, source.indexOf(needle)).split("\n").length;

/** A throwaway tree holding exactly the files a case names. */
function fixtureTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "game-mount-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return root;
}

/** A green tree, so a case that wants one defect changes exactly one file. */
const greenTree = (t, overrides = {}) =>
  fixtureTree(t, {
    [ROOT_SCHEMA]: schema(),
    [SHELL_FILE]: SHELL_PEERS,
    [ROUTES_FILE]: routes(),
    ...overrides,
  });

const codes = (reading) => reading.violations.map((violation) => violation.code);

test("the tree passes: the halves are peers and no shell subject hangs from the Chat half", () => {
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", JSON.stringify(reading.violations, null, 1));
  assert.deepEqual(
    reading.members.map((member) => `${member.name}:${member.optional ? "optional" : "required"}`),
    ["chat:optional", "game:optional"],
  );
  assert.ok(reading.population > 0, `examined ${String(reading.population)} module(s) under ${SHELL_COMPONENTS}`);
  assert.ok(
    reading.shellSubjects.some((subject) => subject.id === "app-bar") &&
      reading.shellSubjects.some((subject) => subject.id === "game-surface"),
    "the shell's own subjects are resolved, or reading 2 measured nothing",
  );
  assert.ok(reading.comparisons.length > 0, "the Chat half's presence is compared somewhere in the shell's tree");
  assert.equal(reading.debtRows.length, 4, "the Host declares four platform wire shapes");
  assert.ok(
    reading.debtRows.every((row) => row.clients > 0),
    `every declared platform route has a browser client: ${JSON.stringify(reading.debtRows)}`,
  );
  assert.ok(
    reading.retired.every((row) => row.sites === 0),
    `no Chat-half spelling of a platform concern is read: ${JSON.stringify(reading.retired)}`,
  );
});

test("a required Chat member beside an optional Game is named with both members and both shapes", (t) => {
  const declared = schema({ chat: "chat: TavernStateSnapshotV1Schema," });
  const root = greenTree(t, { [ROOT_SCHEMA]: declared });
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root });
  assert.equal(reading.status, "failed");
  assert.ok(codes(reading).includes("root_half_optionality_differs"), codes(reading).join(", "));
  const violation = reading.violations.find((entry) => entry.code === "root_half_optionality_differs");
  const chatLine = lineOfSource(declared, "chat: TavernStateSnapshotV1Schema");
  const gameLine = lineOfSource(declared, "game: Type.Optional");
  assert.equal(violation.at, `${ROOT_SCHEMA}:${chatLine},${gameLine}`);
  assert.match(violation.detail, new RegExp(`\`chat\` is REQUIRED at line ${chatLine}`, "u"));
  assert.match(violation.detail, new RegExp(`\`game\` is optional at line ${gameLine}`, "u"));
  assert.match(violation.detail, /Game surface that cannot mount/u);
});

test("a shell condition on the Chat half is red at its own line, naming what it withholds", (t) => {
  const root = greenTree(t, { [SHELL_FILE]: SHELL_GATED });
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root });
  assert.equal(reading.status, "failed");
  assert.deepEqual(codes(reading), ["game_mount_is_gated_on_the_chat_half"]);
  const violation = reading.violations[0];
  assert.equal(violation.at, `${SHELL_FILE}:${lineOfSource(SHELL_GATED, "mountedChat !== null")}`);
  assert.match(violation.detail, /`mountedChat !== null`/u);
  assert.match(violation.detail, /app-bar at line \d+ \(AppBar\)/u);
  assert.match(violation.detail, /game-surface at line \d+ \(GameSurface\)/u);
  assert.match(violation.detail, /shell-region/u);
});

test("a fallback the Game half also answers is not a Chat-half condition", (t) => {
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root: greenTree(t) });
  assert.equal(reading.status, "passed", JSON.stringify(reading.violations, null, 1));
  // The shell's guard is a `??` chain whose other arm is the Game half's own token: it is not in the
  // Chat-half population at all, which is what keeps this reading from flagging the fix as the defect.
  assert.deepEqual(
    reading.comparisons.filter((comparison) => comparison.text.includes("shellCsrfToken")),
    [],
  );
  assert.ok(
    reading.comparisons.some((comparison) => comparison.text === "chatSession !== null"),
    "the Chat half's own guard is still read, so the reading did not simply lose the file",
  );
});

test("a Chat-half spelling that came back is red at its own line, naming the route that replaced it", (t) => {
  const browser = routes(['export const moved = fetch("/api/tavern/v1/settings/appearance");']);
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root: greenTree(t, { [ROUTES_FILE]: browser }) });
  assert.equal(reading.status, "failed");
  const violation = reading.violations.find((entry) => entry.code === "platform_fact_read_through_the_chat_half");
  assert.ok(violation !== undefined, codes(reading).join(", "));
  assert.equal(violation.at, `${ROUTES_FILE}:${lineOfSource(browser, "/api/tavern/v1/settings/appearance")}`);
  assert.match(violation.detail, /the Chat half's spelling of the appearance/u);
  assert.match(violation.detail, /`GET \/api\/platform\/v1\/appearance` took it over/u);
  assert.match(violation.detail, /reachable only where a Chat half is/u);
});

test("a declared platform route nobody reads is red, naming the wire shape", (t) => {
  const declared = schema();
  const root = greenTree(t, {
    [ROOT_SCHEMA]: declared.replace(
      /path: "\/api\/platform\/v1\/locale", replaces: Object\.freeze\(\["\/api\/tavern\/v1\/settings\/ui-language"\]\) \}\),\n  Object\.freeze\(\{ concern: "locale" as const, method: "PUT" as const/u,
      'path: "/api/platform/v1/nowhere", replaces: Object.freeze(["/api/tavern/v1/settings/ui-language"]) }),\n  Object.freeze({ concern: "locale" as const, method: "PUT" as const',
    ),
  });
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root });
  const violation = reading.violations.find((entry) => entry.code === "platform_route_unread");
  assert.ok(violation !== undefined, codes(reading).join(", "));
  assert.match(violation.detail, /GET \/api\/platform\/v1\/nowhere/u);
  assert.match(violation.detail, /no browser module under dialogue-web\/src reads it/u);
});

test("a platform route no declaration names is unjudged, never passed", (t) => {
  const declared = routes(['export const status = fetch("/api/platform/v1/status");']);
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root: greenTree(t, { [ROUTES_FILE]: declared }) });
  assert.deepEqual(codes(reading), ["platform_route_unjudged"]);
  assert.equal(reading.violations[0].at, `${ROUTES_FILE}:${lineOfSource(declared, "/api/platform/v1/status")}`);
  assert.match(reading.violations[0].detail, new RegExp(PLATFORM_ROUTE_DECLARATION, "u"));
});

test("a Host whose declaration cannot be read blocks rather than passing", (t) => {
  const root = greenTree(t, { [ROOT_SCHEMA]: schema().replace(PLATFORM_ROUTE_DECLARATION, "SOMETHING_ELSE") });
  const reading = checkTheGameMountDoesNotDependOnTheChat({ root });
  assert.equal(reading.status, "blocked");
  assert.match(String(reading.blocked), /platform_routes_not_declared/u);
});

test("zero populations block, each naming the population it lost", (t) => {
  const empty = checkTheGameMountDoesNotDependOnTheChat({ root: fixtureTree(t, {}) });
  assert.equal(empty.status, "blocked");
  assert.match(String(empty.blocked), /root_schema_unreadable/u);
  assert.match(String(empty.blocked), /shell_modules_empty/u);
  assert.match(String(empty.blocked), /platform_reaches_not_found/u);

  const noSubject = checkTheGameMountDoesNotDependOnTheChat({
    root: greenTree(t, { [SHELL_FILE]: PANEL }),
  });
  assert.equal(noSubject.status, "blocked");
  assert.match(String(noSubject.blocked), /shell_subjects_not_found/u);

  const noCondition = checkTheGameMountDoesNotDependOnTheChat({
    root: greenTree(t, { [SHELL_FILE]: SHELL_WITHOUT_A_CHAT_CONDITION }),
  });
  assert.equal(noCondition.status, "blocked");
  assert.match(String(noCondition.blocked), /chat_half_conditions_empty/u);
});
