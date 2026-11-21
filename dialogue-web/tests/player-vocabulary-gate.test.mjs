/**
 * A sentence a player reads may not name a thing that exists only inside our code.
 *
 * WHY (measured 2026-11-20, the same day the product owner ruled on it): 76 keys of both catalogues carried
 * a word from our own implementation - `host` in five sentences, `session` in twenty-four, `authoritative`
 * in twelve (and `权威` in the same twelve Chinese ones), `runtime`, `instance`, `projection`, `assembly`,
 * `continuity`, `bootstrap`, `process`, `fold`. The player can act on none of them: `gameLaunchQuarantined`
 * said the lock "is inside GameBuddy's own process", which names the layer that failed rather than the
 * state the player is in and the step left to them.
 *
 * THE POPULATION is derived, not listed. A key is player-facing when a source under `src` reads it
 * (`labels.<key>`, `labels().<key>` and `labels["<key>"]`, the three access forms the shell and the panels
 * use), in both locales of every catalogue under `src`. Which files those are is also derived: a file
 * that declares both an `en` and a `zh` binding of string-valued keys is a catalogue, which is how the
 * character/companion domain's own words (`src/components/character-domain-labels.ts`) came into the
 * population that the first pass did not scan - and how a third one would, without anyone remembering
 * to add it here. A declared key no source reads cannot reach a player, and
 * `i18n-parity-gate.test.mjs` (`i18n.7`) already records those as debt, so this gate inherits that
 * boundary rather than restating it. Placeholders are stripped before the scan: `{{authority}}` is
 * substituted with the Host's own id for a part of the profile, and a value the code fills in is not a word
 * the sentence chose.
 *
 * THE LEXICON is declared, and every entry is WITNESSED against the Host's own source - the noun has to
 * appear in a module path or an identifier under `host/src`, or the entry is a finding ("this word is not
 * ours; drop it or cite the module that names it"). That is what keeps the list from rotting into a
 * spell-checker nobody dares touch: an entry whose mechanism has left the tree goes red, and the words the
 * player owns are simply not entries at all.
 *
 * WHY THE WHOLE LEXICON IS NOT DERIVED, stated with the measurement rather than as a preference: every
 * mechanical derivation tried here fails in one of two directions.
 *  - `host/src` module-path words (306 today) and declared-name words (771) intersected with the copy give
 *    ~115 words, and the list is dominated by the player's own vocabulary - `read`, `start`, `new`, `mod`,
 *    `folder`, `conversation`, `settings`, `provider`, `greeting`, `voice` - because the Host names its
 *    domain with the same English a player uses. Banned that way, the gate would force a rewrite of
 *    sentences that never mentioned a mechanism.
 *  - subtracting "whatever the browser layer names" removes the words this gate exists for: the browser
 *    client is the Host's own client and mentions `host`, `session`, `runtime` and `quarantine` in its own
 *    identifiers, so `host` - the product owner's example - falls out of the derived set while `microsoft`
 *    and `tavern` stay in it (measured: 125 candidates, 11 collisions, every one of them a false positive).
 *
 * So the set is declared and its members are pinned to source. The narrowing that makes it safe to live
 * with is the one the brief names: a word the player sees on their screen is not an entry. `Settings`,
 * `Chats`, `Memory`, `Characters`, `folder`, `mod`, `save`, `connection`, `provider`, `protocol`, `token`,
 * `journal`, `服务`, `协议`, `绑定`, `能力` are all absent for that reason - a gate that forbade them would
 * forbid the interface's own words.
 *
 * ONE THING THIS GATE DOES NOT CHECK, measured rather than assumed: whether every failure sentence names a
 * step. A rule for it was written in the third pass and removed again, because the detector has to read
 * prose: `gameSetupFailed` passed only because it contains "the last state it **read** from the game",
 * and the twelve Chinese sentences beside it failed for the same non-reason. Fourteen of fifteen
 * findings were that spelling, not a missing step. A gate whose boundary is a verb list agrees with
 * itself; the honest answer is the two rules that CAN be held soundly - no wall before the account
 * (`player-vocabulary.6`) and a step after a wall - plus a reader, which is what caught the rewrites
 * that shipped in the same pass.
 *
 * CHINESE IS SCANNED TOO, from a rendering table attached to the entries it renders (`权威` for
 * `authoritative`, `装配` for `assembly`, `投影` for `projection`, ...). A rendering is checked in both
 * directions: it must name a Latin entry that is itself witnessed, so a row cannot outlive its word.
 * `会话` is deliberately NOT in the table: it is the catalogue's own word for a Chat
 * (`chats: "会话"`), so a scan for it would fail the interface's name for its own surface. The Chinese
 * half of `session` therefore rests on the English half - the two catalogues are edited together, and the
 * sentence pair is what a reviewer reads.
 *
 * THREE MORE THINGS A SENTENCE A PLAYER READS MAY NOT DO, added by the second pass over the same copy:
 *  - carry a raw identifier (`player-vocabulary.5`). A `snake_case` or `camelCase` token, a dotted name or a
 *    slashed path is a code wearing another spelling: no player can read it, act on it, or repeat it to
 *    anyone. The population is the same derived one, so a code typed into a sentence tomorrow is a finding;
 *    the one exception is a token the player typed themselves (`PLAYER_TOKENS`, witnessed in the copy and
 *    dropped the moment no sentence carries it). Measured on this tree: the catalogue's own literals are
 *    clean, and the codes a player actually met came through a placeholder, not through a typed word.
 *  - meet the wall first (`player-vocabulary.6`). "Nothing on this page can do it, and reloading does not
 *    either" is a true fact and a bad opening line: a player reads it as the product giving up before it has
 *    said what happened. The wall belongs after the account and before the step, and a wall that nothing
 *    follows is a dead end with no way out. The population is the strings that state the page's own limit,
 *    derived by scanning for the phrases that do; zero of them would mean a true fact left the copy.
 *  - print a contract code (`player-vocabulary.8`). This is the one the first pass could not see: the
 *    catalogue's own literals were clean, because the codes arrived through a placeholder - a rendered
 *    `{{cause}}` put `stardew_contained_player_host_launch_failed` on the screen and a rendered
 *    `{{code}}` put the wire's own word on the internal-error card. A scan of the strings cannot catch
 *    that, so the check drives the REAL `composedProblemView` over the declared code unions and the
 *    `stardew_*` names this repository declares, and reads what comes out. The code is not forbidden to
 *    exist: it stays on the error for the record and for a report, which is where `observedProblemCause`
 *    reads it. The claim is that no player's SENTENCE carries one.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { composedProblemView, GAME_CAUSE_CLAUSES, humanizeProblemCause } from "../src/composed-problem-view.ts";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  GAME_PROBLEM_CODES,
} from "../src/composed-reference-game-browser-api.ts";
import { messages } from "../src/i18n.ts";
import { PROBLEM_CODES, TavernProblemError, TavernProtocolError } from "../src/reference-pipeline-api.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const REPO = join(WEB, "..");
const SRC = join(WEB, "src");
const I18N = join(SRC, "i18n.ts");
const HOST_SRC = join(REPO, "host", "src");

/** A Host module that states a rule, not a piece of the product: it witnesses nothing. */
const HOST_TEST_FILE = /\.(?:test|private|internal|test-support)(?:\.|$)/u;

