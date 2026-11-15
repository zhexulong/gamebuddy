#!/usr/bin/env node
/**
 * Every press that destroys player content on the Host is armed, or says who armed it instead.
 *
 * WHY. This family arrived one control at a time and each time it was found by a player, never by a
 * check: a companion's whole record deleted by one press, a connection (which IS the credential)
 * removed by one press, a reply deleted by one press, a world-book entry dropped from the library by
 * one press. Five lanes fixed five instances; `dialogue-web/src/components/armed-confirmation.ts`
 * became the ONE spelling of the second press (focus into the safe answer, Escape on the element that
 * holds the two answers), and the last bare one sat in plain sight: `CharactersPanel.tsx`'s clear of
 * the companion's performance directive, one press, 8192 characters of the player's direction gone
 * with nothing on that screen able to bring it back. A class fixed instance by instance is a class
 * that comes back, so the population here is derived from the source rather than listed by hand.
 *
 * POPULATION (derived from `dialogue-web/tsconfig.json`'s own `include`, so a new file joins without
 * an edit here). A site is a DESTRUCTIVE DURABLE CALL, i.e. a call expression that is both:
 *
 *   1. DESTRUCTIVE by its own name - its callee matches `delete|remove|clear|reset|revoke` - or by
 *      the request it carries, an argument object literal setting one of those words to `true`
 *      (`updateCompanionVoice({ ..., clear: true })` is a clear that no method name spells); and
 *   2. DURABLE by the method it calls: the call's resolved signature is declared in one of the browser API
 *      client modules (`*-api.ts`). That is the boundary to the Host, so the content it acts on outlives
 *      the page - which is exactly what separates `api.deleteCompanion(...)` from `document
 *      .removeEventListener(...)`, `window.clearTimeout(...)`, `next.delete(rowId)` and
 *      `voiceText.clear()` on a draft. Those four are the same VERB on content the player can retype; the
 *      method's own declaring module is what makes the verb a fact about durable content, and it is read
 *      from the checker rather than matched by a naming convention on the call.
 *
 * The API modules themselves are not scanned: they DEFINE the durable routes, they do not decide to
 * use one, and the request body they build is not a press.
 *
 * WHAT IT ASSERTS, per site, two facts:
 *
 *   A. `press_not_armed` - the function that owns the press spends an arm: it references a binding
 *      whose name carries `arm` (`setArm(null)`, `setArmed(false)`, `setVoiceClearArmed(false)`),
 *      which is the tree's own vocabulary for a pending destructive intent. Walking OUT of callback
 *      literals is deliberate: `send: () => api.delete(...)` sits inside `handleDeleteConfirm`, and
 *      the arm is spent one level out, in the `before:` the mutation takes. A press in a component
 *      that owns no arm at all is the defect this gate exists for.
 *   B. `confirmation_primitive_absent` - the site's MODULE calls `useArmedConfirmation`. Fact A alone
 *      accepts a hand-rolled two-button pair with no focus path and no Escape, which is the other
 *      half of the same defect class (`armed-confirmation.ts`'s header states the contract: focus
 *      into the safe answer on open, back to the trigger on cancel, Escape on the confirmation).
 *
 * THE EXEMPTIONS ARE STATED, COUNTED, AND EXPIRE IN BOTH DIRECTIONS. Two shapes are genuinely
 * detached and cannot be read out of one function: the panel that PERFORMS the act renders a row
 * that ARMS it (`CharacterWorldBookPanel`'s `remove`, the settings surface's inline `onRemove`), and
 * the shell that SENDS the mutation holds the arm state while the bubble holds the pair
 * (`ComposedReferenceGameApp`). Those are declared in `DETACHED_ARMED_SITES` with the module that
 * owns the pair, one line of reason, and an expiry condition. `armedIn` is CHECKED, not believed: the
 * named module must still call `useArmedConfirmation`, or the exemption is `exemption_arm_owner_unarmed`
 * - a lane that dismantles the pair cannot leave a licence behind. An entry that matches no observed
 * site is `exemption_expired`, and one that matches more than one is `exemption_count_mismatch`, so
 * the table cannot rot in either direction. A reason too short to name anything, or an entry with no
 * expiry, is `exemption_unreasoned`.
 *
 * WHAT IT DOES NOT ASSERT, stated so a green run is not read as more than it is: that the arm the
 * handler spends is the one the rendered control sets (a module can hold an arm for another act -
 * that is what `examined N · armed X · exempt Y` invites a reader to check); that a destruction
 * expressed WITHOUT one of those verbs is armed (`retainConversation({operation:"trash"})`, `rewind`,
 * `setWorldInfo` detaching an item, a draft-only removal such as an entry dropped from the form
 * being authored); and that an armed pair's confirmation actually performs the act. Those are the
 * limits of a name-and-type reading, and the specs of each surface own them.
 *
 * `examined N · armed X · exempt Y` is the verdict line, and an empty population is `blocked` with
 * exit 1: a gate that read no call has not passed.
 *
 * red-proof: inject  a copy of the tree with the performance directive cleared from a bare button (the shape
 *   that shipped at 45889e97) -> `press_not_armed` and `confirmation_primitive_absent` naming the handler
 *   `handleClearVoice`, `examined 7 · armed 3 · exempt 3`, exit 1
 * red-proof: history  the same copy with the directive panel as 45889e97 committed it and the connection row
 *   as it stood before 4d228964 armed it -> `press_not_armed` and `confirmation_primitive_absent` on the
 *   directive's clear, `exemption_arm_owner_unarmed` for the connection removal whose pair went away,
 *   `examined 6 · armed 2 · exempt 3`, exit 1
 * red-proof: fixture  an exemption whose `armedIn` module drops its `useArmedConfirmation` call ->
 *   `exemption_arm_owner_unarmed`; one naming no observed site -> `exemption_expired`; one matching two ->
 *   `exemption_count_mismatch`; a short reason or expiry -> `exemption_unreasoned`; an empty `src` ->
 *   `blocked` with exit 1 (tools/check-armed-destructive-actions.test.mjs)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WEB_ROOT = join(ROOT, "dialogue-web");
/**
 * The TypeScript compiler the web workspace builds with, resolved from the WORKSPACE rather than from a
 * fixture root: the falsifier drives this reader over throwaway trees that have no `node_modules`.
 */
