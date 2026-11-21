/**
 * A name a journey reads must be a name the product writes.
 *
 * The class: an assertion about a selector, test id, attribute or class that no
 * product source produces. `expect(page.locator("[aria-modal='true']")).toHaveCount(0)`
 * is green whether or not anything is modal, because nothing writes `aria-modal`
 * any more - a check that passes because the thing it watched is gone. Two of these
 * shipped in one drawer conversion: `surface-navigation.spec.ts` asserted
 * `[aria-modal='true']` and `.composed-drawer-backdrop` absent while the Game
 * surface was up, and the conversion to a native `<dialog>` deleted both spellings,
 * so both assertions became unfalsifiable in the same commit that made them wrong.
 * The same shape arrived four other ways: `.composer-chip` and
 * `.composer-chips-row` (the break-ice chips were deleted, the `toBe(0)` stayed),
 * `.empty-state-nameplate` (the nameplate went, `toBeNull()` stayed),
 * `data-testid="chat-select-blocked"` and `data-testid="world-info-surface"` (both
 * test ids deleted, both `toHaveCount(0)` stayed).
 *
 * The population is built from both sides, never from a list here:
 *   - TEST SIDE: every string literal a test hands to a selector API (`locator`,
 *     `querySelector(All)`, `$`/`$$`/`$eval`/`$$eval`, `getByTestId`,
 *     `waitForSelector`, `toHaveClass`, `matches`, `closest`, `contains`). From
 *     those literals the gate reads attribute names (inside `[...]`), the value of a
 *     `data-testid` selector, and class names (`.foo`, or the words a `toHaveClass`
 *     expects).
 *   - PRODUCT SIDE: `dialogue-web/src/**` TypeScript, COMMENTS STRIPPED. An
 *     attribute name is produced when the source names it (`data-tone="progress"`,
 *     `"aria-modal": ...`, `setAttribute("data-x", ...)`); a test id when a string
 *     literal in the source equals it (a JSX `data-testid="x"` and the
 *     `data-testid={testId}` props callers pass are the same fact one call apart); a
 *     class name when the source names it as a whole token anywhere - `className="a
 *     b"`, a template, `classList.add("a")`, a `class="a"` inside generated HTML, or
 *     a constant such as `ACTION_BEAT_CLASS = "message-action"`.
 *   - THE HARNESS is a producer too: an attribute a journey writes into the page
 *     itself (`host.setAttribute("data-notice-probe", "")`) is written by the test
 *     that reads it, so it is produced - by the harness, and that is which.
 *
 * Stripping comments is load-bearing, not tidiness. `AppBar.tsx` carries the sentence
 * "there is no backdrop, no dimming and no `aria-modal`" in a comment: a raw-text
 * search calls `aria-modal` produced, and would have kept the very assertion this
 * gate exists for looking alive.
 *
 * Three-way classification of a name with no producer, and why the middle one is not
 * a loophole:
 *   - `dead` - no producer and the assertion is one of absence. Unfalsifiable. Must be
 *     fixed: assert the platform fact the assertion was standing in for, or delete it
 *     and say why it measured nothing.
 *   - `absence-guard` - no producer, but ABSENCE_LEDGER below declares the code path
 *     that would write it and the live assertion beside it that carries the force
 *     today. Legitimate, and it expires: each entry reds the moment a producer appears
 *     (the assertion is falsifiable again, so the exemption is not needed), reds if the
 *     path it names is not on disk, and reds if the guarded assertion itself is gone.
 *   - `declared-absent` - a `kind: "absent"` role-pair declaration
 *     (`runtime-frontend-gates.spec.ts`) names the spellings a missing capability
 *     would use. Such a declaration owns its names, but only because it also carries a
 *     name-agnostic sweep (`attributes: [/unread/iu]`) that finds the state whatever it
 *     is called. The gate refuses a declaration that lists spellings and no sweep: that
 *     one is this class with extra steps.
 *
 * What this cannot see, stated rather than hidden:
 *   - a selector assembled at runtime is never in the population, because the test does
 *     not spell the name;
 *   - a name is checked, not a value: `[data-tone="danger"]` passes on the strength of
 *     `data-tone` being written anywhere, so a value the product never writes is out of
 *     scope here;
 *   - a hyphenated class name that happens to coincide with a word in a source segment
 *     reads as produced. The rule is deliberately conservative in that direction: a gate
 *     that reds on a name the product does write is noise, and this one has to keep its
 *     force for the names nothing writes;
 *   - platform attributes (`[disabled]`, `[open]`, `[role]`) are out of the population:
 *     they are not product names, React and the browser write them from JSX props, and a
 *     rule for them would be a hand-maintained list of HTML;
 *   - the static `*.test.mjs` gates are scanned but contribute almost nothing: they parse
 *     sources instead of driving a DOM, so their literals are patterns, not selectors.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const THIS_FILE = fileURLToPath(import.meta.url);
const DIALOGUE_WEB = join(dirname(THIS_FILE), "..");
const TESTS = join(DIALOGUE_WEB, "tests");
const SRC = join(DIALOGUE_WEB, "src");

/** The calls whose string argument is a selector (or, for `toHaveClass`, a class list). */
const SELECTOR_APIS = new Set([
  "locator",
  "querySelector",
  "querySelectorAll",
  "$",
  "$$",
  "$eval",
  "$$eval",
  "waitForSelector",
  "toHaveClass",
  "matches",
  "closest",
  "contains",
]);