/**
 * The nouns that name our own machinery, and the Chinese words the same sentences used for them.
 *
 * `forms` are the spellings a sentence would use; `zh` the Chinese renderings that are unambiguously the
 * mechanism rather than the player's word for the thing. `names` is what the mechanism is, so a reader can
 * tell why the entry is here.
 */
export const INTERNAL_NOUNS = [
  { names: "the GameBuddy process", forms: ["host", "hosts"] },
  { names: "one GameBuddy run, kept in a record", forms: ["session", "sessions"] },
  { names: "the in-process game engine and its authority", forms: ["runtime", "runtimes"], zh: ["运行时"] },
  { names: "the boot handoff that opens a surface", forms: ["bootstrap"] },
  { names: "the lock a failed attempt leaves for the rest of the process", forms: ["quarantine", "quarantined", "quarantines"] },
  { names: "the watcher that reports how a child process ended", forms: ["guardian", "guardians"] },
  { names: "the state a caller is allowed to act on", forms: ["authority", "authorities", "authoritative"], zh: ["权威"] },
  { names: "a read-only view derived from a record", forms: ["projection", "projections"], zh: ["投影"] },
  { names: "one launched game, as a record rather than as the game", forms: ["instance", "instances"], zh: ["实例"] },
  { names: "the identity shared between a Chat and a Game", forms: ["continuity", "continuities"], zh: ["连续性"] },
  { names: "the seam a surface renders from", forms: ["surface", "surfaces"] },
  { names: "what the current run is able to do", forms: ["capability", "capabilities"] },
  { names: "the declaration a deployment is read from", forms: ["manifest", "manifests"] },
  { names: "the check that a child really is the one we started", forms: ["attestation", "attestations"] },
  { names: "the exclusive hold on a run of a role", forms: ["lease", "leases"] },
  { names: "one numbered run of a role", forms: ["epoch", "epochs"] },
  { names: "the channel a control command travels on", forms: ["pipe", "pipes"] },
  { names: "the record of executed steps", forms: ["ledger", "ledgers"] },
  { names: "one numbered replacement of a record", forms: ["generation", "generations"] },
  { names: "one numbered version of a record", forms: ["revision", "revisions"] },
  { names: "the reclamation of a role's processes", forms: ["containment"] },
  { names: "the owner that starts and stops roles", forms: ["supervisor", "supervisors"] },
  { names: "turning a declaration into a running role", forms: ["materialise", "materialize", "materialiser", "materializer"] },
  { names: "the JSON seam between two of our processes", forms: ["wire"] },
  { names: "one graded object between the surface and a contract", forms: ["envelope", "envelopes"] },
  { names: "the hand-over of one fact between surfaces", forms: ["handoff", "handoffs"] },
  { names: "one binding of the game to this surface", forms: ["attachment", "attachments"] },
  { names: "the closing of a run after it was asked to end", forms: ["settlement", "settlements"] },
  { names: "the way a stream is carried", forms: ["transport"] },
  { names: "reading a prompt's entries into a request", forms: ["assembly", "assembles", "assembled", "assemble"], zh: ["装配"] },
  { names: "the fold that writes a transcript into memory", forms: ["fold", "folds", "folding"], zh: ["折叠"] },
  { names: "a game prepared ahead of the surface that asks for it", forms: ["staged", "staging"], zh: ["暂存"] },
  { names: "an operating-system process a role runs in", forms: ["process", "processes"], zh: ["进程"] },
  { names: "the registry entry that holds a game after a run", forms: ["registration", "registrations"] },
  { names: "the settlement record of a finished program", forms: ["digest", "digests"] },
  { names: "the quota a turn may use", forms: ["budget", "budgets"] },
  { names: "the identity GameBuddy creates for a thing it stores", forms: ["mint", "mints", "minted", "minting"], zh: ["铸造"] },
];

/** The nouns this gate exists for: a shrinking lexicon must fail loudly instead of quietly passing. */
const ANCHORS = ["host", "session", "runtime", "quarantine", "guardian", "authority", "projection", "assembly"];

