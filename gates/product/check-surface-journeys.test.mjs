import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditSurfaceJourneys } from "./check-surface-journeys.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-surface-journeys.mjs");

// red-proof: inject  a declared surface added to a synthetic tree's panel union that no journey asserts
//            on -> `surface_without_journey` names it, while the same tree with one assertion on one of
//            its own ids is green ("a surface no journey asserts on is named" + its control below).
//            Also injected: a journey that only CLICKS the surface's control (`surface_without_journey`
//            again - a click is not an assertion), a panel declared and never rendered by the shell
//            (`surface_without_component`), a test id two surfaces share that therefore witnesses
//            neither, and a panel union that cannot be read (`surface_population_unassessable`).

const roots = [];

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "surface-journeys-"));
  roots.push(root);
  const base = {
    "dialogue-web/src/composed-surface-route.ts": [
      'export const PANEL_PARAM = "panel";',
      'export const CHAT_PANEL = "chat" as const;',
      'export const GAME_PANEL = "game" as const;',
      "",
    ].join("\n"),
    "dialogue-web/src/components/ComposedReferenceGameApp.tsx": [
      'import { CHAT_PANEL, GAME_PANEL } from "../../composed-surface-route";',
      'import { ChatSurface } from "../../tools/ChatSurface";',
      'import { GameSurface } from "../../tools/GameSurface";',
      "",
      "export function App({ shownSurface }) {",
      "  return (",
      "    <main>",
      "      {shownSurface === CHAT_PANEL && (<ChatSurface />)}",
      "      <GameSurface selected={shownSurface === GAME_PANEL} />",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "dialogue-web/src/components/ChatSurface.tsx": [
      "export function ChatSurface() {",
      '  return <section data-testid="chat-surface" testId="chat-surface" />;',
      "}",
      "",
    ].join("\n"),
    "dialogue-web/src/components/GameSurface.tsx": [
      "export function GameSurface() {",
      '  return <section data-testid="game-surface" />;',
      "}",
      "",
    ].join("\n"),
    "dialogue-web/tests/both.spec.ts": [
      'import { expect, test } from "../../tools/frontend-coverage";',
      "",
      'test("the conversation is up", async ({ page }) => {',
      '  await expect(page.getByTestId("chat-surface")).toBeVisible();',
      "});",
      "",
      'test("the game surface is up", async ({ page }) => {',
      '  await expect(page.getByTestId("game-surface")).toBeVisible();',
      "});",
      "",
    ].join("\n"),
  };
  for (const [relativePath, contents] of Object.entries({ ...base, ...files })) {
    if (contents === null) continue;
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

/** The same tree plus one more declared+rendered surface, `memory`, with no journey driving it. */
const MEMORY_SURFACE = {
  "dialogue-web/src/composed-surface-route.ts": [
    'export const PANEL_PARAM = "panel";',
    'export const CHAT_PANEL = "chat" as const;',
    'export const GAME_PANEL = "game" as const;',
    'export const MEMORY_PANEL = "memory" as const;',
    "",
  ].join("\n"),
  "dialogue-web/src/components/ComposedReferenceGameApp.tsx": [
    'import { CHAT_PANEL, GAME_PANEL, MEMORY_PANEL } from "../../composed-surface-route";',
    'import { ChatSurface } from "../../tools/ChatSurface";',
    'import { GameSurface } from "../../tools/GameSurface";',
    'import { MemorySurface } from "../../tools/MemorySurface";',
    "",
    "export function App({ shownSurface }) {",
    "  return (",
    "    <main>",
    "      {shownSurface === CHAT_PANEL && (<ChatSurface />)}",
    "      <GameSurface selected={shownSurface === GAME_PANEL} />",
    "      {shownSurface === MEMORY_PANEL && (<MemorySurface />)}",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "dialogue-web/src/components/MemorySurface.tsx": [
    "export function MemorySurface() {",
    '  return <section data-testid="memory-surface" />;',
    "}",
    "",
  ].join("\n"),
};

const codes = (reading) => reading.findings.map((finding) => `${finding.code}:${finding.surface ?? "-"}`);

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("every declared surface the shell renders and a journey asserts on is reached", () => {
  const reading = auditSurfaceJourneys({ root: makeTree({}) });
  assert.deepEqual(reading.findings, []);
  assert.deepEqual(
    reading.surfaces.map((surface) => surface.id),
    ["chat", "game"],
  );
  assert.equal(reading.surfaces[0].component, "ChatSurface");
  assert.equal(reading.surfaces[1].component, "GameSurface");
});

test("a surface no journey asserts on is named", () => {
  const reading = auditSurfaceJourneys({ root: makeTree(MEMORY_SURFACE) });
  assert.deepEqual(codes(reading), ["surface_without_journey:memory"]);
  assert.deepEqual(reading.unreached, ["memory"]);
});

test("a journey that only clicks the surface's control has not asserted on it", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      ...MEMORY_SURFACE,
      "dialogue-web/tests/both.spec.ts": [
        'import { expect, test } from "../../tools/frontend-coverage";',
        "",
        'test("the conversation is up", async ({ page }) => {',
        '  await expect(page.getByTestId("chat-surface")).toBeVisible();',
        "});",
        "",
        'test("the game surface is up", async ({ page }) => {',
        '  await expect(page.getByTestId("game-surface")).toBeVisible();',
        "});",
        "",
        'test("the memory surface opens", async ({ page }) => {',
        '  await page.getByTestId("memory-surface").click();',
        "});",
        "",
      ].join("\n"),
    }),
  });
  assert.deepEqual(codes(reading), ["surface_without_journey:memory"]);
});