const typescript = createRequire(join(DEFAULT_WEB_ROOT, "package.json"))("typescript");

/** The verbs that destroy. A verb is read at the START of the callee's name, so `clear` is one and `clarify` is not. */
const DESTRUCTIVE_VERB = /^(?:delete|remove|clear|reset|revoke)/iu;
/** The same vocabulary as a request FIELD set to `true`: the clear that no method name spells. */
const DESTRUCTIVE_FLAG = /^(?:delete|remove|clear|reset|revoke)$/iu;
/** The browser API client modules: the boundary that defines the durable routes. */
const API_MODULE = /(?:^|-)api\.ts$/u;
/** The tree's word for a pending destructive intent, in a binding the handler that spends it names. */
const ARM_BINDING = /arm/iu;
/** The one confirmation primitive (`dialogue-web/src/components/armed-confirmation.ts`). */
const ARM_HOOK = "useArmedConfirmation";
/** The shortest reason that names anything: the same bar `check-prelive-gate-registry.mjs` sets. */
const MIN_REASON = 40;

/**
 * The detached sites: a press in one function whose second press lives in a component that owns it.
 *
 * `symbol` is the owning function as this reader names it (`<module>` for module scope), `call` is the
 * callee's own text, and `armedIn` is the module that must still call `useArmedConfirmation` - the
 * check that keeps this a statement about TODAY rather than a permanent licence.
 */