/** Unwraps `as const`, `satisfies T`, `Object.freeze(...)` and parentheses - the forms both catalogue files use. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (
      current !== undefined &&
      (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))
    ) {
      current = current.expression;
      continue;
    }
    if (
      current !== undefined &&
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

function parse(file, text = readFileSync(file, "utf8")) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** `src/...:line` for the first token of a node. */
function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop()}:${line + 1}`;
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

/** The catalogues of a text: `{ name, entries: [{ key, value, line }], gaps }` for `en` and `zh`. */
export function catalogues(text, fileName = I18N) {
  const sourceFile = parse(fileName, text);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text !== "en" && node.name.text !== "zh") return;
    const object = unwrap(node.initializer);
    if (object === undefined || !ts.isObjectLiteralExpression(object)) return;
    const entries = [];
    // A property whose name the reader cannot resolve is not a silent skip: it is a gap, because a
    // key written as a computed name is a string this gate would otherwise never see.
    const gaps = [];
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) {
        gaps.push(`${at(property, sourceFile)} ${ts.SyntaxKind[property.kind]}`);
        continue;
      }
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
      if (name === null) {
        gaps.push(`${at(property, sourceFile)} ${ts.SyntaxKind[property.name.kind]}`);
        continue;
      }
      entries.push({
        key: name,
        value: ts.isStringLiteral(property.initializer) ? property.initializer.text : null,
        line: at(property, sourceFile),
      });
    }
    found.push({ name: node.name.text, entries, gaps });
  });
  return found;
}

/** Is this expression the label catalogue, however the site names it? */
function isLabelObject(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "labels";
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "labels";
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    ["labels", "messages", "characterLabels"].includes(expression.expression.text)
  );
}

/** Every catalogue key a source under `src` reads, through the three access forms. */
export function readKeys(directory = SRC) {
  const keys = new Set();
  for (const file of sourceFiles(directory)) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      if (ts.isPropertyAccessExpression(node) && isLabelObject(node.expression)) keys.add(node.name.text);
      if (
        ts.isElementAccessExpression(node) &&
        isLabelObject(node.expression) &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteral(node.argumentExpression)
      )
        keys.add(node.argumentExpression.text);
    });
  }
  return keys;
}

/** A catalogue value without its placeholders: the words the sentence itself chose. */
export function spokenText(value) {
  return String(value).replace(/\{\{[A-Za-z0-9_]+\}\}/gu, " ");
}

const LATIN = (word) => new RegExp(`\\b${word}\\b`, "giu");

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

/**
 * Every finding in one catalogue pair: a string, in either language, that names a mechanism.
 * `entries` are `{ key, value, line }` of one locale; `locale` names the language in the failure.
 */
export function internalsIn(entries, locale, lexicon = INTERNAL_NOUNS) {
  const findings = [];
  for (const entry of entries) {
    if (entry.value === null) continue;
    const text = spokenText(entry.value);
    for (const noun of lexicon) {
      for (const form of noun.forms) {
        const count = occurrences(text, LATIN(form));
        if (count === 0) continue;
        findings.push({ key: entry.key, line: entry.line, locale, noun: form, names: noun.names });
      }
      for (const term of noun.zh ?? []) {
        if (!text.includes(term)) continue;
        findings.push({ key: entry.key, line: entry.line, locale, noun: term, names: noun.names });
      }
    }
  }
  return findings;
}

/**
 * The shapes of a raw identifier: a `snake_case` or `camelCase` token, a dotted name, a slashed path.
 * A player cannot read one, cannot act on it, and cannot repeat it to anyone - so one in a sentence
 * is the code showing through in another form.
 */
const IDENTIFIER_TOKENS = [
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/gu,
  /\b[a-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/gu,
  /\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]+){2,}\b/gu,
  /\b[a-z][a-z0-9_]*(?:\/[a-z0-9_]+)+\b/gu,
];

/**
 * The tokens a player typed themselves and reads on their own screen: a server they run, not a word
 * of ours. An entry no sentence carries any more is a finding, so the list cannot outlive its reason.
 */
export const PLAYER_TOKENS = [
  { token: "vLLM", why: "a model server the player runs, named in their own connection settings" },
];

/** Every raw identifier a player-facing string would put in front of a player. */
export function identifiersIn(entries, locale, allowed = PLAYER_TOKENS.map((entry) => entry.token)) {
  const findings = [];
  for (const entry of entries) {
    if (entry.value === null) continue;
    const text = spokenText(entry.value);
    const tokens = new Set();
    for (const pattern of IDENTIFIER_TOKENS) for (const match of text.matchAll(pattern)) tokens.add(match[0]);
    for (const token of tokens)
      if (!allowed.includes(token)) findings.push({ key: entry.key, line: entry.line, locale, token });
  }
  return findings;
}

/**
 * The phrases that tell a player nothing on this page can help. Every one of them is a fact worth
 * stating - a reload is wasted otherwise - and every one of them reads as the product giving up when
 * it stands where what happened should stand.
 */
const WALL = [
  /\bno control\b/giu,
  /\bnothing on this page\b/giu,
  /\bdoes not help\b/giu,
  /\bwill not help\b/giu,
  /\bimpossible\b/giu,
  /\bno way to\b/giu,
  /\bstarting this page over will not change\b/giu,
  /没有任何控件/gu,
  /刷新这一页也不会改变/gu,
  /无能为力/gu,
  /没有办法/gu,
  /无济于事/gu,
];

/** What a sentence says the player can do: the verbs this product's own steps are written with. */
const STEP = [
  /\b(?:close|quit|open|reload|read|try|check|choose|pick|press|wait|save|start|enable|load|delete|remove|update|confirm|stop)\b/iu,
  /关闭|退出|打开|刷新|读取|重试|试试|检查|选择|等待|保存|开始|启用|删除|确认|停掉/u,
];

/** What a player reads first: everything up to the first full stop. */
function openingSentence(text) {
  const end = text.search(/[.。!！?？]/u);
  return end < 0 ? text : text.slice(0, end);
}

/** A wall standing where what happened should stand, or a wall with no step after it. */
export function wallsIn(entry, locale) {
  if (entry.value === null) return [];
  const text = spokenText(entry.value);
  const walls = [];
  for (const pattern of WALL) for (const match of text.matchAll(pattern)) walls.push({ at: match.index, phrase: match[0] });
  if (walls.length === 0) return [];
  walls.sort((left, right) => left.at - right.at);
  const findings = [];
  const opening = openingSentence(text);
  if (walls[0].at < opening.length)
    findings.push({ key: entry.key, line: entry.line, locale, kind: "wall in the opening sentence", phrase: walls[0].phrase });
  const last = walls[walls.length - 1];
  if (!STEP.some((pattern) => pattern.test(text.slice(last.at + last.phrase.length))))
    findings.push({ key: entry.key, line: entry.line, locale, kind: "nothing to do after the wall", phrase: last.phrase });
  return findings;
}

/** The Host files whose path or text names a word: the witness that the word is ours. */
function hostWitnesses(word, cache) {
  const pattern = LATIN(word);
  const files = [];
  for (const [file, text] of cache) if (pattern.test(text) || pattern.test(file)) files.push(file);
  return files;
}

/** The Host's own source, read once: `[repo-relative path, text]`. */
function hostSourceCache() {
  const cache = new Map();
  for (const file of sourceFiles(HOST_SRC)) {
    if (HOST_TEST_FILE.test(file.split(/[\\/]/u).pop())) continue;
    const path = file.replace(/\\/gu, "/").slice(REPO.replace(/\\/gu, "/").length + 1);
    cache.set(path, readFileSync(file, "utf8"));
  }
  return cache;
}

/**
 * Every catalogue pair under `src`: a file that declares both an `en` and a `zh` binding is one.
 * The derivation is the tree's, not a list: the second catalogue (the character/companion domain's
 * own words) declares its pair the same way the main one does, and a third would be scanned without
 * anyone remembering to add it here.
 */
function cataloguePairs() {
  const pairs = [];
  for (const file of sourceFiles(SRC)) {
    const parsed = catalogues(readFileSync(file, "utf8"), file);
    const en = parsed.find((catalogue) => catalogue.name === "en");
    const zh = parsed.find((catalogue) => catalogue.name === "zh");
    if (en !== undefined && zh !== undefined)
      pairs.push({ file: file.replace(/\\/gu, "/").split("/dialogue-web/").pop(), en, zh });
  }
  return pairs;
}

/** A catalogue entry a player can actually read: a source reads its key, or names it for a dynamic read. */
function spoken(entries, visible, locale, file) {
  return entries
    .filter((entry) => visible.has(entry.key) && entry.value !== null)
    .map((entry) => ({ ...entry, locale, file }));
}

/** A test file's own data is not a read path: a literal that happens to equal a key name proves nothing. */
const TEST_FILE = /\.test\.(?:ts|tsx)$/u;

/**
 * Catalogue keys a source NAMES as a string literal instead of reading them.
 *
 * An indirection map hands a key name to a dynamic read the static scan cannot see:
 * `CONNECTION_API_SHAPE_LABELS[shape]`, `GAME_SITUATION_WHERE_MESSAGE[where]`. Measured when this
 * rule was written: 25 declared keys of 1 133 were reachable only this way - ten connection-shape
 * names and fourteen `gameSituation*` - so every copy check in this file was reading fewer strings
 * than a player can reach. That is the defect class this lane kept meeting: a gate that agrees with
 * itself because it never looked.
 */
export function namedKeys(declared, directory = SRC) {
  const keys = new Set();
  for (const file of sourceFiles(directory)) {
    if (TEST_FILE.test(file)) continue;
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      if (!ts.isStringLiteral(node) || !declared.has(node.text)) return;
      const parent = node.parent;
      if (parent !== undefined && ts.isPropertyAssignment(parent) && parent.initializer === node) keys.add(node.text);
    });
  }
  return keys;
}

/** Every catalogue pair, the keys a source can reach, and the strings a player can therefore see. */
function population() {
  const pairs = cataloguePairs();
  assert.ok(pairs.length >= 2, `only ${pairs.length} catalogue pair(s) under src; the derivation broke`);
  const read = readKeys();
  const declared = new Set(pairs.flatMap((pair) => [...pair.en.entries, ...pair.zh.entries].map((entry) => entry.key)));
  const named = namedKeys(declared);
  const visible = new Set([...read, ...named]);
  const strings = pairs.flatMap((pair) => [
    ...spoken(pair.en.entries, visible, "en", pair.file),
    ...spoken(pair.zh.entries, visible, "zh", pair.file),
  ]);
  return { pairs, read, named, strings };
}

test("player-vocabulary.1: the population is derived, and it is not empty", (t) => {
  const { pairs, read, named, strings } = population();
  const examined = strings.length;
  assert.ok(
    examined >= 1400,
    `only ${examined} player-facing string(s) were derived from ${pairs.reduce((total, pair) => total + pair.en.entries.length, 0)} declared key(s), ${read.size} read key(s) and ${named.size} named-by-a-map key(s); a population this small means the derivation broke, not that the copy is clean`,
  );
  // Both catalogues hold the same keys (i18n.1); a player reads one of the two sentences, never both.
  const lexicon = INTERNAL_NOUNS.flatMap((noun) => [...noun.forms, ...(noun.zh ?? [])]);
  const carriers = new Set(strings.filter((entry) => internalsIn([entry], entry.locale).length > 0).map((entry) => entry.key)).size;
  const visible = new Set([...read, ...named]);
  t.diagnostic(
    `player-vocabulary.1: strings examined ${examined} (${pairs.map((pair) => `${pair.file} ${pair.en.entries.length} declared / ${spoken(pair.en.entries, visible, "en", pair.file).length} visible`).join("; ")}) · ${named.size} key(s) reachable only through an indirection map · containing an internal noun ${carriers} · lexicon ${lexicon.length} word(s) over ${INTERNAL_NOUNS.length} noun(s)`,
  );
});

test("player-vocabulary.2: no player-facing sentence names our machinery", (t) => {
  const { pairs, read, strings } = population();
  const findings = strings.flatMap((entry) => internalsIn([entry], entry.locale));
  const counts = new Map();
  for (const finding of findings) counts.set(finding.noun, (counts.get(finding.noun) ?? 0) + 1);
  const top = [...counts].sort((left, right) => right[1] - left[1]).slice(0, 8);
  t.diagnostic(
    `player-vocabulary.2: ${findings.length} finding(s) across ${new Set(findings.map((finding) => finding.key)).size} key(s) in ${pairs.length} catalogue file(s); top: ${top.map(([noun, count]) => `${noun}:${count}`).join(", ")}`,
  );
  for (const finding of findings)
    t.diagnostic(`player-vocabulary.2: ${finding.line} ${finding.locale}.${finding.key} names "${finding.noun}" (${finding.names})`);
  assert.deepEqual(
    findings.map((finding) => `${finding.line} ${finding.locale}.${finding.key}: ${finding.noun}`),
    [],
    "a sentence a player reads may name the game, the companion, the chat, this page, their computer - not the layer that failed",
  );
});

test("player-vocabulary.3: every noun in the lexicon is witnessed by the Host's own source", (t) => {
  const cache = hostSourceCache();
  const failures = [];
  const seen = new Set();
  let witnessed = 0;
  for (const noun of INTERNAL_NOUNS) {
    for (const form of noun.forms) {
      if (seen.has(form)) failures.push(`${form} is declared twice`);
      seen.add(form);
    }
    const witnesses = noun.forms.filter((form) => hostWitnesses(form, cache).length > 0);
    if (witnesses.length === 0)
      failures.push(`no Host source names any of ${noun.forms.map((form) => JSON.stringify(form)).join(", ")}; drop the entry`);
    else witnessed += 1;
    for (const term of noun.zh ?? []) if (/\s/u.test(term)) failures.push(`${term} is a rendering, not a word`);
  }
  for (const anchor of ANCHORS)
    if (!INTERNAL_NOUNS.some((noun) => noun.forms.includes(anchor)))
      failures.push(`the lexicon no longer holds ${anchor}, one of the nouns this gate was built for`);
  assert.deepEqual(failures, [], "an entry that no Host module names is a word this product does not have");
  t.diagnostic(
    `player-vocabulary.3: ${witnessed} of ${INTERNAL_NOUNS.length} noun(s) witnessed across ${cache.size} Host module(s); ${INTERNAL_NOUNS.reduce((total, noun) => total + (noun.zh?.length ?? 0), 0)} Chinese rendering(s); anchors ${ANCHORS.join(", ")}`,
  );
});

test("player-vocabulary.4 (mutation): a planted mechanism noun fails, the player's own words do not", (t) => {
  const planted = [
    "const en = {",
    '  gateMutationQuarantine: "The guardian still holds the game inside GameBuddy\\u0027s own process.",',
    '  gateMutationClean: "Choose your game folder in Game installation on this page, then enable companion play again.",',
    '  gateMutationPlaceholder: "No backup was saved: {{authority}} could not be read.",',
    "} as const;",
    "const zh = {",
    '  gateMutationChinese: "当前显示的是最新权威游戏状态。",',
    "} as const;",
  ].join("\n");
  const parsed = catalogues(planted, "src/i18n.ts");
  const plantedEntries = (locale) =>
    parsed
      .find((catalogue) => catalogue.name === locale)
      .entries.filter((entry) => entry.key.startsWith("gateMutation"));
  assert.deepEqual(
    internalsIn(plantedEntries("en"), "en").map((finding) => `${finding.key}: ${finding.noun}`),
    ["gateMutationQuarantine: guardian", "gateMutationQuarantine: process"],
    "the planted sentence names two mechanisms and both are reported; the folder sentence and the substituted id name nothing",
  );
  assert.deepEqual(
    internalsIn(plantedEntries("zh"), "zh").map((finding) => finding.noun),
    ["权威"],
    "the Chinese rendering of an entry is scanned by the same rule",
  );
  t.diagnostic("player-vocabulary.4: a planted noun and its Chinese rendering are reported; a player's own words are not");
});

test("player-vocabulary.5: no player-facing sentence carries a raw identifier", (t) => {
  const { strings } = population();
  const findings = strings.flatMap((entry) => identifiersIn([entry], entry.locale));
  const carried = PLAYER_TOKENS.filter((entry) => strings.some((string) => spokenText(string.value).includes(entry.token)));
  t.diagnostic(
    `player-vocabulary.5: ${findings.length} raw identifier(s) across ${new Set(findings.map((finding) => finding.key)).size} key(s) in ${strings.length} string(s); ${carried.length} of ${PLAYER_TOKENS.length} player-typed token(s) still carried (${PLAYER_TOKENS.map((entry) => entry.token).join(", ")})`,
  );
  for (const finding of findings)
    t.diagnostic(`player-vocabulary.5: ${finding.line} ${finding.locale}.${finding.key} prints "${finding.token}"`);
  assert.ok(strings.length > 0, "a population of zero strings would agree with itself");
  assert.deepEqual(
    [
      ...findings.map((finding) => `${finding.line} ${finding.locale}.${finding.key}: ${finding.token}`),
      ...PLAYER_TOKENS.filter((entry) => !carried.includes(entry)).map(
        (entry) => `${entry.token} is declared a token the player typed, and no sentence carries it any more; drop the entry`,
      ),
    ],
    [],
    "a player's sentence names the game, the companion, the chat and their own machine - never an identifier",
  );
});

test("player-vocabulary.6: a wall is never what a player reads first, and a step always follows it", (t) => {
  const { strings } = population();
  const findings = strings.flatMap((entry) => wallsIn(entry, entry.locale));
  const walls = new Set(
    strings.filter((entry) => WALL.some((pattern) => pattern.test(spokenText(entry.value)))).map((entry) => entry.key),
  );
  t.diagnostic(
    `player-vocabulary.6: ${findings.length} finding(s) across ${new Set(findings.map((finding) => finding.key)).size} key(s); ${walls.size} key(s) tell the player the page cannot help`,
  );
  for (const finding of findings)
    t.diagnostic(
      `player-vocabulary.6: ${finding.line} ${finding.locale}.${finding.key} - ${finding.kind} ("${finding.phrase}")`,
    );
  assert.ok(
    walls.size > 0,
    "no sentence states the page's own limit any more; either a true fact left the copy or the detector broke, and neither is a pass",
  );
  assert.deepEqual(
    findings.map((finding) => `${finding.line} ${finding.locale}.${finding.key}: ${finding.kind}`),
    [],
    "a dead end a player meets before anything else reads as the product giving up: what happened, then why the page cannot help, then the step and what is true after it",
  );
});

test("player-vocabulary.7 (mutation): a planted wall and a planted identifier fail; a three-part sentence does not", (t) => {
  const planted = [
    "const en = {",
    '  gateMutationWall: "This failed, and no control on this page can do it. Quit GameBuddy from the tray.",',
    '  gateMutationWallNoStep: "Stardew Valley ended. GameBuddy keeps that ending, and nothing on this page reaches it.",',
    '  gateMutationThreePart: "This start failed. GameBuddy still holds the attempt and lets go only when it is started again: no control on this page reaches it. Quit GameBuddy from the tray and open it again.",',
    '  gateMutationIdentifier: "The launch reported stardew_contained_player_host_launch_failed and stopped.",',
    '  gateMutationPlayerToken: "Compatible with Ollama, LM Studio or vLLM.",',
    // The sentence as it shipped, both catalogues: the wall stood where what happened belonged, and
    // this gate is red on the text it was written against rather than only on a sample of my making.
    '  gateMutationShippedLaunch: "This start failed, and GameBuddy cannot clear what it left behind until it is started again: no control on this page reaches it, and reloading this page does not either. If Stardew Valley is still running, close it. Then quit GameBuddy itself from the tray icon (Quit GameBuddy) and open it again.",',
    "} as const;",
    "const zh = {",
    '  gateMutationShippedLaunchZh: "这次启动失败了，GameBuddy 要重新打开才能清掉它留下的状态：本页没有任何控件能做到，刷新本页也不行。如果《星露谷物语》还在运行，请先关掉它。然后从系统托盘退出 GameBuddy 本身（Quit GameBuddy），再重新打开。",',
    "} as const;",
  ].join("\n");
  const parsed = catalogues(planted, "src/i18n.ts");
  const plantedEntries = parsed
    .find((catalogue) => catalogue.name === "en")
    .entries.filter((entry) => entry.key.startsWith("gateMutation"));
  assert.deepEqual(
    plantedEntries.flatMap((entry) => wallsIn(entry, "en")).map((finding) => `${finding.key}: ${finding.kind}`),
    [
      "gateMutationWall: wall in the opening sentence",
      "gateMutationWallNoStep: nothing to do after the wall",
      "gateMutationShippedLaunch: wall in the opening sentence",
    ],
    "a wall where what happened should stand, a wall nothing follows, and the sentence that shipped that way are all reported; the three-part sentence is not",
  );
  assert.deepEqual(
    wallsIn(parsed.find((catalogue) => catalogue.name === "zh").entries.find((entry) => entry.key === "gateMutationShippedLaunchZh"), "zh").map(
      (finding) => finding.kind,
    ),
    ["wall in the opening sentence"],
    "the Chinese sentence that shipped carried the same wall in the same place, and the scan is not English-only",
  );
  assert.deepEqual(
    identifiersIn(plantedEntries, "en").map((finding) => `${finding.key}: ${finding.token}`),
    ["gateMutationIdentifier: stardew_contained_player_host_launch_failed"],
    "a code in a sentence is one raw identifier; the server the player runs themselves is not",
  );
  t.diagnostic(
    "player-vocabulary.7: a planted wall, a wall with no step and a planted code are reported; the three-part sentence and the player's own server name are not",
  );
});

/** The Host's own source as text, for a question about what it DECLARES: only test files are out. */
function hostModuleCache() {
  const cache = new Map();
  for (const file of sourceFiles(HOST_SRC)) {
    if (/(?:\.test|test-support)(?:\.|$)/u.test(file.split(/[\\/]/u).pop())) continue;
    const path = file.replace(/\\/gu, "/").slice(REPO.replace(/\\/gu, "/").length + 1);
    cache.set(path, readFileSync(file, "utf8"));
  }
  return cache;
}

/**
 * Every `stardew_*` name this repository declares, as the thing a game refusal can carry on its
 * `cause`.
 *
 * `hostModuleCache` rather than `hostSourceCache`: the module that declares a coordinator cause is
 * `stardew-production-lifecycle-coordinator.internal.ts`, and the lexicon's witness rule skips
 * `.internal.` because a rule stated there is not a mechanism to defend - for a DECLARED NAME that
 * exclusion is exactly backwards, and it hid four of the ten causes this gate holds.
 */
function stardewCauses(cache = hostModuleCache()) {
  const names = new Set();
  for (const [, text] of cache) for (const match of text.matchAll(/"stardew_[a-z0-9_]+"/gu)) names.add(match[0].slice(1, -1));
  return [...names].sort();
}

test("player-vocabulary.8: no contract code reaches a player's sentence", (t) => {
  const causes = stardewCauses();
  assert.ok(GAME_PROBLEM_CODES.length > 0, "an empty game code union would agree with itself");
  assert.ok(PROBLEM_CODES.length > 0, "an empty tavern code union would agree with itself");
  assert.ok(
    causes.length >= 20,
    `only ${causes.length} stardew_* name(s) were derived from the Host's own source; a population this small means the derivation broke`,
  );

  const findings = [];
  const seen = [];
  let examined = 0;
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const examine = (route, view) => {
      examined += 1;
      const text = `${view.title}\n${view.detail}`;
      for (const finding of identifiersIn([{ key: route, value: text, line: route }], locale))
        findings.push(`${finding.key} -> ${finding.token}`);
      if (route === GAME_PROBLEM_CODES[0] && !seen.includes(`${locale} ${route}`)) {
        seen.push(`${locale} ${route}`);
        seen.push(`${locale} ${route}: ${view.detail}`);
      }
    };
    for (const code of PROBLEM_CODES)
      examine(
        code,
        composedProblemView(
          new TavernProblemError({ type: "about:blank", title: "refused", status: 409, code, requestId: "request-1", retryable: false }),
          labels,
        ),
      );
    for (const code of GAME_PROBLEM_CODES)
      for (const cause of [null, ...causes])
        examine(
          cause === null ? code : `${code} + ${cause}`,
          composedProblemView(new ComposedReferenceGameProblemError(code, 409, "request-1", cause), labels),
        );
    // The client's own closed reasons are codes too, and they reach the same card.
    for (const error of [new ComposedReferenceGameProtocolError("invalid_composed_root"), new TavernProtocolError(), new Error("socket closed")])
      examine(`the client's own ${error.constructor.name}`, composedProblemView(error, labels));
  }

  t.diagnostic(
    `player-vocabulary.8: ${examined} rendered sentence pair(s) driven through the real view — ${PROBLEM_CODES.length} tavern code(s), ${GAME_PROBLEM_CODES.length} game code(s) x ${causes.length} stardew_* cause(s) + none, the client's own reasons — in 2 catalogues; ${findings.length} code token(s)`,
  );
  for (const sample of seen) t.diagnostic(`player-vocabulary.8: ${sample}`);
  for (const finding of findings) t.diagnostic(`player-vocabulary.8: ${finding}`);
  assert.deepEqual(
    findings,
    [],
    "a code belongs on the wire and in the record, which is where observedProblemCause reads it — a sentence a player reads may not carry one",
  );
});

