/**
 * The falsifier for `tools/check-code-duplication.mjs`: every verdict seen red once, against jscpd's real report.
 *
 * The pure cases drive `groupClones`/`evaluateGroups` over hand-written pair readings, which is how the rule's
 * boundaries (39 vs 40 tokens, 2 vs 3 sites) and both baseline directions are pinned without a scanner. The
 * end-to-end cases build a throwaway tree, run the installed jscpd binary over it, and read the report the gate
 * itself reads - so the grouping is proved against the tokeniser's own output rather than against a fixture that
 * agrees with my reading of it by construction.
 *
 * red-proof: inject  a fourth copy of the admission body into a tree whose baseline records three ->
 *                    `clone_group_grew:<hash>: now 4 sites at ...`; the three copies with no baseline ->
 *                    `clone_group:...tokens:3sites: Alpha.cs:1, Bravo.cs:1, Charlie.cs:1`; two copies against a
 *                    three-site entry -> `stale_clone_baseline:<hash>`; a tree with no source file -> `blocked`
 *                    `code_duplication_examined_no_files`; a declared `typescript` format with no TypeScript file ->
 *                    `blocked` `format_examined_no_files:typescript`; a config naming another population ->
 *                    `jscpd_config_disagrees:<field>` for path, format, ignore and both thresholds.
 * red-proof: inject  a fourth copy of a baselined group that is written but not staged -> `untracked_not_counted 1` and the
 *                    verdict still `passed`, because the population is the index; `git add` the same file -> the same
 *                    group reads `clone_group_grew:<hash>: now 4 sites ...` and `untracked_not_counted` disappears
 *                    (tools/check-code-duplication.test.mjs)
 * red-proof: inject  a baseline recording 4 sites beside a tree with 3 -> `recordShrinks` lowers the entry to those 3 and
 *                    the next reading has no findings at all; a group that grew -> the payload is the recorded entries
 *                    byte for byte and `clone_group_grew` still fails; an unrecorded group -> no entry is ever added, now
 *                    or on the run after; no baseline file -> `baseline_shrink_refused`.
 * red-proof: inject  a tree whose baseline records one group and whose fourth copy has landed -> the CLI
 *                    `--root <fixture> --write-baseline` prints `baseline_write_refused: 1 group(s) are new or grew`,
 *                    exits 1 and leaves the baseline file byte-identical; with no baseline it prints `baseline_created`,
 *                    and with the fourth copy removed it prints `baseline_written` - so the refusal is a condition on
 *                    the tree, not a refusal to write.
 * red-proof: inject  one recorded group at three runner sites beside one recorded group at three host sites ->
 *                    `debt: 2 groups · 6 sites · of which runners 1 groups / 3 sites`; the same groups unrecorded ->
 *                    `debt: 0 groups · 0 sites …` beside `new 2`; one runner site beside two host sites ->
 *                    `of which runners 1 groups / 1 sites`; a blocked reading -> `debt: not measured · <reason>`.
 * red-proof: inject  three tools files sharing only an import preamble and a const -> `syntax-floor 1 (3 sites) ·
 *                    duplication 0 (0 sites)` and status `passed`; the same three files with one function body copied
 *                    instead -> `duplication 1 (3 sites)` and `clone_group:...tokens:3sites: tools/alpha.mjs:...`,
 *                    status `failed` - the only variable between the two trees is whether the block below the preamble is
 *                    a body, so the split is what decides the verdict.
 * red-proof: inject  a tree whose three copies are committed -> the finding carries `attribution.commit`,
 *                    `attribution.date` and the commit subject beside its `detail`; the same tree with no commit ->
 *                    `unrecorded (no commit holds host/src/a.cs)` and the verdict is unchanged.
 * red-proof: inject  a baseline that records nothing beside three committed copies -> `--record-ceiling` prints
 *                    `ceiling recorded: 1 group(s) · 3 sites · nothing lowered` and one `ceiling:<hash>: last touched
 *                    <commit> <date> <subject> (<file>:<line>)` line, the next run is `passed`, and a fourth copy is
 *                    `clone_group_grew`; the same tree with no baseline -> `ceiling_record_refused: there is no
 *                    tools/duplicate-code-baseline.json`; a fifth copy written into a tracked file and not committed ->
 *                    `ceiling_record_refused:<hash>: host/src/Alpha.cs:<n> sits in a file an uncommitted change has
 *                    moved` and the baseline stays byte-identical.
 * red-proof: inject  a group recorded in the baseline whose text is an import preamble ->
 *                    `syntax_floor_clone_baselined:<hash>`, status `failed`, and `--record-shrinks` deletes that entry
 *                    (`removed 1`) without adding anything.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  baselinePayload,
  baselineWriteRefusal,
  attributionLine,
  censusLine,
  checkCodeDuplication,
  configDisagreements,
  debtLine,
  evaluateGroups,
  FACADE,
  FORMATS,
  facadeLine,
  firstLineOf,
  groupClones,
  groupHash,
  groupKind,
  hasStatementBlock,
  IGNORES,
  isFacadeOnly,
  isRunnerSite,
  MIN_LINES,
  MIN_TOKENS,
  normaliseSitePath,
  readBaseline,
  recordCeiling,
  recordShrinks,
  runJscpd,
  SOURCE_TREES,
  serialiseBaseline,
  STRUCTURAL,
  tokenCountLine,
  untrackedSources,
} from "./check-code-duplication.mjs";
import { RUNNER_FILE, runnerFiles } from "./check-native-local-runner-scaffold.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPO, "tools/check-code-duplication.mjs");
const workspaces = [];

after(() => {
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
});

/** `git` in a fixture tree. The gate's population is the index, so a fixture has to have one. */
const git = (root, args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

/** A throwaway tree: `files` is `{ "host/src/a.cs": "..." }`, and `jscpd.json` declares `trees`/`formats`. */
function workspace(files, { trees = ["host/src"], formats = ["csharp"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-duplication-"));
  workspaces.push(root);
  mkdirSync(join(root, "host/src"), { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  writeFileSync(
    join(root, "jscpd.json"),
    JSON.stringify({ path: trees, format: formats, ignore: IGNORES, minTokens: MIN_TOKENS, minLines: MIN_LINES }),
    "utf8",
  );
  git(root, ["init", "--quiet"]);
  git(root, ["add", "-A"]);
  return { root, trees, formats };
}

/**
 * The eight-step body the real tree repeats under 24 method names: `receiptsByRequestId` -> `revision++` ->
 * `Guid.NewGuid` -> `nowMs` -> `AdmitExecution` -> the handler call -> `RememberTerminal`. Written with a different
 * method name and handler per copy, which is what makes it one group rather than one text.
 */
const pipeline = (name, handler) =>
  [
    `    public LocalExecutionReceipt RequestLocal${name}(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)`,
    "    {",
    "        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;",
    "        this.revision++;",
    '        string executionId = Guid.NewGuid().ToString("N");',
    "        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();",
    "        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection) return this.RememberTerminal(admissionRejection);",
    `        return this.${handler}(requestId, slot, targetX, targetY, expectedTargetId, requestedDeadlineMs);`,
    "    }",
  ].join("\n");

const copies = (names) => Object.fromEntries(names.map((name) => [`host/src/${name}.cs`, pipeline(name, "Execute")]));

/** A second admission body, different enough to be its own group: what an unrecorded `new` family looks like. */
const otherFamily = (name) =>
  [
    `    public LocalExecutionReceipt RequestLocalClaim${name}(string requestId, int slot, int targetX, int targetY)`,
    "    {",
    "        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;",
    "        this.revision++;",
    '        string executionId = Guid.NewGuid().ToString("N");',
    "        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();",
    "        return this.Execute(requestId, slot, targetX, targetY, executionId, nowMs);",
    "    }",
  ].join("\n");

/**
 * The other thing the controllers repeat once the eight-step body is folded behind a seam: one method per action
 * sharing the catalogue's envelope, and the one delegation each of them performs. The parameters are one per line
 * because that is how the real partials wrap them, and the method name differs per copy for the same reason the
 * pipeline does - jscpd normalises it, and the envelope is the same envelope either way.
 */
const envelope = (name) =>
  [
    `    public LocalExecutionReceipt RequestLocal${name}(`,
    "        string requestId,",
    "        int slot,",
    "        int targetX,",
    "        int targetY,",
    "        string expectedTargetId,",
    "        long requestedDeadlineMs)",
    "    {",
    "        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection) return admissionRejection;",
    "    }",
  ].join("\n");

const envelopes = (names) => Object.fromEntries(names.map((name) => [`host/src/${name}.cs`, envelope(name)]));

/** A pair reading in the shape jscpd writes: the same fragment at two sites. */
const pair = ({ fragment, tokens = 50, first, second }) => ({
  fragment,
  tokens,
  firstFile: { name: first, start: 1 },
  secondFile: { name: second, start: 1 },
});

/**
 * A five-line STRUCTURAL fragment: a body, because that is the population the ratchet holds (THE UNIT). It is written as
 * a body rather than as five anonymous lines so every case below measures the rule the gate actually applies - a floor
 * fragment would be counted and never fail, and asserting "no finding" against one would prove nothing.
 */
const FRAGMENT = [
  "function replay(receipt) {",
  "  const terminal = lookup(receipt);",
  "  if (terminal === null) return playback(receipt);",
  "  return terminal;",
  "}",
].join("\n");

const threeCopies = () =>
  groupClones(
    [
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/c.ts" }),
    ],
    REPO,
  );

test("a site named by several pairs is one group, and one site is counted once", () => {
  const groups = threeCopies();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].hash, groupHash(FRAGMENT));
  assert.deepEqual(
    groups[0].sites.map((site) => site.file),
    ["host/src/a.ts", "host/src/b.ts", "host/src/c.ts"],
  );
  assert.equal(groups[0].tokens, 50);
});

test("a site's path is relative to the examined tree, in forward slashes, with no extended-length prefix", () => {
  assert.equal(normaliseSitePath(join(REPO, "host/src/a.ts")), "host/src/a.ts");
  assert.equal(normaliseSitePath("host\\src\\a.ts"), "host/src/a.ts");
  assert.equal(normaliseSitePath(`\\\\?\\${join(REPO, "host\\src\\a.ts")}`), "host/src/a.ts");
});

test("the group's first line is what a reader recognises, trimmed and capped", () => {
  assert.equal(firstLineOf("\n   if (x) {   \nmore"), "if (x) {");
  assert.ok(firstLineOf("x".repeat(400)).length <= 160);
});

test("the rule is tokens AND sites: 39 tokens everywhere and two sites everywhere are both below it", () => {
  const belowTokens = groupClones(
    [
      pair({ fragment: `${FRAGMENT}\ntail`, tokens: MIN_TOKENS - 1, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: `${FRAGMENT}\ntail`, tokens: MIN_TOKENS - 1, first: "host/src/a.ts", second: "host/src/c.ts" }),
    ],
    REPO,
  );
  assert.equal(belowTokens[0].sites.length, 3);
  assert.deepEqual(evaluateGroups({ groups: belowTokens, baseline: { groups: [] } }).findings, []);
  const belowSites = evaluateGroups({
    groups: groupClones([pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" })], REPO),
    baseline: { groups: [] },
  });
  assert.deepEqual(belowSites.findings, []);
  assert.equal(belowSites.counted.length, 0);
});

test("a new group is named with every site and its first line", () => {
  const reading = evaluateGroups({ groups: threeCopies(), baseline: { groups: [] } });
  assert.equal(reading.newGroups, 1);
  assert.equal(reading.findings.length, 1);
  assert.equal(reading.findings[0].code, "clone_group");
  assert.match(
    reading.findings[0].detail,
    /^clone_group:50tokens:3sites: host\/src\/a\.ts:1, host\/src\/b\.ts:1, host\/src\/c\.ts:1 :: function replay\(receipt\) \{$/,
  );
});

test("a baselined group recorded at the same size passes", () => {
  const groups = threeCopies();
  const reading = evaluateGroups({ groups, baseline: baselinePayload(groups) });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.baselined, 1);
});

test("a baselined group that gained a site is red, naming the site that arrived", () => {
  const baseline = baselinePayload(threeCopies());
  const grown = groupClones(
    [
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/c.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/d.ts" }),
    ],
    REPO,
  );
  const reading = evaluateGroups({ groups: grown, baseline });
  assert.equal(reading.grown, 1);
  assert.deepEqual(
    reading.findings.map((entry) => entry.code),
    ["clone_group_grew"],
  );
  assert.match(
    reading.findings[0].detail,
    /^clone_group_grew:[0-9a-f]{12}: now 4 sites at 50 tokens, the baseline recorded 3 sites at 50 tokens: /,
  );
  assert.match(reading.findings[0].detail, /host\/src\/d\.ts:1/);
});

test("a baseline written under another rule and recording fewer tokens is named, not silently trusted", () => {
  const groups = threeCopies();
  const baseline = {
    groups: baselinePayload(groups).groups.map((entry) => ({ ...entry, tokens: entry.tokens - 1 })),
  };
  const reading = evaluateGroups({ groups, baseline });
  assert.deepEqual(reading.findings, []);
  assert.deepEqual(
    reading.tokenCountUnstable.map((entry) => `${entry.hash}:${entry.recorded}->${entry.measured}`),
    [`${groupHash(FRAGMENT)}:49->50`],
  );
});

test("a recorded token count the tree does not reproduce is named, because the fragment is the same bytes", () => {
  // The measurement itself is the defect: `tokens` is the run each PAIR matched inside the fragment, and grouping keeps
  // the maximum, so a group whose text is identical can read 91 in the record and 97 in the tree. On this tree 100 of
  // 2191 fragment groups carry more than one pair count. A monotone ratchet cannot hold a number like that.
  const groups = threeCopies();
  const baseline = {
    groups: baselinePayload(groups).groups.map((entry) => ({ ...entry, tokens: entry.tokens - 6 })),
  };
  const reading = evaluateGroups({ groups, baseline });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.grown, 0);
  assert.deepEqual(reading.tokenCountUnstable, [{ hash: groupHash(FRAGMENT), recorded: 44, measured: 50, sites: 3 }]);
  assert.match(censusLine(reading), / · token_count_unstable 1$/);
  assert.match(
    tokenCountLine(reading.tokenCountUnstable[0]),
    /^ {2}token_count_unstable:[0-9a-f]{12}: 44 -> 50 tokens at 3 sites/,
  );
  assert.deepEqual(baselineWriteRefusal({ reading, creating: false }), []);
});

test("a longer block at the same sites is a new group, so nothing longer can ride an old record", () => {
  // What the token count used to stand guard over, and what the hash already does: more copied text moves the fragment's
  // end line, so it arrives as an unrecorded group beside a stale entry - never as a moved number on the old one.
  const longer = `${FRAGMENT}\nline six\nline seven`;
  const groups = groupClones(
    [
      pair({ fragment: longer, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: longer, first: "host/src/a.ts", second: "host/src/c.ts" }),
    ],
    REPO,
  );
  const reading = evaluateGroups({ groups, baseline: baselinePayload(threeCopies()) });
  assert.deepEqual(reading.findings.map((entry) => entry.code).sort(), ["clone_group", "stale_clone_baseline"]);
  assert.equal(reading.tokenCountUnstable.length, 0);
});

test("a baselined group that lost a site is red as stale, so the baseline can only shrink", () => {
  const four = groupClones(
    [
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/c.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/d.ts" }),
    ],
    REPO,
  );
  const reading = evaluateGroups({ groups: threeCopies(), baseline: baselinePayload(four) });
  assert.equal(reading.stale, 1);
  assert.match(
    reading.findings[0].detail,
    /^stale_clone_baseline:[0-9a-f]{12}: the baseline recorded 4 sites at 50 tokens, the tree now has 3 at 50 tokens/,
  );
});

test("a group that vanished entirely is named by its hash", () => {
  const reading = evaluateGroups({ groups: [], baseline: baselinePayload(threeCopies()) });
  assert.equal(reading.findings[0].code, "stale_clone_baseline");
  assert.match(reading.findings[0].detail, new RegExp(`^stale_clone_baseline:${groupHash(FRAGMENT)}: `));
});

test("a config naming another population is red for every field that disagrees", () => {
  const disagreements = configDisagreements({
    config: { path: ["host/src"], format: ["javascript"], ignore: [], minTokens: 50, minLines: 3 },
  });
  assert.deepEqual(
    disagreements.map((entry) => entry.field),
    ["path", "format", "ignore", "minTokens", "minLines"],
  );
});

test("the repository's own jscpd.json agrees with this gate", () => {
  const config = JSON.parse(readFileSync(join(REPO, "jscpd.json"), "utf8"));
  assert.deepEqual(configDisagreements({ config }), []);
});

test("a first baseline records the tree, and every later write refuses to record a new or grown group", () => {
  const groups = threeCopies();
  const reading = evaluateGroups({ groups, baseline: { groups: [] } });
  assert.deepEqual(baselineWriteRefusal({ reading, creating: true }), []);
  assert.deepEqual(
    baselineWriteRefusal({ reading, creating: false }).map((entry) => entry.code),
    ["clone_group"],
  );
  const shrunk = evaluateGroups({ groups, baseline: baselinePayload(threeCopies()) });
  assert.deepEqual(baselineWriteRefusal({ reading: shrunk, creating: false }), []);
});

test("the baseline serialises one group per line and parses back to the same groups", () => {
  const payload = baselinePayload(threeCopies());
  const text = serialiseBaseline(payload);
  assert.equal(text.trimEnd().split("\n").length, payload.groups.length + 4);
  assert.deepEqual(JSON.parse(text), payload);
});

test("three real copies are one group on jscpd's own report", () => {
  const { root, trees, formats } = workspace(copies(["Alpha", "Bravo", "Charlie"]));
  const reading = checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } });
  assert.equal(reading.status, "failed");
  assert.equal(reading.examined, 3);
  assert.equal(reading.counted.length, 1);
  assert.match(
    reading.findings[0].detail,
    /^clone_group:\d+tokens:3sites: host\/src\/Alpha\.cs:\d+, host\/src\/Bravo\.cs:\d+, host\/src\/Charlie\.cs:\d+ :: /,
  );
  assert.match(reading.findings[0].detail, /RequestLocal|receiptsByRequestId/);
});

test("the same tree passes once its group is baselined, and a fourth copy is red on the same group", () => {
  const { root, trees, formats } = workspace(copies(["Alpha", "Bravo", "Charlie"]));
  const baseline = baselinePayload(checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } }).counted);
  assert.equal(checkCodeDuplication({ root, trees, formats, baseline }).status, "passed");

  writeFileSync(join(root, "host/src/Delta.cs"), pipeline("Delta", "Execute"), "utf8");
  git(root, ["add", "host/src/Delta.cs"]);
  const grown = checkCodeDuplication({ root, trees, formats, baseline });
  assert.equal(grown.status, "failed");
  assert.deepEqual(
    grown.findings.map((entry) => entry.code),
    ["clone_group_grew"],
  );
  assert.match(grown.findings[0].detail, /host\/src\/Delta\.cs:\d+/);
  const groups = groupClones(runJscpd({ root, trees, formats }).report.duplicates, root);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sites.length, 4);
});