test("one assertion on a surface's own id is enough, and the witness is reported", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      ...MEMORY_SURFACE,
      "dialogue-web/tests/memory.spec.ts": [
        'import { expect, test } from "../../tools/frontend-coverage";',
        "",
        'test("the memory notebook is the region the player sees", async ({ page }) => {',
        '  await expect(page.getByTestId("memory-surface")).toHaveText("Notebook");',
        "});",
        "",
      ].join("\n"),
    }),
  });
  assert.deepEqual(reading.findings, []);
  const memory = reading.surfaces.find((surface) => surface.id === "memory");
  assert.deepEqual(memory.witnesses, [{ journey: "dialogue-web/tests/memory.spec.ts", id: "memory-surface" }]);
});

test("a panel the shell never renders is a declared surface with no way in", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      "dialogue-web/src/composed-surface-route.ts": [
        'export const CHAT_PANEL = "chat" as const;',
        'export const GAME_PANEL = "game" as const;',
        'export const SETTINGS_PANEL = "settings" as const;',
        "",
      ].join("\n"),
    }),
  });
  assert.deepEqual(codes(reading), ["surface_without_component:settings"]);
  assert.match(reading.findings[0].detail, /shownSurface === SETTINGS_PANEL/u);
});

/** The shell's guard line for a surface, in the conjunction shape the product actually writes. */
const guardedChat = (condition) =>
  [
    'import { CHAT_PANEL, GAME_PANEL } from "../../composed-surface-route";',
    'import { ChatSurface } from "../../tools/ChatSurface";',
    'import { GameSurface } from "../../tools/GameSurface";',
    "",
    "export function App({ shownSurface }) {",
    "  return (",
    "    <main>",
    `      {${condition} && (`,
    "        // The card is drawn where the conversation is drawn; `conversation's` is prose, not a string.",
    '        <div className="state-placeholder" data-testid="chat-problem">',
    '          <ProblemView region="chat" />',
    "        </div>",
    "      )}",
    "      {shownSurface === CHAT_PANEL && chatProblem === null && (",
    "        <ChatSurface />",
    "      )}",
    "      <GameSurface selected={shownSurface === GAME_PANEL} />",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n");

test("a guard is a condition, not a string shape: a second condition before the element still renders it", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      // The real shell: `{shownSurface === CHAT_PANEL && chatProblem === null && (<ChatSurface … />)}`. A reader
      // that demanded the comparison be followed by `&& (<Component` saw neither this guard nor the region card
      // above it and called the surface unreachable (measured 2026-11-12).
      "dialogue-web/src/components/ComposedReferenceGameApp.tsx": guardedChat(
        "shownSurface === CHAT_PANEL && chatProblem !== null",
      ),
    }),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.surfaces[0].component, "ChatSurface");
  assert.deepEqual(reading.surfaces[0].witnesses, [{ journey: "dialogue-web/tests/both.spec.ts", id: "chat-surface" }]);
});

test("the region the guard draws is not the surface's component, and the component beside it is", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      // Two guards on one constant: the first renders the in-region problem card inside a `div`, the second the
      // conversation. Only the second names a component, because a `div` carries no test ids of its own.
      "dialogue-web/src/components/ComposedReferenceGameApp.tsx": guardedChat(
        "shownSurface === GAME_PANEL && chatProblem !== null",
      ),
    }),
  });
  assert.equal(reading.surfaces.find((surface) => surface.id === "chat").component, "ChatSurface");
});

