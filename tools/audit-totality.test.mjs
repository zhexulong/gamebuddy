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
import { ADVISORY, formatReport, runAudit, totals } from "./audit-totality.mjs";

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
    write(
      root,
      "host/src/hygiene-library.test.ts",
      'import test from "node:test";\nimport { readOnlyByTests } from "./hygiene-library.js";\nvoid readOnlyByTests;\ntest("x", () => {});\n',
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
      ["read-path", "bounds", "refusal", "codes", "routes", "fields", "catalogue", "prompt", "promises", "hygiene"],
      "the class list is the audit's own contract",
    );
    assert.deepEqual(
      runAudit({ root, only: ["bounds"] }).map((entry) => entry.id),
      ["bounds"],
    );
    const summary = totals(all);
    assert.equal(summary.classes, 10);
    assert.ok(summary.declared > 0, "the audit must walk something");
    assert.deepEqual(
      [...ADVISORY].sort(),
      ["hygiene"],
      "a class leaves ADVISORY when its findings stop being a ruling the owner has not taken",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree is audited without throwing, and its findings are reported", (t) => {
  const results = runAudit({
    only: ["read-path", "bounds", "refusal", "codes", "routes", "fields", "prompt", "promises", "hygiene"],
  });
  const summary = totals(results);
  t.diagnostic(
    `real tree: ${summary.classes} classes, ${summary.declared} declared items, ${summary.violations} violations`,
  );
  for (const result of results)
    t.diagnostic(`${result.id}: ${result.declared} declared, ${result.violations.length} violation(s)`);
  assert.equal(results.length, 9);
  assert.ok(summary.declared > 100, "the real tree declares far more than a hundred audited items");
});
