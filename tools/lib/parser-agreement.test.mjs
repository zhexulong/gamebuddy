import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditParserAgreement, MACRO_ENGINE_PATH, MAX_PRINTED_FINDINGS, VOCABULARIES } from "./parser-agreement.mjs";

// The repository the declarations were read from. Every drift below is injected into a COPY of the
// authority, taken from this file, so the red cases exercise the shipped grammar rather than a
// fixture written to fail.
//
// red-proof: inject  each red case injects a violation into a copy of the shipped grammar: the split
//                    spelling names `{{ char }}`, a gone reader path names `reader_missing`, and the
//                    unmodified tree is the green control (tools/lib/parser-agreement.test.mjs)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const macroEngineSource = readFileSync(resolve(repoRoot, MACRO_ENGINE_PATH), "utf8");

const roots = [];

/** A throwaway tree holding one edited copy of the authority, at the path the declarations name. */
function treeWith(source) {
  const root = mkdtempSync(join(tmpdir(), "parser-agreement-"));
  roots.push(root);
  const full = join(root, MACRO_ENGINE_PATH);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source, "utf8");
  return root;
}

/** The same source with one literal replaced, asserted to have changed: a stale literal is not a red case. */
function drift(literal, replacement) {
  const drifted = macroEngineSource.replace(literal, () => replacement);
  assert.notEqual(drifted, macroEngineSource, `the drift injection ${JSON.stringify(literal)} matched nothing`);
  return drifted;
}

const macroVocabulary = VOCABULARIES[0];

/** The macro a member token names, stripped of its braces or angle brackets and its parameters. */
const macroNameOf = (token) => /^[<{]{1,2}\s*([a-z][a-z0-9_]*)/u.exec(token)?.[1];

/**
 * The two spellings of the recognition line: the one the file carries today (built from the shared
 * grammar), and the pre-`e6b09cc7` one, where recognition had its OWN pattern with the name flush
 * against the braces. Editing the shared `BRACED_MACRO` cannot reproduce that drift - both readers move
 * together, which is what the shared grammar bought - so the red case replays the split instead.
 */
const SHARED_RECOGNITION = 'new RegExp(`${BRACED_MACRO}|${ANGLE_MACRO}`, "giu")';
const FLUSH_RECOGNITION = 'new RegExp(`[{][{](${MACRO_NAME})[^{}]*[}][}]|${ANGLE_MACRO}`, "giu")';
/** `WHOLE_MACRO`'s initialiser today: the classification reader both metadata checks are written against. */
const WHOLE_MACRO_TODAY = 'new RegExp(`^(?:${BRACED_MACRO}|${ANGLE_MACRO})$`, "iu")';

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("the two macro readers agree on the repository's own grammar", () => {
  const { readings, findings } = auditParserAgreement();
  assert.deepEqual(findings, []);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].vocabulary, "tavern-macro");
  assert.equal(readings[0].readers.length, 2);
  assert.ok(readings[0].members > 100, `the probe corpus measured ${readings[0].members} members`);
});

test("a spaced macro the classifier accepts and the recognizer never replaces is named by token", () => {
  // `{{ char }}` classified as the `char` macro and was never replaced; the survivor then read as junk
  // to `hasUnrenderedMacro` and the whole field carrying it was dropped.
  const root = treeWith(drift(SHARED_RECOGNITION, FLUSH_RECOGNITION));
  const { findings } = auditParserAgreement({ root });
  const disagreement = findings.find((finding) => finding.member === "{{ char }}");
  assert.ok(disagreement !== undefined, `findings were ${JSON.stringify(findings)}`);
  assert.equal(disagreement.code, "member_disagreement");
  assert.equal(disagreement.vocabulary, "tavern-macro");
  assert.equal(disagreement.reader, "macroKey");
  assert.match(disagreement.detail, /macroKey accepts "\{\{ char \}\}" and MACRO_PATTERN does not/u);
});