test("a fourth copy in the worktree but not in the index is reported, and only counts once staged", () => {
  const { root, trees, formats } = workspace(copies(["Alpha", "Bravo", "Charlie"]));
  const baseline = baselinePayload(checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } }).counted);
  writeFileSync(join(root, "host/src/Delta.cs"), pipeline("Delta", "Execute"), "utf8");

  // The defect this pins: a lane's half-written file used to join a baselined group and redden somebody else's ratchet
  // against a tree no commit contains. It is now outside the population, and the reading says how many files it dropped.
  const untracked = checkCodeDuplication({ root, trees, formats, baseline });
  assert.equal(untracked.status, "passed");
  assert.equal(untracked.untrackedNotCounted, 1);
  assert.match(censusLine(untracked), / · untracked_not_counted 1$/);

  git(root, ["add", "host/src/Delta.cs"]);
  const staged = checkCodeDuplication({ root, trees, formats, baseline });
  assert.equal(staged.status, "failed");
  assert.equal(staged.untrackedNotCounted, 0);
  assert.deepEqual(
    staged.findings.map((entry) => entry.code),
    ["clone_group_grew"],
  );
  assert.match(staged.findings[0].detail, /host\/src\/Delta\.cs:\d+/);
});

test("an index git cannot read is an error, never an empty untracked set", () => {
  const reading = untrackedSources({ root: REPO, spawn: () => ({ status: 128 }) });
  assert.match(reading.error, /^git_index_unreadable:/);
  assert.equal(reading.files, undefined);
});

