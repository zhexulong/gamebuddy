#!/usr/bin/env node
/**
 * A spec that measures the page at more than one size must measure a declared set of sizes, or say why not.
 *
 * WHY. The viewport population had five spellings: four hand-written lists in four spec files (seven cells, six cells,
 * two, two) and a fifth that was never written at all - `playwright.config.ts` inherits `devices["Desktop Chrome"]`'s
 * 1280x720, a size in none of the lists, so fifty-four of the mounted specs sample a cell nobody chose. `dialogue-web/
 * tests/viewport-policy.ts` is the one spelling: it declares the cells with the fold each one sits on, the pair that
 * stands for the two layouts, and the cell a spec inherits when it sets none. This gate keeps every spec measuring a
 * declared set - a spec that iterates `VIEWPORT_SIZES` or `LAYOUT_PAIR` joins a new cell without an edit, and a spec
 * that writes its own partial list is named with the sizes it is missing.
 *
 * WHAT IT ASSERTS, per viewport call site in a spec (`page.setViewportSize(...)`), read with the TypeScript parser
 * rather than a text pattern:
 *
 *   1. a site that resolves to ONE cell, or to none, owes nothing: pinning the layout a defect belongs to is a decision
 *      and not an omission. The count of such sites is printed, because a gate whose population is only the odd ones
 *      out must still say how many it looked at.
 *   2. a site that resolves to TWO OR MORE cells must cover `VIEWPORT_SIZES` (the matrix) or `LAYOUT_PAIR` (one cell
 *      per layout), or match a stated exemption. Failing that it is `viewport_cells_incomplete`, naming the file, the
 *      line, the sizes it evaluates and the declared sizes it is missing.
 *   3. an argument this reader cannot resolve to cells is `viewport_cells_unresolved`, never a skip: the population is
 *      what the reader could read, and a reading it could not take is a finding with the expression quoted.
 *   4. the inherited cell - `playwright.config.ts`'s `viewport` - must BE `DEFAULT_VIEWPORT` imported from the policy.
 *      A config that leaves it to the device is `viewport_default_undeclared`, because that is the fifth spelling
 *      coming back.
 *
 * THE EXEMPTIONS ARE STATED, KEYED ON CONTENT AND EXPIRE. A breakpoint sweep - widths 400, 481, 520, 560 at one
 * height, to find where a row starts to wrap - is finer than the population and does not owe it; that is a reason, and
 * it is stated here with the exact cell set it was measured at. The key is the file plus the cell set, not a count, so
 * a sweep that gains or loses a width stops matching its entry (`exemption_expired`) instead of silently widening the
 * pass, and an entry whose file no longer evaluates that set is a lie too. Neither direction is a silent pass.
 *
 * WHAT IT DOES NOT ASSERT: that a declared set is measured well, that a spec claim's cells reach a real page, or that
 * the cells are laid out the way the policy's reasons say. It asserts where the sizes come from, not what they show.
 *
 * red-proof: inject  a spec file measuring 1440x900, 1024x768 and 400x800 by hand ->
 *   `viewport_cells_incomplete: ...cells=1440x900,1024x768,400x800 missing=900x700,816x767,480x900,1280x800` and exit 1
 *   (tools/check-viewport-population.test.mjs, in a throwaway tests root beside the reader)
 * red-proof: inject  a fourth cell added to `VIEWPORT_SIZES` in the same throwaway tree, with the pair spec still
 *   measuring 1440x900 and 400x800 -> the pair spec stays green (it iterates the policy) and the hand-written spec's
 *   `missing=` list grows by the new cell, which is the size it now owes (tools/check-viewport-population.test.mjs)
 * red-proof: inject  a project `use` with no `viewport`, and one with a literal in its place ->
 *   `viewport_default_undeclared: <the config> inherits the device viewport ...` and exit 1
 *   (tools/check-viewport-population.test.mjs)
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(ROOT, "dialogue-web");
const testsRootOf = (webRoot) => join(webRoot, "tests");
const POLICY_FILE = "viewport-policy.ts";
/** The TypeScript compiler the web workspace builds with: the same parser, not a second spelling of it. */
const typescript = createRequire(join(WEB_ROOT, "package.json"))("typescript");