/** The calls whose string argument is a test id rather than a selector. */
const TEST_ID_APIS = new Set(["getByTestId"]);

/**
 * The matchers that state an absence. `toBe(0)` and `toBe(false)` are here because a
 * count and a presence flag are how this corpus says "gone" without a `toHaveCount`.
 */
const ABSENCE_MATCHERS =
  /\.(?:toHaveCount\(\s*0\s*\)|toBe\(\s*0\s*\)|toBe\(\s*false\s*\)|toBeNull\(\)|toBeUndefined\(\)|toBeFalsy\(\)|toBeHidden\(\)|not\.toBeVisible\(\)|not\.toBeNull\(\)|not\.toBeTruthy\(\))/u;

/** Any matcher that states something about the element, so the direction is not unknown. */
const PRESENCE_MATCHERS = /\.(?:not\.)?(?:toHave|toBe|toContain|toMatch|toEqual)[A-Za-z]*\(/u;

/** A literal that opens with this gate's own vocabulary: a hyphenated class, or a `data-`/`aria-` attribute. */
const SELECTOR_SHAPE = /^(?:\.[a-z][\w-]*-[\w-]|\[(?:data|aria)-[a-z])/iu;
const ATTRIBUTE_SELECTOR = /\[\s*((?:data|aria)-[a-z][\w-]*)\s*(?:[~^$*|]?\s*=\s*(?:"[^"]*"|'[^']*'|[^\]]*))?\s*\]/gu;
const TEST_ID_EQUALS = /\[\s*data-testid\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\]/gu;
const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/gu;
const PRODUCT_ATTRIBUTE = /(?<![\w-])((?:data|aria)-[a-z][a-z0-9-]*)(?![\w-])/gu;
const PRODUCT_WORD = /(?<![\w-])(-?[_a-zA-Z][\w-]*)(?![\w-])/gu;

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * The source text with every comment blanked out. The scan is the compiler's own, so a
 * comment marker inside a string or a JSX body is not mistaken for a comment.
 */
export function withoutComments(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text);
  const ranges = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia)
      ranges.push([scanner.getTokenPos(), scanner.getTextPos()]);
  }
  let out = "";
  let last = 0;
  for (const [start, end] of ranges) {
    out += `${text.slice(last, start)} `;
    last = end;
  }
  return out + text.slice(last);
}

function filesUnder(directory, accept) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (["node_modules", "test-fixtures", "test-support"].includes(name)) continue;
      out.push(...filesUnder(path, accept));
      continue;
    }
    if (accept(name)) out.push(path);
  }
  return out;
}

const relativeTo = (file) => relative(DIALOGUE_WEB, file).replace(/\\/gu, "/");

/** The TypeScript sources that ship: a unit test inside `src` cannot vouch for a name. */
export function productSources(directory = SRC) {
  return filesUnder(
    directory,
    (name) => /\.(ts|tsx)$/u.test(name) && !name.includes(".test.") && !name.endsWith(".d.ts"),
  );
}

/** The stylesheets, which reserve a class name without emitting it. */
export function productStylesheets(directory = SRC) {
  return filesUnder(directory, (name) => name.endsWith(".css"));
}