test("two copies left behind are a stale baseline entry, not a pass", () => {
  const { root, trees, formats } = workspace(copies(["Alpha", "Bravo", "Charlie"]));
  const baseline = baselinePayload(checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } }).counted);
  rmSync(join(root, "host/src/Charlie.cs"));
  const reading = checkCodeDuplication({ root, trees, formats, baseline });
  assert.equal(reading.status, "failed");
  assert.deepEqual(
    reading.findings.map((entry) => entry.code),
    ["stale_clone_baseline"],
  );
});

test("a tree with no source file is blocked rather than green", () => {
  const { root, trees, formats } = workspace({});
  const reading = checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } });
  assert.equal(reading.status, "blocked");
  assert.equal(reading.reason, "code_duplication_examined_no_files");
  assert.equal(reading.examined, 0);
});

test("a declared format the tree has no files for is blocked, naming the format", () => {
  const { root, trees } = workspace(copies(["Alpha", "Bravo", "Charlie"]), { formats: ["csharp", "typescript"] });
  const reading = checkCodeDuplication({ root, trees, formats: ["csharp", "typescript"], baseline: { groups: [] } });
  assert.equal(reading.status, "blocked");
  assert.equal(reading.reason, "format_examined_no_files:typescript");
});
test("the façade reader takes an envelope and its one delegation, and refuses a body with anything in it", () => {
  assert.equal(isFacadeOnly(envelope("CollectBuildingChestOutput")), true);
  assert.equal(isFacadeOnly(envelope("ClearCask")), true);
  assert.equal(isFacadeOnly(pipeline("CollectCrate", "Execute")), false);
});

