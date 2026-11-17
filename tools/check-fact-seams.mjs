#!/usr/bin/env node
/**
 * A fact that crosses a process or a language boundary is written in one place and read in another, and the two
 * spellings drift with nothing noticing.
 *
 * WHY. Three of them shipped in one night, all invisible to the whole ladder:
 *
 *   1. The ACK KEY SEQUENCE. The Host's `writeAcknowledgement` gained `drainDeadlineMs` and `stepHangDeadlineMs`
 *      (`0b4e9982`), so the frame it really writes has eleven keys. `tools/desktop-composition-launch.mjs` validated that
 *      frame against a handwritten nine-key list, and its own test built a nine-key ack of its own and asserted the
 *      launcher accepted it - a second copy asserting the first. Every composed launch died
 *      `desktop_compose_bootstrap_ack_invalid` while every test was green.
 *   2. THE FACT-PATCH SWITCH. `dialogue-web/src/composed-reference-game-browser-api.ts` mapped the Host's Game facts
 *      with a three-member `switch` and no `default`, so a fourth fact would compile and fall through.
 *   3. THE PROBLEM-CODE MIRROR. `GAME_PROBLEM_CODES` is the browser's copy of the Host's code union; a new code was
 *      declared and mirrored, and the ROUTE's mapping (`gameCreateProblemCode`) had no arm for it, so the panel was
 *      handed `state_unavailable` - a generic state with false advice - instead of the refusal that had been stated.
 *
 * Each was fixed at its own layer. What did not exist is a gate over the class: a fact whose two ends are two
 * declarations, where neither end can be derived from the other and nothing compares them.
 *
 * THE POPULATION IS DERIVED, THREE WAYS, and each way is a scan rather than a list:
 *
 *   MIRRORS    Every module-level string-literal vocabulary in `host/src`, `dialogue-web/src` and `tools` - an array, an
 *              `Object.freeze([...])`, a `new Set([...])`, a TypeBox `Type.Union([Type.Literal(...)])`, and the
 *              discriminant set of a `Type.Union` whose arms each carry one `Type.Literal` (the Game fact union is
 *              written that way, so a reader that knew only `Type.Union([Type.Literal, ...])` would not see it).
 *              Vocabularies with the same member SET that span two of those three packages are one population member
 *              each: one fact, two declarations. A declaration inside a function body is not a vocabulary - it is a
 *              fixture local to its call - so only column-zero, depth-zero declarations are read.
 *   KEY SEQUENCES
 *              Every key-list validator call in `tools` and `dialogue-web/src` (`exactKeysInOrder`, `hasExactKeys`,
 *              `hasExactKeysOrOptional`, `hasOnlyKeys`) whose expected list is a literal or a file-local literal
 *              constant, TOGETHER WITH the schema literal the same function checks (`value.schema === READY_SCHEMA`).
 *              That pair is what makes it a crossing: the producers of that schema literal in other files are the
 *              writer's side. A frame this file both writes and validates has one authority in this file, and is
 *              reported as such rather than counted as drift.
 *   DECLARED CODES
 *              Every host `Type.Union([Type.Literal(...)])` whose members are all code-shaped tokens. A code the contract
 *              declares must be PRODUCED by some host source outside the file that declares it; a declared code with no
 *              producer is the shape defect 3 took (`stardew_game_create_world_held_by_player` was declared, mirrored,
 *              and produced by nobody, so the route answered `state_unavailable`).
 *
 * WHAT A POPULATION MEMBER MUST RESOLVE TO. One authority, and it is a fact of the tree rather than of this file:
 *
 *   derives: "import"       the reader's file imports the module that declares the authority.
 *   derives: "json"         the reader is bound to a shape file (`*.keys.json` and its kind) that exists, lives beside
 *                           the writer, and is read on this side - the mechanism `88e7e6e9` built for the ack.
 *   derives: "asserted-by"  a test file compares the two declarations, and the check that it does is that the test
 *                           NAMES both symbols. A test that restates the shape and asserts its own copy names no
 *                           authority, which is precisely how defect 1's test stayed green.
 *   debt                    the crossing is recorded and triaged, not resolved: it carries the reason it is not one
 *                           authority today and the owner who owes it. Debt is printed, never silent, and it EXPIRES -
 *                           a recorded crossing whose declarations have moved apart is `fact_seam_drift`, and one whose
 *                           declarations are gone is `stale_fact_seam`. So the list can shrink but never rot.
 *
 * The same three resolutions and the same debt apply to a KEY SEQUENCE's record in KEY_SEQUENCES, and the two
 * populations are COUNTED APART on the reading's last slot: `over a frame another side writes K (one authority X ·
 * recorded debt Y)` - K is how many validator sites have a producer on another side, and X/Y are what the K crossings
 * resolved to. A frame debt is paid by moving its record to `json` beside the writer or to `asserted-by` with a test
 * that names both ends; the entry then leaves Y for X, and a reader that starts deriving is no longer a restatement
 * (`stale_fact_seam` if the record still says debt).
 *
 * FINDINGS, each naming the member and what would have to change:
 *   fact_declared_twice:<file>:<line> <fact>   a declaration in the population with no authority and no record
 *   fact_seam_drift:<fact>                     a recorded crossing whose two declarations now disagree (names the members)
 *   fact_seam_unasserted:<fact>                recorded `asserted-by`, and the named test no longer names both symbols
 *   fact_seam_underived:<fact>                 recorded `import`/`json`, and the reader no longer derives from it
 *   stale_fact_seam:<fact>                     a record whose declaration has gone
 *   fact_declared_unproduced:<code>            a declared problem code that no host source produces
 *
 * ZERO POPULATION BLOCKS. A scan that read no vocabulary, or no key-list call site, has lost its reader rather than
 * removed the class, and `facts examined 0` is a sentence that agrees with itself: exit 2 with the reason.
 *
 * USAGE
 *   node tools/check-fact-seams.mjs              # the gate; exit 0 agreed, 1 drift, 2 blocked
 *   node tools/check-fact-seams.mjs --root DIR   # read another checkout (the red proofs replay real commits)
 *   node tools/check-fact-seams.mjs --list       # every population member with its verdict, nothing else
 *
 * WHAT THIS GATE DOES NOT SEE, stated rather than implied:
 *   - A shape restated in a language this reader cannot parse (the Desktop launcher's C# frames) is visible only as the
 *     JavaScript side of the pair. Where the JavaScript side is derived from a shape file, the pair is one authority;
 *     where it is a literal, the record names the C# file and the debt stands.
 *   - A value that crosses as a number, a boolean, or an object literal's inline shape is not a vocabulary. Those are
 *     `tools/check-parser-agreement.mjs` and `tools/check-cross-language-wire-parity.mjs` territory, and neither this
 *     reader nor its findings claims them.
 *   - A switch that maps a mirrored vocabulary is `tools/check-switch-exhaustiveness.mjs`'s population: this gate pins
 *     that the two ends AGREE, that one pins that every member has an arm. Defect 2 was latent - the third member
 *     existed and was armed - so it is that gate's red, not this one's, and the header says so instead of implying a
 *     second coverage.
 *
 * red-proof: history On `88e7e6e9^` this gate reports
 *   `fact_seam_underived:desktop-composition-ack` for `tools/desktop-composition-launch.mjs` (the shape file the fix
 *   added does not exist at that revision) - the launcher's nine-key list against the Host's eleven-key frame.
 * red-proof: history On `25de4e8f` (before `51732f40`) this gate reports
 *   `fact_declared_unproduced:stardew_game_create_world_held_by_player` and its slot sibling: declared and mirrored,
 *   produced by no host source, so the create route answered `state_unavailable`.
 * red-proof: inject `tools/check-fact-seams.test.mjs` adds one member to a mirrored vocabulary in a copy of the tree and
 *   requires `fact_seam_drift:<fact>` to name that member.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three sides of a boundary this gate reads. A fact inside one of them is a declaration, not a crossing. */
