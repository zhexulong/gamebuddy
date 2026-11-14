/**
 * Two layout defects that both stay green until a human notices them, as one static gate.
 *
 * THE CLASSES. A container that can start scrolling mid-use loses exactly the scrollbar's width on the
 * inline axis the moment its content outgrows it: the chat timeline re-wraps every bubble when a reply
 * crosses the viewport height, a drawer body moves sideways when a section opens. `scrollbar-gutter`
 * fixes it with one declaration per container, and a later rule can quietly delete that declaration.
 * The second class is the same shape in time rather than width: a `useLayoutEffect` that writes
 * `height: auto` and then reads `scrollHeight` forces a synchronous layout, once per keystroke in a
 * view with the whole transcript above it. `field-sizing: content` is the layout engine's own answer,
 * and the fallback that still measures is only honest while it is behind the capability check.
 *
 * WHY A GATE AND NOT THE TWO SPECS ALREADY IN THE TREE. `scroll-containers-keep-their-width.spec.ts`
 * (mounted zone) measures the reservation in a real browser and `text-field-sizing.spec.ts` measures the
 * forced-layout counts per keystroke; both are behaviour, and both pass over a tree that hands the NEXT
 * scroll container no gutter or the NEXT measured field no capability check, because a new rule or a new
 * effect joins no assertion. This file derives both populations from the sources themselves, so a
 * member nobody wrote a spec for is still held.
 *
 * POPULATION 1, from the sheet: every ruleset in `src/style.css` that declares a block-axis overflow of
 * `auto` or `scroll` (`style-scroll-containers.ts` is the reader, shared with the mounted spec). Each is
 * classified as reserving a gutter, exempt with a stated reason, or a finding.
 *
 * POPULATION 2, from the sources: every `*.ts`/`*.tsx` module under `src` that calls `useEffect`/
 * `useLayoutEffect` with an inline callback, and every `scrollHeight` read inside such a callback. Each
 * read is classified by what the effect does with it:
 *
 *   sizing         the effect writes an inline height - the field-sizing fallback, and the only shape
 *                  that needs the capability check. Unguarded, it is a finding.
 *   scroll-to-tail the read is the value assigned to a `scrollTop`, so a scroll position is pinned and no
 *                  box is sized from it. No inline height write exists to remove.
 *   unclassified   anything else: a read the gate cannot vouch for, reported so its author states which
 *                  of the two it is instead of leaving a third meaning in the tree.
 *
 * THE CAPABILITY NAME IS DERIVED, NOT WRITTEN HERE. The guard is whatever `src/components/field-sizing.ts`
 * exports from a `CSS.supports("field-sizing", …)` initialiser, imported by name into the measuring module.
 * A rename in that module moves this gate with it; a measuring effect that stops importing it loses its
 * guard here.
 *
 * EXEMPTIONS EXPIRE, in both populations. A gutter exemption is keyed on the selector, so the entry goes
 * red the day the sheet stops declaring a scroller there; a role exemption is keyed on the role, so it goes
 * red the day no effect reads `scrollHeight` in that shape. Neither direction is a silent pass, and both
 * populations refuse to pass over zero members: a sheet with no scroll container and a source tree with no
 * effect read are readings that agree with themselves.
 *
 * The gate asserts where the declarations and the reads are, not what the browser paints: the mounted
 * specs keep the pixel claims.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SCROLL_GUTTER_EXEMPTIONS, STYLESHEET, scrollContainers } from "./style-scroll-containers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIALOGUE_WEB = join(HERE, "..");
const SRC = join(DIALOGUE_WEB, "src");
const CAPABILITY_MODULE = join(SRC, "components", "field-sizing.ts");
const REPO = join(DIALOGUE_WEB, "..");

/** A finding's location: repo-relative, so a reader can open it from the repository root. */
const at = (file, line) => `${relative(REPO, file).split(sep).join("/")}:${line}`;