/**
 * Viewport sets a spec may measure that are neither the matrix nor the pair, each with the reason.
 *
 * `cells` is the set the site evaluates - the same content the gate compares, so an entry cannot outlive its sweep.
 * `lines` names the call sites the entry was measured at; a line number that drifts is reported, because the reason
 * was written about a particular measurement ("the row wraps somewhere between 400 and 560") rather than about a file.
 */
export const VIEWPORT_EXEMPTIONS = Object.freeze([
  {
    file: "dialogue-web/tests/conversation-rendering-defects.spec.ts",
    cells: ["400x900", "481x900", "520x900", "560x900"],
    reason:
      "A breakpoint sweep, not a matrix: the row's bubble width was measured at 400, 481, 520 and 560 to find where the " +
      "flex row stops fitting. It is finer than the population and asks a different question - where does this start " +
      "to wrap - so it does not owe the declared cells.",
  },
  {
    file: "dialogue-web/tests/app-bar-status-narrow.spec.ts",
    cells: ["1440x900", "400x900", "481x900", "560x900", "640x900", "860x900"],
    reason:
      "A sweep across every width fold in `style.css` (480, 560, 640, 860) at one height, to find the width at which " +
      "the AppBar status changes shape, plus the two ends it must agree with. The declared cells sit on four of those " +
      "folds; the sweep exists to show the fold itself, which no seven-cell set can.",
  },
  {
    file: "dialogue-web/tests/game-drawer-columns.spec.ts",
    cells: ["400x800", "700x800"],
    reason:
      "The drawer's narrow ruling is measured at two widths below the 860px fold, to show it stays one column as the " +
      "window widens without crossing into the wide arrangement. The desktop end (1440x900) is measured in the same " +
      "file, and it is a different ruling - columns, not one.",
  },
  {
    file: "dialogue-web/tests/settings-first-viewport.spec.ts",
    cells: ["360x640", "400x800"],
    reason:
      "The settings sheet's first viewport is measured at the smallest phone the product is expected to run on " +
      "(360x640, a Galaxy-S5-class CSS viewport) as well as the declared phone baseline, because the sheet's next " +
      "action is the thing that falls below the fold first. Neither is a desktop cell: the matrix's floor is the " +
      "declared 400x800, and a 360-wide cell is not yet declared - see the lane note.",
  },
  {
    file: "dialogue-web/tests/management-surface-panels.spec.ts",
    cells: ["400x900", "1440x900"],
    reason:
      "The two ends at a 900-tall window, held fixed so the reading is about width alone while the panels are " +
      "compared; the height is the sweep's own and the file measures the declared pair elsewhere.",
  },
  {
    file: "dialogue-web/tests/ui-hygiene-runtime.spec.ts",
    cells: ["400x800", "1280x800"],
    reason:
      "Two widths at the same height, measuring that a long word does not push the page sideways at either the phone " +
      "baseline or the laptop width. The height is held fixed because the defect is horizontal; the pair and the " +
      "matrix are measured by the label gate in this file.",
  },
]);

/** The declared cell sets, compared as sets of keys: `1440x900` sorts before `400x900`, so order is not an identity. */
const sameCells = (left, right) =>
  left.length === right.length && [...left].sort().join(",") === [...right].sort().join(",");

const finding = (code, detail) => ({ code, detail });
const cellKey = (cell) => `${cell.width}x${cell.height}`;
/** `x as const`, `x satisfies T` and `<T>x` say nothing about the cells; the expression they wrap does. */
const isWrapped = (node) =>
  typescript.isAsExpression(node) ||
  typescript.isSatisfiesExpression(node) ||
  typescript.isTypeAssertionExpression(node);

