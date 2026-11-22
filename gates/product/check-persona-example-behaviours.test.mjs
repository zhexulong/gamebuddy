#!/usr/bin/env node
/**
 * Falsifier suite for `tools/check-persona-example-behaviours.mjs`.
 *
 * The population half is driven through the real gate binary against a COPY of the shipped presets, because the
 * question is about the card's own text: a stub card would answer a question nobody asked. The four truth-table cells
 * and the declaration rules are driven through `judgeBehaviours` directly, where a synthetic row can reach the two
 * cells the shipped card cannot - a sentence with no example, and a row that is a fossil.
 *
 * red-proof: history  `6107a8dd`, the card that shipped before the permission was written: its examples demonstrate
 *                     `这泥巴比水泥还黏靴子` and `震得我手腕生疼` while no sentence in the corpus states that either is
 *                     said -> exit 1 with the two findings below, and the second finding shape
 *                     `behaviour_claim_unmatched:comforts_with_her_own_scar:…` on the same run
 *                     (tools/check-persona-example-behaviours.test.mjs)
 * red-proof: inject   the incident replayed, twice, because the 2026-11-17 reversal left the two rows tied to two
 *                     different sentences: the clause `但对手头东西的评价不用回执，直接说` removed from a copied
 *                     `card.json`'s `data.system_prompt` -> exit 1 naming all three demonstrations of
 *                     `evaluates_the_thing_in_hand`; the clause `只用来调侃活计和工具` removed -> exit 1 naming both
 *                     demonstrations of `complains_about_a_tool`; writing the bytes back after either -> exit 0. A
 *                     `{{char}}` turn appended to a copied `mes_example`, carrying no declared sample ->
 *                     `example_unclassified:早啊，粥在锅里温着，自己盛。`, which is the population being derived rather
 *                     than listed (tools/check-persona-example-behaviours.test.mjs)
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  exampleTurns,
  judgeBehaviours,
  parseArgs,
  readClaimCorpus,
  readExamples,
  runCheck,
  VIOLATION,
} from "./check-persona-example-behaviours.mjs";
import { batchContents } from "./check-persona-prose.mjs";
import { BEHAVIOURS } from "../../tools/lib/persona-behaviour-vocabulary.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "check-persona-example-behaviours.mjs");
const REPOSITORY_ROOT = repositoryRoot(import.meta.url);
const PRESETS = "assets/tavern/presets";
const CARD = `${PRESETS}/default-companion/card.json`;

/**
 * The two behaviours whose permitting sentence lives in the shipped card's `system_prompt`. Each arm removes the row's
 * OWN `claim` - the same string the gate reads - so the removal and the expected finding cannot disagree, and a row
 * re-tied to a clause that reds the wrong behaviour's demonstrations is caught rather than accommodated. The two rows
 * shared one sentence until 2026-11-17, when the complaint licence was deleted and the evaluation half kept.
 */
const CARD_CLAIMS = Object.freeze(["evaluates_the_thing_in_hand", "complains_about_a_tool"]);

/** One declared row by behaviour, or a named refusal - rather than `undefined` reaching an assertion and passing it. */
function rowFor(behaviour) {
  const row = BEHAVIOURS.find((candidate) => candidate.behaviour === behaviour);
  assert.ok(row !== undefined, `the vocabulary no longer declares ${behaviour}`);
  return row;
}

