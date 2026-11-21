/**
 * The seam gate's falsifier suite: the readers it uses, the population it derives, and the real history its two
 * findings are proved on.
 *
 * The three defects it exists for are not reproducible by writing a fixture of them - two are ABSENCES (a key the
 * launcher did not have, a route arm that was never written), and a fixture that spells the defect only proves the
 * pattern matches itself. So the red proofs read the committed bytes at the revision before each fix and assert the
 * finding the gate would have printed there.
 *
 * red-proof: history On `88e7e6e9^` the gate reports `fact_seam_underived:desktop-composition-ack` for the launcher's
 *   nine-key list against the Host's eleven-key frame; on `25de4e8f` it reports `fact_declared_unproduced:` for the two
 *   create-world codes no host source produced. Both are replayed out of the committed bytes in this suite.
 * red-proof: inject A mirrored vocabulary in a copied tree gains one member the other end does not have ->
 *   `fact_seam_drift:<fact>` names that member.
 *
 * What each proof reads, and why it is enough:
 *   `88e7e6e9^`  the launcher as it shipped, beside the Host file that writes the frame, and NOT the shape file the
 *                fix added - that absence is the defect.
 *   `25de4e8f`   the game contract as it shipped, with no producer file beside it: both refusals were declared, mirrored
 *                and sent by nothing until `51732f40` gave the create route its two arms.
 *   mutation     one member appended to a mirrored client list, in a root holding only the two files that fact lives in.
 *                This is the one shape a fixture can state honestly, because a drift is a DIFFERENCE between two lists.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discriminantUnionAt,
  evaluate,
  SEAMS,
  scanKeySequences,
  scanMirrors,
  scanUnproducedCodes,
  vocabularyAt,
  vocabulariesIn,
  withoutComments,
} from "./check-fact-seams.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPO, "tools", "check-fact-seams.mjs");

/** One throw-away root, removed when the test that made it finishes. */
function temporaryRoot(label) {
  return mkdtempSync(join(tmpdir(), `fact-seams-${label}-`));
}