/**
 * Every name one piece of product text writes. Exported so a planted probe runs the
 * same rule the real tree does.
 */
export function namesInProductText(text, where, into) {
  const remember = (map, name) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(where);
  };
  const stripped = withoutComments(text);
  for (const match of stripped.matchAll(PRODUCT_ATTRIBUTE)) remember(into.attributes, match[1]);
  for (const match of stripped.matchAll(PRODUCT_WORD)) remember(into.classes, match[1]);
  // A test id is emitted wherever a literal equals it: `data-testid="x"` and
  // `data-testid={testId}` are the same fact one call apart. Read from the tree rather
  // than by pairing quote characters - an empty literal (`data-x=""`) desynchronises a
  // quote-pairing scan and turns the text between two literals into a "literal".
  walk(ts.createSourceFile(where, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) remember(into.testIds, node.text);
  });
  return into;
}

/** Every name the product writes, in four sets (`sheet` reserves, it does not emit). */
export function productNames(sources = productSources(), stylesheets = productStylesheets()) {
  const into = { attributes: new Map(), classes: new Map(), testIds: new Map(), sheet: new Map() };
  for (const file of sources) namesInProductText(readFileSync(file, "utf8"), relativeTo(file), into);
  for (const file of stylesheets) {
    const where = relativeTo(file);
    for (const match of withoutComments(readFileSync(file, "utf8")).matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)) {
      if (!into.sheet.has(match[1])) into.sheet.set(match[1], []);
      into.sheet.get(match[1]).push(where);
    }
  }
  return into;
}

/** The test files whose literals make up the population. */
export function journeySources(directory = TESTS) {
  return filesUnder(directory, (name) => /\.(ts|tsx|mjs|cjs|js)$/u.test(name)).filter((file) => file !== THIS_FILE);
}

/**
 * The capture kit's drivers: the other half of the population, and the half this gate was missing.
 *
 * `tools/live-run/frontend/capture/*.cjs` is 33 drivers and ~550 selector literals that drive the
 * shipped product over CDP, and nothing read them. The cost of that gap was measured on
 * `frontend-final-r1`: `common.cjs` gated its drawer dismissal on `.backdrop-overlay`, a class the
 * product had deleted when the drawer became a native `<dialog>` with a `::backdrop` scrim. The class
 * survived only inside a CSS comment, the gate was never true, Escape was never pressed, and 21 of 21
 * drivers failed clicking an app-bar entry behind an open modal drawer. Three more of the same shape
 * were in the kit when this population was added (`data-card-import-cancel`, `.message-text`,
 * `.swipe-btn-label`: a rename, a body class and a label class the product has never written), each a
 * reading that silently returns nothing. A driver is a selector consumer exactly as a journey is.
 */
export const CAPTURE_KIT = join(DIALOGUE_WEB, "..", "tools", "live-run", "frontend", "capture");

/** Every source that consumes a selector: the journeys, then the drivers. */
export function selectorConsumers() {
  return [...journeySources(TESTS), ...journeySources(CAPTURE_KIT)];
}

/**
 * The assertion that decides a name's direction: `absent` when the statement, the
 * variable, or the property holding the literal is asserted gone.
 *
 * Three routes, in order, because this corpus reaches an absence three ways: inline
 * (`expect(locator("x")).toHaveCount(0)`), through a variable (`const gone =
 * locator("x"); expect(gone).toHaveCount(0)`), and through a property of a reading
 * returned by `page.evaluate` (`legacyOrderLists: ...;
 * expect(reading.legacyOrderLists, "…").toBe(0)`). Anything else is `unknown` rather
 * than quietly counted as present.
 */
