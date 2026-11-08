/**
 * Gate for the UNIMPLEMENTED CLASS NAME defect class: a `className` the product renders whose name
 * claims a behaviour no stylesheet implements.
 *
 * Confirmed instances (2026-11):
 *
 *   - `visually-hidden-input-label` was written on the two selects' labels in
 *     `management-panels.tsx` and declared nowhere. Measured at 400x800 the two labels laid out
 *     as body text, took 58 px of the saved-connection row's height, and pushed the row's next
 *     action to bottom 836 - 36 px below an 800 px viewport. The name asserted hiding; nothing
 *     hid. (Fixed in 4d0a2cc9; the gate's `history` proof replays the commit before it.)
 *   - `data-tone` values were added to `AppBar` while the status dot's colour stayed hardcoded to
 *     `var(--success)`, so three tones painted one colour. That is the same question asked of an
 *     attribute instead of a class: this gate answers only the class half, because a class name
 *     has one declaration site to check and an attribute value needs a second table.
 *
 * THE POPULATION is derived twice, and neither half is a list:
 *
 *   A. every class name in a `className` of the `.tsx` files under `dialogue-web/src`, read from a
 *      TypeScript AST (the dialogue-web workspace's own compiler, resolved through its
 *      package.json) so a name inside a comment, a string that is not a class list, or a JSDoc
 *      example cannot become a usage;
 *   B. every class selector in the `.css` files under `dialogue-web/src`, read from the selector
 *      text with comments removed. A class is DECLARED when a selector names it - `.a`, `.b` in `:is(...)`,
 *      a descendant of another class - because that is what "a rule implements this name" means.
 *      A class named only inside a declaration block (`content: ".a"`) is not a selector and does
 *      not count.
 *
 * WHAT THE GATE CANNOT READ, it names. `className={expression}` is resolved for the shapes the
 * product actually writes: string literals, template literals, a conditional whose branches are
 * themselves readable, and `+` concatenation of those. Anything else - a prop passthrough
 * (`className={className}`), a helper call (`nextActionClass("test")`), a lookup
 * (`styles[x]`) - is reported as an unreadable site and must be declared in `UNREADABLE_GAPS`
 * with a reason. The readable parts of a template literal are still counted: a gap in the
 * expression does not excuse the static names beside it.
 *
 * WHAT IS DECLARED, and why a declaration cannot outlive its reason:
 *
 *   - `EXEMPT_NAMES` holds a name the product uses deliberately with no rule of its own, with the
 *     reason (today: an umbrella name whose element is styled by a declared modifier, and a
 *     region marker whose treatment comes from a data attribute or an ancestor rule). Each entry
 *     fails the gate when it is no longer needed - the name is gone from the tree, or a stylesheet
 *     declares it now - so an exemption cannot widen into a rule repeal.
 *   - `UNREADABLE_GAPS` holds a site the gate cannot read, quoted by `witness` and counted by
 *     `sites`, and fails on drift in either.
 *
 * The remaining reading - a name that IS declared nowhere and has no exemption - is the finding,
 * named with its file, line and the class.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

/** The one tree this gate governs: the browser product's own sources. */
const UI_ROOT = "dialogue-web/src";

const TSX_EXTENSION = ".tsx";
const CSS_EXTENSION = ".css";
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/** A class token: what CSS and the product both spell the same way. */
const CLASS_TOKEN = /^[A-Za-z_][\w-]*$/u;
/** `.name` in a selector. A decimal (`.45`), which needs a digit, is not a class. */
const CSS_CLASS = /\.([A-Za-z_-][\w-]*)/gu;

/**
 * Names the product writes and no stylesheet declares, with the reason the name is still right.
 * Keyed by the name alone: the reason is a fact about the name, not about one call site.
 */
export const EXEMPT_NAMES = Object.freeze([
  Object.freeze({
    className: "action-btn",
    reason:
      "an umbrella over sixteen buttons in MessageBubble, every one of which also carries a declared " +
      "modifier (`.copy-btn`, `.edit-save-btn`, `.rewind-btn`, `.regenerate-btn`, `.delete-btn`) that owns its " +
      "treatment; the umbrella is what a future shared rule would attach to, and removing it would break the " +
      "name the modifiers' siblings are written against",
  }),
  Object.freeze({
    className: "game-player-settings",
    reason:
      "the section also carries `surface-model-settings`, whose declared rule is the treatment; this name is the " +
      "Game surface's own marker on the same element, the way `.game-diagnostics` marks the disclosure it shares " +
      "with `.custom-disclosure`",
  }),
  Object.freeze({
    className: "opening-option-commit",
    reason:
      "the button also carries `small-button`, whose declared rule carries the 44 px floor and the whole " +
      "treatment; this name marks which control in the footer commits the opening, and the test targets it by " +
      "its `data-testid`",
  }),
  Object.freeze({
    className: "game-diagnostics-summary",
    reason:
      "a `<summary>` inside `.custom-disclosure`, which owns its row, its chevron and its open/closed rotation; " +
      "the name marks the disclosure's own summary for the two rules that reach it through that ancestor",
  }),
  Object.freeze({
    className: "surface-model-recommended-label",
    reason:
      "the span is styled by `.surface-model-recommended > span`, which is the rule that already reaches it; " +
      "naming the span again would be a second spelling of the same selector",
  }),
  Object.freeze({
    className: "chat-item-badge",
    reason:
      "the transient `switching` acknowledgement on a Chats row: an inline note inside the row's own link, " +
      "styled by nothing because it is one word in the row's existing line, and read by " +
      '`data-testid="chat-select-pending"`',
  }),
]);

