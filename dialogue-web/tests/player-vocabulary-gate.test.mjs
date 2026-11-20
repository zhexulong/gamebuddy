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
 * use), in both catalogues of `src/i18n.ts`. A declared key no source reads cannot reach a player, and
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
 * CHINESE IS SCANNED TOO, from a rendering table attached to the entries it renders (`权威` for
 * `authoritative`, `装配` for `assembly`, `投影` for `projection`, ...). A rendering is checked in both
 * directions: it must name a Latin entry that is itself witnessed, so a row cannot outlive its word.
 * `会话` is deliberately NOT in the table: it is the catalogue's own word for a Chat
 * (`chats: "会话"`), so a scan for it would fail the interface's name for its own surface. The Chinese
 * half of `session` therefore rests on the English half - the two catalogues are edited together, and the
 * sentence pair is what a reviewer reads.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  { names: "a game prepared ahead of the surface that asks for it", forms: ["staged", "staging"] },
  { names: "an operating-system process a role runs in", forms: ["process", "processes"], zh: ["进程"] },
  { names: "the registry entry that holds a game after a run", forms: ["registration", "registrations"] },
  { names: "the settlement record of a finished program", forms: ["digest", "digests"] },
  { names: "the quota a turn may use", forms: ["budget", "budgets"] },
];

/** The nouns this gate exists for: a shrinking lexicon must fail loudly instead of quietly passing. */
const ANCHORS = ["host", "session", "runtime", "quarantine", "guardian", "authority", "projection", "assembly"];

/** Unwraps `as const`, `satisfies T` and parentheses. */
function unwrap(node) {
  let current = node;
  while (
    current !== undefined &&
    (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))
  )
    current = current.expression;
  return current;
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

/** The catalogues of a text: `{ name, entries: [{ key, value, line }] }` for `en` and `zh`. */
export function catalogues(text, fileName = I18N) {
  const sourceFile = parse(fileName, text);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const object = unwrap(node.initializer);
    if (object === undefined || !ts.isObjectLiteralExpression(object)) return;
    const entries = [];
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
      entries.push({
        key: property.name.text,
        value: ts.isStringLiteral(property.initializer) ? property.initializer.text : null,
        line: at(property, sourceFile),
      });
    }
    found.push({ name: node.name.text, entries });
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

/** The two catalogues, the keys a source reads, and the strings a player can therefore see. */
function population() {
  const parsed = catalogues(readFileSync(I18N, "utf8"));
  const en = parsed.find((catalogue) => catalogue.name === "en");
  const zh = parsed.find((catalogue) => catalogue.name === "zh");
  assert.ok(en !== undefined && zh !== undefined, "src/i18n.ts must declare both catalogues");
  const read = readKeys();
  const visible = (catalogue) => catalogue.entries.filter((entry) => read.has(entry.key) && entry.value !== null);
  return { en, zh, read, visibleEn: visible(en), visibleZh: visible(zh) };
}

test("player-vocabulary.1: the population is derived, and it is not empty", (t) => {
  const { en, zh, read, visibleEn, visibleZh } = population();
  const examined = visibleEn.length + visibleZh.length;
  assert.ok(
    examined >= 1000,
    `only ${examined} player-facing string(s) were derived from ${en.entries.length} declared key(s) and ${read.size} read key(s); a population this small means the derivation broke, not that the copy is clean`,
  );
  // Both catalogues hold the same keys (i18n.1); a player reads one of the two sentences, never both.
  const lexicon = INTERNAL_NOUNS.flatMap((noun) => [...noun.forms, ...(noun.zh ?? [])]);
  const carriers = visibleEn.filter((entry) => internalsIn([entry], "en").length > 0).length;
  t.diagnostic(
    `player-vocabulary.1: strings examined ${examined} (${visibleEn.length} read key(s) of ${en.entries.length} declared in this file; ${read.size} keys read across every catalogue) · containing an internal noun ${carriers} · lexicon ${lexicon.length} word(s) over ${INTERNAL_NOUNS.length} noun(s)`,
  );
});

test("player-vocabulary.2: no player-facing sentence names our machinery", (t) => {
  const { visibleEn, visibleZh } = population();
  const findings = [...internalsIn(visibleEn, "en"), ...internalsIn(visibleZh, "zh")];
  const counts = new Map();
  for (const finding of findings) counts.set(finding.noun, (counts.get(finding.noun) ?? 0) + 1);
  const top = [...counts].sort((left, right) => right[1] - left[1]).slice(0, 8);
  t.diagnostic(
    `player-vocabulary.2: ${findings.length} finding(s) across ${new Set(findings.map((finding) => finding.key)).size} key(s); top: ${top.map(([noun, count]) => `${noun}:${count}`).join(", ")}`,
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