export function directionOf(sourceFile, node) {
  const names = [];
  let statement = null;
  for (let current = node; current.parent !== undefined; current = current.parent) {
    if (statement === null && ts.isStatement(current)) statement = current;
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) names.push(current.name.text);
    if (ts.isPropertyAssignment(current) && (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)))
      names.push(current.name.text);
    if (ts.isSourceFile(current)) break;
  }
  const verdict = (text) => {
    if (ABSENCE_MATCHERS.test(text)) return "absent";
    if (PRESENCE_MATCHERS.test(text)) return "present";
    return null;
  };
  for (const name of names) {
    const escaped = name.replace(/[$]/gu, "\\$");
    let matched = null;
    walk(sourceFile, (candidate) => {
      if (matched !== null || !ts.isCallExpression(candidate)) return;
      const callee = candidate.expression;
      if (!ts.isIdentifier(callee) || callee.text !== "expect") return;
      const argumentText = candidate.arguments.map((argument) => argument.getText()).join(",");
      if (!new RegExp(`\\b${escaped}\\b`, "u").test(argumentText)) return;
      for (let current = candidate; current.parent !== undefined; current = current.parent) {
        if (!ts.isStatement(current)) continue;
        matched = verdict(current.getText());
        break;
      }
    });
    if (matched !== null) return matched;
  }
  if (statement !== null) {
    const found = verdict(statement.getText());
    if (found !== null) return found;
  }
  return "unknown";
}

/**
 * The declaration a literal sits inside, when that declaration is a role pair marked
 * `kind: "absent"`, with the attribute sweep beside its witness spellings. Those
 * declare a capability the product does not have; the sweep is what makes the absence
 * falsifiable, so the gate takes their evidence rather than the names on their own.
 */
function absentDeclarationOf(node, sourceFile, file) {
  for (let current = node; current.parent !== undefined; current = current.parent) {
    if (ts.isObjectLiteralExpression(current)) {
      const property = (name) =>
        current.properties.find(
          (candidate) => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name,
        );
      const kind = property("kind");
      const isAbsent =
        kind !== undefined && ts.isPropertyAssignment(kind) && ts.isStringLiteral(kind.initializer) && kind.initializer.text === "absent";
      if (!isAbsent) continue;
      const sweep = property("attributes");
      const swept = sweep !== undefined && ts.isPropertyAssignment(sweep) && ts.isArrayLiteralExpression(sweep.initializer) && sweep.initializer.elements.length > 0;
      const { line } = sourceFile.getLineAndCharacterOfPosition(current.getStart(sourceFile));
      return { id: `${relativeTo(file)}:${line + 1}`, file: relativeTo(file), line: line + 1, swept };
    }
    if (ts.isSourceFile(current)) return null;
  }
  return null;
}

/** The names one selector literal mentions, as `{ kind, name }` pairs. */
export function namesInSelector(literal, api) {
  const found = [];
  if (TEST_ID_APIS.has(api)) return [{ kind: "testid", name: literal }];
  if (api === "toHaveClass") {
    for (const word of literal.trim().split(/\s+/u)) if (word !== "") found.push({ kind: "class", name: word });
    return found;
  }
  for (const match of literal.matchAll(TEST_ID_EQUALS)) found.push({ kind: "testid", name: match[1] ?? match[2] });
  for (const match of literal.matchAll(ATTRIBUTE_SELECTOR)) found.push({ kind: "attr", name: match[1] });
  for (const match of literal.matchAll(CLASS_TOKEN)) found.push({ kind: "class", name: match[1] });
  return found;
}

/**
 * The population: every `{ kind, name, file, line, direction, declaration }` the
 * journeys name, the declarations that own a non-empty set of them, and the count of
 * selector-shaped literals that reached no selector API - so the boundary is measured
 * instead of assumed.
 */