export const VOCABULARY_ROOTS = Object.freeze(["host/src", "dialogue-web/src", "tools"]);

export const EXIT = Object.freeze({ agreed: 0, drift: 1, blocked: 2 });

/** A vocabulary with fewer members than this is not a fact worth a seam: three distinct tokens are a vocabulary. */
const MINIMUM_MEMBERS = 3;

/** The key-list validators: a frame's shape, written as a list of names, at the reader's end. */
const KEY_VALIDATORS = Object.freeze(["exactKeysInOrder", "hasExactKeys", "hasExactKeysOrOptional", "hasOnlyKeys"]);

/**
 * The crossings that resolve to ONE authority, verified on every run.
 *
 * Each entry is a fact, the declaration that owns it, and the declarations that read it - `derives` is HOW the reader is
 * held to the owner, and the gate re-checks that the derivation still holds rather than trusting this table.
 */
export const SEAMS = Object.freeze([
  {
    fact: "game_browser_api/v1 problem codes",
    authority: {
      file: "host/src/game-browser-contract/index.ts",
      name: "GameProblemCode",
    },
    readers: [
      {
        file: "dialogue-web/src/composed-reference-game-browser-api.ts",
        name: "GAME_PROBLEM_CODES",
      },
    ],
    derives: {
      kind: "asserted-by",
      assertion: "dialogue-web/tests/problem-code-gate.test.mjs",
      symbols: ["GameProblemCode", "GAME_PROBLEM_CODES"],
    },
    owner: "the composed game client lane",
  },
  {
    fact: "provider failure classes",
    authority: {
      file: "host/src/provider-failure-classification.ts",
      name: "PROVIDER_FAILURE_CLASSES",
    },
    readers: [
      {
        file: "dialogue-web/src/management-pipeline-api.ts",
        name: "PROVIDER_FAILURES",
      },
      {
        file: "dialogue-web/src/reference-pipeline-api.ts",
        name: "PROVIDER_FAILURES",
      },
    ],
    derives: {
      kind: "asserted-by",
      assertion: "dialogue-web/tests/problem-code-gate.test.mjs",
      symbols: ["PROVIDER_FAILURE_CLASSES", "PROVIDER_FAILURES"],
    },
    owner: "the problem-catalogue lane",
  },
]);

const GAME_CONTRACT = "host/src/game-browser-contract/index.ts";
const GAME_CLIENT = "dialogue-web/src/composed-reference-game-browser-api.ts";
const TAVERN_CONTRACT = "host/src/tavern/browser-contract/index.ts";
const MANAGEMENT_CLIENT = "dialogue-web/src/management-pipeline-api.ts";
const REFERENCE_CLIENT = "dialogue-web/src/reference-pipeline-api.ts";

/** `"path/to/file.ts:Name"` -> the declaration the scan indexes. The one spelling this file uses to name one. */
const reference = (value) => {
  const cut = value.lastIndexOf(":");
  return { file: value.slice(0, cut), name: value.slice(cut + 1) };
};

const MIRROR_OWNER = "the browser client lane: the bundle cannot import the Host package";
const MIRROR_REASON =
  "dialogue-web has no typebox dependency and no Host runtime module, so this list is the browser's only copy; no test compares the two declarations today";

/** One mirrored vocabulary: a fact someone restates because the declaration that owns it cannot be imported. */
const mirrorDebt = (fact, authority, readers, extra = {}) => ({
  fact,
  authority: reference(authority),
  readers: readers.map(reference),
  reason: extra.reason ?? MIRROR_REASON,
  owner: extra.owner ?? MIRROR_OWNER,
});

/**
 * The crossings that are recorded and NOT resolved, each with the reason and the owner who owes the fix.
 *
 * This is the triage list, not a waiver: a member here is printed with every run, and the entry goes red when the two
 * ends stop agreeing (`fact_seam_drift`) or when one of them goes (`stale_fact_seam`). Entries leave by being resolved.
 */