/**
 * Sites the gate cannot read, quoted by the text it waives. `sites` is how many times that text
 * occurs in that file; the gate fails when either the text or the count no longer matches, so a
 * gap cannot be declared once and quietly enlarge.
 */
export const UNREADABLE_GAPS = Object.freeze([
  Object.freeze({
    path: "dialogue-web/src/components/CompanionAvatar.tsx",
    witness: "`avatar ${className}`",
    reason:
      "the suffix is the caller's own prop applied on top of the declared `avatar`; which names a caller passes is not knowable here",
    sites: 1,
  }),
  Object.freeze({
    path: "dialogue-web/src/components/ContextDrawer.tsx",
    witness: "`context-panel ${panelClassName}`",
    reason: "the suffix is the panel's caller-supplied variant name, applied on top of the declared `context-panel`",
    sites: 1,
  }),
  Object.freeze({
    path: "dialogue-web/src/components/GameStatePanel.tsx",
    witness: "`game-group ${className}`",
    reason: "the suffix is the caller's own prop applied on top of the declared `game-group`",
    sites: 1,
  }),
  Object.freeze({
    path: "dialogue-web/src/components/SurfaceView.tsx",
    witness: "`surface-view ${className}`",
    reason: "the suffix is the caller's own prop applied on top of the declared `surface-view`",
    sites: 1,
  }),
  Object.freeze({
    path: "dialogue-web/src/components/MarkdownMessage.tsx",
    witness: "className={className}",
    reason: "the markdown renderer forwards the wrapper class its caller chose; the declaration belongs to that caller",
    sites: 1,
  }),
  Object.freeze({
    path: "dialogue-web/src/components/management-panels.tsx",
    witness: "nextActionClass(",
    reason:
      "one local helper answers the saved connection's next-action class for two controls; its four answers are " +
      "declared (`small-button`, `primary`, and the two refusal tones), and resolving a helper's returns would " +
      "mean evaluating the product inside its gate",
    sites: 2,
  }),
]);

const requireFromDialogueWeb = createRequire(join(import.meta.dirname, "..", "..", "dialogue-web", "package.json"));

/** The TypeScript compiler the dialogue-web workspace builds with - the same one that reads these files. */
function typescript() {
  return requireFromDialogueWeb("typescript");
}

function toPosix(path) {
  return path.split(sep).join("/");
}

/** Every file under `directory` whose name ends with `extension`, as absolute paths. */
function listFiles(directory, extension) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("dist")) continue;
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      files.push(path);
    }
  };
  walk(directory);
  return files.sort();
}

/** The class names a stylesheet declares, i.e. every class in every selector, comments removed. */
export function declaredClassNames(cssTexts) {
  const declared = new Set();
  for (const text of cssTexts) {
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const match of withoutComments.matchAll(CSS_CLASS)) declared.add(match[1]);
  }
  return declared;
}

/**
 * The class names one `className` expression renders, and whether the gate could read all of it.
 * `names` is empty and `readable` false for an expression with no static part at all.
 */
function readClassNameExpression(ts, node) {
  const read = (expression) => {
    if (expression === undefined) return { names: [], readable: false };
    if (ts.isParenthesizedExpression(expression)) return read(expression.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
      return { names: tokens(expression.text), readable: true };
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = read(expression.whenTrue);
      const whenFalse = read(expression.whenFalse);
      return { names: [...whenTrue.names, ...whenFalse.names], readable: whenTrue.readable && whenFalse.readable };
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = read(expression.left);
      const right = read(expression.right);
      return { names: [...left.names, ...right.names], readable: left.readable && right.readable };
    }
    if (ts.isTemplateExpression(expression)) {
      // The static text is what the product certainly renders; the spans are read where they can be
      // and the site is still reported when one of them cannot.
      const names = tokens(expression.head.text);
      let readable = true;
      for (const span of expression.templateSpans) {
        const inner = read(span.expression);
        names.push(...inner.names, ...tokens(span.literal.text));
        if (!inner.readable) readable = false;
      }
      return { names, readable };
    }
    return { names: [], readable: false };
  };
  return read(node);
}