export function testedNames(files = journeySources()) {
  const found = [];
  const declarations = new Map();
  let literals = 0;
  let outsideSelectorPosition = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".mjs") || file.endsWith(".js") || file.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TSX,
    );
    const recorded = new Set();
    const record = (kind, name, node, api, declaration) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const key = `${kind}\u0000${name}\u0000${line}`;
      if (recorded.has(key)) return;
      recorded.add(key);
      if (declaration !== null) declarations.set(declaration.id, declaration);
      found.push({
        kind,
        name,
        file: relativeTo(file),
        line: line + 1,
        api,
        direction: declaration === null ? directionOf(sourceFile, node) : "absent",
        declaration: declaration === null ? null : declaration.id,
      });
    };
    walk(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const api = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : ts.isStringLiteral(callee)
            ? callee.text
            : null;
      if (api === null || (!SELECTOR_APIS.has(api) && !TEST_ID_APIS.has(api))) return;
      const argument = node.arguments[0];
      if (argument === undefined || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) return;
      literals += 1;
      const declaration = absentDeclarationOf(argument, sourceFile, file);
      for (const { kind, name } of namesInSelector(argument.text, api)) record(kind, name, argument, api, declaration);
    });
    // A literal that looks like a selector but never reaches a selector API is outside
    // the population. Counted, never guessed at: a name invented at runtime cannot be
    // checked. A name a `kind: "absent"` declaration owns is the exception - the
    // declaration is its selector source, and the sweep beside it is what measures the
    // absence - so those are recorded and held to the ledger's standard below.
    walk(sourceFile, (node) => {
      if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return;
      if (!SELECTOR_SHAPE.test(node.text)) return;
      const declaration = absentDeclarationOf(node, sourceFile, file);
      if (declaration !== null) {
        for (const { kind, name } of namesInSelector(node.text, "locator")) record(kind, name, node, "witness", declaration);
        return;
      }
      let inSelector = false;
      for (let current = node; current.parent !== undefined && !inSelector; current = current.parent) {
        const parent = current.parent;
        if (!ts.isCallExpression(parent) || parent.arguments[0] !== current) continue;
        const callee = parent.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
        inSelector = SELECTOR_APIS.has(name) || TEST_ID_APIS.has(name);
      }
      if (!inSelector) outsideSelectorPosition += 1;
    });
  }
  return { found, declarations: [...declarations.values()], literals, outsideSelectorPosition };
}

