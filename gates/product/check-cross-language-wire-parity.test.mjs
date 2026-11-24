/**
 * The falsifier for `tools/check-cross-language-wire-parity.mjs`.
 *
 * Every case drives the gate over a REAL declaration with one injected fact, because a gate proved only against a
 * synthetic tree proves only that it can read the tree its author imagined. Each case names the failure code it expects,
 * so a case that passes for the wrong reason fails on the message.
 *
 * red-proof: inject  a field added to the real `BridgeBodyProgramNodeStatus`, and `"refusalDetail"` deleted from the
 *   real `isBodyProgramNodeStatus` key list -> `wire_field_unaccepted:program_status_result:<field>:<C# type>`
 * red-proof: inject  the declared-empty row for `destination_index_request` deleted -> `frame_without_fields:` names the
 *   frame and BLOCKS; a `redProofProbe` field added to the real `BridgeDestinationIndexRequest` ->
 *   `stale_wire_exemption:destination_index_request` naming the field; the same field declared on the Host's
 *   `DestinationIndexRequest` -> `wire_field_unknown_to_mod:destination_index_request:redProofProbe`
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import {
  checkCrossLanguageWireParity,
  DECLARED_EMPTY_FRAMES,
  EXIT,
  extractNamingPolicy,
  formatWireParity,
  HOST_FACTS_PATH,
  HOST_PROTOCOL_PATH,
  hostFrameArms,
  MOD_DISPATCH_PATH,
  MOD_PROGRAM_MODELS_PATH,
  MOD_PROTOCOL_DIRECTORY,
  MOD_SESSION_PATH,
  MOD_SOURCE_ROOT,
  MODELS_DIRECTORY,
  modRecords,
  UNPAIRED_FRAME_EXEMPTIONS,
  wireNameOf,
} from "./check-cross-language-wire-parity.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);
const GATE = join(REPOSITORY_ROOT, "gates/product/check-cross-language-wire-parity.mjs");

const MODELS_FILE = `${MODELS_DIRECTORY}/BridgeProtocolModels.cs`;
const PROTOCOL_FILE = `${MOD_PROTOCOL_DIRECTORY}/BridgeProtocol.cs`;
const SESSION_FILE = MOD_SESSION_PATH;

const real = (relativePath) => readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");
const realHostProtocol = () => real(HOST_PROTOCOL_PATH);

/** Every `.cs` declaration the gate reads, relative to the repository root - the population an injection has to empty. */
function treeFiles(relative = MOD_SOURCE_ROOT) {
  const files = [];
  for (const entry of readdirSync(join(REPOSITORY_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === "bin" || entry.name === "obj") continue;
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...treeFiles(path));
    else if (entry.name.endsWith(".cs")) files.push(path);
  }
  return files;
}

/** One injected parameter at the head of a C# record's parameter list: `record X(string? Field = null, ...)`. */
function withRecordField(source, record, parameter) {
  const anchor = `public sealed record ${record}(`;
  assert.ok(source.includes(anchor), `the injection anchor ${anchor} must exist in the tree it is injected into`);
  return source.replace(anchor, `${anchor}\n    ${parameter},`);
}

const codes = (report) => report.violations.map((violation) => violation.code);