export const DEBT = Object.freeze([
  // ─── The game contract's vocabularies, mirrored by the composed game client ───
  mirrorDebt("prerequisite statuses", `${GAME_CONTRACT}:PrerequisiteStatus`, [`${GAME_CLIENT}:PREREQUISITE_STATUSES`]),
  mirrorDebt("instance statuses", `${GAME_CONTRACT}:InstanceStatus`, [`${GAME_CLIENT}:INSTANCE_STATUSES`]),
  mirrorDebt("compatibility statuses", `${GAME_CONTRACT}:CompatibilityStatus`, [
    `${GAME_CLIENT}:COMPATIBILITY_STATUSES`,
  ]),
  mirrorDebt("attachment statuses", `${GAME_CONTRACT}:AttachmentStatus`, [`${GAME_CLIENT}:ATTACHMENT_STATUSES`]),
  mirrorDebt("connection statuses", `${GAME_CONTRACT}:ConnectionStatus`, [`${GAME_CLIENT}:CONNECTION_STATUSES`]),
  mirrorDebt("action authority statuses", `${GAME_CONTRACT}:ActionAuthority`, [
    `${GAME_CLIENT}:ACTION_AUTHORITY_STATUSES`,
  ]),
  mirrorDebt("command outcomes", `${GAME_CONTRACT}:Outcome`, [`${GAME_CLIENT}:OUTCOMES`]),
  mirrorDebt("companion mod outcomes", `${GAME_CONTRACT}:CompanionModOutcome`, [
    `${GAME_CLIENT}:COMPANION_MOD_OUTCOMES`,
    "dialogue-web/src/game-presentation.ts:COMPANION_MOD_OUTCOMES",
  ]),
  // The fact-patch vocabulary. The browser's list and the Host union's discriminant set are two spellings of "which
  // facts can travel", and `check-switch-exhaustiveness` owns the third end of the same fact - that the mapping switch
  // arms every member. A fourth fact added to the union and not to this list is this record's drift.
  mirrorDebt("game fact patches", `${GAME_CONTRACT}:GameFactPatchV1Schema`, [`${GAME_CLIENT}:GAME_FACTS`], {
    reason:
      "the browser cannot import the host contract, so `GAME_FACTS` restates the union's discriminant set; `check-switch-exhaustiveness` pins that the patch switch arms every member, and nothing compares these two lists",
    owner: "the composed game client lane",
  }),
  mirrorDebt("stardew window modes", `${GAME_CONTRACT}:StardewWindowModeV1Schema`, [
    "host/src/games/stardew/stardew-player-settings.ts:WINDOW_MODES",
    "dialogue-web/src/components/GamePlayerSettings.tsx:WINDOW_MODE_KEYS",
    `${GAME_CLIENT}:STARDEW_WINDOW_MODES`,
  ]),
  // The frozen array beside the union, which no test compares to it: `index.private.test.ts:974` restates sixteen of
  // the codes in a list of its own and asserts each is included, which is the third copy of this vocabulary.
  {
    fact: "game problem codes (frozen array)",
    authority: reference(`${GAME_CONTRACT}:GameProblemCode`),
    readers: [reference(`${GAME_CONTRACT}:GAME_BROWSER_PROBLEM_CODES_V1`)],
    reason:
      "the frozen array beside the union is a second spelling of the same 29 codes in one file; nothing compares them, and the contract's own test restates sixteen of them in a third list",
    owner: "the game browser contract lane",
  },

  // ─── The tavern contract's vocabularies ───
  mirrorDebt("connection setup fields", `${TAVERN_CONTRACT}:TavernConnectionSetupFieldV1Schema`, [
    `${MANAGEMENT_CLIENT}:CONNECTION_SETUP_FIELDS`,
  ]),
  mirrorDebt("connection api shapes", `${TAVERN_CONTRACT}:TavernConnectionApiShapeV1Schema`, [
    "host/src/tavern/provider-catalog.ts:TAVERN_PI_API_SHAPES",
    `${MANAGEMENT_CLIENT}:CONNECTION_API_SHAPES`,
  ]),
  mirrorDebt("connection failures", `${TAVERN_CONTRACT}:ConnectionFailure`, [
    "host/src/tavern/connection-store.ts:PROBE_FAILURES",
    `${MANAGEMENT_CLIENT}:CONNECTION_FAILURES`,
  ]),
  mirrorDebt("connection readiness", "host/src/tavern/connection-store.ts:READINESS", [
    `${MANAGEMENT_CLIENT}:CONNECTION_READINESS`,
  ]),
  mirrorDebt("tavern operation ids", `${TAVERN_CONTRACT}:OperationId`, [`${MANAGEMENT_CLIENT}:OPERATION_IDS`]),
  mirrorDebt("management label keys", `${TAVERN_CONTRACT}:LabelKey`, [`${MANAGEMENT_CLIENT}:MANAGEMENT_LABEL_KEYS`]),
  mirrorDebt("navigation item ids", `${TAVERN_CONTRACT}:NavigationItemId`, [
    `${TAVERN_CONTRACT}:contractDeclaredNavigationItemIds`,
    "host/src/tavern-management-dialogue-web.ts:MANAGEMENT_NAVIGATION_ITEM_IDS_WITH_MEMORY",
    `${MANAGEMENT_CLIENT}:NAVIGATION_ITEM_IDS`,
    `${REFERENCE_CLIENT}:NAVIGATION_ITEM_IDS`,
    "tools/run-tavern-release-live-gate.mjs:CONTRACT_NAVIGATION_ITEM_IDS",
  ]),
  mirrorDebt("world info binding states", `${TAVERN_CONTRACT}:WorldInfoBindingState`, [
    `${MANAGEMENT_CLIENT}:WORLD_INFO_STATES`,
    `${REFERENCE_CLIENT}:WORLD_INFO_STATES`,
  ]),
  mirrorDebt("thinking levels", "host/src/runtime-identity.ts:COMPANION_THINKING_LEVELS", [
    `${TAVERN_CONTRACT}:TavernConnectionThinkingLevelV1Schema`,
    "dialogue-web/src/components/management-panels.tsx:MODEL_PROFILE_THINKING_LEVEL_SUGGESTIONS",
    `${MANAGEMENT_CLIENT}:CONNECTION_THINKING_LEVELS`,
  ]),
  mirrorDebt("preset not-applied codes", "host/src/tavern/preset-sampling.ts:PRESET_NOT_APPLIED_CODES", [
    "dialogue-web/src/preset-assembly-surface.ts:PRESET_NOT_APPLIED_CODES",
  ]),

  // ─── The Host's own vocabularies, restated by the harnesses and the audits ───
  mirrorDebt(
    "manifest principal keys",
    "host/src/deployment-manifest.ts:PRINCIPAL_KEYS",
    ["tools/lib/game-operational-gate-preflight.mjs:IDENTITY_KEYS"],
    {
      reason:
        "the preflight re-reads the manifest's own identity keys to decide whether an operational run may start, as a list of its own",
      owner: "the operational gate lane",
    },
  ),
  mirrorDebt(
    "terminal execution states",
    "host/src/execution-correlation-ledger.ts:TERMINAL_EXECUTION_STATES",
    [
      "tools/lib/stardew-formal-action-gate.mjs:TERMINAL_EXECUTION_STATES",
      "tools/lib/stardew-native-smoke-harness-v1.mjs:TERMINAL_STATES",
    ],
    {
      reason: "the harnesses decide whether a receipt is terminal from their own copy of the ledger's state set",
      owner: "the stardew harness lane",
    },
  ),
  mirrorDebt(
    "observe-scene truncation reasons",
    "host/src/protocol.ts:OBSERVE_SCENE_TRUNCATION_REASONS",
    [
      "tools/run-stardew-native-local-player-navigation-mutation-smoke.mjs:PARTIAL_TRUNCATION_REASONS",
      "tools/run-stardew-native-local-player-pickup-forage-smoke.mjs:PARTIAL_TRUNCATION_REASONS",
    ],
    {
      reason: "the smoke harnesses assert which truncation reasons count as partial from a list of their own",
      owner: "the stardew harness lane",
    },
  ),
  mirrorDebt(
    "provider failure classes (a test's own copy)",
    "host/src/provider-failure-classification.ts:PROVIDER_FAILURE_CLASSES",
    ["dialogue-web/src/components/turn-failure-text.test.ts:PROVIDER_FAILURES"],
    {
      reason:
        "the two client mirrors are pinned to the classifier by `problem-code.13`, and this test restates the same five classes to drive its own cases - a third copy asserting the first two",
      owner: "the problem-catalogue lane",
    },
  ),
  mirrorDebt(
    "the Mod's bundle file names",
    "tools/lib/stardew-native-local-player-fixture.mjs:BUNDLE_FILES",
    [
      "host/src/stardew-game-install/deployment.test.ts:MOD_ENTRIES",
      "host/src/stardew-production-lifecycle-coordinator.test-support.ts:packageEntries",
      "host/src/stardew-recovery-integration.private.test.ts:packageEntries",
      "tools/check-live-run-isolation.mjs:BUNDLE_FILES",
      "tools/lib/stardew-fixture-profile.mjs:BUNDLE_FILE_NAMES",
      "tools/lib/stardew-lane-scope.test.mjs:BUNDLE_FILES",
      "tools/provision-stardew-multiplayer-profiles.mjs:BUNDLE_FILE_NAMES",
      "tools/stardew-native-local-player-fixture.test.mjs:BUNDLE_FILES",
      "tools/stardew-navigation-topology-preflight.mjs:BUNDLE_FILES",
    ],
    {
      reason:
        "the Mod's four bundle file names are the build's output (`integrations/stardew/GameBuddy.Stardew.csproj`), and ten declarations beside it restate them - a build that renames an output leaves every one of them wrong",
      owner: "the Mod packaging lane",
    },
  ),
  mirrorDebt(
    "the Mod's four facing directions",
    "host/src/stardew-humanlike-action-projection.test.ts:MOD_DIRECTION_ENUM_4",
    ["tools/lib/failure-dump.mjs:FACING_NAMES"],
    {
      reason:
        "the authority is the Mod's C# direction enum; a Host test restates it and the failure dump restates it again to print a facing",
      owner: "the failure-dump lane",
    },
  ),
  mirrorDebt(
    "chat turn terminal states",
    "dialogue-web/src/components/use-composed-bootstrap.ts:TERMINAL_TURN_STATES",
    [
      "tools/lib/chat-run-audit.mjs:TERMINAL_STATES",
      "tools/live-run/chat/chat-audit-contract.mjs:AUDIT_TERMINAL_STATES",
      "tools/live-run/chat/run-chat-live-audit.mjs:TERMINAL_TURN_STATES",
    ],
    {
      reason: "the live-run audit reads a Chat turn's terminal states from its own copies of the client's three",
      owner: "the chat live-run lane",
    },
  ),
]);