/** The committed bytes of one file at one revision, or an empty string when this checkout cannot see that revision. */
function committed(revision, file) {
  try {
    return execFileSync("git", ["show", `${revision}:${file}`], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Write one committed file into a root at the same relative path. */
function materialise(root, file, revision) {
  const text = committed(revision, file);
  assert.notEqual(text, null, `${revision}:${file} must be readable from this checkout's history`);
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const findingsOf = (report) => report.findings;

/**
 * A root whose one typebox union declares `reloading`, and - when `sent` - a sibling host file that sends it.
 *
 * The record these two proofs read is PASSED IN rather than taken from `UNPRODUCED`: that ledger is empty, and proving
 * that a record expires must not depend on a real word happening to be unproduced in this tree.
 */
function unproducedWorld(root, { declares, sent }) {
  const declaration = join(root, "host/src/game-browser/attachment-projection.ts");
  mkdirSync(dirname(declaration), { recursive: true });
  writeFileSync(
    declaration,
    declares
      ? 'export const AttachmentStatus = Type.Union([Type.Literal("none"), Type.Literal("pending"), Type.Literal("reloading")]);\n'
      : 'export const AttachmentStatus = Type.Union([Type.Literal("none"), Type.Literal("pending"), Type.Literal("attached")]);\n',
  );
  if (!sent) return;
  writeFileSync(join(root, "host/src/game-browser/attachment-producer.ts"), 'export const RELOADING = "reloading";\n');
}

const RELOADING_RECORD = Object.freeze([
  {
    code: "reloading",
    reason: "the record these two proofs read",
    expires: "produced, or deleted with its declaration",
    owner: "this suite",
  },
]);

test("the readers read the four shapes a vocabulary is written in here", () => {
  const array = withoutComments('const CODES = ["a", "b", "c"];');
  assert.deepEqual(vocabularyAt(array, array.indexOf("[")).members, ["a", "b", "c"]);

  const frozen = withoutComments('const CODES = Object.freeze(["a", "b", "c"]);');
  assert.deepEqual(vocabularyAt(frozen, frozen.indexOf("[")).members, ["a", "b", "c"]);

  // The form every host contract uses: the members are one level deeper than the array, so a reader that only took
  // top-level strings read `Type.Union([Type.Literal ...])` as an empty vocabulary - the shape defect 3 lived in.
  const union = withoutComments('const Code = Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")]);');
  const unionVocabulary = vocabularyAt(union, union.indexOf("Type.Union"));
  assert.deepEqual(unionVocabulary.members, ["a", "b", "c"]);
  assert.equal(unionVocabulary.kind, "typebox-union");

  // The Game fact union: its members are not in the union at all, they are the discriminants of three named arms.
  const discriminated = withoutComments(
    [
      'const OneSchema = strictObject({ fact: Type.Literal("instance"), game: strictObject({}) });',
      'const TwoSchema = strictObject({ fact: Type.Literal("attachment"), game: strictObject({}) });',
      'const ThreeSchema = strictObject({ fact: Type.Literal("selectedWorld"), game: strictObject({}) });',
      "const Facts = Type.Union([OneSchema, TwoSchema, ThreeSchema]);",
    ].join("\n"),
  );
  const discrimination = discriminantUnionAt(discriminated, discriminated.indexOf("Type.Union"));
  assert.deepEqual(discrimination.members, ["instance", "attachment", "selectedWorld"]);
  assert.equal(discrimination.kind, "discriminant-union");
});

test("a list built inside a function is a fixture, not a vocabulary", () => {
  const root = temporaryRoot("module-level");
  try {
    const path = join(root, "host", "src", "shapes.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        'const MODULE_LEVEL = ["a", "b", "c"];',
        "function build() {",
        '  const FIXTURE = ["a", "b", "c"];',
        "  return FIXTURE;",
        "}",
        "",
      ].join("\n"),
    );
    const names = vocabulariesIn(root, "host/src/shapes.ts").map((entry) => entry.name);
    assert.deepEqual(names, ["MODULE_LEVEL"], "the function-local list is bound to one call site and is not a fact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the derived population spans two packages, and the game problem codes are one fact with two ends", () => {
  const { groups } = scanMirrors(REPO);
  assert.ok(groups.length >= 20, `the scan should find the mirrors this tree carries, read ${groups.length}`);

  const codes = groups.find((group) => group.declarations.some((entry) => entry.name === "GAME_PROBLEM_CODES"));
  assert.notEqual(codes, undefined, "the composed game client's problem-code mirror must be in the population");
  assert.deepEqual(
    codes.declarations.map((entry) => `${entry.file}:${entry.name}`).sort(),
    [
      "dialogue-web/src/composed-reference-game-browser-api.ts:GAME_PROBLEM_CODES",
      "host/src/game-browser-contract/index.ts:GameProblemCode",
    ],
    "one fact with two ends: the contract's union, and the browser's copy of it. A third list beside the union is " +
      "the copy that was resolved by deriving it, and a new one would appear here as an unrepaired copy again",
  );

  for (const group of groups) {
    const parties = new Set(group.declarations.map((entry) => entry.file.split("/")[0]));
    assert.ok(parties.size >= 2, `a group inside one package is not a crossing: ${group.declarations[0].name}`);
  }
});

test("a code only a test file mentions is not a code some host source produces", () => {
  // The hole this closes: `game_compatibility_error` was declared, mirrored, produced by nothing - and hidden for as
  // long as it was, because the contract's own test listed it. A third copy certifying the declaration it was copied
  // from is not production evidence, so a `*.test.ts` file is not a producer.
  const root = temporaryRoot("producer");
  try {
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(
      "host/src/shapes.ts",
      'const Codes = Type.Union([Type.Literal("produced"), Type.Literal("test_only"), Type.Literal("sent")]);\n',
    );
    write("host/src/producer.ts", 'export const FIRST = "produced";\nexport const SECOND = "sent";\n');
    write("host/src/shapes.private.test.ts", 'const EXPECTED = ["test_only"];\n');
    assert.deepEqual(
      scanUnproducedCodes(root).unproduced.map((entry) => entry.code),
      ["test_only"],
      "the two codes a host source produces are produced; the one only a test names is not",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the key-list scan joins a reader to the side that writes its frame", () => {
  const sites = scanKeySequences(REPO);
  assert.ok(sites.length >= 50, `the key-list scan should read the tree's validators, read ${sites.length}`);
  const ack = sites.find((site) => site.symbol === "BOOTSTRAP_ACK_KEYS");
  assert.notEqual(ack, undefined, "the composed launcher's acknowledgement list must be in the population");
  assert.equal(ack.schema, "gamebuddy-desktop-host-bootstrap/v1");
  assert.deepEqual(
    ack.keys,
    [],
    "a list derived from the shape file has no members of its own - that is what derived means here",
  );
  assert.ok(
    ack.producers.some((file) => file.endsWith("desktop-runtime-bootstrap.internal.ts")),
    `the writer of the frame must be found among the producers, read ${ack.producers.join(", ")}`,
  );
});

test("the tree carries no unrecorded crossing", async (t) => {
  const report = evaluate(REPO);
  const unrecorded = findingsOf(report).filter(
    (finding) =>
      finding.startsWith("fact_declared_twice:") ||
      finding.startsWith("fact_seam_drift:") ||
      finding.startsWith("fact_seam_underived:") ||
      finding.startsWith("fact_declared_unproduced:") ||
      finding.startsWith("stale_fact_seam:"),
  );
  t.diagnostic(
    `measured: facts ${report.readings.facts} · one authority ${report.readings.derived} · recorded debt ${report.readings.debt} · key crossings ${report.readings.crossings} · unproduced ${report.readings.unproduced} (recorded ${report.readings.unproducedRecorded})`,
  );
  assert.deepEqual(
    unrecorded,
    [],
    "a crossing that is not recorded is the finding this gate exists for: resolve it, or record it in DEBT with its owner",
  );
  assert.ok(
    report.readings.facts > 0 && report.readings.sequences > 0,
    "a green reading over an empty population is not a reading",
  );
});

test("red proof: the acknowledgement key sequence is underived at 88e7e6e9^", () => {
  // The launcher as it shipped read a nine-key list of its own; the writer had gained two more fields in `0b4e9982`;
  // the shape file the fix added (`88e7e6e9`) does not exist at its parent, which is exactly what makes this red.
  const root = temporaryRoot("ack");
  try {
    materialise(root, "tools/desktop-composition-launch.mjs", "88e7e6e9^");
    materialise(root, "host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts", "88e7e6e9^");
    const report = evaluate(root);
    const finding = findingsOf(report).find((entry) =>
      entry.startsWith("fact_seam_underived:desktop-composition acknowledgement keys"),
    );
    assert.notEqual(
      finding,
      undefined,
      `the launcher's own nine-key list must be reported: ${findingsOf(report).join(" | ")}`,
    );
    assert.match(finding, /literal again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("red proof: the two game.create refusals are declared and unproduced at 25de4e8f", () => {
  // `51732f40` gave `gameCreateProblemCode` its two arms. Before it, both codes were declared by the contract, mirrored
  // by the browser and produced by nothing, so the create route answered `state_unavailable`.
  const root = temporaryRoot("codes");
  try {
    materialise(root, "host/src/game-browser-contract/index.ts", "25de4e8f");
    const unproduced = scanUnproducedCodes(root).unproduced.map((entry) => entry.code);
    assert.ok(
      unproduced.includes("stardew_game_create_world_held_by_player"),
      `the world-held refusal must be unproduced there, read ${unproduced.join(", ")}`,
    );
    assert.ok(
      unproduced.includes("stardew_game_create_slot_held_by_earlier_attempt"),
      "the slot-held refusal must be unproduced there too",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("red proof: the same two codes are produced on this tree, and no unrecorded code is unproduced any more", () => {
  const report = evaluate(REPO);
  const unproduced = report.codes.unproduced.map((entry) => entry.code);
  assert.deepEqual(
    unproduced.filter((code) => code.startsWith("stardew_game_create")),
    [],
    "the fix that gave the create route its two arms is what moved these out of the finding",
  );
  assert.deepEqual(
    findingsOf(report).filter((entry) => entry.startsWith("fact_declared_unproduced:")),
    [],
    "a declared code no host source produces is the finding this gate exists for: produce it, delete the word, or record it in UNPRODUCED with its owner and its expiry",
  );
  assert.equal(
    report.readings.unproducedRecorded,
    report.readings.unproduced,
    "every code this tree declares and no host source sends is either recorded in UNPRODUCED with its owner or is the finding this gate exists for: a run where the two counts differ would say this rule holds nothing",
  );
});

test("a recorded unproduced code expires the moment a host source produces it", () => {
  const root = temporaryRoot("unproduced-produced");
  try {
    unproducedWorld(root, { declares: true, sent: true });
    const finding = findingsOf(evaluate(root, RELOADING_RECORD)).find((entry) =>
      entry.startsWith("stale_fact_seam:unproduced code reloading"),
    );
    assert.notEqual(finding, undefined, "a produced code makes its record a lie: it has to be removed");
    assert.match(finding, /produces it now/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded unproduced code expires the moment its declaration stops carrying it", () => {
  const root = temporaryRoot("unproduced-deleted");
  try {
    unproducedWorld(root, { declares: false, sent: false });
    const finding = findingsOf(evaluate(root, RELOADING_RECORD)).find((entry) =>
      entry.startsWith("stale_fact_seam:unproduced code reloading"),
    );
    assert.notEqual(
      finding,
      undefined,
      "a record for a word the declaration no longer carries is the same lie the other way",
    );
    assert.match(finding, /no declaration carries it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutation: one member added to a mirrored list is a drift, not a silent difference", () => {
  const root = temporaryRoot("drift");
  const fixture = "host/src/tavern/preset-sampling.ts";
  const mirrored = "dialogue-web/src/preset-assembly-surface.ts";
  try {
    for (const file of [fixture, mirrored]) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(REPO, file)));
    }
    const before = evaluate(root);
    assert.deepEqual(
      findingsOf(before).filter((entry) => entry.startsWith("fact_seam_drift:")),
      [],
      "the two declarations agree in the copied bytes, so this fact is recorded debt and not a drift",
    );

    // The defect: one side learns a member the other never hears about. It stops being equal, so the population no
    // longer groups it - and a record that consulted only the population would have called this a deletion.
    const path = join(root, mirrored);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "PRESET_NOT_APPLIED_CODES = Object.freeze([",
        'PRESET_NOT_APPLIED_CODES = Object.freeze([\n  "gate_invented_cause",',
      ),
    );
    const after = evaluate(root);
    const drift = findingsOf(after).find((entry) => entry.startsWith("fact_seam_drift:preset not-applied codes"));
    assert.notEqual(drift, undefined, `the added member must be named: ${findingsOf(after).join(" | ")}`);
    assert.match(drift, /gate_invented_cause/);
    assert.match(drift, /preset-assembly-surface\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Every generated pair in the tree, not one fact's: the population comes from the records themselves, so a new
// codegen'd fact is covered the day it lands and a record whose generator stops reading its contract is named.
test("every generated pair resolves to its contract, and an edit at either end is named", () => {
  const generated = SEAMS.filter((record) => record.derives.kind === "generated");
  assert.ok(generated.length > 0, "no generated pair is recorded, so this proof read nothing");
  for (const record of generated) {
    const root = temporaryRoot("generated");
    const copy = (file) => {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(REPO, file)));
      return path;
    };
    /** The findings about this one fact: a root this small leaves every other record's declaration behind. */
    const about = (report) => findingsOf(report).filter((entry) => entry.includes(record.fact));
    const outputs = [record.authority, ...record.readers].map((output) => output.file);
    try {
      for (const file of [record.derives.file, record.derives.generator, ...outputs]) copy(file);
      assert.deepEqual(
        about(evaluate(root)),
        [],
        `${record.fact}: both outputs come from the contract and say so, so this fact is one authority`,
      );

      // One output learns a member the contract never had: the outputs stop agreeing, and the member is named.
      const drifted = join(root, record.readers[0].file);
      writeFileSync(drifted, readFileSync(drifted, "utf8").replace('["', '["gate_invented_member", "'));
      const drift = about(evaluate(root));
      assert.equal(drift.length, 1, `${record.fact}: ${drift.join(" | ")}`);
      assert.ok(drift[0].startsWith(`fact_seam_drift:${record.fact}`), drift[0]);
      assert.match(drift[0], /gate_invented_member/u);

      // The bytes agree again, but the header no longer says what generated it - the file someone started editing.
      copy(record.readers[0].file);
      const header = join(root, record.authority.file);
      writeFileSync(
        header,
        readFileSync(header, "utf8").replace(`--contract ${record.derives.file}`, "--contract (edited by hand)"),
      );
      const underived = about(evaluate(root));
      assert.equal(underived.length, 1, `${record.fact}: ${underived.join(" | ")}`);
      assert.ok(underived[0].startsWith(`fact_seam_underived:${record.fact}`), underived[0]);
      assert.ok(underived[0].includes(record.authority.file), underived[0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("zero population blocks rather than passing", () => {
  const root = temporaryRoot("empty");
  try {
    const run = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 2, `a scan that read nothing must block: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /fact_seams_not_measured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
