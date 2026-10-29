/**
 * The totality audit can fail.
 *
 * A gate nobody has seen go red is a gate that reports green for the wrong
 * reason, and this audit is the one place where that mistake would be
 * expensive: it exists to tell the owner how much is broken, and a check that
 * cannot fail reports "nothing is broken" with the same confidence as a real
 * one. So every class is proved twice on a scratch tree built for the purpose -
 * green on a tree that satisfies it, red after one injected violation, green
 * again once the injection is removed - and the injection is a real edit to a
 * real file, not a mocked predicate. Every class that owns a rule is proved
 * that way (`catalogue` is delegated to its own gate and proved there); a class
 * whose findings print but do not decide the run is proved as well, and
 * `ADVISORY` records the ruling its findings await, never a rule nobody could
 * read.
 *
 * The scratch tree is deliberately tiny and complete at the same time: it holds
 * the two browser contracts, the handler modules the audit reads codes out of,
 * the browser mirrors, and one catalogue. It is not a copy of the product, so a
 * class that only passes because today's tree happens to be shaped a certain way
 * fails here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ADVISORY_READINGS, formatReport, runAudit, totals, unprovenReadings } from "./audit-totality.mjs";

function write(root, path, text) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

const TAVERN_CONTRACT = [
  "const strictObject = (properties: unknown) => properties;",
  "const Type = {",
  "  Array: (of: unknown, options: unknown) => ({ of, options }),",
  "  String: (options: unknown) => options,",
  "  Integer: (options: unknown) => options,",
  "};",
  "const NoteV1Schema = strictObject({",
  "  noteTitle: Type.String({ minLength: 1, maxLength: 64 }),",
  "  noteBody: Type.String({ minLength: 1, maxLength: 256 }),",
  "});",
  "const NoteListV1Schema = strictObject({",
  "  revision: Type.Integer({ minimum: 1 }),",
  "  notes: Type.Array(NoteV1Schema, { maxItems: 10 }),",
  "});",
  "const ProblemCode = [",
  '  "note_not_found",',
  '  "notes_too_many",',
  "];",
  "const BrowserTurnV1Schema = strictObject({",
  '  problemCode: { oneOf: ["note_not_found"] },',
  "});",
  "const route = <T extends object>(descriptor: T) => Object.freeze(descriptor);",
  "const RouteDescriptors = Object.freeze([",
  '  route({ routeId: "notes.read", method: "GET", path: "/api/tavern/v1/notes" }),',
  "]);",
  "export const TavernBrowserContractV1 = Object.freeze({ routes: RouteDescriptors });",
  "export const TavernBrowserValidatorsV1 = Object.freeze({ NoteListV1Schema });",
  "",
].join("\n");

const GAME_CONTRACT = [
  "const strictObject = (properties: unknown) => properties;",
  'const GameProblemCode = ["game_unavailable"];',
  "const GameStateV1Schema = strictObject({ connectionStatus: {} });",
  "export const GameBrowserValidatorsV1 = Object.freeze({ GameStateV1Schema });",
  "",
].join("\n");

/**
 * The tree as it should be: one cap that agrees with its writer, one fail-closed
 * read whose dependency tree cannot exceed the cap, every declared code mirrored,
 * every declared field produced and read, one plain catalogue sentence.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "totality-audit-"));
  write(root, "host/src/tavern/browser-contract/index.ts", TAVERN_CONTRACT);
  write(root, "host/src/game-browser-contract/index.ts", GAME_CONTRACT);
  write(
    root,
    "host/src/reference-pipeline-dialogue-web.core.ts",
    [
      'export type ProblemCode = "payload_too_large";',
      "export function sendProblem(response: unknown, status: number, code: string): void {",
      "  void response;",
      "  void status;",
      "  void code;",
      "}",
      "",
    ].join("\n"),
  );
  write(root, "host/src/reference-pipeline-dialogue-web.ts", "export const referenceHandler = 0;\n");
  write(
    root,
    "host/src/tavern-management-dialogue-web.ts",
    [
      "export const turnDefaults = { problemCode: null };",
      "",
      "export function servesNotes(profile: { routeIds: readonly string[] }): boolean {",
      '  return profile.routeIds.includes("notes.read");',
      "}",
      "",
      "export function noteProblem(flag: boolean): { code: string } {",
      '  if (flag) return { code: "note_not_found" };',
      '  return { code: "notes_too_many" };',
      "}",
      "",
    ].join("\n"),
  );
  write(root, "host/src/composed-reference-game-browser.ts", "export const gameState = { connectionStatus: null };\n");
  write(
    root,
    "host/src/note-store.ts",
    [
      "const MAX_NOTES = 10;",
      "const MAX_NOTE_TITLE_LENGTH = 64;",
      "export const noteStoreReady = true;",
      "export type Note = { noteTitle: string; noteBody: string };",
      "",
      "export function acceptNotes(value: { notes: Note[]; revision: number }): void {",
      '  if (value.notes.length > MAX_NOTES) throw new Error("notes_too_many");',
      "  for (const note of value.notes) {",
      '    if (note.noteTitle.length > MAX_NOTE_TITLE_LENGTH) throw new Error("note_title_too_long");',
      "    void note.noteBody;",
      "  }",
      "  void value.revision;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "host/src/note-route.ts",
    [
      'import { MAX_NOTES } from "./note-store.js";',
      'import { TavernBrowserValidatorsV1 } from "./tavern/browser-contract/index.js";',
      "const NOTES_MAX = MAX_NOTES;",
      "",
      "export function readNotes(notes: unknown[], response: unknown): unknown {",
      "  const projected = { revision: 1, notes: notes.slice(0, NOTES_MAX) };",
      '  if (!TavernBrowserValidatorsV1.NoteListV1Schema.Check(projected)) throw new Error("projection_invalid");',
      "  void response;",
      "  return projected;",
      "}",
      "",
    ].join("\n"),
  );
  const mirror = [
    "export const PROBLEM_CODES = Object.freeze([",
    '  "note_not_found",',
    '  "notes_too_many",',
    '  "payload_too_large",',
    "]);",
    'export const TURN_PROBLEM_CODES = Object.freeze(["note_not_found"]);',
    "",
  ].join("\n");
  write(root, "dialogue-web/src/reference-pipeline-api.ts", mirror);
  write(root, "dialogue-web/src/management-pipeline-api.ts", mirror);
  write(
    root,
    "dialogue-web/src/composed-reference-game-browser-api.ts",
    'export const GAME_PROBLEM_CODES = Object.freeze(["game_unavailable"]);\n',
  );
  write(
    root,
    "dialogue-web/src/reference-shape.ts",
    [
      "export const noteShape = Object.freeze({",
      "  revision: 1,",
      "  notes: [],",
      '  noteTitle: "",',
      '  noteBody: "",',
      "  problemCode: null,",
      "  connectionStatus: null,",
      "});",
      "",
    ].join("\n"),
  );
  write(
    root,
    "dialogue-web/src/i18n.ts",
    [
      "export const en = Object.freeze({",
      '  appName: "GameBuddy",',
      '  emptyNotes: "No notes yet.",',
      "});",
      "export const zh = Object.freeze({",
      '  appName: "GameBuddy",',
      '  emptyNotes: "还没有笔记。",',
      "});",
      "",
    ].join("\n"),
  );
  // The hygiene class reads test importers under the two source roots only, so the test that keeps an export alive
  // has to live where the product's own tests live.
  write(root, "host/src/only-a-test.test.ts", 'import test from "node:test";\ntest("x", () => {});\n');
  return root;
}

/** One class's result against a root. */
function violationsOf(root, id) {
  const results = runAudit({ root, only: [id] });
  const result = results.find((entry) => entry.id === id);
  assert.notEqual(result, undefined, `${id} is not a class`);
  return result;
}