test("player-vocabulary.9 (mutation): the sentences that shipped with a code on them are reported", (t) => {
  // The exact text the screen showed before this rule existed, in both catalogues: the catalogue held
  // no code, so only driving the real view (or replaying what it produced) can see this defect.
  const shipped = [
    [
      "gameProblemUnavailableCauseDetail",
      "GameBuddy could not carry out this step of the game (registered cause stardew_contained_player_host_launch_failed). What this page shows is the last state it read from the game; check Game installation, then try again.",
    ],
    [
      "problemInternalErrorDetail",
      "GameBuddy reported an internal error (code stardew_contained_player_host_launch_failed).",
    ],
    ["problemInternalErrorDetailZh", "GameBuddy 报告了内部错误（代码 stardew_contained_player_host_launch_failed）。"],
  ];
  const token = "stardew_contained_player_host_launch_failed";
  const reported = (text) => identifiersIn([{ key: "sample", value: text, line: "sample" }], "en").map((finding) => finding.token);
  assert.deepEqual(
    shipped.map(([, value]) => reported(value)),
    [[token], [token], [token]],
    "each shipped sentence carried the code and is reported for it",
  );
  // …and the sentences that replaced them carry nothing, which is what makes the rule green.
  const labels = messages("en");
  const replaced = [
    labels.gameProblemUnavailableDetail,
    labels.problemInternalErrorDetail,
    messages("zh-CN").problemInternalErrorDetail,
  ];
  assert.deepEqual(
    replaced.map((value) => reported(value)),
    [[], [], []],
    "the replaced sentences name the fault and the step, and print no code",
  );
  t.diagnostic(
    "player-vocabulary.9: the three sentences that shipped a code are reported by the same scan the rendered view is held to; their replacements are not",
  );
});