function tokens(text) {
  return text.split(/\s+/u).filter((token) => CLASS_TOKEN.test(token));
}

/**
 * Every class name the tree's `className` attributes render, keyed by name, plus every site the
 * gate could not read. A name inside an object key, a comment or a non-class string never enters:
 * the walk only looks at JSX attributes named `className`.
 */
function usedClassNames({ repoRoot, files = listFiles(join(repoRoot, UI_ROOT), TSX_EXTENSION) }) {
  const ts = typescript();
  const usages = new Map();
  const unreadable = [];
  const sources = new Map();
  for (const file of files) {
    const path = toPosix(relative(repoRoot, file));
    const text = readFileSync(file, "utf8");
    sources.set(path, text);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const record = (name, line) => {
      if (!usages.has(name)) usages.set(name, []);
      usages.get(name).push({ path, line });
    };
    const visit = (node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "className") {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const initializer = node.initializer;
        const staticText = initializer !== undefined && ts.isStringLiteral(initializer) ? initializer.text : null;
        const expression =
          initializer !== undefined && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
        const reading =
          staticText !== null ? { names: tokens(staticText), readable: true } : readClassNameExpression(ts, expression);
        for (const name of reading.names) record(name, line);
        if (!reading.readable)
          unreadable.push({
            path,
            line,
            text: node.getText(source).replace(/\s+/gu, " ").trim(),
            names: reading.names,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { usages, unreadable, sources };
}

/** The one-line, greppable form the CLI prints and CI matches on. */
export function formatFinding(finding) {
  return `undeclared_class:${finding.path}:${finding.line}:${finding.className}`;
}

/**
 * The verdict: every used name neither declared nor exempt, every exemption that stopped being
 * needed, and every unreadable gap that no longer matches the code it waives.
 */
export function checkClassNameDeclarations({
  repoRoot,
  exempt = EXEMPT_NAMES,
  gaps = UNREADABLE_GAPS,
  files,
  cssFiles,
}) {
  const { usages, unreadable, sources } = usedClassNames({
    repoRoot,
    ...(files === undefined ? {} : { files }),
  });
  const declared = declaredClassNames(
    (cssFiles ?? listFiles(join(repoRoot, UI_ROOT), CSS_EXTENSION)).map((file) => readFileSync(file, "utf8")),
  );
  const exemptNames = new Set(exempt.map((entry) => entry.className));

  const undeclared = [...usages.keys()]
    .filter((name) => !declared.has(name) && !exemptNames.has(name))
    .sort()
    .map((name) => ({ className: name, sites: usages.get(name) }));

  const staleExemptions = [];
  for (const entry of exempt) {
    if (!usages.has(entry.className)) staleExemptions.push({ code: "exemption_unused", className: entry.className });
    else if (declared.has(entry.className))
      staleExemptions.push({ code: "exemption_declared_now", className: entry.className });
  }

  const problems = [];
  for (const entry of exempt)
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      problems.push({ code: "exemption_unreasoned", className: entry.className });

  const declaredGaps = [];
  for (const entry of gaps) {
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      problems.push({ code: "gap_unreasoned", path: entry.path, witness: entry.witness });
    const text = sources.get(entry.path);
    if (text === undefined) {
      problems.push({ code: "gap_stale_path", path: entry.path, witness: entry.witness });
      continue;
    }
    const found = unreadable.filter(
      (site) => site.path === entry.path && site.text.includes(entry.witness) && site.text.includes("className"),
    );
    const occurrences = text.split(entry.witness).length - 1;
    if (found.length !== entry.sites || occurrences === 0) {
      problems.push({
        code: "gap_count_drift",
        path: entry.path,
        witness: entry.witness,
        detail: `declared ${entry.sites} site(s), found ${found.length} unreadable site(s) naming it (${occurrences} occurrence(s) in the file)`,
      });
      continue;
    }
    for (const site of found) declaredGaps.push(site);
  }
  const unreported = unreadable.filter((site) => !declaredGaps.includes(site));

  return {
    counts: { files: sources.size, names: usages.size, declared: declared.size, exempt: exempt.length },
    undeclared,
    unreadable,
    unreported,
    staleExemptions,
    problems,
  };
}

/** Whether the reading is a failure: a finding, a stale declaration, or a declaration problem. */
export function verdict(readout) {
  return (
    readout.undeclared.length > 0 ||
    readout.unreported.length > 0 ||
    readout.staleExemptions.length > 0 ||
    readout.problems.length > 0
  );
}
