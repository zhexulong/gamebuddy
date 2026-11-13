// Falsifier suite for the gate-population agreement gate.
//
// The gate exists because four tools each answered "how many gates are there" differently and nothing compared them
// (129 / 143 / 371 / 211 at HEAD on 2026-11-13). Its assertions are therefore about membership, one member at a time:
// each case injects one member that a consumer reads and another does not, and requires the gate to name it.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agree,
  buildReport,
  readAgreement,
  workflowInvocations,
  invokedGateScripts,
} from "./check-gate-population-agreement.mjs";

const SCRIPTS = { "check:a": "node tools/check-a.mjs", "test:b": "node --test tools/b.test.mjs", build: "tsc" };
const CORPUS = { members: [], notTaken: [], elsewhere: [], packages: [] };

/** One reading with nothing to disagree about; each case changes exactly one member of it. */
const cleanReading = (overrides = {}) => ({
  root: process.cwd(),
  invoked: [],
  scripts: SCRIPTS,
  disk: [],
  census: { records: [], ciGateScripts: ["check:a"] },
  prelive: [],
  corpus: CORPUS,
  registers: [],
  ...overrides,
});

test("a workflow step's script name is read the three ways workflows spell one", () => {
  const parsed = workflowInvocations(
    [
      "      - run: pnpm check:architecture",
      "      - run: pnpm run audit:totality",
      "      - run: bun run --cwd tools test:corpus",
      "      - run: pnpm --filter @gamebuddy/companion-host typecheck",
    ].join("\n"),
  );
  for (const name of ["check:architecture", "audit:totality", "test:corpus", "typecheck"])
    assert.ok(parsed.has(name), `${name} was not read out of the workflow text`);
});

test("only the gate namespace counts: a workflow's build and test steps are not gates", () => {
  assert.deepEqual(invokedGateScripts({ scripts: SCRIPTS, workflowTexts: ["run: pnpm build && pnpm check:a"] }), [
    "check:a",
  ]);
});

test("a falsifier in a consumer's population is named, because a falsifier owes no red proof", () => {
  const { findings } = agree(cleanReading({ prelive: ["tools/check-a.mjs", "tools/check-z.mutation.mjs"] }));
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.id}`),
    ["gate_population_reads_a_falsifier:check-prelive-gate-registry.mjs:tools/check-z.mutation.mjs"],
  );
});

test("a gate file no consumer reads is named", () => {
  const { findings } = agree(
    cleanReading({
      disk: ["tools/check-a.mjs", "tools/audit-ghost.mjs"],
      census: { records: [{ id: "check:a", entryFiles: ["tools/check-a.mjs"] }], ciGateScripts: ["check:a"] },
    }),
  );
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.id}`),
    ["gate_population_unread_file:tools/audit-ghost.mjs"],
  );
});

test("a gate file the index does not carry is published rather than named", () => {
  const { findings } = agree(
    cleanReading({ disk: ["tools/check-untracked.mjs"], untracked: ["tools/check-untracked.mjs"] }),
  );
  assert.deepEqual(findings, [], "a lane's half-written gate is nobody's finding until a commit contains it");
});

test("an invoked gate script that no consumer reads is named", () => {
  const { findings } = agree(cleanReading({ invoked: ["check:a", "audit:nobody-reads-me"] }));
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.id}`),
    ["gate_population_unread_script:audit:nobody-reads-me"],
  );
});

test("an invoked script the corpus reads is accounted for, not named", () => {
  const { findings } = agree(
    cleanReading({ invoked: ["test:b"], corpus: { ...CORPUS, members: [{ name: "test:b" }] } }),
  );
  assert.deepEqual(findings, []);
});

test("a register naming neither a script nor a path on disk is named with its register", () => {
  const { findings } = agree(
    cleanReading({
      root: "tools/does-not-exist",
      registers: [{ register: "gate-red-proof-baseline.json", member: "check:ghost" }],
    }),
  );
  assert.deepEqual(
    findings.map((finding) => `${finding.code}:${finding.id}`),
    ["gate_population_invented_member:gate-red-proof-baseline.json:check:ghost"],
  );
});

test("zero on both halves is blocked, never green", () => {
  const report = buildReport({ counts: { gateScripts: 0, diskFiles: 0, invoked: 0, registers: 0 }, findings: [] });
  assert.equal(report.status, "blocked");
});

test("the real tree agrees: no member is unread, invented, or a falsifier counted as a gate", () => {
  const { findings, counts, coverage } = readAgreement();
  assert.ok(counts.gateScripts > 0 && counts.diskFiles > 0, "a half of the authority measured nothing");
  assert.ok(counts.censusGates >= counts.diskFiles, "the census cannot read fewer gates than the files it enumerates");
  assert.deepEqual(coverage.unreadScripts, []);
  assert.deepEqual(coverage.unreadFiles, []);
  assert.deepEqual(findings, []);
});