test("a token the recognizer matches and the classifier does not know is named from the recognizer's side", () => {
  // The same defect from the other direction: recognition wider than classification.
  const root = treeWith(drift("|${ANGLE_MACRO})$", ")$"));
  const { findings } = auditParserAgreement({ root });
  const disagreement = findings.find((finding) => finding.member === "<char>");
  assert.ok(disagreement !== undefined, `findings were ${JSON.stringify(findings)}`);
  assert.equal(disagreement.reader, "MACRO_PATTERN");
  assert.match(disagreement.detail, /MACRO_PATTERN accepts "<char>" and macroKey does not/u);
});

test("a drift in the shared grammar moves both readers with it, so it is not a disagreement", () => {
  // `\s*` belongs to `BRACED_MACRO`, which BOTH readers interpolate: taking it out takes both of them
  // off every spaced spelling. That is the whole point of `e6b09cc7`, and it is why the historical
  // drift above has to replay the split grammar instead of editing this constant.
  const root = treeWith(drift("\\s*", ""));
  const { readings, findings } = auditParserAgreement({ root });
  assert.deepEqual(findings, []);
  assert.equal(readings[0].readers[0].accepted, readings[0].readers[1].accepted);
});

test("a declared reader whose file is gone fails the gate naming that entry", () => {
  const renamed = {
    ...macroVocabulary,
    readers: [
      macroVocabulary.readers[0],
      { ...macroVocabulary.readers[1], path: "host/src/tavern/renamed-macro-engine.ts" },
    ],
  };
  const { findings } = auditParserAgreement({ root: treeWith(macroEngineSource), vocabularies: [renamed] });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "reader_missing");
  assert.equal(findings[0].vocabulary, "tavern-macro");
  assert.equal(findings[0].reader, "macroKey");
  assert.match(findings[0].detail, /renamed-macro-engine\.ts, which is not on disk/u);
});

test("a grammar constant the file no longer declares is a finding, not one comparison fewer", () => {
  const root = treeWith(drift("const WHOLE_MACRO =", "const WHOLE_MACRO_RENAMED ="));
  const { findings } = auditParserAgreement({ root });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "declaration_not_found");
  assert.equal(findings[0].reader, "macroKey");
  assert.match(findings[0].detail, /`WHOLE_MACRO`/u);
});

test("a reader that cannot be read says the comparison did not happen, never that it agreed", () => {
  // The masking case, measured: `WHOLE_MACRO` rebuilt over a sibling constant its reader's grammar list does
  // not name. The extractor cannot resolve it, so the comparison never runs - and a gate that reported this
  // as anything but "not compared" would leave the disagreement it hides unlooked-for.
  const root = treeWith(
    drift(WHOLE_MACRO_TODAY, `new RegExp(\`^(?:\${NARROW_BRACED}|\${ANGLE_MACRO})$\`, "iu")`).replace(
      "const WHOLE_MACRO =",
      "const NARROW_BRACED = `[{][{]([a-z_][a-z0-9_]*)[^{}]*[}][}]`;\nconst WHOLE_MACRO =",
    ),
  );
  const { readings, findings } = auditParserAgreement({ root });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "declaration_dependency");
  assert.equal(findings[0].reader, "macroKey");
  // The diagnosis names the real situation: the const is there, the reader's declarations are what lack it.
  assert.match(
    findings[0].detail,
    /`WHOLE_MACRO` needs `NARROW_BRACED`, which .* declares as a top-level `const` but this reader's declarations do not name/u,
  );
  assert.match(findings[0].detail, /this reader was not read and no comparison was made/u);
  assert.equal(
    findings.some((finding) => finding.code === "member_disagreement"),
    false,
  );
  assert.equal(readings[0].compared, false);
  assert.deepEqual({ read: readings[0].readers.length, declared: readings[0].declared }, { read: 1, declared: 2 });
});

test("a dependency the file does not declare at all is a different diagnosis from one it does", () => {
  // Same throw, different fact about the file - and the message has to say which one happened.
  const root = treeWith(drift(WHOLE_MACRO_TODAY, `new RegExp(\`^(?:\${NARROW_BRACED}|\${ANGLE_MACRO})$\`, "iu")`));
  const { findings } = auditParserAgreement({ root });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "declaration_dependency");
  assert.match(findings[0].detail, /which .* does not declare at all/u);
  assert.match(findings[0].detail, /no comparison was made/u);
});

