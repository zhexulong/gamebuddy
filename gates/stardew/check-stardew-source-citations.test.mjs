import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import test from "node:test";

import {
  auditCitations,
  baselineDocument,
  citationReading,
  readBaseline,
  renderReading,
  trackedTextFiles,
} from "./check-stardew-source-citations.mjs";
import { resolveCitation, resolveSymbol, sourceNames } from "../../tools/lib/source-citation.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

/**
 * The falsifier suite for `gates/stardew/check-stardew-source-citations.mjs`.
 *
 * Every citation in this file is CONSTRUCTED from its parts rather than written out, and that is not style: the gate reads
 * this file's text too, so a literal line-range citation here would be a citation the gate has to be excused from - the
 * falsifier would become a member of the population it is proving. `citation(...)` writes one; `range(...)` writes the
 * spelling the gate refuses.
 *
 * red-proof: history  the round99 defect replayed on the real commit before it was fixed: `citationReading` over
 *                     `f6ea803a^:host/src/body-program-script.ts` - where `cropTargets.publishedAsWork` cited the
 *                     `DiscoverCropTargets` anchor by a line range - reports `citation_is_a_line_range` at the site that
 *                     writes it, and the same claim citing the symbol is clean
 * red-proof: inject   a line range nothing records -> `citation_is_a_line_range:<site>` (exit 1)
 * red-proof: inject   a recorded row whose citation was converted -> `citation_debt_row_stale`, naming the row to delete
 * red-proof: inject   a symbol citation the named file neither declares nor mentions -> `citation_names_a_symbol_the_file_does_not_carry`
 */

const REPO = repositoryRoot(import.meta.url);

/** `<file>.cs:<from>-<to>` as a string, never as a literal in this file's text. See the docblock. */
const range = (file, from, to) => `${file}.cs:${String(from)}-${String(to)}`;

/** `<file>.cs:<symbol>` as a string, never as a literal in this file's text. */
const citation = (file, symbol) => `${file}.cs:${symbol}`;

const MOD = "FarmhandThing";

/** A Mod file that declares one publication predicate, and mentions another name without declaring it. */
const MOD_TEXT = [
  "internal sealed class FarmhandThing",
  "{",
  "    public bool PublishesOnlyThirstyRows(FarmhandRoster roster)",
  "    {",
  "        return roster.EveryRowNeedsWater;",
  "    }",
  "}",
].join("\n");

const WORLD = {
  ownNames: sourceNames([`integrations/stardew/${MOD}.cs`]),
  engineNames: sourceNames([
    "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/GameLocation.cs",
    "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Tools/WateringCan.cs",
  ]),
  readSource: (citedFile) => (citedFile === `${MOD}.cs` ? MOD_TEXT : null),
};

const sourceOf = (text) => [{ path: "host/src/a-claim.ts", text }];

test("a line range over our own source is refused at the site that writes it", () => {
  const reading = citationReading({
    sources: sourceOf(` * every row the patch holds is thirsty (${range(MOD, 12, 40)}), so the family is the condition`),
    ...WORLD,
  });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["citation_is_a_line_range"],
    "a range nothing records is red the moment it lands",
  );
  assert.match(reading.findings[0].detail, /name the symbol/u);
  assert.equal(reading.counts.own, 1, "and it is counted as a range over this repository's own source");
  assert.equal(reading.counts.debt, 0);
});