// ---------------------------------------------------------------------------
// Reading: comments out, strings intact, and where the module level starts
// ---------------------------------------------------------------------------

/** The source with its comments removed and its string literals intact, so positions and values both stay true. */
export function withoutComments(source) {
  const parts = [];
  let plain = 0;
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      parts.push(source.slice(plain, index));
      const close = source.indexOf("\n", index);
      index = close < 0 ? source.length : close;
      plain = index;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      parts.push(source.slice(plain, index));
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      plain = index;
      continue;
    }
    index += 1;
  }
  parts.push(source.slice(plain));
  return parts.join("");
}

/**
 * The brace depth at `offset`, counting only braces in CODE.
 *
 * A declaration at depth zero is a module-level vocabulary; one inside a function is a fixture bound to a single call
 * site, and treating those as vocabularies reported `const expectedKeys = [...]` in six smoke harnesses as six facts.
 * Strings and comments never move the count, because a `{` inside `"{schema}"` is not a block.
 */
export function braceDepthAt(code, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < offset && code[index] !== char) {
        if (code[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

/**
 * Every `const NAME = ...` in the source, with the offset just after the `=`.
 *
 * Anchored per LINE (`m`), not per `\n`-prefixed match: an initialiser's trailing `\s*` swallows the newline before the
 * next declaration, so a newline anchor read one declaration per file - 43 across the whole tree instead of 1,300.
 */
function constDeclarations(code) {
  const candidates = [];
  for (const match of code.matchAll(/^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+?)?=\s*/gmu)) {
    candidates.push({ name: match[1], at: match.index + match[0].length });
  }
  // One depth pass for every candidate. Asking `braceDepthAt` per declaration rescanned the file from its first byte
  // each time, which is quadratic in declarations and was most of this gate's 5 s.
  const depths = depthsAt(
    code,
    candidates.map((candidate) => candidate.at),
  );
  return candidates.filter((candidate) => depths.get(candidate.at) === 0);
}

/** The brace depth at each of `offsets`, in one pass over the code. Strings and comments never move the count. */
function depthsAt(code, offsets) {
  const wanted = new Set(offsets);
  const found = new Map();
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    if (wanted.has(index)) found.set(index, depth);
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < code.length && code[index] !== char) {
        // A regex literal's quote (`/^[^"<>]+$/`) is not a string, so a "string" here can be a run of real code: an
        // offset inside it still takes the depth the scan has reached. Dropping it reported a module-level declaration
        // as nested, and the fact it declared fell out of the population.
        if (wanted.has(index)) found.set(index, depth);
        if (code[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  return found;
}

/**
 * The string members of the array/paren literal opening at `open`, one level in.
 *
 * `Type.Union([Type.Literal("a"), ...])` puts its members one level deeper than `["a", ...]` does, and the discriminant
 * union of named arms puts them in another declaration entirely - both are read, because the Host writes all three.
 */
function literalMembers(code, open) {
  const stack = [];
  const members = [];
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < code.length && code[index] !== quote) {
        if (code[index] === "\\") index += 1;
        value += code[index] ?? "";
        index += 1;
      }
      if (stack.at(-1) === true) members.push(value);
      continue;
    }
    if (char === "[" || char === "{" || char === "(") {
      const before = code.slice(Math.max(0, index - 16), index);
      // The container itself counts its own members; a nested `(` counts only when it is a `Type.Literal(...)`, whose
      // argument IS the member. Without the first half a whole array read as empty and every inline key list vanished.
      const container = stack.length === 0;
      const inner = char === "(" && /Type\.Literal\s*$/u.test(before);
      stack.push(container || inner);
      continue;
    }
    if (char === "]" || char === "}" || char === ")") {
      stack.pop();
      if (stack.length === 0) return members;
    }
  }
  return members;
}

/** The vocabulary a declaration's initialiser states, or null. */
export function vocabularyAt(code, at) {
  let index = at;
  const wrappers = [];
  const skip = () => {
    while (index < code.length && /\s/u.test(code[index])) index += 1;
  };
  for (;;) {
    skip();
    const wrapper = /^(?:Object\.freeze|new Set<[^>]*>|new Set|Type\.Union|Type\.Readonly|Type\.Array)\s*\(/u.exec(
      code.slice(index),
    );
    if (wrapper === null) break;
    wrappers.push(wrapper[0].replace(/\s*\($/u, ""));
    index += wrapper[0].length;
    skip();
    if (code[index] === "[" || code[index] === "{") break;
  }
  if (code[index] !== "[") return null;
  const members = literalMembers(code, index);
  if (members.length < MINIMUM_MEMBERS) return null;
  return {
    members,
    kind: wrappers.includes("Type.Union") ? "typebox-union" : "array",
  };
}

/**
 * A `Type.Union([A, B, C])` whose arms are schemas this file declares, each carrying exactly one `Type.Literal`.
 *
 * The Game fact union is written this way (`GameInstanceFactPatchV1Schema`, `GameAttachmentFactPatchV1Schema`,
 * `GameSelectedWorldFactPatchV1Schema`), so its discriminant set - the facts that can travel - is stated nowhere as a
 * literal list. Reading it is what makes the browser's `GAME_FACTS` mirror visible to this gate at all.
 */
export function discriminantUnionAt(code, at) {
  const match = /^Type\.Union\s*\(\s*\[/u.exec(code.slice(at));
  if (match === null) return null;
  const open = at + match[0].length - 1;
  const close = matchingBracket(code, open, "[", "]");
  if (close < 0) return null;
  const arms = code
    .slice(open + 1, close)
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm) => /^[A-Za-z_$][\w$]*$/u.test(arm));
  const members = [];
  for (const arm of arms) {
    const declaration = code.indexOf(`const ${arm}`, 0);
    if (declaration < 0) return null;
    // The discriminant is the arm schema's own `fact: Type.Literal(...)`, which is the first literal it declares.
    const literal = /Type\.Literal\s*\(\s*"([^"]+)"/u.exec(code.slice(declaration, declaration + 4000));
    if (literal === null) return null;
    members.push(literal[1]);
  }
  return members.length >= MINIMUM_MEMBERS ? { members, kind: "discriminant-union" } : null;
}

/** Index of the bracket closing the one at `open`, skipping string literals, or -1. */
function matchingBracket(code, open, opener, closer) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < code.length && code[index] !== char) {
        if (code[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * One read per file per run, comment-free.
 *
 * The key-list scan asks "does another side write this frame?" once per site, and answering it any other way read the same
 * three roots again for every one of them: the gate took 7 s on this tree, which is not what a static rung costs.
 */
const SOURCE_CACHE = new Map();

/** The raw bytes of one file, once per run: the producer filter reads every candidate before it strips any. */
const RAW_CACHE = new Map();
function readRaw(root, file) {
  const key = `${root}\u0000${file}`;
  const cached = RAW_CACHE.get(key);
  if (cached !== undefined) return cached;
  const raw = readFileSync(join(root, file), "utf8");
  RAW_CACHE.set(key, raw);
  return raw;
}

function readSource(root, file) {
  const key = `${root}\u0000${file}`;
  const cached = SOURCE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const code = withoutComments(readRaw(root, file));
  SOURCE_CACHE.set(key, code);
  return code;
}

/** Every module-level vocabulary a file declares, with where it is and what it holds. */
export function vocabulariesIn(root, file) {
  const code = readSource(root, file);
  const found = [];
  for (const declaration of constDeclarations(code)) {
    const vocabulary = vocabularyAt(code, declaration.at) ?? discriminantUnionAt(code, declaration.at);
    if (vocabulary === null) continue;
    found.push({
      file,
      name: declaration.name,
      line: lineOf(code, declaration.at),
      kind: vocabulary.kind,
      members: Object.freeze(vocabulary.members),
    });
  }
  return found;
}

/** Sources this reader can parse, and the directories it must not walk. */
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
const SKIPPED_DIRECTORY = /^(?:node_modules|dist|build|\.)/u;
/** A scratch artefact (`tools/.soft-suite.tmp.test.mjs`) is not a declaration the tree owns. */
const TEMPORARY_FILE = /\.tmp\.|\.tmp$/u;

/**
 * Every source file under the gate's roots, depth-first, in a stable order.
 *
 * A root this checkout does not have is empty rather than fatal: a replay tree carries the files it needs and not the
 * others, and the whole point of `--root` is to read one of those.
 */
export function sourceFiles(root, directory) {
  let entries;
  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true });
  } catch {
    return [];
  }
  entries = entries.sort((left, right) => left.name.localeCompare(right.name));
  const found = [];
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY.test(entry.name)) continue;
      found.push(...sourceFiles(root, path));
    } else if (SOURCE_FILE.test(entry.name) && !TEMPORARY_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/** `host`, `dialogue-web` or `tools`: the side of the boundary a file sits on. */
export function boundaryOf(file) {
  if (file.startsWith("host/")) return "host";
  if (file.startsWith("dialogue-web/")) return "dialogue-web";
  if (file.startsWith("tools/")) return "tools";
  return "other";
}

/** The set of sides a group of declarations spans. */
const sidesOf = (declarations) => new Set(declarations.map((declaration) => boundaryOf(declaration.file)));

/** Every vocabulary in the tree, and the groups where one member set is declared on two sides. */
export function scanMirrors(root) {
  const declarations = [];
  for (const directory of VOCABULARY_ROOTS)
    for (const file of sourceFiles(root, directory)) {
      declarations.push(...vocabulariesIn(root, file));
    }
  const byMembers = new Map();
  for (const declaration of declarations) {
    const key = [...declaration.members].sort().join("\u0000");
    byMembers.set(key, [...(byMembers.get(key) ?? []), declaration]);
  }
  const groups = [];
  for (const members of byMembers.values()) {
    if (sidesOf(members).size < 2) continue;
    groups.push({ members: members[0].members, declarations: members });
  }
  return { declarations, groups };
}

// ---------------------------------------------------------------------------
// Key sequences: the reader's list, the frame it validates, and who writes that frame
// ---------------------------------------------------------------------------

/** The function body containing `offset`, by matching its parameter list and then its brace block. */
function enclosingFunction(code, offset) {
  const head = code.lastIndexOf("function ", offset);
  if (head < 0) return null;
  // The parameter list may destructure (`function readPointer({ outputRoot })`), so the first `{` after the name is not
  // the body: matching the `(...)` first is what keeps the body's own braces in view.
  const parameters = code.indexOf("(", head);
  if (parameters < 0 || parameters > offset) return null;
  let depth = 0;
  let close = parameters;
  for (; close < code.length; close += 1) {
    const char = code[close];
    if (char === '"' || char === "'" || char === "`") {
      close += 1;
      while (close < code.length && code[close] !== char) {
        if (code[close] === "\\") close += 1;
        close += 1;
      }
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const open = code.indexOf("{", close);
  if (open < 0) return null;
  let braces = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < code.length && code[index] !== char) {
        if (code[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === "{") braces += 1;
    else if (char === "}") {
      braces -= 1;
      if (braces === 0) return { from: head, to: index, text: code.slice(head, index + 1) };
    }
  }
  return null;
}

/** The string a file-local constant stands for, or null when the initialiser is not a plain string literal. */
function stringConstant(code, name) {
  const match = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]*)"`, "u").exec(code);
  return match === null ? null : match[1];
}

/**
 * The schema a validator checks beside its key list: `value.schema === READY_SCHEMA`, or the literal itself.
 *
 * This is the join that makes a key list a CROSSING rather than a local habit: the schema names the frame, and the
 * files that write that frame are the writer's side of the boundary.
 */
function schemaOf(body) {
  const comparison = /\.schema\s*[!=]==\s*([A-Za-z_$][\w$]*|"[^"]*")/u.exec(body);
  if (comparison === null) return null;
  const token = comparison[1];
  if (token.startsWith('"')) return { literal: token.slice(1, -1), symbol: null };
  return { literal: null, symbol: token };
}

/**
 * The expected-key argument a validator call names, whether inline, through a file-local constant, or through a shape file.
 *
 * An argument that is neither (`exactKeysInOrder(value, keys)`, where `keys` is the caller's parameter) is NOT in this
 * population: it restates no shape, it forwards one.
 */
function expectedKeys(code, argumentTokens, baseOffset) {
  if (/^\s*\[/u.test(argumentTokens)) {
    const members = literalMembers(code, baseOffset + argumentTokens.indexOf("["));
    return members.length > 0 ? { members, symbol: null } : null;
  }
  const name = /^\s*([A-Za-z_$][\w$]*)/u.exec(argumentTokens);
  if (name === null) return null;
  const declaration = new RegExp(`const\\s+${name[1]}\\s*(?::[^=]+)?=\\s*`, "u").exec(code);
  if (declaration === null) return null;
  const at = declaration.index + declaration[0].length;
  const vocabulary = vocabularyAt(code, at);
  if (vocabulary !== null) return { members: vocabulary.members, symbol: name[1] };
  const shapeFile = jsonDerivation(code, name[1]);
  return shapeFile === null ? null : { members: [], symbol: name[1], shapeFile };
}

/** Is the reader's list bound to a shape file rather than to its own bytes? */
export function jsonDerivation(code, symbol) {
  if (symbol === null) return null;
  const binding = new RegExp(`const\\s+${symbol}\\s*(?::[^=]+)?=\\s*[^;]*JSON\\.parse\\s*\\(`, "u").exec(code);
  if (binding === null) return null;
  const after = code.slice(binding.index, binding.index + 600);
  const path = /([\w./-]+\.json)/u.exec(after);
  return path === null ? null : path[1];
}

/**
 * The files that name a schema literal, one walk for every site in the run.
 *
 * Asking per site read three roots again for each of the five crossings. The raw bytes are matched first, so only the
 * handful of files that mention a frame are comment-stripped at all - the filter is a shortcut, and every hit is
 * confirmed against the stripped text, so a frame named only in prose is still not a producer.
 */
function producersOf(root, readerFile, literal) {
  const producers = [];
  for (const directory of [...VOCABULARY_ROOTS, "host/scripts"]) {
    for (const file of sourceFiles(root, directory)) {
      if (file === readerFile) continue;
      let raw;
      try {
        raw = readRaw(root, file);
      } catch {
        continue;
      }
      if (!raw.includes(literal)) continue;
      if (!readSource(root, file).includes(literal)) continue;
      producers.push(file);
    }
  }
  for (const file of desktopSources(root)) {
    if (file === readerFile) continue;
    try {
      if (readRaw(root, file).includes(literal)) producers.push(file);
    } catch {
      continue;
    }
  }
  return producers;
}

/**
 * The C# sources, read only for "does another side name this frame?" - never parsed for a shape.
 *
 * The list is memoised per run: the producer question is asked once per key-list site, and walking two thousand files
 * once per site is how a replay of this gate turned a two-second reading into a quarter of an hour.
 */
const DESKTOP_CACHE = new Map();
function desktopSources(root) {
  const cached = DESKTOP_CACHE.get(root);
  if (cached !== undefined) return cached;
  const found = collectCSharp(root, "desktop");
  const list = found.length > 0 ? found : collectCSharp(root, "host");
  DESKTOP_CACHE.set(root, list);
  return list;
}

/** Every `.cs` file under `directory`, or nothing when this checkout has no such directory. */
function collectCSharp(root, directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(join(root, current), {
      withFileTypes: true,
    })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY.test(entry.name)) continue;
        walk(path);
      } else if (entry.name.endsWith(".cs")) found.push(path);
    }
  };
  try {
    walk(directory);
  } catch {
    return found;
  }
  return found;
}