test("the shipped tree is read, not blocked, and the numbers are printed", () => {
  const report = checkCrossLanguageWireParity();
  assert.notEqual(report.status, "blocked", `the gate must read this tree: ${report.reason}`);
  // The three zeroes are distinguished: a read population, not an empty one that agrees with itself.
  assert.ok(report.frames.examined >= 30, `every Host frame must be counted (examined ${report.frames.examined})`);
  assert.ok(report.frames.paired >= 20, `the Mod's own framing calls must pair (paired ${report.frames.paired})`);
  assert.ok(
    report.fields.examined >= 100,
    `the paired payloads must carry fields (examined ${report.fields.examined})`,
  );
  const line = formatWireParity(report)[0] ?? "";
  assert.match(
    line,
    /^frames examined \d+ · paired \d+ · empty declared \d+ · measured here \d+ · owned elsewhere \d+ · exempt \d+ · unmeasured \d+$/u,
    `the run must print its frame population on one line: ${line}`,
  );
  assert.match(
    formatWireParity(report)[1] ?? "",
    /^fields examined \d+ · accepted \d+ · unaccepted \d+ · exempt \d+$/u,
    "the run must print its field population on the next line",
  );
  // The population this run claims has to be the one it read: every frame is paired, owned by another gate, or exempt.
  assert.equal(report.frames.unpaired.length, 0, `no frame may be silently unmeasured: ${report.reason}`);
  assert.equal(report.frames.exempt, 1, "exactly one frame is exempt today, and it is printed with its owner");
  // The empty payloads are DECLARED, not silent: each row is printed with the owner who owes the decision, and the count
  // on the population line is the number of rows this run re-proved.
  assert.deepEqual(
    report.frames.emptyDeclared.map((entry) => entry.frame),
    DECLARED_EMPTY_FRAMES.map((entry) => entry.frame),
    `every declared-empty frame must be re-proved on this tree: ${JSON.stringify(report.frames.emptyDeclared)}`,
  );
  for (const entry of DECLARED_EMPTY_FRAMES)
    assert.ok(
      formatWireParity(report).some((printed) => printed.startsWith(`  empty declared ${entry.frame} (`)),
      `the run must name the empty frame and its payload: ${entry.frame}`,
    );
  assert.match(
    line,
    new RegExp(`· empty declared ${DECLARED_EMPTY_FRAMES.length} ·`, "u"),
    `the population line must count the rows it re-proved: ${line}`,
  );
});

test("the naming policy is read from the serialiser and printed, not assumed", () => {
  const naming = extractNamingPolicy(real(PROTOCOL_FILE));
  assert.ok(naming !== null, "BridgeProtocol.JsonOptions must declare a naming policy");
  assert.equal(naming.policy, "CamelCase");
  assert.match(naming.where, /integrations\/stardew\/src\/Core\/Protocol\/BridgeProtocol\.cs:\d+$/u);
  // `.NET`'s rule is not "lowercase the first letter": the leading run of capitals comes down together.
  assert.equal(wireNameOf("DeduplicationKey", "CamelCase"), "deduplicationKey");
  assert.equal(wireNameOf("NPCName", "CamelCase"), "npcName");
  assert.equal(wireNameOf("X", "CamelCase"), "x");
});

test("a field the Mod adds to a payload the Host does not accept is named with its frame and C# type", () => {
  const report = checkCrossLanguageWireParity({
    overrides: {
      [MODELS_FILE]: withRecordField(real(MODELS_FILE), "BridgeBodyProgramNodeStatus", "string? RedProofProbe = null"),
    },
  });
  assert.equal(report.status, "failed");
  assert.ok(
    codes(report).includes("wire_field_unaccepted:program_status_result:redProofProbe:BridgeBodyProgramNodeStatus"),
    `the crossing must be named:\n${codes(report).join("\n")}`,
  );
});

test("a field the Mod adds one record down the payload is named too", () => {
  const report = checkCrossLanguageWireParity({
    overrides: { [MODELS_FILE]: withRecordField(real(MODELS_FILE), "BridgeWorldFact", "string? RedProofProbe = null") },
  });
  assert.ok(
    codes(report).includes("wire_field_unaccepted:world_fact:redProofProbe:BridgeWorldFact"),
    `the crossing must be named:\n${codes(report).join("\n")}`,
  );
});

test("the field the incident carried is named when the Host's own key list loses it", () => {
  // The field-level sibling of `tools/check-refusal-detail-state-parity.mjs`: `refusalDetail` rides the
  // `program_status_result` frame, and the frame is refused the moment the Host's optional-key list stops naming it.
  const protocol = realHostProtocol().replace('        "refusalDetail",\n', "");
  assert.notEqual(
    protocol,
    realHostProtocol(),
    "the injection must remove the key it names from isBodyProgramNodeStatus",
  );
  const report = checkCrossLanguageWireParity({ overrides: { [HOST_PROTOCOL_PATH]: protocol } });
  assert.ok(
    codes(report).includes("wire_field_unaccepted:program_status_result:refusalDetail:BridgeBodyProgramNodeStatus"),
    `the refused field must be named:\n${codes(report).join("\n")}`,
  );
});

test("a field the Host writes and the Mod's decoder does not declare is named in the other direction", () => {
  const protocol = realHostProtocol().replace(
    "export type ExecutionRequest = Readonly<{\n",
    "export type ExecutionRequest = Readonly<{\n  redProofProbe?: string;\n",
  );
  assert.notEqual(protocol, realHostProtocol(), "the injection must change the Host declaration");
  const report = checkCrossLanguageWireParity({
    overrides: { [HOST_PROTOCOL_PATH]: protocol },
  });
  assert.ok(
    codes(report).includes("wire_field_unknown_to_mod:execution_request:redProofProbe"),
    `the Host-written key must be named:\n${codes(report).join("\n")}`,
  );
});