/**
 * A role exemption is a fact about the SHAPE of a read, not about a line in a file, so it is keyed on the
 * role the reader derived. It expires when no read in the tree has that role any more (§ the test that
 * names it), which is the only way a shape exemption can stop being true without anyone noticing.
 */
const ROLE_EXEMPTIONS = new Map([
  [
    "scroll-to-tail",
    "the read is a scroll POSITION, not a box height: the value is assigned to a `scrollTop` to keep the " +
      "newest row in view, so nothing is sized from it, there is no inline `height` write for the layout " +
      "engine to take over, and removing the read would remove the feature",
  ],
]);

/** One module under `src`: its absolute path, and the text both readers parse. */
function sourceModules(directory = SRC) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) files.push(path);
    }
  };
  walk(directory);
  return files.sort();
}

const parse = (path, text, kind) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
const jsxKind = (path) => (path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const isExported = (statement) =>
  statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

/** `CSS.supports("field-sizing", …)`, the one expression that says a browser sizes a field from its content. */
function isFieldSizingProbe(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "supports") return false;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "CSS") return false;
  const [property] = node.arguments;
  return property !== undefined && ts.isStringLiteral(property) && property.text === "field-sizing";
}

/**
 * The names `src/components/field-sizing.ts` exports from a `CSS.supports("field-sizing", …)` initialiser.
 *
 * Derived so the gate follows a rename instead of pinning one: an effect that tests a capability this
 * module no longer publishes has no guard, and says so as a finding rather than passing.
 */
export function capabilityExportNames(text, path = CAPABILITY_MODULE) {
  const file = parse(path, text, ts.ScriptKind.TS);
  const names = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      let found = false;
      const visit = (node) => {
        if (isFieldSizingProbe(node)) found = true;
        ts.forEachChild(node, visit);
      };
      visit(declaration.initializer);
      if (found) names.push(declaration.name.text);
    }
  }
  return names;
}

/** The local names a module binds to the capability, from an import of the module that publishes it. */
export function capabilityBindings(sourceFile, capabilityNames) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(?:^|\/)field-sizing(?:\.ts)?$/u.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (capabilityNames.includes(imported)) names.add(element.name.text);
    }
  }
  return names;
}