test("a head whose only statement is one admission guard reads as a façade, inline lookup or seam call alike", () => {
  const head = (guard) =>
    [
      "    public LocalExecutionReceipt RequestLocalWaterCrop(string requestId, long requestedDeadlineMs)",
      "    {",
      guard,
      "            return existing;",
    ].join("\n");
  // The rule cannot tell a guarded lookup from a guarded seam call, and this pins that known release: it is safe
  // because the family the gate exists for is five statements (lookup, revision++, Guid, nowMs, guard), not one.
  const lookup = head(
    "        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))",
  );
  assert.equal(isFacadeOnly(lookup), true);
  assert.equal(
    isFacadeOnly(
      head(
        "        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, out LocalExecutionReceipt? existing))",
      ),
    ),
    true,
  );
  assert.equal(isFacadeOnly(`${lookup}\n        this.revision++;`), false);
});

test("a fragment that opens inside a body is never a façade, whatever it declares", () => {
  assert.equal(
    isFacadeOnly("if (this.AdmitLocalExecution(requestId) is LocalExecutionReceipt refusal) return refusal;"),
    false,
  );
  assert.equal(
    isFacadeOnly(
      [
        '        string executionId = Guid.NewGuid().ToString("N");',
        "        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();",
      ].join("\n"),
    ),
    false,
  );
});

test("a declaration that names a value is a statement, so a repeated object literal stays duplication", () => {
  const literal = (key) =>
    [
      "    {",
      '      status: "running",',
      `      ${key}: value.${key} as string,`,
      "      ...variantFields,",
      "      observation: common.observation,",
    ].join("\n");
  assert.equal(isFacadeOnly(literal("idempotencyKey")), false);
});

test("the façade case: one envelope at three sites passes, is counted, and is named by its hash", () => {
  const { root, trees, formats } = workspace(envelopes(["Alpha", "Bravo", "Charlie"]));
  const reading = checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } });
  assert.equal(reading.status, "passed");
  assert.equal(reading.counted.length, 1);
  assert.equal(reading.duplication.length, 0);
  assert.equal(reading.facade.length, 1);
  assert.deepEqual(reading.findings, []);
  assert.match(
    censusLine(reading),
    /^files examined 3 · clone groups 1 · of which facade-only 1 · syntax-floor 0 \(0 sites\) · duplication 0 \(0 sites\) · new 0 · grown 0 · baselined 0$/,
  );
  assert.match(
    facadeLine(reading.facade[0]),
    /^ {2}facade-only:[0-9a-f]{12}: 3 sites at \d+ tokens :: host\/src\/Alpha\.cs:\d+, host\/src\/Bravo\.cs:\d+, host\/src\/Charlie\.cs:\d+ :: public LocalExecutionReceipt RequestLocal/,
  );
});

test("the real case: a 45-token admission preamble beside the envelope is named as duplication, not façade", () => {
  const mixed = (name) => `${envelope(name)}\n\n${pipeline(name, "Execute")}`;
  const { root, trees, formats } = workspace(
    Object.fromEntries(["Alpha", "Bravo", "Charlie"].map((name) => [`host/src/${name}.cs`, mixed(name)])),
  );
  const reading = checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } });
  assert.equal(reading.status, "failed");
  assert.ok(reading.duplication.length >= 1, "the preamble is duplication");
  assert.ok(reading.facade.length >= 1, "the envelope is still a façade beside it");
  const preamble = reading.duplication.find((group) => group.fragment.includes("receiptsByRequestId.TryGetValue"));
  assert.ok(preamble !== undefined, "the lookup is in the duplication population, not the façade one");
  assert.ok(preamble.tokens >= 45);
  assert.ok(!reading.facade.some((group) => group.hash === preamble.hash));
  assert.match(
    reading.findings.map((entry) => entry.detail).join("\n"),
    /clone_group:\d+tokens:3sites: .*:: (if \(this\.receiptsByRequestId\.TryGetValue|public LocalExecutionReceipt)/,
  );
});

test("a baseline that records a façade group is reclassified, not called stale", () => {
  const { root, trees, formats } = workspace(envelopes(["Alpha", "Bravo", "Charlie"]));
  const facade = checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } }).facade;
  const reading = checkCodeDuplication({ root, trees, formats, baseline: baselinePayload(facade) });
  assert.equal(reading.status, "failed");
  assert.equal(reading.reclassified, 1);
  assert.equal(reading.stale, 0);
  assert.deepEqual(
    reading.findings.map((entry) => entry.code),
    ["facade_only_clone_baselined"],
  );
  assert.match(reading.findings[0].detail, /^facade_only_clone_baselined:[0-9a-f]{12}: the baseline records 3 sites/);
  assert.match(censusLine(reading), /reclassified 1$/);
});

test("--write-baseline records the duplication population, so a façade needs no entry and gets none", () => {
  const mixed = (name) => `${envelope(name)}\n\n${pipeline(name, "Execute")}`;
  const { root, trees, formats } = workspace(
    Object.fromEntries(["Alpha", "Bravo", "Charlie"].map((name) => [`host/src/${name}.cs`, mixed(name)])),
  );
  const reading = checkCodeDuplication({ root, trees, formats, baseline: { groups: [] } });
  const payload = baselinePayload(reading.duplication);
  assert.equal(payload.groups.length, reading.duplication.length);
  assert.ok(payload.groups.every((entry) => reading.duplication.some((group) => group.hash === entry.hash)));
  assert.ok(payload.groups.every((entry) => !reading.facade.some((group) => group.hash === entry.hash)));
});

/** Four sites of one text: the reading a baseline records before a lane removes one of the copies. */
const fourCopies = () =>
  groupClones(
    [
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/c.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/d.ts" }),
    ],
    REPO,
  );

test("--record-shrinks lowers a shrunken entry onto the sites the tree still has", () => {
  const baseline = baselinePayload(fourCopies());
  const reading = evaluateGroups({ groups: threeCopies(), baseline });
  assert.equal(reading.stale, 1);
  const outcome = recordShrinks({ reading, baseline });
  assert.deepEqual(outcome.removed, []);
  assert.deepEqual(outcome.lowered, [groupHash(FRAGMENT)]);
  assert.deepEqual(
    outcome.payload.groups.map((entry) => entry.sites.length),
    [3],
  );
  assert.equal(outcome.payload.groups[0].tokens, 50, "a shrink never moves the recorded token count");
  assert.deepEqual(outcome.after.findings, [], "the recorded shrink leaves nothing to report");
  assert.equal(outcome.after.baselined, 1);
});

test("--record-shrinks leaves a grown group byte-identical, so the growth is never banked", () => {
  const baseline = baselinePayload(threeCopies());
  const reading = evaluateGroups({ groups: fourCopies(), baseline });
  assert.equal(reading.grown, 1);
  const outcome = recordShrinks({ reading, baseline });
  assert.deepEqual(outcome.payload.groups, baseline.groups);
  assert.deepEqual([outcome.removed, outcome.lowered], [[], []]);
  assert.equal(outcome.after.grown, 1);
  assert.match(outcome.after.findings[0].detail, /^clone_group_grew:/);
});

test("--record-shrinks deletes an entry whose group left the tree, and no later run puts it back", () => {
  const baseline = baselinePayload(threeCopies());
  const reading = evaluateGroups({ groups: [], baseline });
  assert.equal(reading.stale, 1);
  const outcome = recordShrinks({ reading, baseline });
  assert.deepEqual(outcome.removed, [groupHash(FRAGMENT)]);
  assert.deepEqual(outcome.payload.groups, []);
  assert.deepEqual(outcome.after.findings, []);
});

