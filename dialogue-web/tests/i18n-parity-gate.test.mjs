/**
 * The two message catalogues' own contracts.
 *
 * A string added to one language only is the cheapest possible i18n defect, and
 * it is invisible: the English build reads perfectly and the Chinese build shows
 * a key name, or worse, silently keeps an older sentence. The type system covers
 * the *shape* (`satisfies Record<MessageKey, string>` in i18n.ts) but says nothing
 * about the two things a translator actually breaks:
 *
 *   - a key that exists in one catalogue and not the other, and
 *   - a placeholder (`{{name}}`, `{{count}}`, `{{code}}`, `{{cause}}`, `{{chars}}`)
 *     that one language kept and the other dropped, which renders a sentence about
 *     nobody while looking translated. `tests/i18n.test.mjs` already guards the one
 *     anchor key (`emptyChatOpening`); this gate generalises it to every key in both
 *     catalogues.
 *
 * The catalogues are read as structure (the TypeScript parser, not a regex that a
 * comment or a duplicated name can defeat): the object literals bound to `en` and
 * `zh` in each catalogue file, with their own `as const` / `satisfies` / `Object.freeze`
 * wrappers unwrapped. Each failure names `file:line` of the offending key, so the
 * message is a route.
 *
 * False positives: the parity direction is symmetric and reports both sides, so a
 * key that is only in the other catalogue is never mistaken for a missing one; a
 * catalogue value that is not a plain string literal (a computed value) is skipped
 * and counted in the diagnostic rather than reported as a failure. Placeholders are
 * compared as *sets*, so a language that repeats `{{count}}` twice is not a finding,
 * and a language that writes `{{ count }}` is, which is the intended strictness
 * (nothing substitutes that form today). The last test is the coverage direction:
 * every `labels.<key>` read in the source exists in one of the catalogues, which
 * catches a key read through a receiver the compiler cannot check (a dynamic
 * `labels[key]` lookup is skipped and counted instead).
 *
 * `i18n.7` adds the direction this gate was missing: a key a catalogue DECLARES
 * that no source reads. That is how `worldInfoPanel` survived the six-surface
 * convergence - nothing asserted the reverse direction, and `i18n.4` did not even
 * count the composed shell's own access form (`labels().<key>`, whose receiver is
 * a call rather than an identifier), so its reads were invisible too. The
 * reverse direction therefore has an explicit false-positive boundary, stated
 * once here because both directions share it:
 *
 *   - reads are gathered from `src` only, mirroring `i18n.4`; a key whose only
 *     reader is a spec is a finding like any other (measured: none is today);
 *   - both access forms count - `labels.<key>` on the identifier every component
 *     holds, and `labels().<key>` on the composed shell's accessor - as does a
 *     *string-literal* element access (`labels["key"]`), which a compiler cannot
 *     see through either;
 *   - a *computed* key (`labels[key]`, `labels[\`prefix${x}\`]`) is not a read,
 *     because which key it names is not decidable from the syntax. A key
 *     reachable only through one therefore needs an allowlist entry rather than
 *     silence: `UNREAD_INDIRECT_READS` names the two sites and the reader each one
 *     has;
 *   - every other unread key must be recorded in `UNREAD_RECORDED_DEBT` with the
 *     reason it may stay, so the direction is enforced instead of aspirational.
 *     Both lists are checked in both directions: a recorded key that acquires a
 *     reader, or that a catalogue stops declaring, is itself a failure, so
 *     neither list can rot into a permanent exemption.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");

/** The catalogue files this gate owns, with the binding names each one declares. */
const CATALOGUES = [
  { file: join(SRC, "i18n.ts"), bindings: ["en", "zh"] },
  { file: join(SRC, "components", "character-domain-labels.ts"), bindings: ["en", "zh"] },
];

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/gu;

/** Unwraps `as const`, `satisfies T`, `Object.freeze(...)` and parentheses. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "freeze" &&
      current.arguments.length === 1
    ) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

/**
 * The script kind follows the extension: a `.tsx` file parsed as plain TS loses
 * every read inside JSX, which is most of the reads in this tree. The catalogue
 * files are `.ts` and are unaffected.
 */
function parse(file, text = readFileSync(file, "utf8")) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** Is this expression the label catalogue object, however the site names it? */
function isLabelObject(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "labels";
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "labels";
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    ["labels", "messages", "characterLabels"].includes(expression.expression.text)
  );
}

/**
 * The catalogue key a node reads, or null. Both access forms count: the
 * identifier every component holds (`labels.<key>`) and the composed shell's
 * accessor, whose receiver is a call (`labels().<key>`). A string-literal
 * element access counts too; a computed one does not (see the header).
 */
