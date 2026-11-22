#!/usr/bin/env node
/**
 * Every directory under `host/src` holds a module; a directory whose only content is a claim is not a layer.
 *
 * The defect this closes, measured on 2026-11-17: `host/src/containment/windows/` contained exactly one file, a
 * README declaring that it owned "game-neutral private Windows containment primitives, identity probing, and process
 * handle adapters". The code it described was somewhere else - `windows-reparse-inspector/`, `windows-named-mutex-
 * broker.ts`, `games/stardew/lifecycle/stardew-process-implementations.ts` - and the README that remained was the
 * first thing a reader of `host/src/containment/` met. Every gate that walks `host/src` counted that directory as a
 * layer and inspected nothing in it, so the claim was the only evidence it existed at all. A README is a claim about
 * code; when it is the only file, the claim is all there is.
 *
 * POPULATION, derived from the tree on every run (`examined N directory(ies)` is printed): every directory at or
 * beneath `host/src`. The listing is the git index, so a lane's half-written directory is not repository content; a
 * walk that finds nothing is blocked rather than passed.
 *
 * THREE PROPERTIES, read from the tree's own bytes rather than from a list here:
 *
 *   1. A directory holds at least one source module at or beneath it. Documentation is not content. The finding is
 *      `a_directory_whose_only_content_is_a_claim:<dir>`, and it names the documents that carry the claim and - when
 *      one of them quotes a module - where that module actually lives, so the next reader is pointed at the code
 *      instead of the tombstone.
 *
 *   2. A document under `host/src` that quotes a module path quotes one the index carries. The finding is
 *      `document_claim_names_missing_source:<file>:<name>`. This is the same defect one hop later: a README that
 *      survives a move and keeps naming the old location is a claim about a file that is not there.
 *
 *   3. A game's own module lives in the game tree. Population: every tracked `host/src/**<game>-*.internal.ts` whose
 *      NAME says it owns the game's lifecycle or its coordinator - the game identities are read from `host/src/games/`
 *      itself, so a second game is covered the day its directory exists, and the words are the predicate while the
 *      population stays a directory scan. The finding is `a_game_module_lives_in_the_game_tree:<file>`.
 *
 *      WHY A STATED REASON RATHER THAN AN EXEMPTION LIST (measured 2026-11-19, this tree). The rule names two members
 *      today, and one of them cannot move: `stardew-production-lifecycle-coordinator.internal.ts` imports
 *      `composition/stardew/stardew-guardian-platform`, `composition/stardew/stardew-guardian-object-presence`,
 *      `stardew-game-install/desktop-entry-mod-deployment`, `windows-reparse-inspector`,
 *      `windows-stardew-folder-picker` and `windows-stardew-installation-discovery` - and
 *      `tools/check-host-game-physical-seam.mjs` blocks every one of those edges for a `games/**` importer. Moving it
 *      there does not relocate a module; it moves a composition root into the layer forbidden to assemble anything, and
 *      the placement rule and the seam rule disagree about a category neither named: a game-specific COMPOSITION
 *      module. The row below is that measurement, and the gate re-proves it on every run by asking whether those
 *      imports are still in the file. When someone inverts them (a capability injected instead), the row expires and
 *      the gate says so - `stated_placement_reason_expired`.
 *
 *      The rule is only worth having if it can still fail, so it is proven on `stardew-game-lifecycle-state.internal.ts`
 *      and `stardew-role-lifecycle-projection.internal.ts`, which moved into `host/src/games/stardew/lifecycle/` under
 *      it. Both are pure game logic with no such edge; the `selfCheck` below drives the same predicate over a scratch
 *      tree in both directions on every verdict.
 *
 *     node tools/check-host-source-directories.mjs          # the verdict; exit 1 on a gap, 2 on a blocked reading
 *     node tools/check-host-source-directories.mjs --list   # the population and what each directory holds
 *
 * red-proof: self-check  a scratch tree whose one directory holds only a README -> the finding names that directory,
 *                    `a_directory_whose_only_content_is_a_claim` plus `document_claim_names_missing_source` for the
 *                    module the README quotes and the tree does not carry, while the same tree with both files added
 *                    is silent (tools/check-host-source-directories.mjs)
 * red-proof: self-check  a scratch tree holding one game module flat (`other-game-lifecycle-widget.internal.ts`) ->
 *                    `a_game_module_lives_in_the_game_tree` naming that module and its directory, while the same file
 *                    under the scratch tree's `games/other/lifecycle/` is silent; and a stated row whose claimed
 *                    import is gone -> `stated_placement_reason_expired` (tools/check-host-source-directories.mjs).
 *                    The scratch paths are written without the `host/src/` prefix on purpose: the red-proof ledger
 *                    resolves every repository path a marker names, and a path that only exists inside the tree the
 *                    falsifier builds is `pointer_missing` rather than a claim it can check (measured 2026-11-19).
 */