test("the same claim citing the symbol is resolved to the declaration, and the verdict line says so", () => {
  const reading = citationReading({
    sources: sourceOf(` * every row the patch holds is thirsty (${citation(MOD, "PublishesOnlyThirstyRows")})`),
    ...WORLD,
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.counts.symbols, 1);
  assert.equal(reading.counts.declared, 1, "the file declares the member, which is the strong answer");
  assert.equal(reading.counts.mentioned, 0);
  const lines = renderReading({ reading });
  assert.equal(
    lines[0],
    "line-range citations: 0 (debt) · symbol citations: 1",
    "the count the gate prints is the two populations, added",
  );
});

test("a fixture literal resolves by mention, and is counted apart from a declaration", () => {
  // `check-stardew-lifecycle-pins.mjs` cites an action id inside a test file: the file names the literal and declares no
  // member of that name, so reading the two tiers as one answer would refuse a citation the tree means literally.
  const reading = citationReading({
    sources: sourceOf(` * the entry itself (${citation(MOD, "EveryRowNeedsWater")}) is a fixture literal`),
    ...WORLD,
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.counts.mentioned, 1);
  assert.equal(reading.counts.declared, 0);
});

test("a symbol the cited file neither declares nor mentions is red, naming the file and the symbol", () => {
  const renamed = `${String("PublishesOnlyThirsty")}Everything`;
  const reading = citationReading({
    sources: sourceOf(` * (${citation(MOD, renamed)}) is the predicate this family rests on`),
    ...WORLD,
  });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["citation_names_a_symbol_the_file_does_not_carry"],
  );
  assert.ok(
    reading.findings[0].detail.includes(`${MOD}.cs neither declares nor mentions \`${renamed}\``),
    `the finding has to name the file and the symbol; it said: ${reading.findings[0].detail}`,
  );
});

test("a recorded row that the claim converted from is stale, and names the row to delete", () => {
  const cited = range(MOD, 12, 40);
  const reading = citationReading({
    sources: sourceOf(` * every row is thirsty (${citation(MOD, "PublishesOnlyThirstyRows")})`),
    ...WORLD,
    baseline: [{ path: "host/src/a-claim.ts", cited }],
  });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["citation_debt_row_stale"],
    "the row outlived the citation it recorded",
  );
  assert.match(reading.findings[0].detail, /convert it and delete the row/u);
});

test("a recorded row covers ONE site: a second copy of the same range is a new citation", () => {
  const cited = range(MOD, 12, 40);
  const line = ` * every row is thirsty (${cited})`;
  const reading = citationReading({
    sources: [{ path: "host/src/a-claim.ts", text: `${line}\n${line}` }],
    ...WORLD,
    baseline: [{ path: "host/src/a-claim.ts", cited }],
  });
  assert.equal(reading.counts.debt, 1, "the recorded occurrence is the debt");
  assert.equal(reading.findings.length, 1, "and the second copy is a finding, not the same debt twice");
  assert.equal(reading.findings[0].code, "citation_is_a_line_range");
});

test("an engine range is counted as a named exception and never a finding", () => {
  const reading = citationReading({
    sources: sourceOf(` * the charge is spent by the power (${range("WateringCan", 189, 191)})`),
    ...WORLD,
  });
  assert.deepEqual(reading.findings, [], "the engine is positional by construction, and the reason is in the tree");
  assert.equal(reading.counts.engine, 1);
  const lines = renderReading({ reading });
  assert.match(lines[1], /POSITIONAL BY CONSTRUCTION/u);
  assert.match(lines[1], /engineReadingAt/u, "the exception names the call that needs the line");
});