/** Green, red after one real edit, green again once the edit is undone. */
function prove(root, id, { file, before, after, expectWhere }) {
  const clean = violationsOf(root, id);
  assert.deepEqual(clean.violations, [], `${id} must be green before the injection:\n${clean.notes.join("\n")}`);
  const original = read(root, file);
  assert.ok(original.includes(before), `${id}: the injection anchor must exist in ${file}`);
  write(root, file, original.replace(before, after));
  try {
    const broken = violationsOf(root, id);
    assert.ok(broken.violations.length > 0, `${id} must go red after injecting a violation`);
    assert.ok(
      broken.violations.some((violation) => violation.where.includes(expectWhere)),
      `${id}: the violation must name ${expectWhere}, got ${broken.violations.map((violation) => violation.where).join(", ")}`,
    );
  } finally {
    write(root, file, original);
  }
  const restored = violationsOf(root, id);
  assert.deepEqual(restored.violations, [], `${id} must be green again after the injection is removed`);
  return clean;
}

test("read-path: a projection that can exceed its own schema is a blank surface", (t) => {
  const root = fixture();
  try {
    // The fixture's read handler projects at most `NOTES_MAX` rows and then validates that projection against the
    // contract's own `NoteListV1Schema`, whose `notes` is capped at 10. The handler's writer constant is what this
    // product got wrong four times over: a producer bounded above the schema it then validates against, so one row
    // over the cap and the fail-closed branch removes the whole surface. Raising that one constant is the injection.
    const clean = prove(root, "read-path", {
      file: "host/src/note-route.ts",
      before: "const NOTES_MAX = MAX_NOTES;",
      after: "const NOTES_MAX = 40;",
      expectWhere: "host/src/note-route.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds: the wire's cap and the writer's cap must agree in both directions", (t) => {
  const root = fixture();
  try {
    const truncating = prove(root, "bounds", {
      file: "host/src/note-store.ts",
      before: "const MAX_NOTES = 10;",
      after: "const MAX_NOTES = 40;",
      expectWhere: "note-store.ts",
    });
    t.diagnostic(truncating.notes.join(" | "));
    // The other direction: a writer stricter than the published bound refuses
    // data the contract says is acceptable.
    prove(root, "bounds", {
      file: "host/src/note-store.ts",
      before: "const MAX_NOTES = 10;",
      after: "const MAX_NOTES = 4;",
      expectWhere: "note-store.ts",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds: one property capped two ways is the drift the element type cannot name", (t) => {
  const root = fixture();
  const file = "host/src/tavern/browser-contract/index.ts";
  try {
    // `NoteListV1Schema.notes` is capped at 10. A second schema declaring the SAME property over the
    // SAME rows at another cap is what this rule exists for: one collection, two published ceilings, so
    // a projection legal under one schema is truncated or refused under the other. The injection is a
    // real second schema, not a mocked predicate.
    const original = read(root, file);
    write(
      root,
      file,
      original.replace(
        "const NoteListV1Schema = strictObject({",
        [
          "const NotePageV1Schema = strictObject({",
          "  notes: Type.Array(NoteV1Schema, { maxItems: 40 }),",
          "});",
          "const NoteListV1Schema = strictObject({",
        ].join("\n"),
      ),
    );
    try {
      const broken = violationsOf(root, "bounds");
      const drift = broken.violations.find((violation) => /capped 2 different ways/u.test(violation.message));
      assert.notEqual(drift, undefined, `one property capped twice is a finding:\n${broken.notes.join("\n")}`);
      assert.match(drift.message, /NoteListV1Schema=10/u, "the message must name every schema and its cap");
      assert.match(drift.message, /NotePageV1Schema=40/u);
      t.diagnostic(drift.message);
    } finally {
      write(root, file, original);
    }
    assert.deepEqual(violationsOf(root, "bounds").violations, [], "green again once the second schema is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounds: two properties over one element type are two collections, not one cap", (t) => {
  const root = fixture();
  const contract = "host/src/tavern/browser-contract/index.ts";
  const store = "host/src/note-store.ts";
  try {
    // The shape `deniedActions` (512) and `deniedActionFamilies` (64) have: one row type, two
    // properties, two caps the writer states on purpose - one constant per collection. An audit that
    // groups by the row type calls this drift and can never be green on correct code, so it must not.
    const originalContract = read(root, contract);
    const originalStore = read(root, store);
    write(
      root,
      contract,
      originalContract.replace(
        "const NoteListV1Schema = strictObject({",
        [
          "const NoteArchiveV1Schema = strictObject({",
          "  notes: Type.Array(NoteV1Schema, { maxItems: 10 }),",
          "  archivedNotes: Type.Array(NoteV1Schema, { maxItems: 40 }),",
          "});",
          "const NoteListV1Schema = strictObject({",
        ].join("\n"),
      ),
    );
    write(
      root,
      store,
      originalStore.replace("const MAX_NOTES = 10;", "const MAX_NOTES = 10;\nconst MAX_ARCHIVED_NOTES = 40;"),
    );
    try {
      const result = violationsOf(root, "bounds");
      assert.deepEqual(
        result.violations,
        [],
        `two collections over one row type are not one cap:\n${result.notes.join("\n")}`,
      );
    } finally {
      write(root, contract, originalContract);
      write(root, store, originalStore);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refusal: a const-bound predicate answers the question its caller names, and one that does not is a finding", (t) => {
  const root = fixture();
  const file = "host/src/note-store.ts";
  try {
    // The shape `MAX_GAME_PROMPT_ADDITION_CHARS` has: `const isX = (value: string): boolean => … length <= MAX`.
    // It is a predicate - `answersQuestion` counts it as named by its caller - and the reader has to see a
    // `const`-bound arrow at all for that branch to exist. Before it did, this comparison was reported as a
    // capacity enforced "with no bounded code", which pointed at the wrong layer: the code lives at the caller.
    const original = read(root, file);
    write(
      root,
      file,
      `${original}\nexport const isNotesBounded = (value: readonly string[]): boolean =>\n  value.length <= MAX_NOTES;\n`,
    );
    try {
      assert.deepEqual(
        violationsOf(root, "refusal").violations,
        [],
        "a boolean-returning const arrow is a predicate, so its caller names the refusal",
      );
    } finally {
      write(root, file, original);
    }
    // And the other direction: the same const arrow answering a non-boolean (a value it narrows) is not a
    // predicate, so its capacity comparison is a refusal the player meets unnamed - which must go red.
    write(
      root,
      file,
      `${original}\nexport const boundedNotes = (value: readonly string[]): readonly string[] =>\n  value.length <= MAX_NOTES ? value : [];\n`,
    );
    try {
      const broken = violationsOf(root, "refusal");
      assert.equal(
        broken.violations.length,
        1,
        `an unnamed capacity refusal is a finding:\n${broken.notes.join("\n")}`,
      );
      assert.match(broken.violations[0].message, /MAX_NOTES/u);
      t.diagnostic(broken.violations[0].message);
    } finally {
      write(root, file, original);
    }
    assert.deepEqual(violationsOf(root, "refusal").violations, [], "green again once the injection is removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refusal: a capacity enforced without a named code is a generic failure", (t) => {
  const root = fixture();
  try {
    // `namedCodeIn` reads a code out of each way this tree refuses: a `{ code: "…" }` payload, a `sendProblem(...)`
    // call, and the first string of a constructor or function whose name ends in `Error`/`Failure` - so
    // `throw new Error("notes_too_many")` names its code and so does `throw new TavernConnectionInputError("…")`.
    // What this proof adds is the other half: a capacity refused with a sentence instead of a code is a finding, and
    // the fixture is green again once the injection is removed.
    const clean = prove(root, "refusal", {
      file: "host/src/note-route.ts",
      before: "  const projected = { revision: 1, notes: notes.slice(0, NOTES_MAX) };",
      after:
        '  if (notes.length > MAX_NOTES) throw new Error("Too many notes to project.");\n  const projected = { revision: 1, notes: notes.slice(0, NOTES_MAX) };',
      expectWhere: "host/src/note-route.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codes: a mirror that is a stale subset fails", (t) => {
  const root = fixture();
  try {
    const clean = prove(root, "codes", {
      file: "dialogue-web/src/reference-pipeline-api.ts",
      before: '  "payload_too_large",\n',
      after: "",
      expectWhere: "reference-pipeline-api.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes: a declared route no dispatcher names is unreachable", (t) => {
  const root = fixture();
  try {
    const clean = prove(root, "routes", {
      file: "host/src/tavern-management-dialogue-web.ts",
      before: 'return profile.routeIds.includes("notes.read");',
      after: "return false;",
      expectWhere: "tavern/browser-contract/index.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fields: a declared field nothing reads is dead payload", (t) => {
  const root = fixture();
  try {
    const clean = prove(root, "fields", {
      file: "dialogue-web/src/reference-shape.ts",
      before: '  noteBody: "",\n',
      after: "",
      expectWhere: "tavern/browser-contract/index.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt: a catalogue sentence may not carry an engineering artefact", (t) => {
  const root = fixture();
  try {
    const clean = prove(root, "prompt", {
      file: "dialogue-web/src/i18n.ts",
      before: 'emptyNotes: "No notes yet.",',
      after: 'emptyNotes: "No notes yet (sha256 0123456789abcdef0123456789abcdef).",',
      expectWhere: "dialogue-web/src/i18n.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promises: a promise that names an unreachable capability fails", (t) => {
  const root = fixture();
  try {
    const clean = prove(root, "promises", {
      file: "dialogue-web/src/i18n.ts",
      before: 'emptyNotes: "No notes yet.",',
      after: 'emptyNotes: "You can restore it later.",',
      expectWhere: "dialogue-web/src/i18n.ts",
    });
    t.diagnostic(clean.notes.join(" | "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hygiene: a suppression directive and a test-only export are both findings", (t) => {
  const root = fixture();
  try {
    const clean = prove(root, "hygiene", {
      file: "host/src/note-store.ts",
      before: "const MAX_NOTES = 10;",
      after: "// @ts-ignore\nconst MAX_NOTES = 10;",
      expectWhere: "host/src/note-store.ts:1",
    });
    t.diagnostic(clean.notes.join(" | "));
    prove(root, "hygiene", {
      file: "host/src/only-a-test.test.ts",
      before: 'import test from "node:test";',
      after: 'import test from "node:test";\nimport { noteStoreReady } from "./note-store.js";\nvoid noteStoreReady;',
      expectWhere: "host/src/note-store.ts",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hygiene: what production reads stays green, what only a test reads goes red", (t) => {
  const root = fixture();
  const library = "host/src/hygiene-library.ts";
  try {
    // Three ways a production path reaches an export, all of them invisible to a scan that keys importers by
    // the bare name of an `import` declaration: another module in another directory importing it through a
    // re-export barrel, and the module that declares it naming it itself.
    write(
      root,
      library,
      [
        "export function readThroughBarrel(): number { return 1; }",
        "export function readInsideThisModule(): number { return 2; }",
        "export const CALLED_HERE = readInsideThisModule();",
        "export function readOnlyByTests(): number { return 3; }",
        "",
      ].join("\n"),
    );
    write(root, "host/src/hygiene-library-barrel.ts", 'export { readThroughBarrel } from "./hygiene-library.js";\n');
    write(
      root,
      "host/src/nested/hygiene-consumer.ts",
      'import { readThroughBarrel } from "../hygiene-library-barrel.js";\nexport const produced = readThroughBarrel();\n',
    );
    // ... and the two consumers that bind no name to import: a type written inline, and a namespace import.
    write(root, "host/src/hygiene-inline-type.ts", "export type InlineRead = { value: number };\n");
    write(root, "host/src/hygiene-namespaced.ts", "export const NAMESPACED = 1;\n");
    write(
      root,
      "host/src/nested/hygiene-unnamed-consumer.ts",
      [
        'import * as namespaced from "../hygiene-namespaced.js";',
        'export const read = (value: import("../hygiene-inline-type.js").InlineRead): number =>',
        "  value.value + namespaced.NAMESPACED;",
        "",
      ].join("\n"),
    );
    // The test reads the two unnamed-consumer exports by name, so a production consumer the scan failed to see
    // would surface them as findings instead of quietly leaving them unexamined.
    write(
      root,
      "host/src/hygiene-library.test.ts",
      [
        'import test from "node:test";',
        'import { readOnlyByTests } from "./hygiene-library.js";',
        'import { NAMESPACED } from "./hygiene-namespaced.js";',
        'import type { InlineRead } from "./hygiene-inline-type.js";',
        "void [readOnlyByTests, NAMESPACED];",
        "export type Probe = InlineRead;",
        'test("x", () => {});',
        "",
      ].join("\n"),
    );

    const broken = violationsOf(root, "hygiene");
    assert.deepEqual(
      broken.violations.map((violation) => violation.where),
      ["host/src/hygiene-library.ts:4"],
      `only the export a test alone reads is a finding:\n${broken.violations.map((v) => `${v.where} ${v.message}`).join("\n")}`,
    );
    t.diagnostic(broken.notes.join(" | "));

    // A production reader turns the red finding green - the same edit in the direction the class was blind to.
    write(
      root,
      "host/src/nested/hygiene-consumer.ts",
      'import { readThroughBarrel } from "../hygiene-library-barrel.js";\nimport { readOnlyByTests } from "../hygiene-library.js";\nexport const produced = readThroughBarrel() + readOnlyByTests;\n',
    );
    assert.deepEqual(violationsOf(root, "hygiene").violations, [], "a production importer must clear the finding");

    // ... and removing it makes the export test-only again, so the green is the reader's and not a silence.
    write(
      root,
      "host/src/nested/hygiene-consumer.ts",
      'import { readThroughBarrel } from "../hygiene-library-barrel.js";\nexport const produced = readThroughBarrel();\n',
    );
    assert.deepEqual(
      violationsOf(root, "hygiene").violations.map((violation) => violation.where),
      ["host/src/hygiene-library.ts:4"],
      "the finding returns once production stops reading the export",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hygiene site defect blocks while the test-only export reading does not", () => {
  const root = fixture();
  try {
    // Two findings of two kinds in ONE class, and the exit code has to separate them. The class used to be advisory as a
    // whole, so a hand-added `@ts-ignore` - a site that is wrong on its own terms - was printed and then ignored by the
    // exit code. That is the shape the complaint named.
    write(root, "host/src/suppressed-store.ts", "// @ts-ignore\nexport const suppressed = 1;\n");
    write(root, "host/src/only-a-test-exports.ts", "export const readOnlyByTests = 1;\n");
    write(
      root,
      "host/src/only-a-test-exports.test.ts",
      'import test from "node:test";\nimport { readOnlyByTests } from "./only-a-test-exports.js";\nvoid readOnlyByTests;\ntest("x", () => {});\n',
    );
    const results = runAudit({ root, only: ["hygiene"] });
    const summary = totals(results);
    const byKind = (kind) =>
      results.flatMap((result) => result.violations).filter((violation) => violation.kind === kind);
    assert.equal(byKind("suppression directive").length, 1, "the fixture must carry exactly one suppression directive");
    assert.equal(byKind("test-only export").length, 1, "and exactly one test-only export");
    assert.equal(summary.blocking, 1, `the site defect decides the run:\n${formatReport(results)}`);
    assert.equal(summary.advisory, 1, "the pending-ruling reading does not");
    assert.match(
      formatReport(results),
      /^\s+hygiene\s+1\s+advisory finding\(s\) of test-only export/mu,
      "the section names the advisory kind and its count, not the class alone",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the audit says out loud what it cannot call clean, so its output cannot be read as a pass", (t) => {
  const root = fixture();
  try {
    // The complaint that produced this section: the scanner said NOT clean in a note among thirty other notes and
    // exited 0, so a reader - or an agent - took "exit 0" for "nothing is wrong". The section is now a place in the
    // report with its own heading, one line per class and reading, and a count on every line.
    const results = runAudit({ root });
    const report = formatReport(results);
    assert.match(report, /^NOT CLEAN - readings this run walked but cannot prove:$/mu);
    const summary = totals(results);
    assert.match(
      report.split("\n")[0],
      new RegExp(`\\(${summary.blocking} blocking, ${summary.advisory} advisory\\)`, "u"),
      "the summary line must separate what blocks from what does not, instead of printing one total",
    );

    // The fixture's own readings: it declares a cap with a paired writer, so `bounds` has nothing unpaired, and it
    // has no test-only export, so `hygiene` has nothing pending. Every line the section prints must therefore be one
    // of the fixture's real gaps - and when it has none, it says so in words rather than printing an empty list.
    const section = report.slice(report.indexOf("NOT CLEAN"));
    const rows = section
      .split("\n")
      .slice(1)
      .filter((line) => /^\s{2}\S/u.test(line) && !line.includes("note") && !line.includes("(none:"));
    for (const row of rows)
      assert.match(
        row,
        /^\s{2}\S+\s+\d+\s+\S/u,
        `every unproven line names its class, its count and its reading: ${row}`,
      );

    // The other direction: a reading that acquires a count must appear here with THAT count. The injection is a real
    // unpaired cap - the fixture's `notes` cap loses its writer constant - so the section has to move.
    const store = "host/src/note-store.ts";
    const original = read(root, store);
    write(root, store, original.replace("const MAX_NOTES = 10;", "const SOMETHING_ELSE = 10;"));
    try {
      const broken = runAudit({ root });
      const brokenRows = unprovenReadings(broken);
      const boundsRow = brokenRows.find((row) => row.className === "bounds");
      assert.notEqual(
        boundsRow,
        undefined,
        `an unpaired cap must be named in the unproven section:\n${formatReport(broken)}`,
      );
      assert.ok(boundsRow.count > 0, "the row carries the count it walked, never a bare label");
      assert.match(boundsRow.reading, /no writer constant paired/u);
      t.diagnostic(`${boundsRow.className}: ${boundsRow.count} -> ${boundsRow.reading}`);
    } finally {
      write(root, store, original);
    }
    assert.deepEqual(
      unprovenReadings(runAudit({ root })).filter((row) => row.className === "bounds"),
      [],
      "the section empties again once the writer constant is restored, so it is a reading and not a permanent line",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hygiene reports by kind with a bounded sample, and the unbounded reading keeps every site", () => {
  const root = fixture();
  try {
    // Twelve findings of one kind - three times the sample bound, so the bound has to bite. The real tree reads the
    // same way at 400: one pattern, one dead line. `main` maps `--verbose` and `--all-findings` to this `all` option.
    const names = Array.from({ length: 12 }, (_, index) => `onlyTest${index}`);
    write(
      root,
      "host/src/only-a-test-exports.ts",
      `${names.map((name, index) => `export const ${name} = ${index};`).join("\n")}\n`,
    );
    write(
      root,
      "host/src/only-a-test-exports.test.ts",
      `import test from "node:test";\nimport { ${names.join(", ")} } from "./only-a-test-exports.js";\nvoid [${names.join(", ")}];\ntest("x", () => {});\n`,
    );
    const results = runAudit({ root, only: ["hygiene"] });
    assert.equal(totals(results).violations, 12, "aggregation reports the count it found, not the number it prints");
    const report = formatReport(results).split("\n");
    assert.ok(
      report.some((line) => /test-only export - 12 finding\(s\)/u.test(line)),
      `the kind line must carry its count:\n${report.join("\n")}`,
    );
    assert.equal(
      report.filter((line) => /onlyTest\d+/u.test(line)).length,
      10,
      "the report prints at most ten sites of one kind",
    );
    assert.ok(
      report.some((line) => /2 more site\(s\) of this kind/u.test(line)),
      "the report says how many sites the sample left out",
    );
    const every = formatReport(results, { all: true }).split("\n");
    assert.equal(every.filter((line) => /onlyTest\d+/u.test(line)).length, 12, "--all-findings keeps every site");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the audit reports its own shape and --only narrows the run", () => {
  const root = fixture();
  try {
    const all = runAudit({ root });
    assert.deepEqual(
      all.map((entry) => entry.id),
      [
        "read-path",
        "bounds",
        "refusal",
        "codes",
        "routes",
        "fields",
        "catalogue",
        "prompt",
        "promises",
        "hygiene",
        "duplication",
      ],
      "the class list is the audit's own contract",
    );
    assert.deepEqual(
      runAudit({ root, only: ["bounds"] }).map((entry) => entry.id),
      ["bounds"],
    );
    const summary = totals(all);
    assert.equal(summary.classes, 11);
    assert.ok(summary.declared > 0, "the audit must walk something");
    assert.deepEqual(
      ADVISORY_READINGS.map((entry) => `${entry.className}: ${entry.kind}`),
      ["hygiene: test-only export"],
      "a reading leaves ADVISORY_READINGS when its findings stop being a ruling the owner has not taken",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree is audited without throwing, and its findings are reported", (t) => {
  const results = runAudit({
    only: [
      "read-path",
      "bounds",
      "refusal",
      "codes",
      "routes",
      "fields",
      "prompt",
      "promises",
      "hygiene",
      "duplication",
    ],
  });
  const summary = totals(results);
  t.diagnostic(
    `real tree: ${summary.classes} classes, ${summary.declared} declared items, ${summary.violations} violations`,
  );
  for (const result of results)
    t.diagnostic(`${result.id}: ${result.declared} declared, ${result.violations.length} violation(s)`);
  assert.equal(results.length, 10);
  assert.ok(summary.declared > 100, "the real tree declares far more than a hundred audited items");
  const duplication = results.find((result) => result.id === "duplication");
  assert.ok(duplication.declared > 10, "the duplication class walks the tree's own decision-verb functions");
});