test("--record-shrinks adds nothing for a group the baseline does not record, and the run after does not either", () => {
  const groups = threeCopies();
  const audited = { groups: [] };
  const outcome = recordShrinks({ reading: evaluateGroups({ groups, baseline: audited }), baseline: audited });
  assert.deepEqual(outcome.payload.groups, []);
  assert.equal(outcome.after.newGroups, 1);
  const again = recordShrinks({
    reading: evaluateGroups({ groups, baseline: outcome.payload }),
    baseline: outcome.payload,
  });
  assert.deepEqual(again.payload.groups, []);
});

test("--record-shrinks refuses without a baseline to shrink, where --write-baseline may create one", () => {
  const reading = evaluateGroups({ groups: threeCopies(), baseline: null });
  assert.match(
    recordShrinks({ reading, baseline: null }).refused,
    /^baseline_shrink_refused: there is no tools\/duplicate-code-baseline\.json to shrink/,
  );
  const blocked = recordShrinks({ reading: { ...reading, counted: undefined }, baseline: { groups: [] } });
  assert.match(blocked.refused, /^baseline_shrink_refused: the reading is blocked/);
  assert.deepEqual(baselineWriteRefusal({ reading, creating: true }), [], "--write-baseline keeps the first write");
  assert.equal(readBaseline({ root: workspace({}).root }), null, "no file reads as no baseline, not an empty one");
});

test("a real shrink recorded against jscpd's report turns the same tree green, adding nothing", () => {
  const { root, trees, formats } = workspace(copies(["Alpha", "Bravo", "Charlie", "Delta"]));
  const baseline = baselinePayload(checkCodeDuplication({ root, trees, formats, baseline: null }).duplication);
  assert.equal(baseline.groups.length, 1);
  assert.equal(baseline.groups[0].sites.length, 4);

  rmSync(join(root, "host/src/Delta.cs"));
  const shrunk = checkCodeDuplication({ root, trees, formats, baseline });
  assert.deepEqual(
    shrunk.findings.map((entry) => entry.code),
    ["stale_clone_baseline"],
  );
  const outcome = recordShrinks({ reading: shrunk, baseline });
  assert.deepEqual(outcome.lowered, [baseline.groups[0].hash]);
  assert.deepEqual(outcome.removed, []);

  const after = checkCodeDuplication({ root, trees, formats, baseline: outcome.payload });
  assert.equal(after.status, "passed");
  assert.equal(after.stale, 0);
  assert.equal(after.duplication.length, 1);
});

/** A site in the native-local smoke-runner family, spelled as the family's own gate derives it. */
const runnerSite = (name) => `tools/run-stardew-native-local-player-${name}-smoke.mjs`;

/**
 * A second body, so a runner group and a host group are two groups rather than one text: it has to be STRUCTURAL too, or
 * the debt line would be measuring the floor (THE UNIT).
 */
const RUNNER_FRAGMENT = [
  "async function runSmoke(client, receipts) {",
  "  const accepted = await submit(client, receipts);",
  '  if (accepted.state !== "accepted") throw new Error("not_accepted");',
  "  return waitForTerminal(receipts, accepted);",
  "}",
].join("\n");

/** One recorded group at three runner sites: the debt the L1 extraction is retiring. */
const runnerCopies = () =>
  groupClones(
    [
      pair({ fragment: RUNNER_FRAGMENT, first: runnerSite("alpha"), second: runnerSite("bravo") }),
      pair({ fragment: RUNNER_FRAGMENT, first: runnerSite("alpha"), second: runnerSite("charlie") }),
    ],
    REPO,
  );

test("the debt line counts the recorded groups, their sites, and the runner share in one unit", () => {
  const groups = [...runnerCopies(), ...threeCopies()];
  const reading = evaluateGroups({ groups, baseline: baselinePayload(groups) });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.debt.groups, reading.baselined, "the debt population and `baselined` are one number");
  assert.deepEqual(reading.debt, { groups: 2, sites: 6, runnerGroups: 1, runnerSites: 3 });
  assert.equal(debtLine(reading), "debt: 2 groups · 6 sites · of which runners 1 groups / 3 sites");
});

test("debt counts what the baseline records, so an unrecorded tree full of clones has none", () => {
  // The falsifier for reading the line as a verdict: these two groups are real duplication and both are `new`, which is
  // the finding - the debt line says only what the ratchet is already carrying.
  const reading = evaluateGroups({ groups: [...runnerCopies(), ...threeCopies()], baseline: { groups: [] } });
  assert.equal(reading.newGroups, 2);
  assert.equal(debtLine(reading), "debt: 0 groups · 0 sites · of which runners 0 groups / 0 sites");
});

test("a group is runner debt when any of its sites is a runner, and only its runner sites are counted", () => {
  const shared = groupClones(
    [
      pair({ fragment: FRAGMENT, first: runnerSite("delta"), second: "host/src/a.ts" }),
      pair({ fragment: FRAGMENT, first: runnerSite("delta"), second: "host/src/b.ts" }),
    ],
    REPO,
  );
  const mixed = evaluateGroups({ groups: shared, baseline: baselinePayload(shared) });
  assert.equal(debtLine(mixed), "debt: 1 groups · 3 sites · of which runners 1 groups / 1 sites");
  const hostOnly = evaluateGroups({ groups: threeCopies(), baseline: baselinePayload(threeCopies()) });
  assert.equal(debtLine(hostOnly), "debt: 1 groups · 3 sites · of which runners 0 groups / 0 sites");
});

test("a blocked reading has no debt to report, and says so instead of printing zero", () => {
  assert.equal(
    debtLine({ status: "blocked", reason: "code_duplication_examined_no_files" }),
    "debt: not measured · code_duplication_examined_no_files",
  );
});

test("the runner predicate is the family's own population, and the template is not in it", () => {
  // Derived, not remembered: every file the scaffold gate scans is attributed here, and the module the migration extracts
  // INTO is not a runner - so a runner added or renamed tomorrow needs no edit in this gate.
  const runners = runnerFiles({ root: REPO });
  assert.ok(runners.length > 100, `the family has members: ${runners.length}`);
  assert.ok(
    runners.every((file) => isRunnerSite(file)),
    "every runner `check-native-local-runner-scaffold.mjs` scans is attributed by this gate",
  );
  for (const file of runners) assert.ok(RUNNER_FILE.test(basename(file)), `${file} is a runner by the family's rule`);
  assert.equal(isRunnerSite("tools/lib/native-local-runner-primitives.mjs"), false);
  assert.equal(isRunnerSite("host/src/run-stardew-native-local-player-x-smoke.mjs"), false);
  assert.equal(isRunnerSite("tools/check-code-duplication.mjs"), false);
});

/**
 * A throwaway tree shaped like this repository: every declared source tree exists (jscpd fails on a path that is not
 * there), and each tokenised format has one file of its own, because the CLI reads the real `SOURCE_TREES`/`FORMATS` and a
 * format with no file is a blocked reading rather than a small one. They are twelve lines because jscpd does not count a
 * shorter file as a source at all, and they share no shape with each other or with the families under test.
 */