test("a cited file neither index holds is recorded, because no symbol could be checked there either", () => {
  const cited = range("SomewhereNotInThisTree", 1, 9);
  const reading = citationReading({
    sources: sourceOf(` * (${cited}) decides it`),
    ...WORLD,
    baseline: [{ path: "host/src/a-claim.ts", cited }],
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.counts.unheld, 1, "recorded, and printed as a class of its own");
});

test("THE ROUND99 DEFECT, REPLAYED ON REAL HISTORY: the reason before the fix cites the anchor by a range", (t) => {
  const historical = spawnSync("git", ["show", "f6ea803a^:host/src/body-program-script.ts"], {
    cwd: REPO,
    encoding: "utf8",
    windowsHide: true,
  });
  if (historical.status !== 0) {
    t.skip("the replay names commit f6ea803a, which this checkout cannot resolve");
    return;
  }
  const ownNames = sourceNames(["integrations/stardew/farmhandtargetdiscovery.cs"]);
  const named = range("farmhandtargetdiscovery", 2217, 2238);
  const reading = citationReading({
    sources: [{ path: "host/src/body-program-script.ts", text: historical.stdout }],
    ownNames,
    engineNames: new Set(),
    readSource: () => null,
    baseline: [],
  });
  const finding = reading.findings.find(
    (entry) => entry.code === "citation_is_a_line_range" && entry.detail.includes(named),
  );
  assert.ok(finding !== undefined, `the pre-fix reason must be red; findings were ${JSON.stringify(reading.findings)}`);
  assert.equal(reading.counts.debt, 0, "and nothing records it, because a range is not an anchor");
});

test("the real tree is green, and the verdict line is the two populations", () => {
  const result = auditCitations({ root: REPO });
  assert.equal(result.blocked, null, "this checkout has git, the decompiled mount and a readable baseline");
  assert.deepEqual(
    result.reading.findings,
    [],
    "the tree's recorded debt matches its citations, and every symbol citation resolves",
  );
  assert.match(
    renderReading(result)[0],
    /^line-range citations: \d+ \(debt\) · symbol citations: \d+$/u,
    "the verdict is the two populations, so a reader can see the debt fall and never grow",
  );
  assert.ok(
    result.reading.counts.declared >= 1,
    "the shipped `publishedAsWork` reason resolves by DECLARATION, which is the anchor it claims",
  );
});

test("the resolver refuses a call site as a declaration, which is what makes the anchor checkable", () => {
  // `EveryRowNeedsWater` is MENTIONED inside the body of the predicate and declared nowhere: the strong tier must not
  // reach it, or a reason could anchor to a call site and read exactly like an anchored one.
  assert.equal(resolveSymbol(MOD_TEXT, "EveryRowNeedsWater"), null);
  assert.equal(resolveCitation(MOD_TEXT, "EveryRowNeedsWater").tier, "mention");
  assert.notEqual(resolveSymbol(MOD_TEXT, "PublishesOnlyThirstyRows"), null);
});

test("a repository git cannot list is not measured, and a missing engine mount blocks rather than reds", () => {
  const noGit = auditCitations({
    root: REPO,
    git: () => ({ status: 1, stdout: "" }),
  });
  assert.equal(noGit.blocked, "citation_population_not_measured");

  const oneFile = () => ({ status: 0, stdout: "README.md\0" });
  const noEngine = auditCitations({ root: REPO, git: oneFile, engine: null });
  assert.equal(
    noEngine.blocked,
    "stardew_decompile_root_missing",
    "without the mount an engine citation cannot be told from a file this tree does not hold",
  );

  const empty = auditCitations({ root: REPO, git: () => ({ status: 0, stdout: "" }), engine: new Map() });
  assert.equal(empty.blocked, "citation_population_empty", "a reading of nothing agrees with itself, so it is blocked");
});

test("the baseline is content-keyed: a row survives its claim moving down the file, and dies with the claim", () => {
  const cited = range(MOD, 12, 40);
  const rows = [{ path: "host/src/a-claim.ts", cited }];
  const moved = citationReading({
    sources: sourceOf(`\n\n\n * every row is thirsty (${cited})`),
    ...WORLD,
    baseline: rows,
  });
  assert.deepEqual(moved.findings, [], "a line number is not part of the identity, so moving the claim changes nothing");
  const document = baselineDocument(moved.recorded);
  assert.deepEqual(
    readBaseline({ root: REPO, path: ".unused" }),
    [],
    "an absent baseline is no debt, and an unreadable one is refused rather than read as empty",
  );
  assert.deepEqual(document.rows, [{ path: "host/src/a-claim.ts", cited }]);
});

test("the population is the tree's own text, with the baseline skipped and every tracked .cs a member", () => {
  const listed = trackedTextFiles({ root: REPO });
  assert.ok(listed !== null, "git must answer in this checkout");
  assert.ok(listed.sources.length > 100, "a population of nothing would agree with every assertion above");
  assert.ok(
    listed.sources.some((source) => source.path.endsWith(".cs")),
    "the files a claim about our own code is written in are members",
  );
  assert.ok(
    listed.sources.every((source) => !source.path.endsWith("line-range-citation-baseline.json")),
    "the baseline is skipped, because scanning it would count every recorded row as a new citation",
  );
});