/** A copy of the shipped presets outside the repository, so a rewrite of the card is a real rewrite and never a real one. */
function copiedCorpus(context) {
  const root = mkdtempSync(join(tmpdir(), "persona-example-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(REPOSITORY_ROOT, PRESETS), join(root, PRESETS), { recursive: true });
  const path = join(root, CARD);
  return { root, path, original: readFileSync(path, "utf8") };
}

/** The real gate binary, so the arms measure what a caller reads: the exit status and the printed findings. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, lines: result.stdout.trim().split("\n") };
}

const censusOf = (stdout) => stdout.trim().split("\n")[0];

/** A minimal card document, for the arms that are about the derivation rather than the shipped prose. */
const cardDocument = (examples) => ({ data: { system_prompt: "一句话。", mes_example: examples } });

test("the shipped card's 15 example turns are all claimed by the shipped vocabulary", () => {
  const result = runCheck({ root: REPOSITORY_ROOT });
  assert.equal(result.status, "passed", result.lines.join("\n"));
  assert.deepEqual(result.findings, []);

  // Cross-check: the gate's example count against the raw `{{char}}:` occurrences in the same card, so the count is
  // asserted against its own authority rather than against a number written here. Two derivations, one equality.
  const card = JSON.parse(readFileSync(join(REPOSITORY_ROOT, CARD), "utf8"));
  const declared = (card.data.mes_example.match(/\{\{char\}\}\s*[:：]/gu) ?? []).length;
  assert.equal(result.examples.length, declared);
  assert.ok(declared > 0);

  // The property, not today's numbers: every turn is classified, and no declared row is orphaned.
  assert.match(censusOf(result.lines.join("\n")), new RegExp(`covered ${declared} of|covered ${declared} ·`, "u"));
  for (const row of result.rows) assert.ok(row.examples > 0, `${row.behaviour} has no shipped example`);
  assert.ok(BEHAVIOURS.length > 0 && BEHAVIOURS.length <= 12, `vocabulary has ${BEHAVIOURS.length} rows`);
});

test("the incident: deleting a permission reds every example that demonstrated it, restoring it is green", (context) => {
  const { root, path, original } = copiedCorpus(context);
  for (const behaviour of CARD_CLAIMS) {
    const row = rowFor(behaviour);
    assert.ok(original.includes(row.claim), `the shipped card no longer carries ${row.claim}`);
    writeFileSync(path, original.replace(row.claim, ""));

    const deleted = runGate(root);
    assert.equal(deleted.status, 1, deleted.stdout);
    assert.match(deleted.lines.at(-1) ?? "", /^\{"gate":"persona_example_behaviour_claim/u);
    assert.ok(deleted.lines.some((line) => line.startsWith("persona_example_behaviour_uncovered:")));

    // The finding names the example fragment, the behaviour and the sentence that went missing - all three, because a
    // reader who sees only one of them has to go and find the other two.
    for (const sample of row.samples) {
      const finding = `${VIOLATION}:${sample}:${behaviour}:${row.claim}`;
      assert.ok(deleted.lines.includes(finding), `missing ${finding}`);
    }
    const findings = deleted.lines.filter((line) => line.startsWith(`${VIOLATION}:`));
    assert.equal(
      findings.length,
      row.samples.length,
      `${behaviour} names exactly its own demonstrations: ${findings.join(" | ")}`,
    );
    assert.ok(findings.every((line) => line.endsWith(row.claim)));
    // The gate reds on the deleted clause and on nothing else: a finding is not a count that always fires.
    assert.equal(
      deleted.lines.filter((line) => line.startsWith("behaviour_claim_") || line.startsWith("example_unclassified"))
        .length,
      0,
    );
  }

  writeFileSync(path, original);
  const restored = runGate(root);
  assert.equal(restored.status, 0, restored.stdout);
  assert.ok(restored.lines.includes("persona_example_behaviours_all_claimed"));
  assert.equal(censusOf(restored.stdout).split("findings ")[1], "0");
});

test("an example the vocabulary has not classified reds, because the population is derived from the card", (context) => {
  const { root, path, original } = copiedCorpus(context);
  const baseline = censusOf(runGate(root).stdout);
  const baselineExamples = Number(baseline.match(/examples (\d+)/u)?.[1] ?? 0);
  assert.ok(baselineExamples > 0, baseline);
  const card = JSON.parse(original);
  const added = "早啊，粥在锅里温着，自己盛。";
  card.data.mes_example = `${card.data.mes_example}\n\n<START>\n{{user}}: 早上好。\n{{char}}: ${added}`;
  writeFileSync(path, JSON.stringify(card, null, 2));

  const result = runGate(root);
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.lines.includes(`example_unclassified:${added}`), result.stdout);
  assert.match(
    censusOf(result.stdout),
    new RegExp(`examples ${baselineExamples + 1} · covered ${baselineExamples}`, "u"),
  );
});

test("the four truth-table cells are disjoint, and each names its own remedy", () => {
  // One row under test, and a covering row that keeps its turn classified so each arm isolates ONE cell.
  const row = { behaviour: "b", gloss: "", mode: "permitted", claim: "CLAIM", samples: ["SAMPLE"] };
  const cover = { behaviour: "c", gloss: "", mode: "permitted", claim: "CLAIM", samples: ["nothing"] };
  const turn = { card: "card.json", text: "a SAMPLE here" };
  const other = { card: "card.json", text: "nothing at all" };
  const corpus = [{ location: "card.json system_prompt", text: "a CLAIM here" }];

  const held = judgeBehaviours({ behaviours: [row], turns: [turn], corpus });
  assert.deepEqual(held.findings, []);
  assert.equal(held.rows[0].examples, 1);
  assert.equal(held.rows[0].claimAt, "card.json system_prompt");

  const sentenceGone = judgeBehaviours({ behaviours: [row], turns: [turn], corpus: [] });
  assert.deepEqual(sentenceGone.findings, [`${VIOLATION}:SAMPLE:b:CLAIM`]);
  assert.equal(sentenceGone.rows[0].claimAt, null);

  const sampleGone = judgeBehaviours({ behaviours: [row, cover], turns: [other], corpus });
  assert.deepEqual(sampleGone.findings, ["behaviour_claim_unmatched:b:CLAIM"]);

  // No corpus at all: `b`'s sample is gone too, so `b` is a fossil while `c` keeps its sample and becomes the incident
  // cell. Two rows, two different cells, one call - which is the partition holding under its worst case.
  const bothGone = judgeBehaviours({ behaviours: [row, cover], turns: [other], corpus: [] });
  assert.deepEqual(bothGone.findings, ["behaviour_claim_stale:b:SAMPLE", `${VIOLATION}:nothing:c:CLAIM`]);
});

test("a row whose mode is outside the closed pair, or whose claim is empty, is a declaration finding", () => {
  const turns = [{ card: "card.json", text: "SAMPLE" }];
  const corpus = [{ location: "card.json system_prompt", text: "CLAIM" }];
  const bad = judgeBehaviours({
    behaviours: [{ behaviour: "b", mode: "tolerated", claim: "CLAIM", samples: ["SAMPLE"] }],
    turns,
    corpus,
  });
  assert.deepEqual(bad.findings, ["behaviour_declaration_invalid:b:tolerated"]);
  const empty = judgeBehaviours({
    behaviours: [{ behaviour: "b", mode: "permitted", claim: "  ", samples: ["SAMPLE"] }],
    turns,
    corpus,
  });
  assert.deepEqual(empty.findings, ["behaviour_declaration_invalid:b:claim", `${VIOLATION}:SAMPLE:b:  `]);
});

test("an empty population is blocked, not green", (context) => {
  const root = mkdtempSync(join(tmpdir(), "persona-example-empty-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, CARD);
  cpSync(join(REPOSITORY_ROOT, PRESETS, "default-companion"), join(root, `${PRESETS}/default-companion`), {
    recursive: true,
  });
  const card = JSON.parse(readFileSync(path, "utf8"));
  delete card.data.mes_example;
  writeFileSync(path, JSON.stringify(card, null, 2));

  const result = runCheck({ root });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /^persona_example_population_empty/u);
  assert.equal(runGate(root).status, 2);
});

test("the derivation reads both example shapes and every claim source, and the parser agrees with the card", () => {
  const arrayShape = exampleTurns(["<START>\n{{user}}: a\n{{char}}: one", "<START>\n{{char}}: two"]);
  assert.deepEqual(arrayShape, ["one", "two"]);
  assert.deepEqual(exampleTurns("<START>\n{{user}}: a\n{{char}}: one\n\n<START>\n{{char}}: two"), ["one", "two"]);

  const documents = [
    { path: "x/card.json", document: cardDocument("<START>\n{{char}}: one") },
    { path: "x/worldbook.json", document: { alwaysOnPremise: "premise", entries: [{ content: "entry" }] } },
    { path: "x/preset.json", document: { prompts: [{ content: "prompt rule" }, { content: "" }] } },
  ];
  assert.deepEqual(readExamples(documents), [{ card: "x/card.json", text: "one" }]);
  const locations = readClaimCorpus(documents).map((field) => field.location);
  assert.deepEqual(locations, [
    "x/card.json system_prompt",
    "x/worldbook.json alwaysOnPremise",
    "x/worldbook.json entries.0.content",
    "x/preset.json prompts.0.content",
  ]);
});

test("--root is honoured and the default is the repository", () => {
  assert.equal(parseArgs([]).root, REPOSITORY_ROOT);
  assert.equal(parseArgs(["--root", "some/where"]).root, resolve("some/where"));
});

test("red (history): the card that shipped before the permission wrote examples nothing permitted", (context) => {
  // `f731fbb9` ADDED the permission, so its parent is the card that shipped these examples with no sentence permitting
  // them. Replayed out of the object store rather than from a fixture, because that state is the defect itself.
  const revision = "6107a8dd";
  const root = mkdtempSync(join(tmpdir(), "persona-example-history-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  let unavailable = null;
  try {
    const paths = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", revision, "--", PRESETS], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    })
      .split("\u0000")
      .filter((path) => path.endsWith(".json"));
    const contents = batchContents(
      REPOSITORY_ROOT,
      paths.map((path) => `${revision}:${path}`),
    );
    for (const path of paths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents.get(`${revision}:${path}`));
    }
  } catch (error) {
    unavailable = String(error?.stderr ?? error?.message ?? error);
  }
  // A clone with no history - `actions/checkout`'s default is `fetch-depth: 1` - cannot replay the revision. That is a
  // reading that was not taken, and it says so by name instead of passing as if the gate had been shown red there.
  if (unavailable !== null) {
    assert.match(unavailable, new RegExp(`${revision}|bad object|unknown revision|not a valid`, "u"));
    return;
  }
  const result = runGate(root);
  assert.equal(result.status, 1, result.stdout);
  // The expected sentence comes from the row that owns it, not from a second copy written here: the historical card has
  // no permitting sentence at all, so the gate prints the row's current `claim` and this reading must agree with it.
  const missing = rowFor("evaluates_the_thing_in_hand").claim;
  assert.ok(result.lines.includes(`${VIOLATION}:这泥巴比水泥还黏靴子:evaluates_the_thing_in_hand:${missing}`));
  assert.ok(
    result.lines.includes(
      `${VIOLATION}:震得我手腕生疼:complains_about_a_tool:${rowFor("complains_about_a_tool").claim}`,
    ),
  );
  // The second finding shape is reachable on real history too, so it is not a branch that only a fixture can enter.
  assert.ok(result.lines.some((line) => line.startsWith("behaviour_claim_unmatched:comforts_with_her_own_scar:")));
});

test("the default run prints a self-verification report whose population is the example turns", () => {
  // `gates/meta/check-harness-conformance.mjs` reads a gate by running it, and `tools/lib/assert-non-vacuous.mjs` reads
  // `examined` before it reads `passed`: a report whose population is zero without a reason is a gate that measured
  // nothing. Both facts are asserted here rather than assumed from the printed lines.
  const result = runGate(REPOSITORY_ROOT);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.lines.at(-1));
  assert.equal(report.gate, "persona_example_behaviour_claim/v1");
  assert.equal(report.status, "passed");
  assert.equal(report.examined, result.lines[0].split("examples ")[1].split(" ")[0] * 1);
  assert.ok(report.examined > 0, "a report with no population reads exactly like a gate that measured nothing");
  assert.equal(report.covered, report.examined);
  assert.ok(
    report.checks.every((check) => check.status === "passed"),
    JSON.stringify(report.checks),
  );
  assert.deepEqual(
    report.checks.map((check) => check.id),
    [
      VIOLATION,
      "behaviour_claim_unmatched",
      "behaviour_claim_stale",
      "example_unclassified",
      "behaviour_declaration_invalid",
    ],
  );
});