test("an exemption downgrades a crossing, and an exemption whose field is gone goes red", () => {
  const drifting = (exemptions) =>
    checkCrossLanguageWireParity({
      overrides: {
        [MODELS_FILE]: withRecordField(real(MODELS_FILE), "BridgeWorldFact", "string? RedProofProbe = null"),
      },
      exemptions,
    });

  const exempt = drifting([
    {
      key: "world_fact:redProofProbe:BridgeWorldFact",
      reason: "probe field, injected by the falsifier",
      owner: "gates/product/check-cross-language-wire-parity.test.mjs",
    },
  ]);
  assert.deepEqual(codes(exempt), [], `an exempted crossing must not fail the run: ${codes(exempt).join("\n")}`);
  assert.equal(exempt.fields.exempt, 1, "the exemption must be counted, not silently accepted");
  assert.equal(exempt.status, "passed");

  const stale = checkCrossLanguageWireParity({
    exemptions: [{ key: "world_fact:noSuchField:BridgeWorldFact", reason: "gone", owner: "this falsifier" }],
  });
  assert.ok(
    codes(stale).includes("stale_wire_exemption:world_fact:noSuchField:BridgeWorldFact"),
    `an exemption for a field that does not drift must be red:\n${codes(stale).join("\n")}`,
  );
});

test("an exemption without a reason and an owner is refused", () => {
  const report = checkCrossLanguageWireParity({
    exemptions: [{ key: "world_fact:redProofProbe:BridgeWorldFact", reason: "  ", owner: "" }],
  });
  assert.ok(
    codes(report).includes("exemption_without_owner:world_fact:redProofProbe:BridgeWorldFact"),
    `a silent exemption is the thing exemptions exist against:\n${codes(report).join("\n")}`,
  );
});