/** Does this expression mention one of the capability bindings? */
function mentionsCapability(node, bindings) {
  if (bindings.size === 0) return false;
  let found = false;
  const visit = (candidate) => {
    if (ts.isIdentifier(candidate) && bindings.has(candidate.text)) found = true;
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

const isReturnOfNothing = (statement) =>
  ts.isReturnStatement(statement) ||
  (ts.isBlock(statement) &&
    statement.statements.some((inner) => ts.isReturnStatement(inner) && inner.expression === undefined));

const isPropertyNamed = (node, name) => ts.isPropertyAccessExpression(node) && node.name.text === name;

/** `el.style.height = …` or `el.style.setProperty("height", …)` inside the effect. */
function writesInlineHeight(body) {
  let found = false;
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isPropertyNamed(node.left, "height") &&
      isPropertyNamed(node.left.expression, "style")
    )
      found = true;
    if (
      ts.isCallExpression(node) &&
      isPropertyNamed(node.expression, "setProperty") &&
      isPropertyNamed(node.expression.expression, "style") &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "height"
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * Is the read behind the capability check? Two shapes, both of which the two measured fields use:
 * a surrounding `if`/conditional that tests the capability (so the read only runs where the engine cannot
 * size the field), or an early `return` on it earlier in the same block (so the read runs only for the
 * browsers outside the sheet's own path).
 */
export function guardedByCapability(read, body, bindings) {
  for (let node = read.parent; node !== undefined && node !== body; node = node.parent) {
    if (ts.isIfStatement(node) && mentionsCapability(node.expression, bindings)) return true;
    if (ts.isConditionalExpression(node) && mentionsCapability(node.condition, bindings)) return true;
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) &&
      mentionsCapability(node, bindings)
    )
      return true;
  }
  for (let node = read; node !== undefined && node !== body; node = node.parent) {
    const block = node.parent;
    if (block === undefined || !ts.isBlock(block)) continue;
    for (const statement of block.statements) {
      if (statement.getStart() >= read.getStart()) break;
      if (ts.isIfStatement(statement) && mentionsCapability(statement.expression, bindings) && isReturnOfNothing(statement.thenStatement))
        return true;
    }
  }
  return false;
}

const calleeName = (expression) => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
};

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"]);

/** The inline callbacks handed to a React effect hook in one module. */
function effectCallbacks(sourceFile) {
  const callbacks = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && EFFECT_HOOKS.has(calleeName(node.expression) ?? "")) {
      const [callback] = node.arguments;
      if (callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
        callbacks.push(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return callbacks;
}

/** `X.scrollHeight` and `X["scrollHeight"]`: the two spellings of the layout read this gate is about. */
const isScrollHeightRead = (node) =>
  isPropertyNamed(node, "scrollHeight") ||
  (ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "scrollHeight");

/**
 * Every `scrollHeight` read inside an effect callback, with the role the enclosing effect gives it.
 *
 * The role is read from the effect's own body rather than from a comment or a list: an inline height write
 * makes the read a sizing measure, an assignment of the read to a `scrollTop` makes it a scroll position,
 * and anything else is left unclassified so its author has to say which it is.
 */
export function effectReads(path, text, capabilityNames) {
  const sourceFile = parse(path, text, jsxKind(path));
  const bindings = capabilityBindings(sourceFile, capabilityNames);
  const rows = [];
  for (const body of effectCallbacks(sourceFile)) {
    const sizing = writesInlineHeight(body);
    const visit = (node) => {
      if (isScrollHeightRead(node)) {
        const assignedToScrollTop =
          node.parent !== undefined &&
          ts.isBinaryExpression(node.parent) &&
          node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          isPropertyNamed(node.parent.left, "scrollTop");
        rows.push({
          file: path,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          role: sizing ? "sizing" : assignedToScrollTop ? "scroll-to-tail" : "unclassified",
          guarded: guardedByCapability(node, body, bindings),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
  }
  return rows;
}

/** The sheet's containers, each with how it is accounted for. */
export function classifyContainers(containers, exemptions = SCROLL_GUTTER_EXEMPTIONS) {
  return containers.map((container) => ({
    selector: container.selector,
    how: container.reserving ? "reserving" : exemptions.has(container.selector) ? "exempt" : "unguarded",
  }));
}

const readCapabilityNames = () =>
  existsSync(CAPABILITY_MODULE) ? capabilityExportNames(readFileSync(CAPABILITY_MODULE, "utf8")) : [];
const readContainers = () => scrollContainers(readFileSync(STYLESHEET, "utf8"));
const readEffectReads = () => {
  const capabilityNames = readCapabilityNames();
  return sourceModules().flatMap((path) => effectReads(path, readFileSync(path, "utf8"), capabilityNames));
};

test("layout-stability.1: every scroll container reserves its gutter, or is exempt with a reason", (t) => {
  const containers = readContainers();
  const classified = classifyContainers(containers);
  const unguarded = classified.filter((container) => container.how === "unguarded");
  const reserving = classified.filter((container) => container.how === "reserving").length;
  const exempt = classified.filter((container) => container.how === "exempt").length;
  t.diagnostic(
    `layout-stability.1: ${containers.length} scroll container(s) examined · ${reserving} reserving a gutter · ` +
      `${exempt} exempt with a reason · ${unguarded.length} unguarded`,
  );
  assert.ok(
    containers.length > 0,
    "examined 0 scroll container(s) in src/style.css: the sheet declares no block-axis scroller, so this reading " +
      "agrees with itself and cannot pass",
  );
  assert.deepEqual(
    unguarded.map(
      (container) =>
        `${container.selector} can start scrolling mid-use but reserves no gutter - declare ` +
        "`scrollbar-gutter: stable`, or add it to SCROLL_GUTTER_EXEMPTIONS in style-scroll-containers.ts with the " +
        "reason it is left alone and the condition that would end the exemption",
    ),
    [],
    "a scroll container that takes its scrollbar's width from the content re-wraps every line above it the moment " +
      "the content outgrows the box",
  );
});

test("layout-stability.2: every gutter exemption still names a scroll container, so none outlives its reason", (t) => {
  const declared = new Set(readContainers().map((container) => container.selector));
  const stale = [...SCROLL_GUTTER_EXEMPTIONS.keys()].filter((selector) => !declared.has(selector));
  t.diagnostic(
    `layout-stability.2: ${SCROLL_GUTTER_EXEMPTIONS.size} gutter exemption(s) examined against ${declared.size} ` +
      `container selector(s) · ${stale.length} stale`,
  );
  assert.deepEqual(
    stale,
    [],
    "these exemptions no longer name a scroll container, so the reason each recorded is gone and the entry must go " +
      "with it - an exemption that cannot expire is a hole in the population above",
  );
});

test("layout-stability.3: the sheet reader tells a reservation, an inline-axis scroller and a hidden one apart", (t) => {
  const selectors = (css) => scrollContainers(css).map((container) => container.selector);
  const reserving = (css) => scrollContainers(css)[0]?.reserving;
  assert.deepEqual(selectors(".gate-probe-body {\n  overflow-y: auto;\n}\n"), [".gate-probe-body"], "a block-axis scroller is the population");
  assert.equal(reserving(".gate-probe-body {\n  overflow-y: auto;\n  scrollbar-gutter: stable;\n}\n"), true, "`stable` is read as the reservation");
  assert.equal(
    reserving(".gate-probe-body {\n  overflow: auto;\n  scrollbar-gutter: stable both-edges;\n}\n"),
    true,
    "`stable both-edges` reserves as well",
  );
  assert.equal(reserving(".gate-probe-body {\n  overflow: auto;\n  scrollbar-gutter: auto;\n}\n"), false, "`auto` reserves nothing");
  assert.deepEqual(selectors(".gate-probe-pre {\n  overflow-x: auto;\n}\n"), [], "an inline-axis scroller is outside the population");
  assert.deepEqual(selectors(".gate-probe-field {\n  overflow-y: hidden;\n}\n"), [], "`hidden` draws no scrollbar to reserve for");
  t.diagnostic("layout-stability.3: 6 reader boundaries examined");
});

test("layout-stability.4: the capability guard's name is read from the module that owns it", (t) => {
  const names = readCapabilityNames();
  t.diagnostic(`layout-stability.4: ${names.length} capability binding(s) published by field-sizing.ts: ${names.join(", ")}`);
  assert.deepEqual(
    names.length > 0 ? [] : [relative(REPO, CAPABILITY_MODULE).split(sep).join("/")],
    [],
    "that module is absent, or publishes no exported binding whose initialiser probes `CSS.supports(\"field-sizing\", …)` " +
      "- which leaves population 2 with no guard to read, so every measuring effect in the tree is reported as unguarded",
  );
});

test("layout-stability.5: every scrollHeight read in an effect is a sizing measure behind the capability check, or a declared role", (t) => {
  const reads = readEffectReads();
  const sizing = reads.filter((read) => read.role === "sizing");
  const guarded = sizing.filter((read) => read.guarded);
  const roles = reads.filter((read) => read.role !== "sizing");
  const findings = [];
  for (const read of reads) {
    if (read.role === "sizing" && !read.guarded)
      findings.push(
        `${at(read.file, read.line)} writes an inline height and then reads scrollHeight with no capability check - ` +
          "put the measurement behind `if (<capability>) return;` so it runs only where the layout engine cannot " +
          "size the field, or delete it and let `field-sizing: content` do the work",
      );
    if (read.role === "unclassified")
      findings.push(
        `${at(read.file, read.line)} reads scrollHeight in an effect and the gate cannot say what it is for - ` +
          "if it sizes a box it owes the capability check, and if it is a scroll position it must be assigned to a " +
          "`scrollTop` or given a role exemption with its reason",
      );
  }
  t.diagnostic(
    `layout-stability.5: ${reads.length} scrollHeight read(s) in effect(s) examined · ${sizing.length} sizing ` +
      `(${guarded.length} behind the capability check) · ${roles.length} with a declared role · ${findings.length} unguarded`,
  );
  assert.ok(
    reads.length > 0,
    "examined 0 scrollHeight read(s) in an effect: either the product no longer measures a box in an effect (then " +
      "delete this population's rule and say so) or this reader stopped seeing the sources",
  );
  assert.deepEqual(findings, [], "a per-keystroke write-then-read of the layout is the defect this population holds");
});

test("layout-stability.6: every role exemption still names a read, so none outlives its reason", (t) => {
  const roles = new Set(readEffectReads().map((read) => read.role));
  const stale = [...ROLE_EXEMPTIONS.keys()].filter((role) => !roles.has(role));
  t.diagnostic(
    `layout-stability.6: ${ROLE_EXEMPTIONS.size} role exemption(s) examined against ${roles.size} role(s) in the ` +
      `sources · ${stale.length} stale`,
  );
  assert.deepEqual(
    stale,
    [],
    "these role exemptions no longer name a read, so the shape they recorded is gone and the entry must go with it",
  );
});

test("layout-stability.7: a read is guarded by the capability check and by nothing else", (t) => {
  const names = ["fieldSizingSupported"];
  const guarded = (source) => {
    const rows = effectReads("probe.tsx", source, names);
    return rows.map((row) => `${row.role}:${row.guarded}`);
  };
  assert.deepEqual(
    guarded(
      'import { fieldSizingSupported } from "./field-sizing";\nexport function A({ value }) {\n' +
        '  useLayoutEffect(() => {\n    if (fieldSizingSupported) return;\n    const el = ref.current;\n' +
        '    el.style.height = "auto";\n    el.style.height = `${el.scrollHeight}px`;\n  }, [value]);\n}\n',
    ),
    ["sizing:true"],
    "an early `return` on the capability makes the measurement a fallback",
  );
  assert.deepEqual(
    guarded(
      'import { fieldSizingSupported as sized } from "./field-sizing";\nexport function A({ value }) {\n' +
        "  useLayoutEffect(() => {\n    if (!sized) {\n      const el = ref.current;\n" +
        '      el.style.height = `${el.scrollHeight}px`;\n    }\n  }, [value]);\n}\n',
    ),
    ["sizing:true"],
    "the same guard read through an alias, and stated as a positive branch rather than an early return",
  );
  assert.deepEqual(
    guarded(
      'export function A({ value }) {\n  useLayoutEffect(() => {\n    const el = ref.current;\n' +
        '    el.style.height = "auto";\n    el.style.height = `${el.scrollHeight}px`;\n  }, [value]);\n}\n',
    ),
    ["sizing:false"],
    "a write-then-read loop with no capability check is the defect, and it is not excused by importing nothing",
  );
  assert.deepEqual(
    guarded(
      'export function A({ value }) {\n  useLayoutEffect(() => {\n    const section = ref.current;\n' +
        "    section.scrollTop = section.scrollHeight;\n  }, [value]);\n}\n",
    ),
    ["scroll-to-tail:false"],
    "a scroll position is its own role, and it owes no capability check because no box is sized from it",
  );
  assert.deepEqual(
    guarded('export function A() {\n  useEffect(() => {\n    const el = ref.current;\n    if (el.scrollHeight > 0) log(el);\n  }, []);\n}\n'),
    ["unclassified:false"],
    "a read the gate cannot classify is reported rather than passed",
  );
  t.diagnostic("layout-stability.7: 5 guard and role shapes examined");
});