/**
 * The objects under `src` big enough to hold a catalogue's worth of player text. Five string-valued
 * keys is the floor: below it, a map is a table of one or two words and not a catalogue.
 */
const CATALOGUE_FLOOR = 5;

/**
 * Objects that hold player text and are NOT one of the catalogue pairs, each with the reason.
 *
 * Both kinds of entry here are honest about the same thing: the strings they hold are already in the
 * population. A key map's values are catalogue key names, so `namedKeys` brings the text itself in;
 * a code map's values are contract codes, which are not player text at all. An entry whose object is
 * gone is a finding, so this list cannot outlive what it explains.
 */
export const NOT_A_CATALOGUE = [
  {
    binding: "ACTIVATION_REFUSALS",
    why: "its values are contract problem codes, not player text",
  },
  {
    binding: "GAME_SITUATION_WHERE_MESSAGE",
    why: "its values are catalogue key names, so the sentences it points at are in the population",
  },
  {
    binding: "CONNECTION_API_SHAPE_LABELS",
    why: "its values are catalogue key names, so the sentences it points at are in the population",
  },
];

/** Objects under `src` with at least `CATALOGUE_FLOOR` string-valued keys: catalogue-shaped, by count. */
function catalogueShapes(directory = SRC) {
  const shapes = [];
  for (const file of sourceFiles(directory)) {
    const sourceFile = parse(file);
    const relative = file.replace(/\\/gu, "/").split("/dialogue-web/").pop();
    walk(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
      const object = unwrap(node.initializer);
      if (object === undefined || !ts.isObjectLiteralExpression(object)) return;
      const stringKeys = object.properties.filter(
        (property) =>
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          ts.isStringLiteral(property.initializer),
      ).length;
      if (stringKeys >= CATALOGUE_FLOOR)
        shapes.push({ file: relative, binding: node.name.text, stringKeys, keys: object.properties.length });
    });
  }
  return shapes;
}