export const gateDeclaration = {
  id: "check-host-source-directories",
  domain: "arch",
  tier: "l1",
  kind: "contract",
};

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const ROOT = repositoryRoot(import.meta.url);
const SOURCE_ROOT = "host/src";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const DOCUMENT_EXTENSION = ".md";
// A quoted module path is a claim about a file. A glob (`*.ts`) is a shape, `<path>` is usage prose, and a
// URL or an absolute path belongs to another authority - none of them promise a module here.
const QUOTED_MODULE = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))`/gu;

const GAMES_ROOT = `${SOURCE_ROOT}/games`;
const PRIVATE_MODULE_SUFFIX = ".internal.ts";
// A module's name says which part of the game it owns. `internal` already means "private to its layer"; the words
// below are the parts of a game that belong beside the game rather than beside the Host that runs it.
const GAME_OWNED_NAME = /(?:^|[-.])(?:lifecycle|coordinator)(?:[-.]|$)/u;

/**
 * The one stated reason, as data rather than prose: the gate reads the imports back out of the file on every run, so
 * the reason cannot drift into "known exception" while the code underneath it changes.
 */
export const STATED_GAME_MODULE_PLACEMENT = new Map([
  [
    `${SOURCE_ROOT}/stardew-production-lifecycle-coordinator.internal.ts`,
    {
      reason:
        "a composition root, not game logic: it assembles the Stardew guardian platform and the desktop/native seams, " +
        "and `tools/check-host-game-physical-seam.mjs` blocks those imports under `host/src/games/`",
      blockedBy: [
        "./stardew-game-install/desktop-entry-mod-deployment.js",
        "./windows-reparse-inspector/index.js",
        "./composition/stardew/stardew-guardian-object-presence.js",
        "./windows-stardew-folder-picker/index.js",
        "./windows-stardew-installation-discovery/index.js",
        "./composition/stardew/stardew-guardian-platform.js",
      ],
    },
  ],
]);

const isSource = (path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
const isDocument = (path) => path.endsWith(DOCUMENT_EXTENSION);
const basenameOf = (path) => path.split("/").at(-1) ?? "";
const directoryOf = (path) => path.split("/").slice(0, -1).join("/");

/** Every game identity the tree ships, read from `host/src/games/` rather than from a list here. */
export function gameIdentities({ trackedFiles }) {
  const found = new Set();
  for (const path of trackedFiles) {
    if (!path.startsWith(`${GAMES_ROOT}/`)) continue;
    const segments = path.split("/");
    if (segments.length < 5) continue;
    found.add(segments[3]);
  }
  return [...found].sort();
}

/**
 * The population: a game's own `*.internal.ts` module whose name owns its lifecycle or its coordinator, wherever it
 * currently sits under `host/src`. A flat module and a module already in the tree are the same member of the same
 * class, which is what lets the gate count how many are in the tree rather than only how many are not.
 */
export function gameModules({ trackedFiles }) {
  const identities = gameIdentities({ trackedFiles });
  return trackedFiles
    .filter((path) => path.startsWith(`${SOURCE_ROOT}/`) && path.endsWith(PRIVATE_MODULE_SUFFIX))
    .filter((path) => {
      const name = basenameOf(path);
      return identities.some((game) => name.startsWith(`${game}-`)) && GAME_OWNED_NAME.test(name);
    })
    .sort();
}

const importsOf = (text) => [...text.matchAll(/(?:from|import)\s*"([^"]+)"/gu)].map((match) => match[1]);

/**
 * One placement verdict over one tree.
 *
 * `read` is injected so the falsifier drives the same rule over a scratch tree instead of a second copy of it.
 */
export function checkGameModulePlacement({ trackedFiles, read = () => null }) {
  const modules = gameModules({ trackedFiles });
  const identities = gameIdentities({ trackedFiles });
  const findings = [];
  const statements = [];
  let inTree = 0;
  let stated = 0;
  for (const path of modules) {
    const game = identities.find((identity) => basenameOf(path).startsWith(`${identity}-`));
    const directory = directoryOf(path);
    if (directory === `${GAMES_ROOT}/${game}` || directory.startsWith(`${GAMES_ROOT}/${game}/`)) {
      inTree += 1;
      continue;
    }
    const statement = STATED_GAME_MODULE_PLACEMENT.get(path);
    if (statement === undefined) {
      findings.push({ kind: "a_game_module_lives_in_the_game_tree", module: path, game });
      continue;
    }
    const text = read(path);
    if (text === null || text === undefined) {
      findings.push({
        kind: "stated_placement_reason_expired",
        module: path,
        detail: "the module the reason is about is not in this tree",
        missing: [],
      });
      continue;
    }
    const present = new Set(importsOf(text));
    const missing = statement.blockedBy.filter((specifier) => !present.has(specifier));
    if (missing.length > 0) {
      findings.push({
        kind: "stated_placement_reason_expired",
        module: path,
        detail: "the reason names imports this module no longer makes, so the placement rule now applies to it",
        missing,
      });
      continue;
    }
    stated += 1;
    statements.push({ module: path, reason: statement.reason, blockedBy: statement.blockedBy });
  }
  // An exemption must expire: a row that names a module this tree carries but no longer flat - moved into the tree,
  // or no longer a member - is a claim about nothing, and the next reader would read it as a standing permission.
  // A row about a file the tree does not carry at all is measured by the tree that carries it, not by this one.
  for (const path of STATED_GAME_MODULE_PLACEMENT.keys()) {
    if (modules.includes(path)) continue;
    const name = basenameOf(path);
    const movedTo = trackedFiles.find((file) => file !== path && basenameOf(file) === name);
    if (!trackedFiles.includes(path) && movedTo === undefined) continue;
    findings.push({
      kind: "stated_placement_reason_expired",
      module: path,
      detail:
        movedTo === undefined
          ? "no longer a flat game module, so the row must be deleted"
          : `it now lives at ${movedTo}, so the row must be deleted`,
      missing: [],
    });
  }
  return {
    examined: modules.length,
    inTree,
    stated,
    findings,
    statements,
    blocked:
      identities.length > 0 && modules.length === 0
        ? [`game_module_placement_read_nothing: examined 0 module(s) in a tree that ships game identities`]
        : [],
  };
}

/**
 * The directories under `host/src` and the tracked files that give them content.
 *
 * A directory is "documentation only" when no source module is tracked at or beneath it. The documents are the
 * `.md` files tracked directly in it, because that is the file a reader meets before any subdirectory.
 */
export function hostSourceDirectories({ trackedFiles }) {
  const under = trackedFiles.filter((path) => path === SOURCE_ROOT || path.startsWith(`${SOURCE_ROOT}/`));
  const sources = under.filter(isSource);
  const directories = new Map();
  for (const path of under) {
    const segments = path.split("/");
    // Every directory between `host/src` and the file itself is a member, so a directory that holds only
    // subdirectories is examined too and its claim is read.
    for (let depth = 2; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      if (!directories.has(directory)) directories.set(directory, []);
    }
    if (isDocument(path)) directories.get(segments.slice(0, -1).join("/"))?.push(path);
  }
  return [...directories.entries()]
    .map(([directory, documents]) => ({
      directory,
      documents: documents.sort(),
      sources: sources.filter((path) => path.startsWith(`${directory}/`)),
    }))
    .sort((a, b) => (a.directory < b.directory ? -1 : 1));
}

/** Where a module a document quotes actually is: the tracked paths the quote could name, if any.
 *
 * A document quotes a module the way a reader resolves it - relative to the document's own directory (`../x.ts`,
 * `index.ts`) or as a path from the top of the tree (`composition/stardew/x.ts`). Both readings are tried, and the
 * quote is also accepted as a suffix so a document may name a module by its tail.
 */
export function quotedModuleResolution(name, trackedFiles, fromDirectory = "") {
  const verbatim = name.replace(/^\.\//u, "");
  const relative = posix.normalize(posix.join(fromDirectory, verbatim)).replace(/^\.\//u, "");
  const candidates = [...new Set([verbatim, relative])];
  return trackedFiles.filter((path) =>
    candidates.some((candidate) => path === candidate || path.endsWith(`/${candidate}`)),
  );
}

/**
 * The gate's verdict over one tree.
 *
 * `read` is injected so the falsifier drives the same rule over a scratch tree instead of a second copy of it.
 */
export function checkHostSourceDirectories({
  root = ROOT,
  trackedFiles,
  read = (path) => readFileSync(resolve(root, path), "utf8"),
} = {}) {
  const directoryRecords = hostSourceDirectories({ trackedFiles });
  const findings = [];
  for (const record of directoryRecords) {
    if (record.sources.length > 0) continue;
    const quoted = [
      ...new Set(
        record.documents.flatMap((document) =>
          [...(read(document).matchAll(QUOTED_MODULE) ?? [])].map((match) => match[1]),
        ),
      ),
    ];
    const elsewhere = quoted
      .map((name) => ({
        name,
        at: quotedModuleResolution(name, trackedFiles, posix.dirname(record.directory)),
      }))
      .filter((entry) => entry.at.length > 0 && !entry.at.some((path) => path.startsWith(`${record.directory}/`)));
    findings.push({
      kind: "a_directory_whose_only_content_is_a_claim",
      directory: record.directory,
      documents: record.documents,
      claimedElsewhere: elsewhere,
    });
  }
  for (const path of trackedFiles.filter((file) => file.startsWith(`${SOURCE_ROOT}/`) && isDocument(file))) {
    for (const match of new Set([...(read(path).matchAll(QUOTED_MODULE) ?? [])].map((found) => found[1]))) {
      if (quotedModuleResolution(match, trackedFiles, posix.dirname(path)).length > 0) continue;
      findings.push({ kind: "document_claim_names_missing_source", document: path, name: match });
    }
  }
  const placement = checkGameModulePlacement({
    trackedFiles,
    read: (path) => {
      try {
        return read(path);
      } catch {
        return null;
      }
    },
  });
  return {
    examined: directoryRecords.length,
    examinedDocuments: directoryRecords.reduce((total, record) => total + record.documents.length, 0),
    directories: directoryRecords.map((record) => ({
      directory: record.directory,
      sources: record.sources.length,
      documents: record.documents.length,
    })),
    placement,
    findings: [...findings, ...placement.findings],
    blocked: [
      ...(directoryRecords.length === 0
        ? [`host_source_directories_read_nothing: examined 0 directory(ies) under ${SOURCE_ROOT}`]
        : []),
      ...placement.blocked,
    ],
  };
}

function trackedFilesOf(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => path.replaceAll("\\", "/"));
}

function describeFinding(finding) {
  if (finding.kind === "a_directory_whose_only_content_is_a_claim") {
    const documents = finding.documents.length === 0 ? "no document at all" : finding.documents.join(", ");
    const moved =
      finding.claimedElsewhere.length === 0
        ? "it quotes no module that exists elsewhere, so nothing says where the code went"
        : finding.claimedElsewhere.map((entry) => `\`${entry.name}\` is at ${entry.at.join(" or ")}`).join("; ");
    return (
      `${finding.kind}:${finding.directory} - ${documents} is the only content left; ${moved}. ` +
      `Delete the directory, or hold the module it claims (README.md's placement rule: move game assembly to ` +
      `composition and keep platform primitives where they are implemented).`
    );
  }
  if (finding.kind === "a_game_module_lives_in_the_game_tree") {
    return (
      `${finding.kind}:${finding.module} - this is ${finding.game} lifecycle logic sitting flat beside the Host that ` +
      `runs it. Move it under ${GAMES_ROOT}/${finding.game}/, or add a stated row to ` +
      "STATED_GAME_MODULE_PLACEMENT whose imports the gate can re-read and find."
    );
  }
  if (finding.kind === "stated_placement_reason_expired") {
    const names = finding.missing.length === 0 ? "" : ` Missing: ${finding.missing.join(", ")}.`;
    return `${finding.kind}:${finding.module} - ${finding.detail}.${names}`;
  }
  return (
    `${finding.kind}:${finding.document}:${finding.name} - no tracked file in this tree has that name, ` +
    "so the document points at a module that does not exist."
  );
}