export const DETACHED_ARMED_SITES = Object.freeze([
  {
    file: "dialogue-web/src/components/management-surface-panels.tsx",
    symbol: "SettingsSurfacePanel",
    call: "client.removeConnection",
    armedIn: "dialogue-web/src/components/management-panels.tsx",
    reason:
      "The settings surface performs the connection removal inside the `onRemove` it hands to " +
      "`ConnectionSettingsPanel`; the row that renders the control (`ConnectionRow`) owns the pair, because the " +
      "record IS the credential and the press may not remove it on the first answer.",
    expires: "expires when the removal is performed in ConnectionRow, or when ConnectionRow stops holding the pair",
  },
  {
    file: "dialogue-web/src/components/ComposedReferenceGameApp.tsx",
    symbol: "handleDeleteConfirm",
    call: "tavernApiRef.current.delete",
    armedIn: "dialogue-web/src/components/MessageBubble.tsx",
    reason:
      "The shell sends the mutation and the bubble arms it (`deletePair` beside the row's own delete control). The " +
      "shell holds the arm state this function spends (`before: () => setArm(null)`), and the focus-and-Escape " +
      "contract belongs to the control that is rendered, which is the bubble's.",
    expires: "expires when the shell renders the delete control itself, or when MessageBubble stops holding the pair",
  },
  {
    file: "dialogue-web/src/components/ComposedReferenceGameApp.tsx",
    symbol: "handleSwipeRemoveConfirm",
    call: "tavernApiRef.current.removeSwipeVariant",
    armedIn: "dialogue-web/src/components/MessageBubble.tsx",
    reason:
      "Same shape as the delete one row over: `swipeRemovePair` is the bubble's pair and this function is the " +
      "transport the row's confirmation reaches.",
    expires: "expires when the shell renders the variant discard itself, or when MessageBubble stops holding the pair",
  },
]);

