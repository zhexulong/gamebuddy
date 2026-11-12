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
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  baselinePayload,
  baselineWriteRefusal,
  censusLine,
  checkCodeDuplication,
  configDisagreements,
  evaluateGroups,
  facadeLine,
  firstLineOf,
  groupClones,
  groupHash,
  IGNORES,
  isFacadeOnly,
  MIN_LINES,
  MIN_TOKENS,
  normaliseSitePath,
  runJscpd,
  serialiseBaseline,
  tokenCountLine,
  untrackedSources,
} from "./check-code-duplication.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const FRAGMENT = "line one\nline two\nline three\nline four\nline five";

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
    /^clone_group:50tokens:3sites: host\/src\/a\.ts:1, host\/src\/b\.ts:1, host\/src\/c\.ts:1 :: line one$/,
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
    /^files examined 3 · clone groups 1 · of which facade-only 1 · duplication 0 · new 0 · grown 0 · baselined 0$/,
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