test("an indented const is still found, so the diagnosis stays 'outside this reader's grammar'", () => {
  // Leading whitespace does not make a top-level `const` absent. Reading it as absent would make the message
  // assert something false about a file that carries the declaration on the very next line.
  const root = treeWith(
    drift(WHOLE_MACRO_TODAY, `new RegExp(\`^(?:\${NARROW_BRACED}|\${ANGLE_MACRO})$\`, "iu")`).replace(
      "const WHOLE_MACRO =",
      "  const NARROW_BRACED = `[{][{]([a-z_][a-z0-9_]*)[^{}]*[}][}]`;\nconst WHOLE_MACRO =",
    ),
  );
  const { findings } = auditParserAgreement({ root });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "declaration_dependency");
  assert.match(findings[0].detail, /declares as a top-level `const` but this reader's declarations do not name/u);
});

test("a const preceded by another statement on its line is unreadable, not silently absent", () => {
  // A hand edit that merges two statements into one line is a well-formed file this extractor cannot
  // read. The message has to say so: claiming the file "does not define" a const that is right there
  // sends the next reader looking for a rename that never happened.
  const root = treeWith(
    drift(WHOLE_MACRO_TODAY, `new RegExp(\`^(?:\${NARROW_BRACED}|\${ANGLE_MACRO})$\`, "iu")`).replace(
      "const WHOLE_MACRO =",
      "const NARROW_BRACED = `[{][{]([a-z_][a-z0-9_]*)[^{}]*[}][}]`; const WHOLE_MACRO =",
    ),
  );
  const { readings, findings } = auditParserAgreement({ root });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "declaration_not_found");
  assert.match(findings[0].detail, /could not read as a top-level `const`/u);
  assert.match(findings[0].detail, /no comparison was made/u);
  assert.equal(readings[0].compared, false);
});

test("the printed sample names every macro the two readers disagreed about", () => {
  // The historical drift disagrees about ~486 members. A name-major corpus spent the whole twenty-line
  // sample on `bot` spellings, so `char` - the token this gate exists for, finding #30 - never appeared,
  // and a report that hides the decisive member reads as green to the person looking at it.
  const root = treeWith(drift(SHARED_RECOGNITION, FLUSH_RECOGNITION));
  const { findings } = auditParserAgreement({ root });
  const allNames = new Set(findings.map((finding) => macroNameOf(finding.member)));
  const printed = new Set(findings.slice(0, MAX_PRINTED_FINDINGS).map((finding) => macroNameOf(finding.member)));
  assert.ok(findings.length > MAX_PRINTED_FINDINGS * 4, `the drift produced only ${findings.length} findings`);
  assert.ok(allNames.size >= 10, `the corpus disagreed about ${allNames.size} macros`);
  assert.deepEqual([...printed].sort(), [...allNames].sort(), `the sample named ${JSON.stringify([...printed])}`);
  assert.ok(printed.has("char"), `the sample named ${JSON.stringify([...printed])}`);
});

test("a vocabulary with fewer than two readers cannot compare, and says so", () => {
  const single = { ...macroVocabulary, readers: [macroVocabulary.readers[1]] };
  const { readings, findings } = auditParserAgreement({ root: treeWith(macroEngineSource), vocabularies: [single] });
  assert.equal(findings.length, 1, `findings were ${JSON.stringify(findings)}`);
  assert.equal(findings[0].code, "readers_unpaired");
  assert.match(findings[0].detail, /no comparison was made/u);
  assert.equal(readings[0].compared, false);
});

test("a reader that accepts nothing is reported instead of agreeing with an empty set", () => {
  const silent = {
    ...macroVocabulary,
    readers: [
      macroVocabulary.readers[0],
      { ...macroVocabulary.readers[1], name: "silent", function: undefined, match: () => false },
    ],
  };
  const { findings } = auditParserAgreement({ root: treeWith(macroEngineSource), vocabularies: [silent] });
  const empty = findings.find((finding) => finding.code === "reader_empty");
  assert.ok(empty !== undefined, `findings were ${JSON.stringify(findings).slice(0, 400)}`);
  assert.equal(empty.reader, "silent");
  assert.match(empty.detail, /one-sided/u);
});