test("player-vocabulary.10: every cause a player can be told about is a clause, and an unknown one says so", (t) => {
  const causes = stardewCauses();
  const mapped = Object.keys(GAME_CAUSE_CLAUSES);
  assert.ok(causes.length >= 20, `only ${causes.length} stardew_* name(s) derived from the Host; the derivation broke`);
  assert.ok(
    mapped.length > 0,
    "the clause map is empty: an empty map would make every cause fall back to 'we do not know', which is a lie for the ones we do know",
  );
  // The anchors are the owner's own example and the second role's launch: a map that lost them is a
  // map that stopped carrying what it was built for.
  for (const anchor of ["stardew_contained_player_host_launch_failed", "stardew_contained_ai_client_launch_failed"])
    assert.ok(mapped.includes(anchor), `${anchor} is one of the causes this map exists for and it is not in it`);

  const findings = [];
  for (const cause of mapped) if (!causes.includes(cause)) findings.push(`${cause} is mapped and no Host module declares it; drop the entry`);
  for (const locale of ["en", "zh-CN"]) {
    const labels = messages(locale);
    const clauses = mapped.map((cause) => ({ cause, clause: humanizeProblemCause(cause, labels) }));
    for (const { cause, clause } of clauses) {
      if (clause === labels.gameCauseUnknown) findings.push(`${locale} ${cause} fell back to the unknown clause, so the entry does nothing`);
      for (const finding of identifiersIn([{ key: cause, value: clause, line: cause }], locale))
        findings.push(`${locale} ${cause} clause prints "${finding.token}"`);
    }
    if (new Set(clauses.map(({ clause }) => clause)).size !== clauses.length)
      findings.push(`${locale} two causes share one clause, so the sentence cannot tell them apart`);
    // Every declared cause gets SOME answer - a clause or the honest fallback - never nothing.
    for (const cause of causes) {
      const clause = humanizeProblemCause(cause, labels);
      if (typeof clause !== "string" || clause.length === 0) findings.push(`${locale} ${cause} produced no clause`);
    }
    // The fallback says we do not know, and it is not one of the answers to a cause we do know.
    if (clauses.some(({ clause }) => clause === labels.gameCauseUnknown))
      findings.push(`${locale} the fallback is also a mapped clause`);
    if (humanizeProblemCause("a_cause_from_a_future_host", labels) !== labels.gameCauseUnknown)
      findings.push(`${locale} an unknown cause does not read as the unknown clause`);
    for (const finding of identifiersIn([{ key: "gameCauseUnknown", value: labels.gameCauseUnknown, line: "gameCauseUnknown" }], locale))
      findings.push(`${locale} the fallback clause prints "${finding.token}"`);
  }

  t.diagnostic(
    `player-vocabulary.10: ${mapped.length} cause(s) mapped to a clause, ${causes.length} stardew_* cause(s) derived from the Host, both catalogues; ${findings.length} finding(s)`,
  );
  for (const finding of findings) t.diagnostic(`player-vocabulary.10: ${finding}`);
  assert.deepEqual(findings, [], "a cause a player can be told about is a clause, and an unknown one says we do not know");
});

