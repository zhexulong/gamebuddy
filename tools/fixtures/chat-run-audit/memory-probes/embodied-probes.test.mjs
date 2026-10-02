import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { loadProbeManifest, evaluateProbeReply, probeVerdict } from "../../../run-chat-live-audit.mjs";

const run = promisify(execFile);
const PROBE_DIR = new URL("./", import.meta.url);

/**
 * Every probe fixture must survive the exact bug that already burned this design
 * once. The distractor fixtures originally asked a question whose correct answer
 * DENIES a rumour, so a correct reply contained the forbidden words and scored as
 * `distractor.confused`. A fixture is only trustworthy if a plausible CORRECT reply
 * scores a pass and a plausible WRONG reply does not - both directionally, and
 * against the real scorer rather than a restatement of it.
 *
 * The correct/wrong replies below are authored per fixture: they are what that
 * scenario should and should not produce. If a fixture changes without these being
 * revisited, the test fails rather than silently weakening the probe.
 */
const EXPECTED_REPLIES = Object.freeze({
  "p-embodied-preference": {
    // Recognises the standing rule: leave the strawberries for wine.
    correct: "Those strawberries are for your wine, so we leave them on the vine tomorrow.",
    // Applied the wrong action: cleared them out for sale.
    wrong: "We should gather the strawberries and drop them in the shipping bin.",
  },
  "p-embodied-provenance": {
    // Routes to the right container.
    correct: "That blade is in the blue chest upstairs in the farmhouse.",
    // Sounds confident, routes to the wrong place.
    wrong: "I think you left that blade out in the barn near the hay.",
  },
  "p-supersede-stress": {
    // New fact only - the supersession took effect.
    correct: "These days it is amethyst, no question.",
    // The both-answers fudge: the superseded fact survived into the reply.
    wrong: "Honestly you always liked parsnips, and amethyst is the new one, so both.",
  },
  "p-restart": {
    // Names the player's OWN cat, which only the stored fact carries.
    correct: "That is Sesame, your calico - she is the one who loves grilled saury.",
    // Confused the player's cat with the other cat in the same world.
    wrong: "You mean the innkeeper's ginger cat, the one on the porch.",
  },
  "p-turn-short": {
    // The historical fixture, kept here so the rule is enforced on it too. A correct
    // reply states the real job; its `needle_only` reason (not the code) is what marks
    // recall, because denying the rumour necessarily names the distractor.
    correct: "You were the postman in the town below the hill.",
    wrong: "You spent those years hauling on the mine road, I am sure of it.",
  },
});

async function loadFixture(name) {
  const text = await readFile(new URL(name, PROBE_DIR), "utf8");
  return loadProbeManifest(text);
}

test("every probe fixture scores a correct reply as a pass", async () => {
  for (const [probeId, replies] of Object.entries(EXPECTED_REPLIES)) {
    const manifest = await loadFixture(`${probeId.replace("p-", "")}.json`);
    const probe = manifest.probes[0];
    const step = probe.steps.find((candidate) => candidate.kind === "probe");
    const verdict = probeVerdict({
      gate: { ok: true },
      keywords: evaluateProbeReply({ transcriptText: replies.correct, step }),
      dimension: probe.dimension,
    });
    // Pass looks different per dimension: retention passes as needle.hit (or as
    // needle_only when a correct reply necessarily names the distractor), while
    // supersession has its own frozen code.
    const passing =
      verdict.event === "needle.hit" ||
      verdict.event === "supersede.pass" ||
      (verdict.event === "distractor.confused" && verdict.reason === "needle_only");
    assert.equal(
      passing,
      true,
      `${probeId}: a correct reply scored ${verdict.event}${verdict.reason ? `/${verdict.reason}` : ""} - the fixture's forbidden set contains words a correct reply must use`,
    );
  }
});

test("every probe fixture scores a plausible wrong reply as a failure", async () => {
  for (const [probeId, replies] of Object.entries(EXPECTED_REPLIES)) {
    const manifest = await loadFixture(`${probeId.replace("p-", "")}.json`);
    const probe = manifest.probes[0];
    const step = probe.steps.find((candidate) => candidate.kind === "probe");
    const verdict = probeVerdict({
      gate: { ok: true },
      keywords: evaluateProbeReply({ transcriptText: replies.wrong, step }),
      dimension: probe.dimension,
    });
    assert.notEqual(verdict.event, "needle.hit", `${probeId}: a wrong reply PASSED - the probe cannot detect this failure`);
    if (probeId === "p-supersede-stress") {
      // The both-answers fudge must land on the supersession failure, not on a
      // generic confusion, because criterion 3 is specifically about that.
      assert.equal(verdict.event, "supersede.fail");
      assert.equal(verdict.reason, "old_retained");
    }
  }
});

test("a forbidden keyword is never a word the CORRECT reply must contain", async () => {
  // Mechanically restates the authoring rule: if a forbidden token appears in the
  // correct reply, the fixture is self-defeating no matter how it was reasoned about.
  for (const [probeId, replies] of Object.entries(EXPECTED_REPLIES)) {
    const manifest = await loadFixture(`${probeId.replace("p-", "")}.json`);
    const step = manifest.probes[0].steps.find((candidate) => candidate.kind === "probe");
    const correct = replies.correct.toLowerCase();
    for (const forbidden of step.forbiddenKeywords ?? []) {
      assert.equal(
        correct.includes(forbidden.toLowerCase()),
        false,
        `${probeId}: forbidden keyword ${JSON.stringify(forbidden)} appears in the correct reply`,
      );
    }
  }
});