const repoShaped = (files) =>
  workspace(
    {
      ...files,
      "host/src/anchor.ts": [
        "interface AnchorShape {",
        "  width: number;",
        "  label: string;",
        "}",
        "",
        "export function anchorWidth(shape: AnchorShape): number {",
        "  const doubled = shape.width * 2;",
        "  const labelled = shape.label.trim();",
        "  if (labelled.length === 0) return doubled;",
        "  const weight = labelled.length > 3 ? 3 : 1;",
        "  return doubled + weight;",
        "}",
        "",
      ].join("\n"),
      "tools/anchor.mjs": [
        "const anchorLevels = new Map();",
        "export function recordAnchor(name, value) {",
        "  const previous = anchorLevels.get(name);",
        "  if (previous !== undefined) return previous;",
        "  const next = Math.max(0, Number(value));",
        "  anchorLevels.set(name, next);",
        "  for (const key of anchorLevels.keys())",
        "    if (key.startsWith('_')) anchorLevels.delete(key);",
        "  return anchorLevels.get(name);",
        "}",
        "export const anchorNames = () => [...anchorLevels.keys()].sort();",
        "export default anchorLevels;",
        "",
      ].join("\n"),
      "integrations/stardew/anchor.md": "# anchor\n",
      "host/scripts/anchor.md": "# anchor\n",
      "dialogue-web/src/anchor.md": "# anchor\n",
      "packages/anchor.md": "# anchor\n",
      "desktop/anchor.md": "# anchor\n",
    },
    { trees: SOURCE_TREES, formats: FORMATS },
  );

/** The gate's own CLI over a throwaway tree - the door `--root` exists for. */
const cli = (root, ...args) =>
  spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8", timeout: 300_000 });

/**
 * Everything staged, then committed. Attribution reads `git log`, and `--record-ceiling` banks only debt a commit holds,
 * so a fixture that wants either has to have a commit - with an identity given on the command line, because a throwaway
 * tree has no configuration of its own.
 */
const commitAll = (root, message = "fixture: the tree the gate reads") =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=gate@example.invalid",
      "-c",
      "user.name=gate",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      message,
    ],
    { cwd: root, stdio: "ignore" },
  );

const baselineFileOf = (root) => join(root, "tools/duplicate-code-baseline.json");

test("--write-baseline refuses a grown group and leaves the baseline byte-identical", () => {
  const { root } = repoShaped(copies(["Alpha", "Bravo", "Charlie"]));

  const created = cli(root, "--write-baseline");
  assert.equal(created.status, 0, created.stdout);
  assert.match(created.stdout, /baseline_created: 1 group\(s\) -> tools\/duplicate-code-baseline\.json/);
  const recorded = readFileSync(baselineFileOf(root), "utf8");

  const green = cli(root);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /^debt: 1 groups · 3 sites · of which runners 0 groups \/ 0 sites$/m);

  // A fourth copy lands and is staged, so it is inside the population the gate measures.
  writeFileSync(join(root, "host/src/Delta.cs"), pipeline("Delta", "Execute"), "utf8");
  git(root, ["add", "host/src/Delta.cs"]);
  const grew = cli(root);
  assert.equal(grew.status, 1, grew.stdout);
  assert.match(grew.stdout, /clone_group_grew:[0-9a-f]{12}: now 4 sites at \d+ tokens, the baseline recorded 3 sites/);

  // The claim this refutes: that `--write-baseline` is how new duplication gets packed into the record.
  const refused = cli(root, "--write-baseline");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(
    refused.stdout,
    /baseline_write_refused: 1 group\(s\) are new or grew - the baseline may only record a shrink/,
  );
  assert.equal(
    readFileSync(baselineFileOf(root), "utf8"),
    recorded,
    "a refused write leaves the baseline byte-identical",
  );

  // The other direction: the refusal is a condition on the tree, not a refusal to write. With the fifth copy gone the same
  // file records again - and records the same tree, so the write is not drifting the record either.
  rmSync(join(root, "host/src/Delta.cs"));
  git(root, ["rm", "-q", "--cached", "host/src/Delta.cs"]);
  const written = cli(root, "--write-baseline");
  assert.equal(written.status, 0, written.stdout);
  assert.match(written.stdout, /baseline_written: 1 group\(s\)/);
  assert.equal(readFileSync(baselineFileOf(root), "utf8"), recorded, "the written tree is the tree already recorded");
});

test("--write-baseline still refuses an unrecorded group, and still creates the first baseline", () => {
  const { root } = repoShaped(copies(["Alpha", "Bravo", "Charlie"]));
  const noBaseline = cli(root);
  assert.equal(noBaseline.status, 1, noBaseline.stdout);
  assert.match(noBaseline.stdout, /^debt: 0 groups · 0 sites · of which runners 0 groups \/ 0 sites$/m);
  assert.match(noBaseline.stdout, /clone_group:\d+tokens:3sites: host\/src\/Alpha\.cs:\d+/);

  assert.equal(existsSync(baselineFileOf(root)), false, "a read run writes nothing");
  const created = cli(root, "--write-baseline");
  assert.equal(created.status, 0, created.stdout);
  assert.match(created.stdout, /baseline_created: 1 group\(s\)/);
  assert.equal(existsSync(baselineFileOf(root)), true);

  // A family the record has never seen is `new`, and `new` is refused however large the count is.
  const recorded = readFileSync(baselineFileOf(root), "utf8");
  for (const name of ["Echo", "Foxtrot", "Golf"])
    writeFileSync(join(root, `host/src/${name}.cs`), otherFamily(name), "utf8");
  git(root, ["add", "host/src"]);
  const refused = cli(root, "--write-baseline");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /baseline_write_refused: [1-9]\d* group\(s\) are new or grew/);
  assert.equal(readFileSync(baselineFileOf(root), "utf8"), recorded, "an unrecorded group is never banked");
});

test("the debt site count moves by the copies that moved, which is the unit it claims to be", () => {
  // Four recorded sites, then one copy deleted: the number falls by ONE, and the record is stale until the shrink is
  // recorded - so a reader subtracting what they removed can tell the shrink apart from a token count that drifted.
  const four = groupClones(
    [
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/c.ts" }),
      pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/d.ts" }),
    ],
    REPO,
  );
  const baseline = baselinePayload(four);
  const before = evaluateGroups({ groups: four, baseline });
  assert.equal(before.debt.sites, 4);
  const after = evaluateGroups({ groups: threeCopies(), baseline });
  assert.equal(after.debt.sites, 3);
  assert.equal(after.stale, 1, "the record still says four sites, so the shrink has to be recorded");

  // One copy further and the group is below the rule: it leaves the population and takes all three sites with it.
  const twoCopies = groupClones([pair({ fragment: FRAGMENT, first: "host/src/a.ts", second: "host/src/b.ts" })], REPO);
  const gone = evaluateGroups({ groups: twoCopies, baseline });
  assert.deepEqual(gone.debt, { groups: 0, sites: 0, runnerGroups: 0, runnerSites: 0 });
  assert.equal(debtLine(gone), "debt: 0 groups · 0 sites · of which runners 0 groups / 0 sites");
});

/**
 * THE UNIT, as one table: the same scanner reads every one of these, and the only question that separates a finding from
 * a census count is whether the matched text contains a block of statements (THE UNIT, in the gate's header). Each row is
 * a shape that exists in this tree today - the import preamble `clone_group_grew` was raised about, the runner's terminal
 * members, the C# parameter list, the truncated window jscpd hands over when a match ends mid-body.
 */
const FLOOR_SHAPES = {
  "an import preamble and the two consts beside it": [
    'import path from "node:path";',
    'import process from "node:process";',
    'import { fileURLToPath } from "node:url";',
    'const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    'const gate = "stardew_open_ground_claims/v1";',
  ].join("\n"),
  "brace and paren closers, which are the end of somebody else's body": ["});", "}", ");"].join("\n"),
  "one error-shaping statement":
    'throw new Error(`break_container_source_evidence_${key}:${evidence[key] ?? "missing"}`);',
  "a type literal whose members are separated by semicolons":
    "input: Readonly<{ messageId: string; targetIndex?: number }>,",
  "a literal's members, so `evidence,` and its neighbours": [
    "evidence,",
    "receipt: summarizeReceipt(terminal),",
    "trace,",
  ].join("\n"),
  "a brace inside a message, which is not a block": ['const message = "{ not a block; }";', "const count = 1;"].join(
    "\n",
  ),
};