function main(
  argv,
  {
    root = ROOT,
    write = (line) => process.stdout.write(line),
    writeError = (line) => process.stderr.write(line),
    verifyRules = true,
  } = {},
) {
  const listing = argv.includes("--list");
  const trackedFiles = trackedFilesOf(root);
  if (listing) {
    for (const record of hostSourceDirectories({ trackedFiles })) {
      write(`directory\t${record.directory}\tsources=${record.sources.length}\tdocuments=${record.documents.length}\n`);
    }
    const placement = checkGameModulePlacement({
      trackedFiles,
      read: (path) => {
        try {
          return readFileSync(resolve(root, path), "utf8");
        } catch {
          return null;
        }
      },
    });
    for (const path of gameModules({ trackedFiles })) write(`module\t${path}\n`);
    write(
      `modules examined ${placement.examined} \u00b7 in-tree ${placement.inTree} \u00b7 ` +
        `stated ${placement.stated} \u00b7 findings ${placement.findings.length}\n`,
    );
    return 0;
  }
  const report = checkHostSourceDirectories({ root, trackedFiles });
  const checks = verifyRules ? selfCheck() : [];
  const failedChecks = checks.filter((entry) => entry.status !== "passed");
  write(
    `${JSON.stringify({
      gate: "host_source_directories/v1",
      status:
        report.blocked.length === 0 && report.findings.length === 0 && failedChecks.length === 0 ? "passed" : "failed",
      examined: report.examined,
      examinedDocuments: report.examinedDocuments,
      modulesExamined: report.placement.examined,
      modulesInTree: report.placement.inTree,
      modulesStated: report.placement.stated,
      findings: report.findings.length,
      ...(report.blocked.length === 0 ? {} : { blocked: report.blocked }),
      ...(checks.length === 0 ? {} : { checks }),
    })}\n`,
  );
  // The stated rows print their imports, so the reason cannot drift into "known exception": a reader of the verdict
  // sees exactly which edges keep the module out of the game tree.
  for (const statement of report.placement.statements) {
    write(`stated\t${statement.module}\t${statement.reason}\n`);
    for (const specifier of statement.blockedBy) write(`stated-blocked-by\t${statement.module}\t${specifier}\n`);
  }
  if (failedChecks.length > 0) {
    writeError(
      `host_source_directories_self_check_failed: ${failedChecks
        .map((entry) => `${entry.id}: ${entry.detail}`)
        .join("; ")}\n`,
    );
    return 1;
  }
  for (const line of report.blocked) writeError(`✖ ${line}\n`);
  for (const finding of report.findings) writeError(`✖ ${describeFinding(finding)}\n`);
  write(
    `host_source_directories examined ${report.examined} directory(ies) and ${report.examinedDocuments} ` +
      `document(s); findings ${report.findings.length}\n`,
  );
  write(
    `modules examined ${report.placement.examined} \u00b7 in-tree ${report.placement.inTree} \u00b7 ` +
      `stated ${report.placement.stated} \u00b7 findings ${report.placement.findings.length}\n`,
  );
  return report.blocked.length === 0 && report.findings.length === 0 ? 0 : 1;
}