function labelRead(node) {
  if (ts.isPropertyAccessExpression(node) && isLabelObject(node.expression)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    isLabelObject(node.expression) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return null;
}

/** Every catalogue key a source under `src` reads, through either access form. */
function readKeys() {
  const keys = new Set();
  for (const file of sourceFiles(SRC)) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      const key = labelRead(node);
      if (key !== null) keys.add(key);
    });
  }
  return keys;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** `src/...:line` for the first token of a node. */
export function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const file = sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop();
  return `${file}:${line + 1}`;
}

/**
 * The 1-based line of the first `needle` in `text`, so a mutation proof derives the
 * route it expects from the text it actually mutated instead of pinning today's
 * line number (the catalogue grows, and the line moves with it).
 */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `the mutation anchor ${JSON.stringify(needle)} must exist`);
  return text.slice(0, index).split("\n").length;
}

/**
 * Every catalogue binding in a source text: `{ name, entries, duplicates, dynamic }`.
 * An entry is `{ key, value, line }`; `value` is null for a non-literal value.
 */
export function catalogues(text, fileName = "i18n.ts") {
  const sourceFile = parse(fileName, text);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const name = node.name.text;
    if (name !== "en" && name !== "zh") return;
    if (node.initializer === undefined) return;
    const object = unwrap(node.initializer);
    if (!ts.isObjectLiteralExpression(object)) return;
    const entries = [];
    const duplicates = [];
    const seen = new Set();
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      const key = property.name.text;
      const value = ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
      if (seen.has(key)) duplicates.push({ key, line: at(property, sourceFile) });
      seen.add(key);
      entries.push({ key, value, line: at(property, sourceFile) });
    }
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    found.push({
      name,
      entries,
      duplicates,
      declaration: at(node, sourceFile),
      file: sourceFile.fileName,
      line,
    });
  });
  return found;
}

/** The placeholder names a message value carries, as a sorted set. */
export function placeholdersOf(value) {
  return [...new Set([...String(value).matchAll(PLACEHOLDER)].map((match) => match[1]))].sort();
}

/** Every `.ts`/`.tsx` file under a directory, sorted. */
function sourceFiles(directory) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Loads both catalogue files as structure. */
function loadCatalogues() {
  const loaded = [];
  for (const { file, bindings } of CATALOGUES) {
    const text = readFileSync(file, "utf8");
    const parsed = catalogues(text, file);
    const wanted = parsed.filter((catalogue) => bindings.includes(catalogue.name));
    assert.equal(
      wanted.length,
      bindings.length,
      `${relative(DIALOGUE_WEB, file).replace(/\\/gu, "/")} must declare the catalogues ${bindings.join(", ")}`,
    );
    for (const catalogue of wanted)
      loaded.push({ ...catalogue, file: relative(DIALOGUE_WEB, file).replace(/\\/gu, "/") });
  }
  return loaded;
}

/** Groups the loaded catalogues by file, so a pair is compared inside one file. */
function pairs() {
  const byFile = new Map();
  for (const catalogue of loadCatalogues()) {
    const group = byFile.get(catalogue.file) ?? [];
    group.push(catalogue);
    byFile.set(catalogue.file, group);
  }
  return [...byFile.entries()];
}

test("i18n.1: the locales of one catalogue declare exactly the same keys", (t) => {
  const failures = [];
  let keys = 0;
  let files = 0;
  for (const [file, group] of pairs()) {
    files += 1;
    assert.equal(group.length, 2, `${file} must hold exactly two locales`);
    const [left, right] = group;
    const leftKeys = new Set(left.entries.map((entry) => entry.key));
    const rightKeys = new Set(right.entries.map((entry) => entry.key));
    keys += leftKeys.size;
    for (const entry of left.entries)
      if (!rightKeys.has(entry.key)) failures.push(`${entry.line}: ${left.name}.${entry.key} has no ${right.name} entry`);
    for (const entry of right.entries)
      if (!leftKeys.has(entry.key)) failures.push(`${entry.line}: ${right.name}.${entry.key} has no ${left.name} entry`);
  }
  t.diagnostic(`i18n.1: ${files} catalogue file(s), ${keys} keys per locale, ${failures.length} violating key(s)`);
  assert.deepEqual(failures, [], "every key must exist in every locale of its own catalogue");
});