const STRUCTURAL_SHAPES = {
  "a function body": [
    "function replay(receipt) {",
    "  const terminal = lookup(receipt);",
    "  return terminal;",
    "}",
  ].join("\n"),
  "a body the window cuts off before its closing brace": [
    "function parseEvidence(evidence) {",
    '  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";',
    "  const result = {};",
    '  for (const field of detail.split(";")) {',
    '    const separator = field.indexOf("=");',
  ].join("\n"),
  "a C# constructor body": [
    "public FarmingActionHandler(ExecutionManager executions)",
    "{",
    "    this.executions = executions;",
    "}",
  ].join("\n"),
  "a handler that shapes a terminal in its catch": [
    "  } catch (error) {",
    "    return {",
    '      state: "blocked",',
    "      trace,",
    "    };",
    "  }",
  ].join("\n"),
};

test("the floor is counted and never a finding: every shape the language forces on a file of that kind", () => {
  for (const [name, fragment] of Object.entries(FLOOR_SHAPES))
    assert.notEqual(groupKind(fragment), STRUCTURAL, `${name} is not structural`);
  for (const [name, fragment] of Object.entries(FLOOR_SHAPES))
    assert.equal(hasStatementBlock(fragment), false, `${name}: no block of statements`);
});

test("a body is structural: a function, a constructor, a handler's catch, and a window cut off mid-body", () => {
  for (const [name, fragment] of Object.entries(STRUCTURAL_SHAPES))
    assert.equal(groupKind(fragment), STRUCTURAL, `${name} is a block of statements`);
});

test("a declaration envelope is a façade before it is the floor, because that rule still wins", () => {
  // The precedence is the rule's own history (FACADE, in the gate's header): the catalogue envelope exists to be released,
  // and a parameter list with no body in it is that envelope's text. Neither bucket decides a verdict; the census says
  // which one the split put it in, and this pins which.
  assert.equal(groupKind(["(int X, int Y) actor,", "(int X, int Y) target,", "int slot,"].join("\n")), FACADE);
  assert.equal(
    groupKind(
      [
        "    public LocalExecutionReceipt RequestLocalClaimMuseumReward(",
        "        string requestId,",
        "        int slot)",
      ].join("\n"),
    ),
    FACADE,
  );
});

test("a floor group is counted in the census and passes, and the same three files with a body copied are red", () => {
  // The falsifier for the unit, on jscpd's own report: the SAME three files, differing only in whether the block below the
  // shared preamble is copied. Nothing about the preamble changes, so the only variable is the body.
  const preamble = [
    'import path from "node:path";',
    'import process from "node:process";',
    'import { readFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
    'export const READING_KIND = "syntax_floor_fixture/v1";',
    "",
  ].join("\n");
  const ownBody = (name, number) =>
    [
      `export function ${name}Reading(input) {`,
      `  const scaled = input * ${number};`,
      `  const labelled = "${name}" + String(scaled);`,
      "  return labelled;",
      "}",
      "",
    ].join("\n");
  const sharedBody = [
    "export function sharedReading(input) {",
    "  const scaled = input * 7;",
    '  const labelled = "shared" + String(scaled);',
    "  return labelled;",
    "}",
    "",
  ].join("\n");
  const files = (body) => ({
    "tools/alpha.mjs": preamble + body("alpha", 3),
    "tools/bravo.mjs": preamble + body("bravo", 5),
    "tools/charlie.mjs": preamble + body("charlie", 9),
    // One C# file, because `csharp` is a declared format and a format with no file is a BLOCKED reading rather than none.
    "integrations/stardew/anchor.cs": [
      "internal static class AnchorReading",
      "{",
      "    internal static int Level(string name)",
      "    {",
      "        int parsed = int.TryParse(name, out int value) ? value : 0;",
      "        return Math.Max(0, parsed);",
      "    }",
      "}",
      "",
    ].join("\n"),
  });

  const floor = repoShaped(files(ownBody));
  const floorReading = checkCodeDuplication({
    root: floor.root,
    trees: floor.trees,
    formats: floor.formats,
    baseline: null,
  });
  assert.equal(floorReading.status, "passed", censusLine(floorReading));
  assert.equal(floorReading.syntaxFloor.length, 1);
  assert.equal(floorReading.duplication.length, 0);
  assert.match(
    censusLine(floorReading),
    /· syntax-floor 1 \(3 sites\) · duplication 0 \(0 sites\) · new 0 · grown 0 · baselined 0$/,
  );

  const structural = repoShaped(files(() => sharedBody));
  const structuralReading = checkCodeDuplication({
    root: structural.root,
    trees: structural.trees,
    formats: structural.formats,
    baseline: null,
  });
  assert.equal(structuralReading.status, "failed", censusLine(structuralReading));
  assert.equal(structuralReading.duplication.length, 1, censusLine(structuralReading));
  assert.match(
    structuralReading.findings[0].detail,
    /^clone_group:\d+tokens:3sites: tools\/alpha\.mjs:\d+, tools\/bravo\.mjs:\d+, tools\/charlie\.mjs:\d+ :: /,
  );
});