/** Every key-list call site in `tools` and `dialogue-web/src`, with the frame it validates and who writes that frame. */
export function scanKeySequences(root) {
  const sites = [];
  for (const directory of ["tools", "dialogue-web/src"]) {
    for (const file of sourceFiles(root, directory)) {
      const code = readSource(root, file);
      for (const validator of KEY_VALIDATORS) {
        for (const match of code.matchAll(new RegExp(`\\b${validator}\\s*\\(`, "gu"))) {
          const open = match.index + match[0].length - 1;
          let depth = 0;
          let close = open;
          for (; close < code.length; close += 1) {
            const char = code[close];
            if (char === '"' || char === "'" || char === "`") {
              close += 1;
              while (close < code.length && code[close] !== char) {
                if (code[close] === "\\") close += 1;
                close += 1;
              }
              continue;
            }
            if (char === "(") depth += 1;
            else if (char === ")") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          const call = code.slice(open + 1, close);
          const comma = call.indexOf(",");
          if (comma < 0) continue;
          const expected = expectedKeys(code, call.slice(comma + 1), open + 1 + comma + 1);
          if (expected === null) continue;
          const fn = enclosingFunction(code, match.index);
          const schema = fn === null ? null : schemaOf(fn.text);
          const literal = schema === null ? null : (schema.literal ?? stringConstant(code, schema.symbol));
          const producers = literal === null ? [] : producersOf(root, file, literal);
          sites.push({
            file,
            line: lineOf(code, match.index),
            validator,
            symbol: expected.symbol,
            keys: Object.freeze(expected.members),
            schema: literal,
            producers: Object.freeze(producers),
            thisSideOnly: producers.length === 0,
          });
        }
      }
    }
  }
  return sites;
}

/**
 * The declared problem codes a host source never produces.
 *
 * Defect 3's shape exactly: the contract declared the code and the browser mirrored it, and the route that had to answer
 * it had a `default` arm, so the code was unreachable and the panel read `state_unavailable`. A declaration whose only
 * appearance in the tree is the file that declares it is a code nobody can send.
 */
export function scanUnproducedCodes(root) {
  const declarations = [];
  const hostFiles = sourceFiles(root, "host/src");
  const texts = new Map(hostFiles.map((file) => [file, readSource(root, file)]));
  for (const [file, code] of texts) {
    for (const declaration of constDeclarations(code)) {
      const vocabulary = vocabularyAt(code, declaration.at);
      if (vocabulary === null || vocabulary.kind !== "typebox-union") continue;
      if (!vocabulary.members.every((member) => /^[a-z][a-z0-9_]*$/u.test(member))) continue;
      declarations.push({
        file,
        name: declaration.name,
        line: lineOf(code, declaration.at),
        members: Object.freeze(vocabulary.members),
      });
    }
  }
  const unproduced = [];
  for (const declaration of declarations) {
    for (const code of declaration.members) {
      const produced = [...texts.entries()].some(
        ([file, text]) => file !== declaration.file && text.includes(`"${code}"`),
      );
      if (!produced)
        unproduced.push({
          code,
          declaredIn: `${declaration.file}:${declaration.line}`,
          name: declaration.name,
        });
    }
  }
  return { declarations, unproduced };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** The declaration a record names, looked up in the scan, or undefined when it has gone. */
function declarationAt(scan, file, name) {
  return scan.declarations.find((declaration) => declaration.file === file && declaration.name === name);
}

/**
 * The declaration a record names, read from its own FILE whether or not the scan still groups it.
 *
 * The difference between the two readers is the difference between a drift and a deletion. A declaration that gained a
 * member is no longer equal to its authority, so the group it belonged to dissolves - and a record that consulted only
 * the population would report that as "the declaration is gone", which is the wrong sentence and sends the next reader
 * looking for a deletion. The record pins IDENTITY; the scan pins MEMBERSHIP.
 */
function declarationIn(root, file, name) {
  let code;
  try {
    code = readSource(root, file);
  } catch {
    return undefined;
  }
  for (const declaration of constDeclarations(code)) {
    if (declaration.name !== name) continue;
    const vocabulary = vocabularyAt(code, declaration.at) ?? discriminantUnionAt(code, declaration.at);
    if (vocabulary === null) continue;
    return {
      file,
      name,
      line: lineOf(code, declaration.at),
      kind: vocabulary.kind,
      members: Object.freeze(vocabulary.members),
    };
  }
  return undefined;
}

/** The members that disagree between two declarations of one fact. */
function disagreements(authority, reader) {
  const left = new Set(authority.members);
  const right = new Set(reader.members);
  return [
    ...[...left]
      .filter((member) => !right.has(member))
      .map((member) => `only in ${authority.file}:${authority.name}:${member}`),
    ...[...right]
      .filter((member) => !left.has(member))
      .map((member) => `only in ${reader.file}:${reader.name}:${member}`),
  ];
}

/** Does the reader derive from the authority the record names? Decided by reading the tree, not by trusting the record. */
function derivationHolds(root, record) {
  const { derives } = record;
  const reader = record.readers[0];
  const readerCode = readSource(root, reader.file);
  if (derives.kind === "asserted-by") {
    let assertion;
    try {
      assertion = readFileSync(join(root, derives.assertion), "utf8");
    } catch {
      return { holds: false, why: `${derives.assertion} is gone` };
    }
    const missing = derives.symbols.filter((symbol) => !assertion.includes(symbol));
    return missing.length === 0
      ? { holds: true }
      : {
          holds: false,
          why: `${derives.assertion} no longer names ${missing.join(", ")}`,
        };
  }
  if (derives.kind === "json") {
    try {
      statSync(join(root, derives.file));
    } catch {
      return { holds: false, why: `the shape file ${derives.file} is gone` };
    }
    const basename = derives.file.split("/").at(-1);
    return readerCode.includes(basename)
      ? { holds: true }
      : { holds: false, why: `${reader.file} no longer reads ${derives.file}` };
  }
  if (derives.kind === "import") {
    const stem = derives.module.replace(/\.(?:ts|js)$/u, "");
    return readerCode.includes(stem)
      ? { holds: true }
      : {
          holds: false,
          why: `${reader.file} no longer imports ${derives.module}`,
        };
  }
  return { holds: false, why: `unknown derivation "${derives.kind}"` };
}

/** Every finding, and the two readings the verdict prints. */
export function evaluate(root) {
  // One run, one reading of the tree: the caches are per run, so a caller that edits a file between two calls (the
  // mutation proof does exactly that) reads what is on disk now rather than what it read the first time.
  SOURCE_CACHE.clear();
  RAW_CACHE.clear();
  DESKTOP_CACHE.clear();
  const mirror = scanMirrors(root);
  const keys = scanKeySequences(root);
  const codes = scanUnproducedCodes(root);
  const findings = [];
  const records = [
    ...SEAMS.map((record) => ({ ...record, resolved: true })),
    ...DEBT.map((record) => ({ ...record, resolved: false })),
  ];
  const recorded = new Set();

  for (const record of records) {
    const authority =
      declarationAt(mirror, record.authority.file, record.authority.name) ??
      declarationIn(root, record.authority.file, record.authority.name);
    if (authority === undefined) {
      findings.push(
        `stale_fact_seam:${record.fact} (${record.authority.file} no longer declares ${record.authority.name})`,
      );
      continue;
    }
    recorded.add(`${authority.file}:${authority.name}`);
    let broke = false;
    for (const reader of record.readers) {
      const declaration =
        declarationAt(mirror, reader.file, reader.name) ?? declarationIn(root, reader.file, reader.name);
      if (declaration === undefined) {
        findings.push(`stale_fact_seam:${record.fact} (${reader.file} no longer declares ${reader.name})`);
        broke = true;
        continue;
      }
      recorded.add(`${declaration.file}:${declaration.name}`);
      const drift = disagreements(authority, declaration);
      if (drift.length > 0) {
        findings.push(`fact_seam_drift:${record.fact} (${drift.join(", ")})`);
        broke = true;
      }
    }
    if (broke || !record.resolved) continue;
    const derivation = derivationHolds(root, record);
    if (!derivation.holds) findings.push(`fact_seam_underived:${record.fact} (${derivation.why})`);
  }

  for (const group of mirror.groups) {
    for (const declaration of group.declarations) {
      if (recorded.has(`${declaration.file}:${declaration.name}`)) continue;
      findings.push(`fact_declared_twice:${declaration.file}:${declaration.line} ${declaration.name}`);
    }
  }

  for (const site of keys) {
    const record = KEY_SEQUENCES.find(
      (entry) => entry.reader.file === site.file && entry.reader.schema === site.schema,
    );
    if (record === undefined) {
      if (site.thisSideOnly) continue;
      findings.push(
        `fact_declared_twice:${site.file}:${site.line} ${site.validator} over "${site.schema}" (${site.symbol ?? "inline list"})`,
      );
      continue;
    }
    if (record.derives.kind === "debt") {
      // The debt is "this list is still spelled here". A reader that has started deriving from a shape file has paid it,
      // and the record has to leave rather than describe a tree that no longer exists.
      if (site.keys.length === 0) findings.push(`stale_fact_seam:${record.fact} (${site.file} now derives it)`);
      continue;
    }
    const derivation = keyDerivationHolds(root, site, record);
    if (!derivation.holds) findings.push(`fact_seam_underived:${record.fact} (${derivation.why})`);
  }

  for (const entry of codes.unproduced) {
    findings.push(`fact_declared_unproduced:${entry.code} (declared ${entry.declaredIn})`);
  }

  return {
    mirrors: mirror,
    keys,
    codes,
    findings,
    readings: {
      facts: mirror.groups.length,
      derived: records.filter((record) => record.resolved).length,
      debt: records.filter((record) => !record.resolved).length,
      sequences: keys.length,
      crossings: keys.filter((site) => !site.thisSideOnly).length,
      // The frame records are a second population with its own verdict: a crossing over a frame another side writes
      // is one authority when its reader derives, and recorded debt while it still spells the list. Counting them
      // beside the mirrored vocabularies' totals is what lets a resolution show as movement rather than as prose.
      crossingAuthority: KEY_SEQUENCES.filter((entry) => entry.derives.kind !== "debt").length,
      crossingDebt: KEY_SEQUENCES.filter((entry) => entry.derives.kind === "debt").length,
      unproduced: codes.unproduced.length,
      codes: codes.declarations.length,
    },
  };
}

/** Does the reader's key list still come from the authority its record names? */
function keyDerivationHolds(root, site, record) {
  const code = readSource(root, site.file);
  if (record.derives.kind === "json") {
    const derived = jsonDerivation(code, site.symbol);
    if (derived === null)
      return {
        holds: false,
        why: `${site.file} states the list inline or as a literal again`,
      };
    try {
      statSync(join(root, record.derives.file));
    } catch {
      return {
        holds: false,
        why: `the shape file ${record.derives.file} is gone`,
      };
    }
    return { holds: true };
  }
  if (record.derives.kind === "asserted-by") {
    let assertion;
    try {
      assertion = readFileSync(join(root, record.derives.assertion), "utf8");
    } catch {
      return { holds: false, why: `${record.derives.assertion} is gone` };
    }
    const missing = record.derives.symbols.filter((symbol) => !assertion.includes(symbol));
    return missing.length === 0
      ? { holds: true }
      : {
          holds: false,
          why: `${record.derives.assertion} no longer names ${missing.join(", ")}`,
        };
  }
  return { holds: false, why: `unknown derivation "${record.derives.kind}"` };
}

/**
 * The key lists whose frame another side writes: one record per (reader file, frame), and HOW the reader is held to the
 * writer. `debt` is the honest third kind - the list is still a restatement, and leaving this table is the fix.
 */
export const KEY_SEQUENCES = Object.freeze([
  {
    fact: "desktop-composition acknowledgement keys",
    reader: {
      file: "tools/desktop-composition-launch.mjs",
      schema: "gamebuddy-desktop-host-bootstrap/v1",
    },
    authority: "host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts",
    derives: {
      kind: "json",
      file: "host/src/bootstrap/wire/desktop-host-bootstrap-ack.keys.json",
    },
    owner: "the desktop launch lane",
  },
  {
    fact: "desktop-composition ready frame",
    reader: {
      file: "tools/desktop-composition-launch.mjs",
      schema: "gamebuddy-desktop-composition-ready/v1",
    },
    authority: "host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts",
    derives: {
      kind: "json",
      file: "host/src/bootstrap/wire/desktop-composition-ready.keys.json",
    },
    owner: "the desktop launch lane",
  },
  {
    fact: "production generation pointer",
    reader: {
      file: "tools/desktop-composition-launch.mjs",
      schema: "gamebuddy-host-production-current/v2",
    },
    authority: "host/scripts/production-artifact.mjs",
    derives: { kind: "debt" },
    reason:
      "the publisher writes `current.json` and the launcher spells its four keys inline; the Desktop launcher reads the same pointer from C#, so three languages spell one shape",
    owner: "the release publication lane",
  },
  {
    fact: "host runtime admission",
    reader: {
      file: "tools/desktop-composition-launch.mjs",
      schema: "host-runtime-admission/v1",
    },
    authority: "host/scripts/production-artifact.mjs",
    derives: { kind: "debt" },
    reason:
      "the publisher writes the admission sidecar and the launcher spells its eleven keys inline; `desktop/GameBuddy.Desktop/InstalledHostRuntimeAdmission.cs` spells the same shape again",
    owner: "the release publication lane",
  },
  {
    fact: "guardian session hello",
    reader: {
      file: "tools/lib/guardian-role-broker.mjs",
      schema: "gamebuddy-desktop-guardian-session/v1",
    },
    authority: "desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs",
    derives: { kind: "debt" },
    reason:
      "the guardian bridge in C# writes the hello answer and this broker validates it against `HELLO_KEYS`, a list of its own; the same file also spells the command and role-exit shapes",
    owner: "the desktop guardian lane",
  },
]);

/** The gate's own command: print the reading, then the findings, then the verdict. */
function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag < 0 ? REPOSITORY_ROOT : resolve(argv[rootFlag + 1]);
  const listOnly = argv.includes("--list");
  const report = evaluate(root);

  if (listOnly) {
    for (const group of report.mirrors.groups) {
      console.log(
        `fact (${group.members.length} members): ${group.members.slice(0, 6).join(", ")}${group.members.length > 6 ? ", ..." : ""}`,
      );
      for (const declaration of group.declarations)
        console.log(
          `   ${boundaryOf(declaration.file).padEnd(13)} ${declaration.file}:${declaration.line} ${declaration.name} (${declaration.kind})`,
        );
    }
    for (const site of report.keys)
      console.log(
        `key list ${site.file}:${site.line} ${site.validator} "${site.schema}" producers ${site.producers.length}`,
      );
    return EXIT.agreed;
  }

  const { readings } = report;
  console.log(
    `facts examined ${readings.facts} · one authority ${readings.derived} · recorded debt ${readings.debt} · key sequences examined ${readings.sequences} · over a frame another side writes ${readings.crossings} (one authority ${readings.crossingAuthority} · recorded debt ${readings.crossingDebt}) · declared codes examined ${readings.codes} · unproduced ${readings.unproduced}`,
  );
  for (const finding of report.findings) console.log(`  ${finding}`);

  if (readings.facts === 0) {
    console.log("fact_seams_not_measured: the vocabulary scan read no cross-boundary fact, so nothing was compared");
    return EXIT.blocked;
  }
  if (readings.sequences === 0) {
    console.log("fact_seams_not_measured: the key-list scan read no validator call, so nothing was compared");
    return EXIT.blocked;
  }
  // The report is what `tools/replay-gate-on-history.mjs` and `tools/check-ci-coverage.mjs` read: the population is the
  // number of facts compared, never the number of findings, so a run over nothing cannot print a green report.
  console.log(
    JSON.stringify({
      gate: "fact_seams/v1",
      status: report.findings.length === 0 ? "passed" : "failed",
      population: readings.facts,
      examined: readings.facts,
      findings: report.findings.length,
      oneAuthority: readings.derived,
      recordedDebt: readings.debt,
      keySequences: readings.sequences,
      keyCrossings: readings.crossings,
      keyCrossingsDerived: readings.crossingAuthority,
      keyCrossingsRecorded: readings.crossingDebt,
      codes: readings.codes,
      unproduced: readings.unproduced,
    }),
  );
  return report.findings.length === 0 ? EXIT.agreed : EXIT.drift;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