test("i18n.2: both locales of a key carry the same placeholders", (t) => {
  const failures = [];
  let compared = 0;
  let literalKeys = 0;
  let nonLiteral = 0;
  for (const [file, group] of pairs()) {
    const [left, right] = group;
    const rightByKey = new Map(right.entries.map((entry) => [entry.key, entry]));
    for (const entry of left.entries) {
      const counterpart = rightByKey.get(entry.key);
      if (counterpart === undefined) continue; // i18n.1 owns the missing-key finding
      if (entry.value === null || counterpart.value === null) {
        nonLiteral += 1;
        continue;
      }
      literalKeys += 1;
      compared += placeholdersOf(entry.value).length;
      const expected = placeholdersOf(entry.value);
      const actual = placeholdersOf(counterpart.value);
      if (expected.join(",") !== actual.join(","))
        failures.push(
          `${counterpart.line}: ${right.name}.${entry.key} has placeholders [${actual.join(", ")}] but ${left.name}.${entry.key} has [${expected.join(", ")}]`,
        );
    }
  }
  t.diagnostic(
    `i18n.2: ${literalKeys} key(s) compared, ${compared} placeholder occurrence(s), ${nonLiteral} non-literal value(s) skipped, ${failures.length} mismatch(es)`,
  );
  assert.deepEqual(failures, [], "a placeholder dropped in one language renders a sentence about nobody");
});

test("i18n.3: a catalogue never declares the same key twice", (t) => {
  const failures = [];
  let checked = 0;
  for (const catalogue of loadCatalogues()) {
    checked += 1;
    for (const duplicate of catalogue.duplicates)
      failures.push(`${duplicate.line}: ${catalogue.name}.${duplicate.key} is declared more than once`);
  }
  t.diagnostic(`i18n.3: ${checked} catalogue(s), ${failures.length} duplicate key(s)`);
  assert.deepEqual(failures, [], "a duplicate key means the second declaration silently wins");
});

test("i18n.4: every labels.<key> a component reads is declared in a catalogue", (t) => {
  const declared = new Set();
  for (const catalogue of loadCatalogues()) for (const entry of catalogue.entries) declared.add(entry.key);

  const failures = [];
  let reads = 0;
  let dynamic = 0;
  for (const file of sourceFiles(SRC)) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      const key = labelRead(node);
      if (key === null) return;
      reads += 1;
      if (!declared.has(key)) failures.push(`${at(node, sourceFile)} labels.${key} is not declared`);
    });
    const text = readFileSync(file, "utf8");
    dynamic += [...text.matchAll(/\blabels\[/gu)].length;
  }
  t.diagnostic(
    `i18n.4: ${reads} labels.<key> read(s) (both access forms) checked against ${declared.size} declared key(s), ${dynamic} dynamic labels[...] read(s) skipped, ${failures.length} undeclared`,
  );
  assert.deepEqual(failures, [], "a key read through an untyped receiver is the one tsc cannot check");
});

test("i18n.5 (mutation): a key added to one locale only fails with file and line", (t) => {
  // The mutation proof, kept as a permanent negative test: the same predicate run
  // over real catalogue text with one key added to the English side only.
  const original = readFileSync(CATALOGUES[0].file, "utf8");
  const mutated = original.replace(
    '  appName: "GameBuddy",',
    '  appName: "GameBuddy",\n  gateMutationKey: "only in en",',
  );
  assert.notEqual(mutated, original, "the mutation anchor must exist");
  const [en, zh] = catalogues(mutated, CATALOGUES[0].file);
  const zhKeys = new Set(zh.entries.map((entry) => entry.key));
  const missing = en.entries.filter((entry) => !zhKeys.has(entry.key));
  assert.deepEqual(
    missing.map((entry) => entry.key),
    ["gateMutationKey"],
    "the injected key is the only key missing from the other locale",
  );
  assert.equal(missing[0].line, `src/i18n.ts:${lineOf(mutated, "gateMutationKey")}`);
  t.diagnostic(`i18n.5: injected en-only key reported at ${missing[0].line}`);
});

test("i18n.6 (mutation): a placeholder dropped in one language fails with file and line", (t) => {
  const original = readFileSync(CATALOGUES[0].file, "utf8");
  const mutated = original.replace('  emptyChatOpening: "与 {{name}} 开启一段新的旅程…"', '  emptyChatOpening: "开启一段新的旅程…"');
  assert.notEqual(mutated, original, "the zh placeholder anchor must exist");
  const parsed = catalogues(mutated, CATALOGUES[0].file);
  const en = parsed.find((catalogue) => catalogue.name === "en");
  const zh = parsed.find((catalogue) => catalogue.name === "zh");
  const entry = zh.entries.find((candidate) => candidate.key === "emptyChatOpening");
  const expected = en.entries.find((candidate) => candidate.key === "emptyChatOpening");
  assert.deepEqual(placeholdersOf(expected.value), ["name"]);
  assert.deepEqual(placeholdersOf(entry.value), []);
  assert.equal(entry.line, `src/i18n.ts:${lineOf(mutated, 'emptyChatOpening: "开启一段新的旅程…"')}`);
  t.diagnostic(`i18n.6: dropped placeholder reported at ${entry.line}`);
});