test("an unreadable declaration is blocked, never green", () => {
  const blocked = (overrides, expected) => {
    const report = checkCrossLanguageWireParity({ overrides });
    assert.equal(report.status, "blocked", `expected blocked, got ${report.status}`);
    assert.equal(report.fields.examined, 0, "a blocked run examined nothing, and says so");
    assert.match(report.reason, expected, `the block must name what it could not read: ${report.reason}`);
    assert.equal(EXIT.blocked, 2);
    return report;
  };

  blocked({ [PROTOCOL_FILE]: "// the Mod's serialiser was not found\n" }, /JsonNamingPolicy/u);
  blocked(
    { [PROTOCOL_FILE]: real(PROTOCOL_FILE).replace("JsonNamingPolicy.CamelCase", "JsonNamingPolicy.SnakeCaseLower") },
    /SnakeCaseLower/u,
  );
  blocked({ [HOST_PROTOCOL_PATH]: "export {};\n" }, /validateBridgeMessage|no `case/u);
  // The declarations are the whole `src` tree, so one quiet directory is no longer "the reader found nothing": the
  // injection is a tree that carries no declaration at all, with the serialiser's naming policy the only thing left in it.
  const emptyTree = Object.fromEntries(treeFiles().map((path) => [path, "// no wire type here\n"]));
  assert.ok(Object.keys(emptyTree).length > 50, "the injection must empty the tree the reader walks");
  blocked(
    {
      ...emptyTree,
      [SESSION_FILE]: "// nor here\n",
      [PROTOCOL_FILE]:
        "JsonSerializerOptions JsonOptions = new () { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };\n",
    },
    /no type declaration under integrations\/stardew\/src/u,
  );
});

test("a frame the Mod answers from its dispatch pairs, and renaming that arm blocks it by name", () => {
  // The Host dispatches on `farmhand_action_policy_request` and the Mod answers it in `ModEntry.HandleFarmhandActionPolicy`
  // - a file a reader that knew only the session and the wire models never opened. The frame was inside neither
  // population, and the run blocked on a frame both languages handle (38 Host arms, 36 pairs, one exempt).
  const shipped = checkCrossLanguageWireParity();
  assert.equal(shipped.status, "passed", `the shipped tree must pass: ${shipped.reason}`);
  const arms = hostFrameArms(realHostProtocol()).size;
  assert.ok(arms > 30, `the Host's own switch is the frame population: ${arms} arm(s)`);
  assert.equal(shipped.frames.examined, arms, "every Host arm is in the population");
  assert.ok(
    !shipped.frames.unpaired.includes("farmhand_action_policy_request"),
    "the pushed policy frame is answered by the Mod, so it must not be unmeasured",
  );

  const dispatch = real(MOD_DISPATCH_PATH);
  const renamed = dispatch.replace(
    'TryDeserializeInbound(json, "farmhand_action_policy_request"',
    'TryDeserializeInbound(json, "farmhand_action_policy_query"',
  );
  assert.notEqual(renamed, dispatch, "the injection must rename the frame the Mod answers");
  const report = checkCrossLanguageWireParity({ overrides: { [MOD_DISPATCH_PATH]: renamed } });
  assert.equal(report.status, "blocked", `an unanswered arm must block, not pass: ${report.status}`);
  assert.deepEqual(
    report.frames.unpaired,
    ["farmhand_action_policy_request"],
    `the frame must be named, not dropped: ${report.frames.unpaired.join(", ")}`,
  );
  // Both sides on the printed line: the Host's arms and the Mod's pairs are what makes the missing one visible, and the
  // difference is the one exemption the Mod cannot pair plus the frame this injection unhooked.
  assert.equal(report.frames.examined, arms);
  const expectedPairs = arms - UNPAIRED_FRAME_EXEMPTIONS.length - 1;
  assert.equal(report.frames.paired, expectedPairs);
  const line = formatWireParity(report)[1] ?? "";
  assert.match(
    line,
    new RegExp(`the Host dispatches on ${arms} frame\\(s\\) · the Mod pairs ${expectedPairs} of them`, "u"),
    line,
  );
  assert.match(line, /unmeasured farmhand_action_policy_request$/u, line);
});

test("a key the Host writes on the pushed policy frame is named in the other direction", () => {
  // Pairing the frame is half the fact: its two keys are the Host's declaration read against the Mod's record, and the
  // record lives in `Core/Policy` rather than with the wire models.
  const protocol = realHostProtocol().replace(
    "export type FarmhandActionPolicyRequest = Readonly<{\n",
    "export type FarmhandActionPolicyRequest = Readonly<{\n  redProofProbe?: string;\n",
  );
  assert.notEqual(protocol, realHostProtocol(), "the injection must change the Host declaration");
  const report = checkCrossLanguageWireParity({ overrides: { [HOST_PROTOCOL_PATH]: protocol } });
  assert.ok(
    codes(report).includes("wire_field_unknown_to_mod:farmhand_action_policy_request:redProofProbe"),
    `the Host-written key must be named:\n${codes(report).join("\n")}`,
  );
});

test("a frame nothing pairs BLOCKS the run and is named, instead of being a trailing sentence", () => {
  // The Host dispatches on a frame the Mod's framing calls never mention. Before the population verdict this run printed
  // `passed` and a line of prose below it; the frame contributed nothing to "fields examined" and the verdict said the
  // gate had checked it.
  const protocol = realHostProtocol().replace(
    '    case "world_fact":',
    '    case "unheard_frame":\n      return null;\n    case "world_fact":',
  );
  assert.notEqual(protocol, realHostProtocol(), "the injection must add the frame it names");
  const report = checkCrossLanguageWireParity({ overrides: { [HOST_PROTOCOL_PATH]: protocol } });
  assert.equal(report.status, "blocked", `an unmeasured frame must block, not pass: ${report.status}`);
  assert.match(report.reason, /frame_not_measured:unheard_frame/u);
  assert.ok(report.frames.unpaired.includes("unheard_frame"), "the frame must be named in the report");
  assert.equal(report.frames.gaps.includes("frame_not_measured:unheard_frame"), true);
});

test("a frame exemption downgrades an unpaired frame, and one for a paired frame is stale", () => {
  const protocol = realHostProtocol().replace(
    '    case "world_fact":',
    '    case "unheard_frame":\n      return null;\n    case "world_fact":',
  );
  const exempted = checkCrossLanguageWireParity({
    overrides: { [HOST_PROTOCOL_PATH]: protocol },
    frameExemptions: [
      ...UNPAIRED_FRAME_EXEMPTIONS,
      { frame: "unheard_frame", reason: "probe frame, injected by the falsifier", owner: "this falsifier" },
    ],
  });
  assert.equal(exempted.status, "passed", `a named exemption clears the block: ${exempted.reason}`);
  assert.equal(exempted.frames.exempt, UNPAIRED_FRAME_EXEMPTIONS.length + 1, "every exemption is counted, not silent");

  const stale = checkCrossLanguageWireParity({
    frameExemptions: [{ frame: "world_fact", reason: "gone", owner: "this falsifier" }],
  });
  assert.ok(
    codes(stale).includes("stale_wire_exemption:world_fact"),
    `an exemption whose frame now pairs must be red:\n${codes(stale).join("\n")}`,
  );

  const ownerless = checkCrossLanguageWireParity({
    overrides: { [HOST_PROTOCOL_PATH]: protocol },
    frameExemptions: [{ frame: "unheard_frame", reason: "  ", owner: "" }],
  });
  assert.equal(ownerless.status, "blocked");
  assert.ok(ownerless.frames.gaps.includes("exemption_without_owner:unheard_frame"));
});

test("a frame that pairs to a type carrying no fields is blocked too", () => {
  // The exact hole the reader had: `program_submit` paired with `ActionProgramCandidate` from the Mod's envelope while the
  // declaration lived in a file this gate did not read - a paired frame that contributed zero fields and looked measured.
  const report = checkCrossLanguageWireParity({
    overrides: { [MOD_PROGRAM_MODELS_PATH]: "// the program payload declarations were moved\n" },
  });
  assert.equal(report.status, "blocked");
  assert.ok(
    report.frames.gaps.some((gap) => gap.startsWith("frame_without_fields:program_submit")),
    `a paired frame with no fields must be blocked by name:\n${report.frames.gaps.join("\n")}`,
  );
});

test("an empty frame is declared, and deleting the row blocks it by name again", () => {
  // `destination_index_request` carries the empty object on purpose (the directory is the world's), and a payload with no
  // fields is indistinguishable from a declaration this reader never found. The row is the difference, and removing it has
  // to reproduce the block - otherwise "declared empty" would be a silent pass instead of a stated fact.
  const shipped = checkCrossLanguageWireParity();
  assert.ok(
    shipped.frames.emptyDeclared.some((entry) => entry.frame === "destination_index_request"),
    `the shipped tree must declare the frame's empty payload: ${JSON.stringify(shipped.frames.emptyDeclared)}`,
  );

  const undeclared = checkCrossLanguageWireParity({ emptyFrames: [] });
  assert.equal(undeclared.status, "blocked", `an undeclared empty payload is not a measurement: ${undeclared.reason}`);
  assert.ok(
    undeclared.frames.gaps.includes("frame_without_fields:destination_index_request:BridgeDestinationIndexRequest"),
    `the block must name the frame and its payload:\n${undeclared.frames.gaps.join("\n")}`,
  );
  assert.deepEqual(undeclared.frames.emptyDeclared, [], "no row survived, and the run says so");
  // The block is about that frame, not about abandoning the tree: the fields that CAN be compared are still compared.
  assert.ok(undeclared.fields.examined > 0, "a population block still reads the rest of the tree");
});

test("an empty-frame row does not excuse a field the Host declares on the frame", () => {
  const protocol = realHostProtocol().replace(
    "export type DestinationIndexRequest = Readonly<Record<string, never>>;",
    "export type DestinationIndexRequest = Readonly<{ redProofProbe?: string }>;",
  );
  assert.notEqual(protocol, realHostProtocol(), "the injection must change the Host declaration");
  const report = checkCrossLanguageWireParity({ overrides: { [HOST_PROTOCOL_PATH]: protocol } });
  assert.equal(report.status, "failed", `a key on an empty payload is a crossing, not a declaration: ${report.status}`);
  assert.ok(
    codes(report).includes("wire_field_unknown_to_mod:destination_index_request:redProofProbe"),
    `the crossing must be named with its field:\n${codes(report).join("\n")}`,
  );
});

test("a declared-empty payload that grows a field makes its row stale, naming the field", () => {
  const models = real(MODELS_FILE).replace(
    "public sealed record BridgeDestinationIndexRequest;",
    "public sealed record BridgeDestinationIndexRequest(string? RedProofProbe = null);",
  );
  assert.notEqual(models, real(MODELS_FILE), "the injection must give the empty payload a field");
  const report = checkCrossLanguageWireParity({ overrides: { [MODELS_FILE]: models } });
  assert.equal(report.status, "failed", `a row that outlived its payload is drift: ${report.status} ${report.reason}`);
  const stale = report.violations.find(
    (violation) => violation.code === "stale_wire_exemption:destination_index_request",
  );
  assert.ok(stale, `the row must go red by name:\n${codes(report).join("\n")}`);
  assert.match(stale.detail, /redProofProbe/u, `the row must name the field that made it false: ${stale.detail}`);
  assert.ok(
    !report.frames.emptyDeclared.some((entry) => entry.frame === "destination_index_request"),
    "a frame that now carries a field is no longer counted as declared empty",
  );
});

test("an empty-frame row with no reason or no owner is refused", () => {
  const report = checkCrossLanguageWireParity({
    emptyFrames: [
      { frame: "destination_index_request", payload: "BridgeDestinationIndexRequest", reason: " ", owner: "" },
    ],
  });
  assert.equal(report.status, "blocked");
  assert.ok(
    report.frames.gaps.includes("exemption_without_owner:destination_index_request"),
    `a silent declaration is what the row exists against:\n${report.frames.gaps.join("\n")}`,
  );
});

test("the family is not vacuous: the frames the incidents lived on are examined", () => {
  const report = checkCrossLanguageWireParity();
  for (const frame of ["execution_request", "world_fact", "hello_ack", "program_status_result"]) {
    assert.ok(
      report.frames.examined > 0 && !report.frames.unpaired.includes(frame),
      `\`${frame}\` must be inside the population; unpaired [${report.frames.unpaired.join(", ")}]`,
    );
  }
  // The frames an existing gate already owns are excluded BY NAME, with the owner printed.
  assert.deepEqual(
    report.frames.ownedElsewhere.map((entry) => entry.frame),
    ["snapshot", "execution_receipt"],
  );
  const bodies = report.frames.ownedElsewhere.map((entry) => entry.owner);
  assert.ok(bodies.includes("host/src/declaration-agreement.test.ts"));
  assert.ok(bodies.includes("gates/stardew/check-stardew-execution-receipt-field-parity.mjs"));
});

test("the CLI exits 0 on this tree and 2 on a tree it cannot read", () => {
  const green = spawnSync(process.execPath, [GATE, "--json"], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(green.status, EXIT.agree, `the shipped tree must pass: ${green.stdout.slice(0, 800)}${green.stderr}`);

  const root = mkdtempSync(join(tmpdir(), "wire-parity-"));
  try {
    // The gate reads the Mod's whole `src` tree for declarations, so the copy is the tree: a checkout that carried only
    // `Core/Models` would answer a question about a tree nobody builds.
    for (const relativePath of [
      MOD_SOURCE_ROOT,
      MOD_DISPATCH_PATH,
      SESSION_FILE,
      HOST_PROTOCOL_PATH,
      HOST_FACTS_PATH,
    ]) {
      cpSync(join(REPOSITORY_ROOT, relativePath), join(root, relativePath), {
        recursive: true,
        filter: (source) => !/[\\/](?:bin|obj)$/u.test(source),
      });
    }
    const copied = spawnSync(process.execPath, [GATE, "--json", "--root", root], { encoding: "utf8" });
    assert.equal(copied.status, EXIT.agree, `the copied tree must read the same way: ${copied.stdout.slice(0, 400)}`);

    writeFileSync(join(root, PROTOCOL_FILE), "// the serialiser is gone\n");
    const blocked = spawnSync(process.execPath, [GATE, "--json", "--root", root], { encoding: "utf8" });
    assert.equal(blocked.status, EXIT.blocked, "a tree the gate cannot read exits 2, never 0");
    assert.match(blocked.stdout, /"status":"blocked"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the records the gate reads are the records the Mod declares", () => {
  const records = modRecords(real(MODELS_FILE));
  const request = records.get("BridgeExecutionRequest") ?? [];
  assert.deepEqual(
    request.map((field) => field.name),
    ["RequestId", "IdempotencyKey", "Action", "Args", "ExpectedRevision", "DeadlineMs"],
  );
  const args = records.get("BridgeExecutionArgs") ?? [];
  assert.ok(
    args.some((field) => field.name === "SceneTarget"),
    `BridgeExecutionArgs must carry the field the incident named: ${args.map((field) => field.name).join(", ")}`,
  );
  // Frame population comes from the Host's own dispatch, so a new frame joins without an edit here.
  assert.ok(hostFrameArms(realHostProtocol()).has("execution_request"));
});