test("a surface two components guard is named ambiguous rather than guessed", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      "dialogue-web/src/components/ComposedReferenceGameApp.tsx": [
        'import { CHAT_PANEL, GAME_PANEL } from "../../composed-surface-route";',
        'import { ChatSurface } from "../../tools/ChatSurface";',
        'import { GameSurface } from "../../tools/GameSurface";',
        "",
        "export function App({ shownSurface }) {",
        "  return (",
        "    <main>",
        "      {shownSurface === CHAT_PANEL && (<ChatSurface />)}",
        "      {shownSurface === CHAT_PANEL && chatProblem !== null && (<ChatProblemSurface />)}",
        "      <GameSurface selected={shownSurface === GAME_PANEL} />",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n"),
    }),
  });
  assert.deepEqual(codes(reading), ["surface_component_ambiguous:chat"]);
  assert.match(reading.findings[0].detail, /CHAT_PANEL` with ChatProblemSurface and ChatSurface/u);
});

test("a guard that renders a call instead of an element names no component, and the surface is still named", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      // Deliberately not read: the component's identity is in the callee, and following it would be a guess.
      "dialogue-web/src/components/ComposedReferenceGameApp.tsx": [
        'import { CHAT_PANEL, GAME_PANEL } from "../../composed-surface-route";',
        'import { ChatSurface } from "../../tools/ChatSurface";',
        'import { GameSurface } from "../../tools/GameSurface";',
        "",
        "export function App({ shownSurface }) {",
        "  return (",
        "    <main>",
        "      {shownSurface === CHAT_PANEL && renderChat()}",
        "      <GameSurface selected={shownSurface === GAME_PANEL} />",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n"),
    }),
  });
  assert.deepEqual(codes(reading), ["surface_without_component:chat"]);
});

test("the guard comparison changed to another surface is still the defect this gate exists for", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({
      "dialogue-web/src/components/ComposedReferenceGameApp.tsx": [
        'import { CHAT_PANEL, GAME_PANEL } from "../../composed-surface-route";',
        'import { ChatSurface } from "../../tools/ChatSurface";',
        'import { GameSurface } from "../../tools/GameSurface";',
        "",
        "export function App({ shownSurface }) {",
        "  return (",
        "    <main>",
        "      {shownSurface === GAME_PANEL && chatProblem === null && (<ChatSurface />)}",
        "      <GameSurface selected={shownSurface === GAME_PANEL} />",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n"),
    }),
  });
  assert.ok(codes(reading).includes("surface_without_component:chat"), codes(reading).join(","));
});

test("a test id two surfaces render alike witnesses neither, and the reading says so", () => {
  const shared = makeTree({
    ...MEMORY_SURFACE,
    "dialogue-web/src/components/MemorySurface.tsx": [
      "export function MemorySurface() {",
      '  return <section data-testid="surface-panel" />;',
      "}",
      "",
    ].join("\n"),
    "dialogue-web/src/components/ChatSurface.tsx": [
      "export function ChatSurface() {",
      '  return <section data-testid="surface-panel" />;',
      "}",
      "",
    ].join("\n"),
    "dialogue-web/tests/shared.spec.ts": [
      'import { expect, test } from "../../tools/frontend-coverage";',
      "",
      'test("a panel is there", async ({ page }) => {',
      '  await expect(page.getByTestId("surface-panel")).toHaveText("Notebook");',
      "});",
      "",
    ].join("\n"),
  });
  const reading = auditSurfaceJourneys({ root: shared });
  assert.deepEqual(codes(reading), ["surface_without_journey:chat", "surface_without_journey:memory"]);
  assert.deepEqual(reading.shared, [{ id: "surface-panel", surfaces: ["chat", "memory"] }]);
  assert.ok(
    reading.unassessed.some((line) => /unassessed: test id "surface-panel" - rendered by chat, memory/u.test(line)),
  );
});

test("a panel union that cannot be read is a finding, not a silent pass", () => {
  const reading = auditSurfaceJourneys({
    root: makeTree({ "dialogue-web/src/composed-surface-route.ts": 'export const PANEL_PARAM = "panel";\n' }),
  });
  assert.deepEqual(codes(reading), ["surface_population_unassessable:-"]);
  assert.match(reading.unassessed[0], /^unassessed: dialogue-web\/src\/composed-surface-route\.ts - /u);
});

test("the gate prints how many surfaces it examined, and never passes on none", () => {
  // A gate that says "0 violations" without "examined N" is a table, not a verdict: the reading is only as wide
  // as the population it printed. The empty union above is the other half of the same rule - it exits 1.
  const run = spawnSync(process.execPath, [GATE], { cwd: join(REPOSITORY_ROOT, "tools"), encoding: "utf8" });
  assert.match(run.stdout, /^surface_journeys surfaces=\d+ reached=\d+ unreached=\d+ shared_ids=\d+$/mu);
  const examined = Number(/^surface_journeys surfaces=(\d+)/mu.exec(run.stdout)[1]);
  assert.ok(examined > 0, "the gate examined no surface, so its verdict is about nothing");
  assert.equal(run.status, 0, run.stderr);
});