/**
 * Keys a catalogue declares that a *computed* read reaches, which no syntax can
 * name. Each group cites the reader; the key is not dead, it is just not
 * statically visible.
 */
const UNREAD_INDIRECT_READS = [
  {
    reason:
      "read through a computed key: `connectionFailureText`'s closed `labels[key]` union in components/management-panels.tsx",
    keys: [
      "connectionFailureInvalidEndpoint",
      "connectionFailureInvalidResponse",
      "connectionFailureNotConfigured",
      "connectionFailureNotFound",
      "connectionFailureTimeout",
      "connectionFailureUnauthorized",
      "connectionFailureUnreachable",
    ],
  },
  {
    reason:
      "read through a computed key: the voice panel's `labels[`voiceConsent${...}`]` in components/management-panels.tsx",
    keys: ["voiceConsentUndecided", "voiceConsentAccepted", "voiceConsentRevoked"],
  },
];

/**
 * Keys a catalogue declares that nothing under `src` reads at all. They are
 * recorded here rather than removed, because a catalogue cleanup is its own
 * change and this gate's job is to make the debt visible, not to silently
 * delete copy a lane may be about to read. Remove a group and its keys together
 * when the surface it names is gone; the reverse check below fails a group the
 * moment any key in it is read again.
 */
const UNREAD_RECORDED_DEBT = [
  {
    reason:
      "the Settings surface reads the `connection*`, `modelProfiles*`, `language*` and `advancedPiSettings*` keys it kept; these older Settings words have no reader",
    keys: [
      "active",
      "back",
      "chatModelProfile",
      "chinese",
      "connectionPending",
      "connectionRecommended",
      "english",
      "gameModelProfile",
      "high",
      "independent",
      "language",
      "model",
      "modelProfile",
      "noWorldInfo",
      "surface",
      "theme",
      "thinkingLevel",
    ],
  },
  {
    reason: "the live card import is `CharacterCardImport.tsx` over `character-domain-labels.ts`; this older wizard's vocabulary has no reader",
    keys: [
      "activeCharacter",
      "allCharacters",
      "characterName",
      "confirmCharacter",
      "import",
      "importCharacterCard",
      "newCharacter",
      "pasteCardJson",
      "reviewDetails",
    ],
  },
  {
    reason: "the converged World Info surface binds whole revisions (`CharacterWorldBookPanel`); the entry editor these named is gone",
    keys: ["addEntry", "attachToChat", "entryContent", "entryKey", "entryTitle", "worldInfoEntries", "worldInfoLocked"],
  },
  {
    reason:
      "the live Characters surface reads `character-domain-labels.ts`, which carries this same vocabulary; the i18n.ts copy has no reader",
    keys: [
      "authoredContentError",
      "authoredContentSaved",
      "authoredContentSaving",
      "cardImportConfirming",
      "cardImportCreated",
      "cardImportDispositionsTitle",
      "cardImportError",
      "cardImportFieldsTitle",
      "cardImportHint",
      "cardImportHistoryEmpty",
      "cardImportHistoryFailed",
      "cardImportHistoryHint",
      "cardImportHistoryTitle",
      "cardImportLongHint",
      "cardImportReviewSelected",
      "cardImportReviewSelectionTitle",
      "cardImportStage",
      "cardImportStaging",
      "cardImportTitle",
      "charactersTitle",
      "charactersUnavailable",
      "chatRetentionRestore",
      "companionCreateHint",
      "companionCreateSubmit",
      "companionCreateTitle",
      "companionDetailName",
      "companionDetailTitle",
      "companionListEmpty",
      "companionListTitle",
      "greetingAddVariant",
      "greetingEditHint",
      "greetingEditTitle",
      "greetingNotPresent",
      "greetingSave",
      "greetingVariantLabel",
      "greetingVariantText",
      "personaEditHint",
      "personaEditTitle",
      "personaNotPresent",
      "personaPresentHint",
      "scenarioEditHint",
      "scenarioEditTitle",
      "scenarioNotPresent",
    ],
  },
  {
    reason: "the shell names each nav entry with its own `<surface>Panel` key (`labels().charactersPanel` ...); these bare words have no reader",
    keys: ["characters", "memory", "persona", "settings", "worldInfo"],
  },
  {
    reason: "the Chats surface reads `chatsPanel`/`chatRetention*`; these older action words have no reader",
    keys: ["chatHistory", "deleteChat", "exportChat"],
  },
  {
    reason:
      "the shell's list vocabulary converged on `chatsPanel`/`memoryPanel`/`loading`, and the `voice*` trio duplicates `voiceConsent*`; none of these has a reader",
    keys: ["chatsEmpty", "memoryEmpty", "selected", "untitled", "voiceAccepted", "voiceRevoked", "voiceUndecided"],
  },
  {
    reason: "the live Memory surface reads `components/memory-notebook-labels.ts`; these older words have no reader",
    keys: ["deleteMemory", "semanticMemory"],
  },
  {
    reason: "the game facts row renders connection/instance/world/save/compatibility/outcome only; these two have no reader",
    keys: ["gameFactCapabilities", "gameFactExecution"],
  },
  {
    reason: "the bootstrap failure renders through `composed-problem-view.ts`; this older title/detail pair has no reader",
    keys: ["problemBootstrapUnavailableTitle", "problemBootstrapUnavailableDetail"],
  },
  {
    reason: "the live Persona editor reads `character-domain-labels.ts` (`personaTitle`/`personaHint`); the i18n.ts heading has no reader",
    keys: ["userPersona"],
  },
  {
    reason: "no surface renders a read-only chat badge; the word has no reader",
    keys: ["readOnlyChat"],
  },
];