test("player-vocabulary.11: the reader reads every string the catalogues hold, and names what it does not", (t) => {
  const { pairs, read, named } = population();
  const shapes = catalogueShapes();
  const findings = [];

  for (const pair of pairs) {
    const shape = shapes.find((candidate) => candidate.binding === pair.en.name && candidate.file === pair.file);
    if (shape === undefined) {
      findings.push(`${pair.file} declares ${pair.en.name} and the shape scan did not see it at all`);
      continue;
    }
    // The historical defect, held durably: parsing the second catalogue without unwrapping
    // `Object.freeze` read ZERO of its strings, and nothing said so. A reader that reads fewer
    // strings than the object holds is now a finding, whatever shape caused it.
    if (shape.keys !== pair.en.entries.length || shape.keys !== pair.zh.entries.length)
      findings.push(
        `${pair.file} holds ${shape.keys} key(s) and the reader read ${pair.en.entries.length} of ${pair.en.name} / ${pair.zh.entries.length} of ${pair.zh.name}`,
      );
    for (const gap of [...pair.en.gaps, ...pair.zh.gaps]) findings.push(`${gap} is a property this reader cannot see`);
    if (pair.en.entries.length !== pair.zh.entries.length)
      findings.push(`${pair.file} reads ${pair.en.entries.length} ${pair.en.name} key(s) and ${pair.zh.entries.length} ${pair.zh.name} key(s)`);
  }

  // Every catalogue-shaped object is either a locale this gate reads, or named here with a reason.
  const readBindings = new Set(pairs.flatMap((pair) => [pair.en.name, pair.zh.name]).map((name) => name));
  for (const shape of shapes) {
    if (readBindings.has(shape.binding) && pairs.some((pair) => pair.file === shape.file)) continue;
    if (NOT_A_CATALOGUE.some((entry) => entry.binding === shape.binding)) continue;
    findings.push(
      `${shape.file} declares ${shape.binding} with ${shape.stringKeys} string-valued key(s) and no copy check reads it: make it a catalogue or name it in NOT_A_CATALOGUE with the reason`,
    );
  }
  for (const entry of NOT_A_CATALOGUE)
    if (!shapes.some((shape) => shape.binding === entry.binding))
      findings.push(`${entry.binding} is named as not-a-catalogue and no object by that name is left; drop the entry`);

  assert.ok(shapes.length >= 6, `only ${shapes.length} catalogue-shaped object(s) found under src; the scan broke`);
  assert.ok(
    named.size > 0,
    "no key is reachable through an indirection map any more: either the maps are gone or the scan broke, and neither is a pass",
  );
  t.diagnostic(
    `player-vocabulary.11: ${shapes.length} catalogue-shaped object(s), ${pairs.length} catalogue pair(s) read, ${read.size} statically read key(s), ${named.size} key(s) reachable only through an indirection map, ${NOT_A_CATALOGUE.length} named as not-a-catalogue; ${findings.length} finding(s)`,
  );
  for (const finding of findings) t.diagnostic(`player-vocabulary.11: ${finding}`);
  assert.deepEqual(
    findings,
    [],
    "a gate that reads fewer strings than the tree holds agrees with itself: every catalogue-shaped object is read, or named with the reason it is not",
  );
});

