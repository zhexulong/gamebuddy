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
 * TWO PROPERTIES, both read from the directory's own bytes rather than from a list here:
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
 *     node tools/check-host-source-directories.mjs          # the verdict; exit 1 on a gap, 2 on a blocked reading
 *     node tools/check-host-source-directories.mjs --list   # the population and what each directory holds
 *
 * red-proof: self-check  a scratch tree whose one directory holds only a README -> the finding names that directory,
 *                    `a_directory_whose_only_content_is_a_claim` plus `document_claim_names_missing_source` for the
 *                    module the README quotes and the tree does not carry, while the same tree with both files added
 *                    is silent (tools/check-host-source-directories.mjs)
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
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = "host/src";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const DOCUMENT_EXTENSION = ".md";
// A quoted module path is a claim about a file. A glob (`*.ts`) is a shape, `<path>` is usage prose, and a
// URL or an absolute path belongs to another authority - none of them promise a module here.
const QUOTED_MODULE = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))`/gu;

const isSource = (path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
const isDocument = (path) => path.endsWith(DOCUMENT_EXTENSION);

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
  return {
    examined: directoryRecords.length,
    examinedDocuments: directoryRecords.reduce((total, record) => total + record.documents.length, 0),
    directories: directoryRecords.map((record) => ({
      directory: record.directory,
      sources: record.sources.length,
      documents: record.documents.length,
    })),
    findings,
    blocked:
      directoryRecords.length === 0
        ? [`host_source_directories_read_nothing: examined 0 directory(ies) under ${SOURCE_ROOT}`]
        : [],
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
      findings: report.findings.length,
      ...(report.blocked.length === 0 ? {} : { blocked: report.blocked }),
      ...(checks.length === 0 ? {} : { checks }),
    })}\n`,
  );
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
  } finally {
    rmSync(defect, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
  return checks;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