/** Every allowed unread key, its reason, and the failures a list itself can have. */
function unreadAllowlist() {
  const recorded = new Map();
  const failures = [];
  for (const group of [...UNREAD_INDIRECT_READS, ...UNREAD_RECORDED_DEBT])
    for (const key of group.keys) {
      if (recorded.has(key)) failures.push(`${key} is allowlisted twice`);
      recorded.set(key, group.reason);
    }
  return { recorded, failures };
}

test("i18n.7: a declared catalogue key is read by a source, or recorded as unread with a reason", (t) => {
  const declared = new Map();
  for (const catalogue of loadCatalogues())
    for (const entry of catalogue.entries) if (!declared.has(entry.key)) declared.set(entry.key, entry.line);

  const reads = readKeys();
  const unread = [...declared.keys()].filter((key) => !reads.has(key)).sort();
  const { recorded, failures: listFailures } = unreadAllowlist();
  const failures = [...listFailures];
  for (const key of unread) if (!recorded.has(key)) failures.push(`${declared.get(key)}: ${key} is declared and no source reads it`);
  for (const key of recorded.keys()) {
    if (!declared.has(key)) failures.push(`${key} is recorded as unread but no catalogue declares it; drop the stale entry`);
    else if (reads.has(key)) failures.push(`${declared.get(key)}: ${key} is recorded as unread but a source reads it; drop the stale entry`);
  }
  t.diagnostic(
    `i18n.7: ${declared.size} declared key(s), ${reads.size} read by a source, ${unread.length} unread (${UNREAD_INDIRECT_READS.reduce((total, group) => total + group.keys.length, 0)} indirect, ${UNREAD_RECORDED_DEBT.reduce((total, group) => total + group.keys.length, 0)} recorded debt), ${failures.length} unrecorded or stale`,
  );
  assert.deepEqual(failures, [], "a declared key no source reads must be recorded with a reason, and a recorded key must still be a real unread one");
});

test("i18n.8 (mutation): a key nothing reads is reported at its file:line", (t) => {
  // The reverse direction's own mutation proof, kept as a permanent negative
  // test: the real read set, and catalogue text carrying one extra key in both
  // locales, so i18n.1's parity direction cannot be what fails.
  const original = readFileSync(CATALOGUES[0].file, "utf8");
  const mutated = original
    .replace('  appName: "GameBuddy",', '  appName: "GameBuddy",\n  gateUnreadMutationKey: "nobody reads this",')
    .replace('  appName: "GameBuddy",', '  appName: "GameBuddy",\n  gateUnreadMutationKey: "没有人读这个",');
  assert.notEqual(mutated, original, "the mutation anchor must exist");
  const en = catalogues(mutated, CATALOGUES[0].file).find((catalogue) => catalogue.name === "en");
  const injected = en.entries.find((entry) => entry.key === "gateUnreadMutationKey");
  assert.notEqual(injected, undefined, "the injected key must be parsed");
  const reads = readKeys();
  assert.ok(!reads.has(injected.key), "no source reads the injected key");
  assert.equal(injected.line, `src/i18n.ts:${lineOf(mutated, "gateUnreadMutationKey")}`);
  t.diagnostic(`i18n.8: injected unread key reported at ${injected.line}`);
});