function parseConfig(webRoot) {
  const configPath = join(webRoot, "tsconfig.json");
  const config = typescript.readConfigFile(configPath, typescript.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(typescript.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  return typescript.parseJsonConfigFileContent(config.config, typescript.sys, webRoot);
}

/** The callee's own name: `api.deleteCompanion` answers `deleteCompanion`, `delete(...)` answers `delete`. */
function calleeName(call) {
  const callee = call.expression;
  if (typescript.isPropertyAccessExpression(callee)) return callee.name.text;
  if (typescript.isIdentifier(callee)) return callee.text;
  return null;
}

/** The request field that turns this call into a destruction, or `null`: `{ clear: true }` is a clear. */
function destructiveFlag(call) {
  for (const argument of call.arguments) {
    if (!typescript.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!typescript.isPropertyAssignment(property)) continue;
      const name = property.name.getText().replaceAll(/^["']|["']$/gu, "");
      if (!DESTRUCTIVE_FLAG.test(name)) continue;
      if (property.initializer.kind === typescript.SyntaxKind.TrueKeyword) return name;
    }
  }
  return null;
}

/**
 * The API client module the method this call resolves to is declared in, or `null` when it is not one of
 * them.
 *
 * Read through the CHECKER's resolved signature, so it is the declaration that decides rather than what the
 * receiver is called: `api`, `client` and `tavernApiRef.current` are three spellings of the same boundary
 * here, while `document.removeEventListener`, `next.delete(rowId)` and a draft's `clear()` resolve to
 * `lib.dom`, a `Set` and a hook in this tree. The alias/symbol readings are a second attempt for a call
 * whose signature the checker cannot resolve (a method reached through an index signature).
 */
function apiModuleOf(call, checker) {
  const callee = call.expression;
  const signature = checker.getResolvedSignature(call);
  const declared = signature?.getDeclaration()?.getSourceFile().fileName;
  if (declared !== undefined && API_MODULE.test(basename(declared))) return declared;
  if (!typescript.isPropertyAccessExpression(callee)) return null;
  const receiverType = checker.getTypeAtLocation(callee.expression);
  const candidates = [receiverType.aliasSymbol, receiverType.symbol];
  const method = checker.getSymbolAtLocation(callee.name);
  if (method !== undefined) candidates.push(method.parent);
  for (const symbol of candidates) {
    if (symbol === undefined) continue;
    for (const declaration of symbol.declarations ?? []) {
      const file = declaration.getSourceFile().fileName;
      if (API_MODULE.test(basename(file))) return file;
    }
  }
  return null;
}

/** A function created AS a value - an argument, a JSX attribute, an object field - is one level of indirection. */
function createdAsValue(node) {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (typescript.isCallExpression(parent) || typescript.isNewExpression(parent)) return parent.arguments.includes(node);
  if (typescript.isPropertyAssignment(parent)) return parent.initializer === node;
  if (typescript.isJsxExpression(parent)) return true;
  // `void (async () => { ... })()` and `(async () => { ... })()`: the arrow IS the call's callee, so it is
  // the handler's own body one indirection out, not a function that owns anything.
  return immediatelyInvoked(node);
}

/** Is this function the callee of the call it sits in, through parentheses? */
function immediatelyInvoked(node) {
  let callee = node;
  let outer = node.parent;
  while (outer !== undefined && typescript.isParenthesizedExpression(outer)) {
    callee = outer;
    outer = outer.parent;
  }
  return outer !== undefined && typescript.isCallExpression(outer) && outer.expression === callee;
}

/** The name a function-like node is known by: its declaration's, or the identifier it is assigned to. */
function functionName(node) {
  if (typescript.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
  const parent = node.parent;
  if (parent !== undefined && typescript.isVariableDeclaration(parent) && typescript.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent !== undefined && typescript.isPropertyAssignment(parent) && typescript.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return "<anonymous>";
}

/**
 * The function that OWNS the press: the nearest enclosing function that was not created as a value.
 *
 * `send: ({ csrfToken }) => tavernApiRef.current.delete(...)` is inside `handleDeleteConfirm`, and the arm
 * (`before: () => setArm(null)`) is spent one level out - so a callback literal is walked through rather
 * than treated as the owner. `null` means module scope: a destruction at the top level of a module owns
 * no arm at all.
 */
function owningFunction(call) {
  for (let node = call.parent; ; node = node.parent) {
    if (node === undefined) return null;
    if (typescript.isFunctionLike(node) && !createdAsValue(node)) return node;
  }
}

/** Does this function's own body name an arm? `setArm(null)`, `setArmed(false)`, `voiceClearArmed` - all count. */
function spendsArm(node) {
  let found = null;
  const visit = (current) => {
    if (found !== null) return;
    if (typescript.isIdentifier(current) && ARM_BINDING.test(current.text) && current.text !== ARM_HOOK) {
      found = current.text;
      return;
    }
    typescript.forEachChild(current, visit);
  };
  // The node's own name is the function's, not an arm it spends; visit the body only.
  for (const child of node.getChildren()) visit(child);
  return found;
}

/** Does this module call the confirmation primitive? One call is enough - the primitive is the module's own. */
function callsArmHook(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression)) {
      if (node.expression.text === ARM_HOOK) {
        found = true;
        return;
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** `<parent of the web root>/...`: `dialogue-web/src/...` for this tree, and the same shape for a copy of it. */
function reportPath(file, webRootPath) {
  return relative(dirname(webRootPath), file).split(sep).join("/");
}

/** One line naming the press: the callee, plus the destructive field when that is what makes it one. */
function callText(call, flag) {
  const text = call.expression.getText();
  return flag === null ? text : `${text}({ ${flag}: true })`;
}

/**
 * The reading, over a workspace. `webRoot` and `exemptions` are arguments so the falsifier drives this
 * reader over a throwaway tree instead of a second implementation of it
 * (`tools/check-armed-destructive-actions.test.mjs`).
 */
export function checkArmedDestructiveActions({ webRoot = DEFAULT_WEB_ROOT, exemptions = DETACHED_ARMED_SITES } = {}) {
  const webRootPath = resolve(webRoot);
  const parsed = parseConfig(webRootPath);
  const program = typescript.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const hookCache = new Map();
  const rows = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const inside = relative(webRootPath, sourceFile.fileName);
    if (inside.startsWith("..") || inside.split(sep)[0] !== "src") continue;
    // The boundary defines the durable routes; it does not decide to use one.
    if (API_MODULE.test(basename(sourceFile.fileName))) continue;
    const file = reportPath(sourceFile.fileName, webRootPath);
    const hookFor = (source) => {
      const key = source.fileName;
      if (!hookCache.has(key)) hookCache.set(key, callsArmHook(source));
      return hookCache.get(key);
    };
    const visit = (node) => {
      if (typescript.isCallExpression(node)) {
        const name = calleeName(node);
        const flag = name === null ? null : destructiveFlag(node);
        if (name !== null && (DESTRUCTIVE_VERB.test(name) || flag !== null)) {
          const apiModule = apiModuleOf(node, checker);
          if (apiModule !== null) {
            const owner = owningFunction(node);
            rows.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              symbol: owner === null ? "<module>" : functionName(owner),
              call: callText(node, flag),
              apiModule: reportPath(apiModule, webRootPath),
              arm: owner === null ? null : spendsArm(owner),
              hook: hookFor(sourceFile),
            });
          }
        }
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return judge({ rows, exemptions, base: dirname(webRootPath) });
}

/** The verdict over the observed rows: the two facts per site, then the exemptions in both directions. */
function judge({ rows, exemptions, base }) {
  const claimed = new Map();
  for (const row of rows) {
    const match = exemptions.find(
      (entry) => entry.file === row.file && entry.symbol === row.symbol && entry.call === row.call,
    );
    row.exemption = match ?? null;
    row.verdict = verdictOf(row, match);
    if (match !== undefined) claimed.set(match, (claimed.get(match) ?? 0) + 1);
  }
  const findings = [...rows.flatMap((row) => pressFindings(row)), ...exemptionFindings({ exemptions, claimed, base })];
  const armed = rows.filter((row) => row.verdict === "armed").length;
  const exempt = rows.filter((row) => row.verdict === "exempt").length;
  let status = "failed";
  if (rows.length === 0) status = "blocked";
  else if (findings.length === 0) status = "passed";
  return { status, findings, examined: rows.length, armed, exempt, rows };
}

/** A press is `exempt` when it is declared, `armed` when both facts hold, and `bare` otherwise. */
function verdictOf(row, match) {
  if (match !== undefined) return "exempt";
  return row.arm !== null && row.hook ? "armed" : "bare";
}

/** What a pressed site with no exemption owes: an arm in the function that presses, and the primitive in its module. */
function pressFindings(row) {
  if (row.verdict === "exempt") return [];
  const where = `${row.file}:${row.line}`;
  const out = [];
  if (row.arm === null) {
    out.push({
      code: "press_not_armed",
      detail:
        `${where} symbol=${row.symbol} calls ${row.call}: one press destroys durable player content on the ` +
        `Host and nothing in this function spends an arm. Put the press behind ` +
        `\`useArmedConfirmation\` (dialogue-web/src/components/armed-confirmation.ts) - the trigger arms, ` +
        `the confirmation performs - or declare it in DETACHED_ARMED_SITES with the module that arms it`,
    });
  }
  if (!row.hook) {
    out.push({
      code: "confirmation_primitive_absent",
      detail:
        `${where} symbol=${row.symbol} calls ${row.call}, and this module never calls \`${ARM_HOOK}\`: a ` +
        `hand-rolled pair has no focus into the safe answer and no Escape, which is half of the contract ` +
        `(armed-confirmation.ts). Use the primitive, or declare the module that owns it`,
    });
  }
  return out;
}

/** The exemption table in both directions: each entry matches one site, and its arm owner still arms. */
function exemptionFindings({ exemptions, claimed, base }) {
  const out = [];
  for (const [entry, count] of claimed) {
    const where = `${entry.file} ${entry.symbol} ${entry.call}`;
    if (count > 1) {
      out.push({
        code: "exemption_count_mismatch",
        detail: `${where}: the exemption matches ${count} observed sites, so it names none of them`,
      });
    }
    if (resolveOwner(entry.armedIn, base) === null) {
      out.push({
        code: "exemption_arm_owner_unarmed",
        detail:
          `${where}: armedIn ${entry.armedIn} does not call \`${ARM_HOOK}\` any more, so the pair this press ` +
          `answered is gone - arm the press, or point the exemption at the module that owns it now`,
      });
    }
  }
  for (const entry of exemptions) {
    const where = `${entry.file} ${entry.symbol} ${entry.call}`;
    if (!claimed.has(entry)) {
      out.push({
        code: "exemption_expired",
        detail: `${where}: no observed press matches this exemption, so it excuses nothing - delete it`,
      });
    }
    const reasoned = typeof entry.reason === "string" && entry.reason.trim().length >= MIN_REASON;
    const expiring = typeof entry.expires === "string" && entry.expires.trim().length >= MIN_REASON;
    if (reasoned && expiring) continue;
    out.push({
      code: "exemption_unreasoned",
      detail: `${where}: ${reasoned ? "the expiry" : "the reason"} does not name the condition that ends it`,
    });
  }
  return out;
}

/**
 * Does the module an exemption names still call the primitive? Read from the tree being MEASURED first - a copy
 * of the tree (the history red proof replays an older file into one) must answer for itself - then from this
 * repository, which is where a falsifier's fixture exemptions point (a fixture tree is not a copy of the app).
 */
function resolveOwner(path, base) {
  for (const root of [base, ROOT]) {
    let source;
    try {
      source = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    return source.includes(`${ARM_HOOK}(`) ? path : null;
  }
  return null;
}

/** The evidence a row prints, by verdict. */
function evidenceOf(row) {
  if (row.verdict === "exempt") return `exempt - armed in ${row.exemption.armedIn}`;
  if (row.verdict === "armed") return `armed - ${row.arm}`;
  return `BARE - no arm in ${row.symbol}`;
}

function printRows(rows) {
  for (const row of rows) {
    console.log(
      `[armed-destructive] ${row.file}:${row.line} symbol=${row.symbol} call=${row.call} -> ${evidenceOf(row)}`,
    );
  }
}

function main() {
  const webRootIndex = process.argv.indexOf("--web-root");
  const webRoot = webRootIndex === -1 ? DEFAULT_WEB_ROOT : process.argv[webRootIndex + 1];
  const verdict = checkArmedDestructiveActions({ webRoot });
  printRows(verdict.rows);
  console.log(`[armed-destructive] examined ${verdict.examined} · armed ${verdict.armed} · exempt ${verdict.exempt}`);
  for (const entry of verdict.findings) console.log(`[armed-destructive] ${entry.code}: ${entry.detail}`);
  console.log(
    JSON.stringify({
      gate: "armed-destructive-actions",
      status: verdict.status,
      examined: verdict.examined,
      checks: [
        {
          id: "destructive_press_is_armed",
          status: verdict.findings.some((entry) => entry.code === "press_not_armed") ? "failed" : "passed",
        },
        {
          id: "confirmation_is_the_primitive",
          status: verdict.findings.some((entry) => entry.code === "confirmation_primitive_absent")
            ? "failed"
            : "passed",
        },
        {
          id: "exemptions_current",
          status: verdict.findings.some((entry) => entry.code.startsWith("exemption_")) ? "failed" : "passed",
        },
      ],
      findings: verdict.findings,
    }),
  );
  if (verdict.status === "blocked") {
    process.exit(blockedOnEmptyPopulation("armed-destructive", "this gate examined no destructive call"));
  }
  process.exit(verdict.findings.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