test("player-vocabulary.12 (mutation): the shape that hid the second catalogue, replayed", (t) => {
  // The second catalogue declares `const en: CharacterLabels = Object.freeze({ ... })`. The reader
  // that shipped in the first pass unwrapped `as const`, `satisfies` and parentheses, and this file
  // was therefore read as ZERO strings - 283 key(s) of player text outside every copy check, with
  // nothing saying so. This test replays that reader on a planted catalogue so the shape cannot come
  // back unnoticed.
  const planted = [
    "const en = Object.freeze({",
    '  firstKey: "One.",',
    '  secondKey: "Two.",',
    '  thirdKey: "Three.",',
    '  fourthKey: "Four.",',
    '  fifthKey: "Five.",',
    "});",
  ].join("\n");

  const readNow = catalogues(planted, "src/i18n.ts").find((catalogue) => catalogue.name === "en");
  assert.equal(readNow.entries.length, 5, "the reader unwraps the freeze call and sees every key");

  // The pre-fix reader: it looks for an object literal directly, so a call expression around it reads
  // as nothing at all.
  const readThen = (() => {
    const sourceFile = parse("src/i18n.ts", planted);
    let keys = 0;
    walk(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== "en") return;
      if (node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer))
        keys += node.initializer.properties.length;
    });
    return keys;
  })();
  assert.equal(readThen, 0, "the reader that shipped saw none of the five, which is the defect this lane found");
  t.diagnostic(
    `player-vocabulary.12: the pre-fix reader read 0 of 5 planted keys through Object.freeze; the reader above reads all 5`,
  );
});