/** The attribute names the journeys write into the page themselves. */
export function harnessWrittenNames(files = journeySources()) {
  const written = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/setAttribute\(\s*["'`]((?:data|aria)-[a-z][\w-]*)["'`]/gu)) written.add(match[1]);
    for (const match of text.matchAll(/dataset\.([a-zA-Z][\w]*)\s*=/gu))
      written.add(`data-${match[1].replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return written;
}

/**
 * Absence guards: a name nothing writes, which a journey asserts absent, where the
 * product still owns the place the name would come back to. Each entry names the path
 * that would write it and the live assertion beside it that carries the force today.
 * The list is a ledger of exceptions, not a place to park a finding: the entry reds as
 * soon as the product writes the name, reds if the path is not on disk, and reds if
 * the guarded assertion is gone.
 */
export const ABSENCE_LEDGER = Object.freeze([
  Object.freeze({
    kind: "testid",
    name: "game-guide-step-one-order",
    wouldBeWrittenBy: "src/components/GameStatePanel.tsx",
    why:
      "the ordered sub-list of the two staging steps was replaced by one step plus a disclosure; the guide region that would render it again is `GameStatePanel`, and the name-free force beside the guard is `stepOneOrderedLists`, which counts `<ol>` inside step one itself",
    assertedAt: "tests/game-start-guide-single-step.spec.ts",
  }),
  Object.freeze({
    kind: "testid",
    name: "game-mod-loader-install",
    wouldBeWrittenBy: "src/components/StardewInstallationDiscovery.tsx",
    why:
      "the install card was deleted - SMAPI is its own project, so the panel guides the player instead of writing into their game folder - and the panel that used to offer it is `StardewInstallationDiscovery`; the force beside the guard is the panel's own `data-state` and control-roster readings",
    assertedAt: "tests/installation-panel-actions.spec.ts",
  }),
  Object.freeze({
    kind: "class",
    name: "surface-advanced-settings",
    wouldBeWrittenBy: "src/style.css",
    why:
      "the deleted advanced block's rules are still in the sheet (`.surface-advanced-settings`, its `h4` and hover rules), so the class is still the product's own vocabulary; the force beside the guard is the surface's own text, which must not carry the English word that block printed",
    assertedAt: "tests/player-visible-defects.spec.ts",
  }),
]);

function producersOf(kind, name, product, harness) {
  if (kind === "attr")
    return product.attributes.has(name) ? product.attributes.get(name) : harness.has(name) ? ["written by the harness"] : [];
  if (kind === "testid") return product.testIds.has(name) ? product.testIds.get(name) : [];
  return product.classes.has(name) ? product.classes.get(name) : [];
}

/** The ledger entry for a `(kind, name)` pair, or null. */
export function findGuard(kind, name, ledger = ABSENCE_LEDGER) {
  return ledger.find((entry) => entry.kind === kind && entry.name === name) ?? null;
}

/**
 * The whole classification. `dead` holds names nothing writes and a journey asserts
 * absent; `guarded` holds the ledger's names; `declared` holds the names a
 * name-agnostic absence declaration owns; `present` holds a name nothing writes whose
 * assertion expects it to be there - a different break, still a name with no producer.
 */
export function classify(population, product, harness = new Set(), ledger = ABSENCE_LEDGER) {
  const dead = [];
  const guarded = [];
  const declared = [];
  const present = [];
  const seen = new Set();
  let alive = 0;
  let examined = 0;
  for (const entry of population) {
    const key = `${entry.kind}\u0000${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    examined += 1;
    if (producersOf(entry.kind, entry.name, product, harness).length > 0) {
      alive += 1;
      continue;
    }
    const where = `${entry.file}:${entry.line}`;
    const sites = population.filter((other) => other.kind === entry.kind && other.name === entry.name).length;
    if (findGuard(entry.kind, entry.name, ledger) !== null) guarded.push(entry.name);
    else if (entry.declaration !== null) declared.push(entry.name);
    else if (entry.direction === "absent")
      dead.push(
        `${where}: ${entry.kind} \`${entry.name}\` is asserted absent and no source in dialogue-web/src writes it (${sites} site(s))`,
      );
    else
      present.push(
        `${where}: ${entry.kind} \`${entry.name}\` is read (${entry.direction}) and no source in dialogue-web/src writes it (${sites} site(s))`,
      );
  }
  return { examined, alive, dead, guarded, declared, present };
}

const PRODUCT = productNames();
const HARNESS = harnessWrittenNames(selectorConsumers());
const POPULATION = testedNames(selectorConsumers());
const CLASSIFIED = classify(POPULATION.found, PRODUCT, HARNESS);

test("selector-producer.1: every name a journey reads is one the product writes, or a guard that says where it would come back", (t) => {
  const failures = [...CLASSIFIED.dead, ...CLASSIFIED.present];
  t.diagnostic(
    `selector-producer.1: ${POPULATION.literals} selector literal(s) in ${selectorConsumers().length} selector-consuming source(s), ` +
      `${POPULATION.outsideSelectorPosition} selector-shaped literal(s) outside a selector position; ` +
      `${CLASSIFIED.examined} distinct name(s) examined: ${CLASSIFIED.alive} written by dialogue-web/src or the harness, ` +
      `${CLASSIFIED.guarded.length} guarded by the ledger, ${CLASSIFIED.declared.length} owned by a declared absence, ` +
      `${CLASSIFIED.dead.length} dead, ${CLASSIFIED.present.length} read with no producer`,
  );
  assert.ok(
    CLASSIFIED.examined > 0 && POPULATION.literals > 0,
    "the population is empty: no selector literal and no name to check means the reading is blocked, not clean",
  );
  assert.ok(
    PRODUCT.attributes.size > 0 && PRODUCT.testIds.size > 0 && PRODUCT.classes.size > 0,
    "the product side of the population is empty: nothing was read out of dialogue-web/src",
  );
  assert.deepEqual(failures, [], "an assertion about a name nothing writes cannot fail");
});

test("selector-producer.2: the guards expire - a producer, a missing path or a deleted assertion reds the entry", (t) => {
  const failures = [];
  for (const entry of ABSENCE_LEDGER) {
    const producers = producersOf(entry.kind, entry.name, PRODUCT, HARNESS);
    if (producers.length > 0)
      failures.push(
        `${entry.kind} \`${entry.name}\` is written again (${producers.slice(0, 3).join(", ")}), so the assertion is falsifiable - drop the exemption`,
      );
    if (!existsSync(join(DIALOGUE_WEB, entry.wouldBeWrittenBy)))
      failures.push(`${entry.kind} \`${entry.name}\`: wouldBeWrittenBy ${entry.wouldBeWrittenBy} is not on disk`);
    if (!existsSync(join(DIALOGUE_WEB, entry.assertedAt)))
      failures.push(`${entry.kind} \`${entry.name}\`: assertedAt ${entry.assertedAt} is not on disk`);
    else if (!POPULATION.found.some((found) => found.kind === entry.kind && found.name === entry.name))
      failures.push(`${entry.kind} \`${entry.name}\`: the guarded assertion is gone, so the entry reserves nothing - delete it`);
    if (typeof entry.why !== "string" || entry.why.length < 40)
      failures.push(`${entry.kind} \`${entry.name}\`: a guard must name the path and the force beside it`);
  }
  t.diagnostic(
    `selector-producer.2: ${ABSENCE_LEDGER.length} guard(s) - ${ABSENCE_LEDGER.map((entry) => entry.name).join(", ")}`,
  );
  assert.deepEqual(failures, [], "a guard that no longer guards is an exemption nobody re-checks");
});

test("selector-producer.3 (planted): an absent name with no producer is dead; a produced one is not", (t) => {
  const planted = [
    { kind: "attr", name: "data-planted-absent", file: "tests/probe.spec.ts", line: 1, direction: "absent", declaration: null },
    { kind: "class", name: "planted-backdrop", file: "tests/probe.spec.ts", line: 2, direction: "absent", declaration: null },
    { kind: "testid", name: "planted-surface", file: "tests/probe.spec.ts", line: 3, direction: "absent", declaration: null },
  ];
  const empty = { attributes: new Map(), classes: new Map(), testIds: new Map(), sheet: new Map() };
  const dead = classify(planted, empty, new Set(), []);
  assert.equal(dead.examined, 3, "the planted population is the population examined");
  assert.equal(dead.dead.length, 3, "nothing writes these names, and every one is asserted absent");
  assert.match(dead.dead[0], /tests\/probe\.spec\.ts:1: attr `data-planted-absent` is asserted absent/u);
  const written = namesInProductText(
    'export const Shelf = () => <div data-planted-absent="" className="planted-backdrop" data-testid="planted-surface" />;\n',
    "src/probe.tsx",
    { attributes: new Map(), classes: new Map(), testIds: new Map(), sheet: new Map() },
  );
  const alive = classify(planted, written, new Set(), []);
  assert.deepEqual(alive.dead, [], "a name the product writes is not a finding, whichever side of the population it came from");
  assert.equal(alive.alive, 3, "all three planted names are produced by the probe source");
  const guarded = classify(planted, empty, new Set(), [
    {
      kind: "attr",
      name: "data-planted-absent",
      wouldBeWrittenBy: "src/probe.tsx",
      assertedAt: "tests/probe.spec.ts",
      why: "a guard states the path that would write the name again, and the force beside it today",
    },
  ]);
  assert.equal(guarded.dead.length, 2, "the guarded name leaves the dead list; the other two stay");
  assert.deepEqual(guarded.guarded, ["data-planted-absent"]);
  t.diagnostic(`selector-producer.3: planted -> ${dead.dead[0]}`);
});

test("selector-producer.4 (planted): a comment is not a producer", (t) => {
  const probe = "/** No backdrop and no `aria-modal`, and no `.composed-drawer-backdrop` either. */\nconst shelf = 1;\n";
  const stripped = withoutComments(probe);
  assert.equal(stripped.includes("aria-modal"), false, "a comment naming the attribute does not write it");
  assert.equal(stripped.includes("composed-drawer-backdrop"), false, "a comment naming the class does not write it");
  const read = productNames([join(SRC, "components", "AppBar.tsx")], []);
  assert.equal(
    read.attributes.has("aria-modal"),
    false,
    "the real AppBar.tsx names aria-modal only in the sentence saying there is none, and that is not a producer",
  );
  assert.equal(
    read.classes.has("composed-drawer-backdrop"),
    false,
    "no source in this tree names the removed drawer backdrop, in a comment or anywhere else",
  );
  t.diagnostic("selector-producer.4: comments are stripped before the product side is built");
});

test("selector-producer.5: a declared absence owns its spellings only with a name-agnostic sweep beside them", (t) => {
  const failures = POPULATION.declarations
    .filter((declaration) => !declaration.swept)
    .map(
      (declaration) =>
        `${declaration.file}:${declaration.line} declares a capability absent with witness spellings and no attribute sweep: that absence can never be measured, whatever the state is called`,
    );
  t.diagnostic(
    `selector-producer.5: ${POPULATION.declarations.length} declared absence(s) in ${new Set(
      POPULATION.declarations.map((declaration) => declaration.file),
    ).size} file(s), owning ${CLASSIFIED.declared.length} name(s)`,
  );
  assert.ok(POPULATION.declarations.length > 0, "no declared absence was found, so this rule measured nothing");
  assert.deepEqual(failures, [], "an absence that only lists spellings is this class with extra steps");
});