test("a finding names the commit behind its site, and says unrecorded when no commit holds it", () => {
  // "Predates this lane" is the answer this gate used to accept. It is a commit hash now, and a tree with no commit at
  // all reads `unrecorded` rather than nothing - the two readings a reader has to be able to tell apart.
  const committed = repoShaped(copies(["Alpha", "Bravo", "Charlie"]));
  commitAll(committed.root, "the three copies land");
  const reading = checkCodeDuplication({
    root: committed.root,
    trees: committed.trees,
    formats: committed.formats,
    baseline: null,
  });
  const finding = reading.findings.find((entry) => entry.code === "clone_group");
  assert.ok(finding !== undefined);
  assert.match(finding.attribution.commit, /^[0-9a-f]{7,}$/);
  assert.equal(finding.attribution.subject, "the three copies land");
  assert.match(finding.attribution.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    reading.duplication[0].sites.some((site) => site.file === finding.attribution.site.file),
    "the attributed site is one of the group's own sites",
  );
  assert.match(finding.detail, /^clone_group:/, "the attribution lives beside the rule's reading, not inside it");
  assert.match(
    attributionLine(finding.attribution),
    /^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} the three copies land \(host\/src\//,
  );

  const uncommitted = repoShaped(copies(["Alpha", "Bravo", "Charlie"]));
  const noCommit = checkCodeDuplication({
    root: uncommitted.root,
    trees: uncommitted.trees,
    formats: uncommitted.formats,
    baseline: null,
  });
  assert.equal(noCommit.status, "failed");
  assert.match(
    attributionLine(noCommit.findings.find((entry) => entry.code === "clone_group").attribution),
    /^unrecorded \(no commit holds /,
  );
});

const CEILING_ATTRIBUTION = (hash, file = "host/src/a.ts", line = 1) => [
  hash,
  { hash, commit: "abc1234def", date: "2026-11-15", subject: "the copies land", site: { file, line } },
];

test("--record-ceiling refuses what no commit holds: no baseline, an unrecorded group, a dirty site", () => {
  const reading = evaluateGroups({ groups: threeCopies(), baseline: { groups: [] } });
  const hash = groupHash(FRAGMENT);
  const noBaseline = recordCeiling({ reading, baseline: null });
  assert.match(noBaseline.refused[0], /^ceiling_record_refused: there is no tools\/duplicate-code-baseline\.json/);

  const unrecorded = recordCeiling({
    reading,
    baseline: { groups: [] },
    attribution: new Map(),
    uncommitted: new Set(),
  });
  assert.deepEqual(unrecorded.refused, [`ceiling_record_refused:${hash}: no commit holds its sites - unrecorded`]);

  const dirty = recordCeiling({
    reading,
    baseline: { groups: [] },
    attribution: new Map([CEILING_ATTRIBUTION(hash, "host/src/b.ts", 7)]),
    uncommitted: new Set(["host/src/b.ts"]),
  });
  assert.deepEqual(dirty.refused, [
    `ceiling_record_refused:${hash}: host/src/b.ts:1 sits in a file an uncommitted change has moved, so no commit ` +
      "holds this group yet - commit it, or pay it here",
  ]);
});

test("--record-ceiling adds at the tree's size, keeps every existing entry byte-identical, and never lowers", () => {
  const hash = groupHash(FRAGMENT);
  const kept = baselinePayload([...runnerCopies()]).groups[0];
  const reading = evaluateGroups({ groups: [...threeCopies(), ...runnerCopies()], baseline: { groups: [kept] } });
  const outcome = recordCeiling({
    reading,
    baseline: { groups: [kept] },
    attribution: new Map([CEILING_ATTRIBUTION(hash)]),
    uncommitted: new Set(),
  });
  assert.deepEqual(
    outcome.payload.groups,
    [kept, { hash, tokens: 50, sites: ["host/src/a.ts:1", "host/src/b.ts:1", "host/src/c.ts:1"] }].sort((left, right) =>
      left.hash.localeCompare(right.hash),
    ),
  );
  assert.equal(
    JSON.stringify(outcome.payload.groups.find((entry) => entry.hash === kept.hash)),
    JSON.stringify(kept),
    "an existing entry is kept byte-identical, line numbers and token count included",
  );
  assert.deepEqual(
    outcome.after.findings,
    [],
    `the recorded ceiling is green: ${JSON.stringify(outcome.after.findings)}`,
  );
  assert.equal(outcome.after.stale, 0, "nothing was lowered or deleted");

  // The other direction: a tree that only shrank has nothing to add, and the payload is the record it already had.
  const shrank = evaluateGroups({ groups: threeCopies(), baseline: baselinePayload(threeCopies()) });
  const nothing = recordCeiling({
    reading: shrank,
    baseline: baselinePayload(threeCopies()),
    attribution: new Map(),
    uncommitted: new Set(),
  });
  assert.deepEqual(nothing.added, []);
  assert.deepEqual(nothing.payload.groups, baselinePayload(threeCopies()).groups);
});

test("--record-ceiling banks a committed group with the commit it names, and the ceiling only shrinks from there", () => {
  const tree = repoShaped(copies(["Alpha", "Bravo", "Charlie"]));
  commitAll(tree.root, "the pipeline lands");
  const red = cli(tree.root);
  assert.equal(red.status, 1, red.stdout);

  const noBaseline = cli(tree.root, "--record-ceiling");
  assert.equal(noBaseline.status, 1, noBaseline.stdout);
  assert.match(noBaseline.stdout, /ceiling_record_refused: there is no tools\/duplicate-code-baseline\.json/);

  // What a rule change leaves behind: a record that predates the population it now governs.
  writeFileSync(baselineFileOf(tree.root), '{\n  "groups": []\n}\n');
  const recorded = cli(tree.root, "--record-ceiling");
  assert.equal(recorded.status, 0, recorded.stdout);
  assert.match(recorded.stdout, /ceiling recorded: 1 group\(s\) · 3 sites · nothing lowered/);
  assert.match(
    recorded.stdout,
    / {2}ceiling:[0-9a-f]{12}: last touched [0-9a-f]{7,} \d{4}-\d{2}-\d{2} the pipeline lands \(host\/src\/[A-Za-z]+\.cs:\d+\)/,
  );

  const green = cli(tree.root);
  assert.equal(green.status, 0, green.stdout);
  assert.match(green.stdout, /^debt: 1 groups · 3 sites/m);

  // The ratchet after a ceiling is the ratchet before it: a fourth copy fails.
  writeFileSync(join(tree.root, "host/src/Delta.cs"), pipeline("Delta", "Execute"), "utf8");
  git(tree.root, ["add", "host/src/Delta.cs"]);
  const grew = cli(tree.root);
  assert.equal(grew.status, 1, grew.stdout);
  assert.match(grew.stdout, /clone_group_grew:[0-9a-f]{12}: now 4 sites at \d+ tokens, the baseline recorded 3 sites/);

  // The residual reading, which is how the four sites above are attributed rather than counted.
  const residuals = cli(tree.root, "--residuals");
  assert.match(residuals.stdout, /^residuals: 1 groups · 4 sites · 1 commit\(s\)$/m);
  assert.match(
    residuals.stdout,
    / {2}residual:[0-9a-f]{12}: 4 sites at \d+ tokens · last touched [0-9a-f]{7,} \d{4}-\d{2}-\d{2}/,
  );
});

test("--record-ceiling refuses a group a dirty worktree has moved, and leaves the baseline byte-identical", () => {
  const tree = repoShaped(copies(["Alpha", "Bravo", "Charlie"]));
  commitAll(tree.root, "the pipeline lands");
  writeFileSync(baselineFileOf(tree.root), '{\n  "groups": []\n}\n');
  const recorded = readFileSync(baselineFileOf(tree.root), "utf8");

  // A fifth copy written into a tracked file and never committed: the group now names a site no commit holds as it is.
  writeFileSync(
    join(tree.root, "host/src/Alpha.cs"),
    `${pipeline("Alpha", "Execute")}\n${pipeline("Echo", "Execute")}`,
    "utf8",
  );
  const refused = cli(tree.root, "--record-ceiling");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(
    refused.stdout,
    /ceiling_record_refused:[0-9a-f]{12}: host\/src\/Alpha\.cs:\d+ sits in a file an uncommitted change has moved/,
  );
  assert.equal(readFileSync(baselineFileOf(tree.root), "utf8"), recorded, "a refused ceiling writes nothing");
});

test("a baseline that records the floor is named by its own code, and --record-shrinks deletes it", () => {
  // The record was written under the old unit, which counted the import preamble as debt. Under the split it is not a
  // finding and not a pass either: it is a record of something the gate no longer claims is duplication, and the only
  // honest move is to delete it - which is what `--record-shrinks` does, and what `--write-baseline` may not be used for.
  const fragment = FLOOR_SHAPES["an import preamble and the two consts beside it"];
  const floor = groupClones(
    [
      pair({ fragment, first: "host/src/a.ts", second: "host/src/b.ts" }),
      pair({ fragment, first: "host/src/a.ts", second: "host/src/c.ts" }),
    ],
    REPO,
  );
  const recorded = baselinePayload(floor);
  const reading = evaluateGroups({ groups: floor, baseline: recorded });
  assert.deepEqual(
    reading.findings.map((entry) => entry.code),
    ["syntax_floor_clone_baselined"],
  );
  assert.match(reading.findings[0].detail, /^syntax_floor_clone_baselined:[0-9a-f]{12}: the baseline records 3 sites/);
  assert.equal(reading.floorBaselined, 1);
  assert.match(censusLine(reading), / · syntax_floor_baselined 1$/);

  const outcome = recordShrinks({ reading, baseline: recorded });
  assert.deepEqual(outcome.removed, [groupHash(fragment)]);
  assert.deepEqual(outcome.payload.groups, []);
  assert.deepEqual(outcome.after.findings, []);
});