/** The declared sets from the policy file, each as the cell list the gate compares against. */
function readPolicy(webRoot) {
  const path = join(testsRootOf(webRoot), POLICY_FILE);
  const text = readFileSync(path, "utf8");
  const sourceFile = typescript.createSourceFile(
    path,
    text,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const reader = createCellReader(sourceFile, sourceFile);
  const declared = (name) => {
    const initializer = reader.localInitializer(name);
    if (initializer === null) throw new Error(`${POLICY_FILE} declares no \`${name}\``);
    const resolved = reader.cellsOf(initializer);
    if (resolved.cells.size === 0)
      throw new Error(`${POLICY_FILE}'s \`${name}\` resolves to no cell: ${resolved.unresolved.join("; ")}`);
    return [...resolved.cells.values()];
  };
  return {
    sourceFile,
    file: relative(webRoot, path).split(sep).join("/"),
    matrix: declared("VIEWPORT_SIZES"),
    pair: declared("LAYOUT_PAIR"),
    defaultCell: declared("DEFAULT_VIEWPORT")[0],
  };
}

/**
 * Resolves an expression to the viewport cells it can stand for, the way a reader of the file would: a cell literal, a
 * loop binding over a list, a file-local constant, or an export of the policy module.
 */
function createCellReader(sourceFile, policySource = null) {
  const unresolved = (reason) => ({ cells: new Map(), unresolved: [reason] });
  const empty = () => ({ cells: new Map(), unresolved: [] });
  const merge = (into, from) => {
    for (const [key, cell] of from.cells) into.cells.set(key, cell);
    into.unresolved.push(...from.unresolved);
  };

  function importOf(name) {
    for (const statement of sourceFile.statements) {
      if (!typescript.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !typescript.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (element.name.text !== name) continue;
        return {
          specifier: statement.moduleSpecifier.text,
          imported: element.propertyName === undefined ? name : element.propertyName.text,
        };
      }
    }
    return null;
  }

  function localInitializer(name) {
    let found = null;
    const visit = (node) => {
      if (found !== null) return;
      if (typescript.isVariableDeclaration(node) && typescript.isIdentifier(node.name) && node.name.text === name) {
        found = node.initializer ?? null;
        return;
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  /** The expression a name is bound to by the nearest enclosing `for (const name of ...)`. */
  function loopBinding(name, node) {
    let current = node;
    while (current !== undefined) {
      const list =
        typescript.isForOfStatement(current) && typescript.isVariableDeclarationList(current.initializer)
          ? current.initializer
          : typescript.isForStatement(current) && typescript.isVariableDeclarationList(current.initializer)
            ? current.initializer
            : null;
      if (list !== null) {
        for (const declaration of list.declarations) {
          const names = typescript.isIdentifier(declaration.name)
            ? [declaration.name.text]
            : declaration.name.elements.map((element) =>
                typescript.isIdentifier(element.name) ? element.name.text : "",
              );
          if (!names.includes(name)) continue;
          if (typescript.isForOfStatement(current)) return current.expression;
          if (declaration.initializer !== undefined) return declaration.initializer;
        }
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * A helper that takes the viewport as a parameter (`mountAt(page, viewport)`) is read through its call sites in the
   * same file: one hop, so the helper's own `setViewportSize(viewport)` still resolves to the cells it is called with.
   */
  function parameterArguments(name, node) {
    let current = node;
    while (current !== undefined) {
      const parameters = current.parameters;
      if (parameters !== undefined) {
        const index = parameters.findIndex(
          (parameter) => typescript.isIdentifier(parameter.name) && parameter.name.text === name,
        );
        if (index !== -1) {
          const callee = calleeNameOf(current);
          if (callee === null) return null;
          const arguments_ = [];
          const visit = (candidate) => {
            if (
              typescript.isCallExpression(candidate) &&
              typescript.isIdentifier(candidate.expression) &&
              candidate.expression.text === callee &&
              candidate.arguments[index] !== undefined
            )
              arguments_.push(candidate.arguments[index]);
            typescript.forEachChild(candidate, visit);
          };
          visit(sourceFile);
          return arguments_.length === 0 ? null : arguments_;
        }
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * `{ width, height }` handed to a helper that takes both as parameters: each call is one cell, read from the two
   * arguments together, so `measure(1440, 900)` and `measure(400, 800)` are two cells rather than the four pairings.
   */
  function parameterPairCells(width, height) {
    if (!(typescript.isIdentifier(width) && typescript.isIdentifier(height))) return null;
    const parameters = enclosingParameters(width, height);
    if (parameters === null) return null;
    const [callee, widthIndex, heightIndex] = parameters;
    const out = empty();
    for (const call of callSitesOf(callee)) {
      const widthValues = numbersOf(call.arguments[widthIndex] ?? null) ?? [];
      const heightValues = numbersOf(call.arguments[heightIndex] ?? null) ?? [];
      if (widthValues.length === 0 || heightValues.length === 0) {
        out.unresolved.push(`\`${squash(call.getText()).slice(0, 60)}\` passes no numeric viewport`);
        continue;
      }
      for (const w of widthValues) for (const h of heightValues) out.cells.set(`${w}x${h}`, { width: w, height: h });
    }
    return out.cells.size === 0 && out.unresolved.length === 0 ? null : out;
  }

  /** The function-like whose parameters `width` and `height` are, and the call name it is found by. */
  function enclosingParameters(width, height) {
    let current = width;
    while (current !== undefined) {
      const parameters = current.parameters?.filter((parameter) => typescript.isIdentifier(parameter.name));
      if (parameters !== undefined) {
        const names = parameters.map((parameter) => parameter.name.text);
        if (names.includes(width.text) && names.includes(height.text)) {
          const callee = calleeNameOf(current);
          if (callee === null) return null;
          return [callee, names.indexOf(width.text), names.indexOf(height.text)];
        }
      }
      current = current.parent;
    }
    return null;
  }

  function callSitesOf(callee) {
    const calls = [];
    const visit = (candidate) => {
      if (
        typescript.isCallExpression(candidate) &&
        typescript.isIdentifier(candidate.expression) &&
        candidate.expression.text === callee
      )
        calls.push(candidate);
      typescript.forEachChild(candidate, visit);
    };
    visit(sourceFile);
    return calls;
  }

  function calleeNameOf(node) {
    if ((typescript.isFunctionDeclaration(node) || typescript.isFunctionExpression(node)) && node.name !== undefined)
      return node.name.text;
    const container = node.parent;
    if (container === undefined) return null;
    if (typescript.isVariableDeclaration(container) && typescript.isIdentifier(container.name))
      return container.name.text;
    return null;
  }

  /** The numbers a numeric expression can take: literals, and a binding over a list of literals. */
  function numbersOf(node) {
    if (node === null || node === undefined) return [];
    if (typescript.isNumericLiteral(node)) return [Number(node.text)];
    if (typescript.isParenthesizedExpression(node)) return numbersOf(node.expression);
    if (isWrapped(node)) return numbersOf(node.expression);
    if (typescript.isIdentifier(node)) {
      const bound = loopBinding(node.text, node) ?? localInitializer(node.text);
      if (bound === null) return [];
      return numbersOf(bound);
    }
    if (typescript.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => numbersOf(element));
    return [];
  }

  /** The cells an export of `viewport-policy` stands for, read from the policy's own declarations. */
  function policyCells(name) {
    if (policySource === null) return null;
    const initializer = policyReader().localInitializer(name);
    return initializer === null ? null : policyReader().cellsOf(initializer);
  }

  let policyReaderCache = null;
  function policyReader() {
    if (policyReaderCache === null) policyReaderCache = createCellReader(policySource, policySource);
    return policyReaderCache;
  }

  function propertyOf(object, name) {
    for (const property of object.properties) {
      if (
        typescript.isPropertyAssignment(property) &&
        typescript.isIdentifier(property.name) &&
        property.name.text === name
      )
        return property.initializer;
      if (typescript.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
    }
    return null;
  }

  return {
    localInitializer,
    cellsOf,
  };

  function cellsOf(node) {
    if (node === null || node === undefined) return unresolved("no initializer");
    if (typescript.isParenthesizedExpression(node)) return cellsOf(node.expression);
    if (isWrapped(node)) return cellsOf(node.expression);
    if (typescript.isArrayLiteralExpression(node)) {
      const out = empty();
      for (const element of node.elements) merge(out, cellsOf(element));
      return out;
    }
    if (typescript.isElementAccessExpression(node)) return cellOfElement(node);
    if (typescript.isIdentifier(node)) {
      const bound = loopBinding(node.text, node) ?? localInitializer(node.text);
      if (bound !== null) return cellsOf(bound);
      const fromParameter = parameterArguments(node.text, node);
      if (fromParameter !== null) {
        const out = empty();
        for (const argument of fromParameter) merge(out, cellsOf(argument));
        return out;
      }
      const imported = importOf(node.text);
      if (imported !== null) {
        if (imported.specifier === "./viewport-policy") {
          const fromPolicy = policyCells(imported.imported);
          return fromPolicy ?? unresolved(`./viewport-policy declares no \`${imported.imported}\``);
        }
        return unresolved(
          `\`${node.text}\` is imported from "${imported.specifier}", so its cells are not readable from this file: ` +
            "iterate it where it is declared, or import the policy constant",
        );
      }
      return unresolved(`\`${node.text}\` is not a viewport list, a loop binding or a file-local constant`);
    }
    if (typescript.isObjectLiteralExpression(node)) return cellsOfObject(node);
    return unresolved(`\`${squash(node.getText())}\` is not a viewport cell or a list of them`);
  }

  /** `LIST[0]` is the entry at that position; an index the reader cannot read falls back to the whole list. */
  function cellOfElement(node) {
    const list = cellsOf(node.expression);
    if (list.unresolved.length > 0) return list;
    if (!typescript.isNumericLiteral(node.argumentExpression)) return list;
    const entry = [...list.cells.values()][Number(node.argumentExpression.text)];
    const out = empty();
    if (entry !== undefined) out.cells.set(cellKey(entry), entry);
    else out.unresolved.push(`\`${squash(node.getText())}\` is past the end of its list`);
    return out;
  }

  /**
   * The cells an object literal stands for. `{ width: X.width, height: X.height }` is one cell per entry of `X`, not the
   * cross-product of its columns, so that pairing is read as a pair before the two dimensions are read separately.
   */
  function cellsOfObject(object) {
    const width = propertyOf(object, "width");
    const height = propertyOf(object, "height");
    if (width === null || height === null)
      return unresolved(`\`${squash(object.getText()).slice(0, 80)}\` has no two viewport dimensions`);
    const paired = pairSourceOf(width, height);
    if (paired !== null) return cellsOf(paired);
    const pairedParameters = parameterPairCells(width, height);
    if (pairedParameters !== null) return pairedParameters;
    const widths = numbersOf(width);
    const heights = numbersOf(height);
    if (widths.length === 0 || heights.length === 0)
      return unresolved(`\`${squash(object.getText()).slice(0, 80)}\` has no two numeric viewport dimensions`);
    const out = empty();
    for (const w of widths) for (const h of heights) out.cells.set(`${w}x${h}`, { width: w, height: h });
    return out;
  }

  /** `X.width` with `X.height`, or `width` with `height` destructured from the same list, names one list. */
  function pairSourceOf(width, height) {
    const base = (node, expected) => {
      if (typescript.isPropertyAccessExpression(node) && node.name.text === expected)
        return { expression: node.expression, name: expected };
      if (typescript.isIdentifier(node) && node.text === expected) return { expression: null, name: expected };
      return null;
    };
    const w = base(width, "width");
    const h = base(height, "height");
    if (w === null || h === null) return null;
    if (w.expression !== null && h.expression !== null)
      return squash(w.expression.getText()) === squash(h.expression.getText()) ? w.expression : null;
    if (w.expression !== null || h.expression !== null) return null;
    const fromWidth = loopBinding("width", width);
    const fromHeight = loopBinding("height", height);
    if (fromWidth === null || fromHeight === null) return null;
    return squash(fromWidth.getText()) === squash(fromHeight.getText()) ? fromWidth : null;
  }
}

const squash = (text) => text.replace(/\s+/gu, "");

/** Every `*.spec.ts` under the tests root, so a new spec joins the population without an edit here. */
function specFiles(testsRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".spec.ts")) files.push(path);
    }
  };
  walk(testsRoot);
  return files.sort();
}

const isViewportCall = (node) =>
  typescript.isCallExpression(node) &&
  typescript.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "setViewportSize";

/** One row per viewport call site in one spec file. */
function sitesOf(path, relativePath, policySource) {
  const text = readFileSync(path, "utf8");
  const sourceFile = typescript.createSourceFile(
    path,
    text,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const reader = createCellReader(sourceFile, policySource);
  const rows = [];
  const visit = (node) => {
    if (isViewportCall(node)) {
      const argument = node.arguments[0];
      const resolved =
        argument === undefined ? { cells: new Map(), unresolved: ["no argument"] } : reader.cellsOf(argument);
      rows.push({
        file: relativePath,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        expression: argument === undefined ? "" : squash(argument.getText()),
        cells: [...resolved.cells.keys()].sort(),
        unresolved: resolved.unresolved,
      });
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rows;
}

function covers(cellKeys, declared) {
  const have = new Set(cellKeys);
  return declared.every((cell) => have.has(cellKey(cell)));
}

/**
 * The reading, over a workspace. `webRoot` and `exemptions` are arguments so the falsifier can point it at a throwaway
 * workspace instead of a second implementation of this reader (`tools/check-viewport-population.test.mjs`).
 */
export function checkViewportPopulation({ webRoot = WEB_ROOT, exemptions = VIEWPORT_EXEMPTIONS } = {}) {
  const policy = readPolicy(webRoot);
  const testsRoot = testsRootOf(webRoot);
  const files = specFiles(testsRoot);
  const findings = [];
  const rows = [];
  for (const path of files) {
    const relativePath = relative(dirname(webRoot), path).split(sep).join("/");
    rows.push(...sitesOf(path, relativePath, policy.sourceFile));
  }

  const usage = exemptions.map((exemption) => ({ exemption, seen: 0 }));
  for (const row of rows) {
    if (row.unresolved.length > 0) {
      findings.push(
        finding(
          "viewport_cells_unresolved",
          `${row.file}:${row.line} \`${row.expression}\` - ${row.unresolved.join("; ")}`,
        ),
      );
      continue;
    }
    if (row.cells.length < 2) continue;
    if (covers(row.cells, policy.matrix)) {
      row.verdict = "matrix";
      continue;
    }
    if (covers(row.cells, policy.pair)) {
      row.verdict = "layout pair";
      continue;
    }
    const stated = usage.find(
      (entry) => entry.exemption.file === row.file && sameCells(entry.exemption.cells, row.cells),
    );
    if (stated !== undefined) {
      stated.seen += 1;
      row.verdict = "exempt";
      continue;
    }
    row.verdict = "incomplete";
    const missing = policy.matrix.filter((cell) => !row.cells.includes(cellKey(cell))).map(cellKey);
    const near = exemptions.find((exemption) => exemption.file === row.file);
    findings.push(
      finding(
        "viewport_cells_incomplete",
        `${row.file}:${row.line} measures ${row.cells.join(",")} but owes the declared set ` +
          `[${policy.matrix.map(cellKey).join(",")}] or the layout pair [${policy.pair.map(cellKey).join(",")}]: ` +
          `missing=${missing.join(",")}` +
          (near === undefined
            ? " - iterate VIEWPORT_SIZES/LAYOUT_PAIR from ./viewport-policy, or state a reason in VIEWPORT_EXEMPTIONS"
            : ` - this file has an exemption for ${near.cells.join(",")}, which does not cover this site`),
      ),
    );
  }
  for (const { exemption, seen } of usage) {
    if (seen > 0) continue;
    findings.push(
      finding(
        "exemption_expired",
        `${exemption.file} cells=${exemption.cells.join(",")}: the stated exemption matches no viewport call site, ` +
          "so either the sweep moved and the reason needs restating, or the site now measures a declared set and the " +
          "entry must go",
      ),
    );
  }

  const inherited = readInheritedViewport(webRoot);
  if (!inherited.declared) findings.push(finding("viewport_default_undeclared", inherited.detail));

  const varying = rows.filter((row) => row.cells.length > 1).length;
  const spelled = rows.filter(
    (row) => row.cells.length > 1 && row.verdict !== "matrix" && row.verdict !== "layout pair",
  ).length;
  let status = "failed";
  if (rows.length === 0 || policy.matrix.length < 2) status = "blocked";
  else if (findings.length === 0) status = "passed";
  return {
    status,
    findings,
    examinedFiles: files.length,
    examinedSites: rows.length,
    varyingSites: varying,
    exemptSites: spelled,
    policy,
    inherited,
    rows,
  };
}

/** The cell a spec that sets no viewport is measured in: `playwright.config.ts` must take it from the policy. */
function readInheritedViewport(webRoot) {
  const path = join(webRoot, "playwright.config.ts");
  const file = relative(dirname(webRoot), path).split(sep).join("/");
  const text = readFileSync(path, "utf8");
  const sourceFile = typescript.createSourceFile(
    path,
    text,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  const assignments = [];
  const visit = (node) => {
    if (typescript.isPropertyAssignment(node) && typescript.isIdentifier(node.name) && node.name.text === "viewport")
      assignments.push(node);
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  const undeclared = (detail) => ({ declared: false, detail: `${file} ${detail}` });
  if (assignments.length === 0)
    return undeclared(
      "names no `viewport`, so every spec that sets none is measured in the Playwright device's cell - the one " +
        "spelling the population never declared. Set `viewport: DEFAULT_VIEWPORT` from ./tests/viewport-policy.",
    );
  if (assignments.length > 1)
    return undeclared(
      `names \`viewport\` ${assignments.length} times, so which one a spec inherits is not decided here`,
    );
  const initializer = assignments[0].initializer;
  if (!typescript.isIdentifier(initializer) || initializer.text !== "DEFAULT_VIEWPORT")
    return undeclared(
      `sets \`viewport\` to \`${squash(initializer.getText())}\` instead of the policy's \`DEFAULT_VIEWPORT\`, so the ` +
        "inherited cell is a second spelling of the population",
    );
  const imported = sourceFile.statements
    .filter((statement) => typescript.isImportDeclaration(statement))
    .filter((statement) => statement.moduleSpecifier.text === "./tests/viewport-policy")
    .flatMap((statement) => {
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !typescript.isNamedImports(bindings)) return [];
      return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
    });
  if (!imported.includes("DEFAULT_VIEWPORT"))
    return undeclared(`uses \`DEFAULT_VIEWPORT\` but does not import it from ./tests/viewport-policy`);
  return { declared: true, detail: "" };
}

function main() {
  const webRootIndex = process.argv.indexOf("--web-root");
  const webRoot = webRootIndex === -1 ? WEB_ROOT : resolve(process.argv[webRootIndex + 1]);
  const verdict = checkViewportPopulation({ webRoot });
  const inherited = verdict.inherited.declared ? "" : " (not declared)";
  for (const row of verdict.rows) {
    const cells = row.cells.length === 0 ? "unresolved" : row.cells.join(",");
    console.log(
      `[viewport-population] ${row.file}:${row.line} cells=${cells} — ${row.verdict ?? "unresolved: " + row.unresolved.join("; ")}`,
    );
  }
  console.log(
    `[viewport-population] examined ${verdict.examinedFiles} spec file(s) and ${verdict.examinedSites} viewport call ` +
      `site(s): ${verdict.varyingSites} vary the size, ${verdict.exemptSites} by a stated exemption; declared ` +
      `${verdict.policy.matrix.length} cells [${verdict.policy.matrix.map(cellKey).join(",")}], pair ` +
      `[${verdict.policy.pair.map(cellKey).join(",")}], inherited ${cellKey(verdict.policy.defaultCell)}${inherited}`,
  );
  for (const entry of verdict.findings) console.log(`[viewport-population] ${entry.code}: ${entry.detail}`);
  console.log(
    JSON.stringify({
      gate: "viewport-population",
      status: verdict.status,
      examined: verdict.examinedSites,
      examinedFiles: verdict.examinedFiles,
      findings: verdict.findings,
    }),
  );
  if (verdict.status === "blocked") {
    console.error("[viewport-population] blocked: the reading covered no viewport call site, which is not a pass");
    process.exit(1);
  }
  process.exit(verdict.findings.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