/**
 * The falsifier, run on every verdict: the gate's own claim driven over two scratch trees.
 *
 * The defect tree holds one directory whose only content is a README that calls itself a component, and a second
 * document that quotes a module the tree does not have. The control adds the module the first claims and the file the
 * second names, so a gate that failed on any tree would pass the first check and fail the second.
 */
function selfCheckTree({ fill }) {
  const root = mkdtempSync(join(tmpdir(), "host-source-directories-"));
  mkdirSync(resolve(root, SOURCE_ROOT, "thing"), { recursive: true });
  mkdirSync(resolve(root, SOURCE_ROOT, "holder"), { recursive: true });
  writeFileSync(
    resolve(root, SOURCE_ROOT, "thing", "README.md"),
    "# Thing\n\n## Owns\nPrivate primitives and process handle adapters.\n\n## Placement\n" +
      (fill ? "Implemented here as `index.ts`.\n" : "Code moved to `host/src/elsewhere/gone.ts`.\n"),
  );
  writeFileSync(resolve(root, SOURCE_ROOT, "holder", "index.ts"), "export const held = true;\n");
  writeFileSync(resolve(root, SOURCE_ROOT, "holder", "README.md"), "# Holder\n\nHolds `index.ts`.\n");
  if (fill) writeFileSync(resolve(root, SOURCE_ROOT, "thing", "index.ts"), "export const thing = true;\n");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in the falsifier tree: ${result.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  return root;
}

function runVerdict(root) {
  const printed = [];
  const errors = [];
  const exitCode = main([], {
    root,
    write: (line) => printed.push(line),
    writeError: (line) => errors.push(line),
    verifyRules: false,
  });
  return { exitCode, stdout: printed.join(""), stderr: errors.join("") };
}

/** A file body that makes every import the one stated row claims, built from the row rather than copied beside it. */
const INTACT_STATEMENT = [...STATED_GAME_MODULE_PLACEMENT.values()][0].blockedBy
  .map((specifier) => `import "${specifier}";`)
  .join("\n");

export function selfCheck() {
  const checks = [];
  const record = (id, ok, detail) => checks.push({ id, status: ok ? "passed" : "failed", detail });
  const defect = selfCheckTree({ fill: false });
  const control = selfCheckTree({ fill: true });
  try {
    const failed = runVerdict(defect);
    const claim = "a_directory_whose_only_content_is_a_claim:host/src/thing";
    const missing = "document_claim_names_missing_source:host/src/thing/README.md:host/src/elsewhere/gone.ts";
    const named = failed.exitCode === 1 && failed.stderr.includes(claim) && failed.stderr.includes(missing);
    record(
      "a_directory_whose_only_content_is_a_claim_is_named_with_where_the_code_went",
      named,
      named
        ? `${claim} and ${missing}`
        : `exit ${failed.exitCode}, printed ${JSON.stringify(failed.stderr.slice(0, 400))}`,
    );

    const passed = runVerdict(control);
    const silent = passed.exitCode === 0 && passed.stderr === "";
    record(
      "the_same_tree_with_its_module_is_silent",
      silent,
      silent ? "exit 0, no finding" : `exit ${passed.exitCode}, printed ${JSON.stringify(passed.stderr.slice(0, 400))}`,
    );

    // A game's own module, in both directions. The member is a name the predicate derives, not a file this checkout
    // happens to hold, so the rule can be shown red after the two modules it names today are where they belong.
    const flatModule = `${SOURCE_ROOT}/other-game-lifecycle-widget.internal.ts`;
    const movedModule = `${SOURCE_ROOT}/games/other/lifecycle/other-game-lifecycle-widget.internal.ts`;
    const gameTree = [`${GAMES_ROOT}/other/README.md`, `${GAMES_ROOT}/stardew/README.md`];
    const flat = checkGameModulePlacement({ trackedFiles: [...gameTree, flatModule], read: () => 'import "x.js";\n' });
    const flatNamed =
      flat.findings.length === 1 &&
      flat.findings[0].kind === "a_game_module_lives_in_the_game_tree" &&
      flat.findings[0].module === flatModule &&
      flat.examined === 1 &&
      flat.inTree === 0 &&
      flat.stated === 0;
    record(
      "a_game_module_left_flat_is_named_by_its_path",
      flatNamed,
      flatNamed ? `examined 1 \u00b7 in-tree 0 \u00b7 stated 0, naming ${flatModule}` : JSON.stringify(flat),
    );
    const moved = checkGameModulePlacement({ trackedFiles: [...gameTree, movedModule], read: () => null });
    const movedSilent = moved.findings.length === 0 && moved.inTree === 1 && moved.examined === 1;
    record(
      "the_same_module_in_the_game_tree_is_silent",
      movedSilent,
      movedSilent ? "examined 1 \u00b7 in-tree 1 \u00b7 stated 0, no finding" : JSON.stringify(moved),
    );
    // The stated row is a claim about the file's imports, so it expires where those imports stop being made.
    const statedPath = [...STATED_GAME_MODULE_PLACEMENT.keys()][0];
    const intact = checkGameModulePlacement({ trackedFiles: [...gameTree, statedPath], read: () => INTACT_STATEMENT });
    const intactStated = intact.findings.length === 0 && intact.stated === 1 && intact.statements.length === 1;
    record(
      "a_stated_row_whose_imports_are_present_is_accepted_and_printed",
      intactStated,
      intactStated
        ? `stated 1 with ${intact.statements[0].blockedBy.length} printed import(s)`
        : JSON.stringify(intact),
    );
    const expired = checkGameModulePlacement({
      trackedFiles: [...gameTree, statedPath],
      read: () => 'import "x.js";\n',
    });
    const expiredNamed =
      expired.findings.length === 1 && expired.findings[0].kind === "stated_placement_reason_expired";
    record(
      "a_stated_row_whose_imports_are_gone_expires",
      expiredNamed,
      expiredNamed
        ? `${expired.findings[0].kind} naming ${expired.findings[0].missing.length} absent import(s)`
        : JSON.stringify(expired),
    );
  } finally {
    rmSync(defect, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
  return checks;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