test("the probe question never echoes a required keyword (the audit's zero-memory-hit finding)", async () => {
  // Found by the memory-loop audit: the embodied-preference question ended with
  // "...the greenhouse strawberries" while "strawberr" is a required keyword, so a
  // reply that merely mentioned the thing being asked about scored a hit WITHOUT
  // remembering anything. A question must not supply the tokens that a correct
  // answer is supposed to contribute from memory.
  for (const [probeId, replies] of Object.entries(EXPECTED_REPLIES)) {
    const manifest = await loadFixture(`${probeId.replace("p-", "")}.json`);
    const step = manifest.probes[0].steps.find((candidate) => candidate.kind === "probe");
    const questionLower = step.text.toLowerCase();
    if (probeId === "p-turn-short") continue; // historical fixture, keyword match is against the reply only
    for (const required of step.requiredKeywords ?? []) {
      assert.equal(
        questionLower.includes(required.toLowerCase()),
        false,
        `${probeId}: required keyword ${JSON.stringify(required)} appears in the probe question - a zero-memory reply can hit`,
      );
    }
  }
});

test("the required keywords are recallable from the seeds at the declared threshold", async () => {
  // The complement of the question-echo rule: the tokens a correct reply must emit
  // have to come from SOMEWHERE the memory system would carry. The precise rule is
  // the fixture being PASSABLE through memory AT ITS OWN THRESHOLD - the number of
  // required keywords present in the seeds must be >= the number needed to pass
  // (ceil(len * minHitRate)). p-turn-short is the instructive case: "mail" is a
  // synonym, not a seed token, but "postman" alone clears ceil(2*0.5)=1, so the
  // fixture is honest at its declared threshold.
  for (const [probeId, replies] of Object.entries(EXPECTED_REPLIES)) {
    const manifest = await loadFixture(`${probeId.replace("p-", "")}.json`);
    const probe = manifest.probes[0];
    const step = probe.steps.find((candidate) => candidate.kind === "probe");
    const seeds = probe.steps.filter((candidate) => candidate.kind === "seed").map((candidate) => candidate.text.toLowerCase());
    const allSeedText = seeds.join(" ");
    const required = step.requiredKeywords ?? [];
    const threshold = Math.ceil(required.length * (step.minHitRate ?? 0.5));
    const presentInSeeds = required.filter((keyword) => allSeedText.includes(keyword.toLowerCase())).length;
    assert.ok(
      presentInSeeds >= threshold,
      `${probeId}: only ${presentInSeeds}/${required.length} required keywords appear in seeds, need ${threshold} at minHitRate ${step.minHitRate} - the fixture cannot pass through memory`,
    );
  }
});

test("the supersede fixture keeps a full hit threshold so a partial answer cannot pass", async () => {
  const manifest = await loadFixture("supersede-stress.json");
  const probe = manifest.probes[0];
  assert.equal(probe.dimension, "supersession");
  const step = probe.steps.find((candidate) => candidate.kind === "probe");
  // One required keyword, so 1.0 is the only threshold that means "stated it".
  assert.equal(step.minHitRate, 1);
  assert.equal(step.requiredKeywords.length, 1);
  const seeds = probe.steps.filter((candidate) => candidate.kind === "seed");
  assert.equal(seeds.length, 2, "supersession needs both the original and the overwrite");
});

test("every fixture on disk is valid, digest-pinned, and has a regenerate check", async () => {
  const names = (await readdir(PROBE_DIR)).filter((name) => name.endsWith(".json"));
  assert.ok(names.length >= 4);
  for (const name of names) {
    const manifest = await loadFixture(name);
    assert.match(manifest.manifestDigest, /^[a-f0-9]{64}$/);
    // The checked-in JSON must be exactly what its generator emits, or the digest
    // describes something other than what the harness will load.
    const generated = await run(process.execPath, [fileURLToPath(new URL(name.replace(/\.json$/, ".manifest.mjs"), PROBE_DIR))], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const regenerated = JSON.parse(generated.stdout);
    assert.equal(regenerated.manifestDigest, manifest.manifestDigest, `${name}: digest drifted from its generator`);
  }
});

test("embodied probes carry a standing directive and an action-shaped question", async () => {
  // The design's whole claim is that these probe ACTION rather than trivia. A fixture
  // whose question never asks what to do would quietly become another trivia test.
  for (const name of ["embodied-preference.json", "embodied-provenance.json"]) {
    const manifest = await loadFixture(name);
    const probe = manifest.probes[0];
    const step = probe.steps.find((candidate) => candidate.kind === "probe");
    assert.equal(probe.seedClass, "explicit", `${name}: an embodied probe needs an explicit directive`);
    assert.match(step.text, /\?/, `${name}: the probe turn must ask something`);
    assert.ok((step.forbiddenKeywords ?? []).length > 0, `${name}: without a forbidden set a wrong ACTION cannot be detected`);
  }
});
