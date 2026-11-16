/**
 * Does a user-level agent file still agree with the definition it shadows?
 *
 * `pi-subagents` resolves an agent by name through four layers, last writer wins per scope:
 * builtin < package < user < project (`mergeAgentsForScope`, `src/agents/agent-selection.js:1-22`). A file we write
 * into the user layer therefore replaces the package's definition of that name for every cwd whose project has no
 * `.pi/agents/<name>.md` - including every worktree, because a worktree is its own project root and carries no
 * `.pi/agents`. The replacement is silent: no warning, no listing, no failure.
 *
 * Why that silence costs hours: `async-execution.js:1094` resolves a run's deadline as
 * `agent.defaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS`, and `DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1000`
 * (`async-execution.js:148`). The global `subagents.timeoutMs` in `settings.json` is never read on the async path.
 * So a user copy of `worker` that forgot `timeoutMs` kills every lane at 30 minutes while looking identical to its
 * source on every other line.
 *
 * THE POPULATION IS THE DIRECTORY THE LOADER READS, NOT THE ONE WE BELIEVE WE WROTE TO.
 *
 * Measured 2026-11-16 by executing the loader (`discoverAgentSnapshot`) rather than reading paths out of it:
 * `PI_CODING_AGENT_DIR=D:\PiData\agent` - a User-scope environment variable - makes `D:\PiData\agent\agents` the
 * user layer, and `C:\Users\long\.pi\agent\agents`, where the timeout copies had been written, is never scanned at
 * all. Every lane launched from a worktree resolved
 * `worker <- user D:\PiData\agent\agents\worker.md timeoutMs=NONE`: the fix was inert and the kill was still live.
 * A gate that measured the directory named in the incident report would have printed green forever.
 *
 * So every user-level directory is examined, and each line says whether the loader scans it. A reading over a
 * directory nothing reads is reported as `loader-scanned no`, never as a pass. `PI_CODING_AGENT_DIR` is printed
 * with it, because nothing else in this repository records the value that decides the layer, and a typo in it
 * empties the whole layer the same way.
 *
 * DECLARATIONS TRAVEL WITH THE FILE, NOT WITH THIS GATE. The exception belongs to the file it exempts:
 *
 *   tracks: none             this file is not a copy of anything upstream - it is a different agent whose name
 *                            collides with one. Its body is not compared; it is printed as `not-a-copy`.
 *   tracks: <path>           compare against this definition (relative paths resolve from this file's directory).
 *   override: a, b, body     frontmatter keys, and/or `body`, allowed to differ from the tracked definition.
 *
 * An omitted `tracks:` while an upstream definition of that name exists is itself a finding: that file is a shadow
 * that does not say whether it is a copy.
 *
 * red-proof: inject  change one body line of `agents/worker.md` in the package copy -> the gate names the file that
 *                    must change and quotes both halves, exit 1 (see check-agent-overrides.test.mjs)
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runWhenEntry } from "./cli-entry.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Keys this gate owns: they describe the file's relation to its source, so they are never compared against it. */
const DECLARATION_KEYS = new Set(["tracks", "override"]);

/** Directory names the loader refuses to descend into while looking for definitions (`DISCOVERY_PRUNED_DIR_NAMES`). */
const PRUNED_DIR_NAMES = new Set([".git", "node_modules", ".pi", "sync-backups"]);

/** `getAgentDir()`: `PI_CODING_AGENT_DIR`, `~`-expanded, else `<home>/.pi/agent`. */
export function expandHome(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/** Escape regex special characters, so a literal prefix matches itself. */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The frontmatter keys and the body of one definition file.
 *
 * A port of the loader's own parser (`src/agents/frontmatter.js`), because the comparison here must see the same
 * keys the loader sees: a nested block value is one value, not a key per line, and a `---` that never closes means
 * the whole file is body.
 */
export function parseFrontmatter(text) {
  const frontmatter = {};
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return { frontmatter, body: normalized.trim() };
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, body: normalized.trim() };
  const body = normalized.slice(endIndex + 4).trim();
  let key = null;
  let blockLines = null;
  const flush = () => {
    if (key === null || blockLines === null) return;
    // The block's own indentation is not part of its value: the loader strips the common prefix before storing it, so
    // an agent file that indents a list by two spaces does not differ from one that indents it by four.
    const raw = blockLines.join("\n");
    const prefix = raw.match(/^[ \t]+(?=\S)/m)?.[0] ?? "";
    const stripped = prefix ? raw.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/u, "") : raw;
    frontmatter[key] = stripped.trimEnd();
    key = null;
    blockLines = null;
  };
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const indented = line.trim() !== "" && /^\s/.test(line);
    if (key !== null && blockLines !== null && (indented || line.trim() === "")) {
      blockLines.push(line);
      continue;
    }
    flush();
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const raw = match[2].trim();
    const quoted = (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
    if (raw === "" || (!quoted && (raw.startsWith(">") || raw.startsWith("|")))) {
      key = match[1];
      blockLines = [];
      continue;
    }
    frontmatter[match[1]] = quoted ? raw.slice(1, -1) : raw;
  }
  flush();
  return { frontmatter, body };
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the loader steps over this directory while scanning for definitions.
 *
 * Mirrors `shouldPruneDiscoveryDir`: a pruned name, a directory that is its own repository, or a nested project root
 * (a directory that carries its own `.pi` or `.agents`). The last rule is why `<repo>/.agents/subagents/*.md` is
 * still read: only a directory that *contains* a project root is skipped, not the project's own scan root.
 */
function prunesDiscovery(rootDir, dirPath, dirName) {
  if (PRUNED_DIR_NAMES.has(dirName)) return true;
  if (existsSync(join(dirPath, ".git"))) return true;
  if (resolve(dirPath) === resolve(rootDir)) return false;
  return isDirectory(join(dirPath, ".pi")) || isDirectory(join(dirPath, ".agents"));
}

/**
 * Whether this file lives under a legacy `.agents/skills` tree, which the loader never reads as a definition.
 *
 * Mirrors `isLegacyAgentSkillPath`. Without it the project layer here was 76 definitions where the loader sees 7:
 * `.agents/skills/**` carries prose documents (guides, checklists) that happen to end in `.md`.
 */
function isLegacyAgentSkillPath(rootDir, filePath) {
  const parts = relative(rootDir, filePath)
    .split(sep)
    .map((part) => part.toLowerCase());
  if (basename(rootDir).toLowerCase() === ".agents") parts.unshift(".agents");
  return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}

/** Every `*.md` definition file the loader would read under `dir`, in the loader's own order. */
export function readDefinitionFiles(dir) {
  const files = [];
  if (!isDirectory(dir)) return files;
  const visited = new Set();
  const visit = (current) => {
    let real;
    try {
      real = realpathSync(current);
    } catch {
      real = resolve(current);
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = join(current, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          directory = statSync(filePath).isDirectory();
        } catch {
          directory = false;
        }
      }
      if (directory) {
        if (!prunesDiscovery(dir, filePath, entry.name)) visit(filePath);
        continue;
      }
      if (entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md") && !isLegacyAgentSkillPath(dir, filePath)) {
        files.push(filePath);
      }
    }
  };
  visit(dir);
  return files;
}

/** One definition file as the comparison sees it. */
export function readDefinition(filePath) {
  const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
  return { path: resolve(filePath), frontmatter, body, name: frontmatter.name };
}

/** Definitions indexed by declared name; the last file to claim a name wins, as in the loader's own maps. */
export function indexDefinitions(dir) {
  const index = new Map();
  for (const filePath of readDefinitionFiles(dir)) {
    const definition = readDefinition(filePath);
    if (typeof definition.name === "string" && definition.name.length > 0) index.set(definition.name, definition);
  }
  return index;
}

/**
 * The user-level directories, each tagged with whether the loader reads it.
 *
 * `scanned` is what the loader does with the directory, never what we wish: `<agent dir>/agents`,
 * `~/.agents`, `PI_SUBAGENT_EXTRA_AGENT_DIRS` and the user settings' `subagents.agentScanDirs` are read
 * (`agents.js:2349-2372`), while `<home>/.pi/agent/agents` is read only when `PI_CODING_AGENT_DIR` points there.
 */
export function resolveUserAgentDirs({ home, agentDir, agentDirFromEnv, extraDirs, scanDirs }) {
  const dirs = new Map();
  const add = (path, source, scanned) => {
    const resolved = resolve(path);
    const existing = dirs.get(resolved);
    if (existing) {
      existing.scanned = existing.scanned || scanned;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    dirs.set(resolved, { path: resolved, sources: [source], scanned });
  };
  for (const dir of extraDirs) add(dir, "PI_SUBAGENT_EXTRA_AGENT_DIRS", true);
  for (const dir of scanDirs) add(dir, "settings subagents.agentScanDirs", true);
  add(join(agentDir, "agents"), agentDirFromEnv ? "from PI_CODING_AGENT_DIR" : "from home .pi/agent", true);
  add(join(home, ".agents"), "from home .agents", true);
  // The directory a home-grown copy lands in when the agent dir points elsewhere. The loader does not read it,
  // which is the one fact about it a reader needs, so it is examined and tagged rather than left out.
  add(join(home, ".pi", "agent", "agents"), "from home .pi/agent", false);
  return [...dirs.values()];
}

function declarationList(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** The first line where two bodies disagree, or null when they agree. */
export function firstBodyDifference(userBody, trackedBody) {
  const user = String(userBody ?? "").split("\n");
  const tracked = String(trackedBody ?? "").split("\n");
  const longest = Math.max(user.length, tracked.length);
  for (let index = 0; index < longest; index += 1) {
    if ((user[index] ?? null) === (tracked[index] ?? null)) continue;
    return {
      line: index + 1,
      user: user[index] ?? "<body ends here>",
      tracked: tracked[index] ?? "<body ends here>",
    };
  }
  return null;
}

/** Fields whose value (or presence) differs between the two definitions, body included. */
function differingFields(user, tracked) {
  const fields = new Set();
  for (const key of new Set([...Object.keys(user.frontmatter), ...Object.keys(tracked.frontmatter)])) {
    if (DECLARATION_KEYS.has(key)) continue;
    if (user.frontmatter[key] !== tracked.frontmatter[key]) fields.add(key);
  }
  return fields;
}

function isInside(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export function judgeUserFile(file, { project, packageIndex, packageDir, repoRoot }) {
  const name = file.frontmatter.name;
  const declared = declarationList(file.frontmatter.override);
  const tracks = String(file.frontmatter.tracks ?? "").trim();
  const notACopy = tracks === "none";
  const collidesWith = project.get(name) ?? packageIndex.get(name) ?? null;
  const { kind, tracked, target } = resolveTracked(file, collidesWith, { tracks, repoRoot, packageDir });
  const judgement = { name, path: file.path, loaderScanned: file.loaderScanned, declared };

  if (target !== null) {
    const finding = { code: "tracked_source_missing", name, field: "tracks", path: file.path, trackedPath: target };
    return { ...judgement, kind, trackedPath: target, findings: [finding] };
  }
  if (tracked === null) {
    // Nothing to compare, so every declared exception is an exception to nothing.
    const findings = declared.map((field) => ({ code: "agent_override_stale", name, field, path: file.path }));
    return { ...judgement, kind, trackedPath: null, findings };
  }

  const findings = compareWithTracked(file, tracked, declared, { name, compareBody: !notACopy });
  if (!notACopy && tracks.length === 0) {
    findings.unshift({
      code: "agent_override_undeclared",
      name,
      field: "tracks",
      path: file.path,
      trackedPath: tracked.path,
      shadow: true,
    });
  }
  return { ...judgement, kind, trackedPath: tracked.path, findings };
}

/** Which definition a file is held to, and what to call that relation. */
function resolveTracked(file, collidesWith, { tracks, repoRoot, packageDir }) {
  if (tracks === "none") return { kind: "not-a-copy", tracked: collidesWith, target: null };
  if (tracks.length > 0) {
    const target = resolve(dirname(file.path), tracks);
    const kind = sourceKind(target, repoRoot, packageDir);
    return {
      kind,
      tracked: existsSync(target) ? readDefinition(target) : null,
      target: existsSync(target) ? null : target,
    };
  }
  if (!collidesWith) return { kind: "no-upstream", tracked: null, target: null };
  const kind = isInside(repoRoot, collidesWith.path) ? "project" : "package";
  return { kind, tracked: collidesWith, target: null };
}

function sourceKind(target, repoRoot, packageDir) {
  if (isInside(repoRoot, target)) return "project";
  if (isInside(packageDir, target)) return "package";
  return "explicit";
}

/** One file's frontmatter and body against the definition it tracks. */
function compareWithTracked(file, tracked, declared, { name, compareBody }) {
  const findings = [];
  const differing = differingFields(file, tracked);
  const bodyDiffers = file.body !== tracked.body;
  if (bodyDiffers && compareBody) differing.add("body");

  for (const field of differing) {
    if (declared.includes(field)) continue;
    findings.push({
      code: "agent_override_undeclared",
      name,
      field,
      path: file.path,
      trackedPath: tracked.path,
      bodyDifference: field === "body" ? firstBodyDifference(file.body, tracked.body) : null,
      userValue: field === "body" ? null : (file.frontmatter[field] ?? null),
      trackedValue: field === "body" ? null : (tracked.frontmatter[field] ?? null),
    });
  }
  for (const field of declared) {
    // `body` is judged by whether the bodies still differ, in both modes: it declares a deliberate divergence, so
    // bodies that became identical mean the declaration outlived its reason.
    const stillDiffers = field === "body" ? bodyDiffers : differing.has(field);
    if (stillDiffers) continue;
    findings.push({ code: "agent_override_stale", name, field, path: file.path, trackedPath: tracked.path });
  }
  return findings;
}

function quote(value) {
  return value === null ? "(absent)" : JSON.stringify(value);
}

function describeFinding(finding) {
  const lines = [];
  const where = finding.trackedPath ? ` — user ${finding.path} ↔ tracked ${finding.trackedPath}` : ` — ${finding.path}`;
  if (finding.code === "tracked_source_missing") {
    lines.push(`tracked_source_missing:${finding.path}:${finding.trackedPath}`);
    lines.push(
      "  → the definition this file tracks is gone: a moved or renamed upstream agent is drift, not `not-a-copy`",
    );
    lines.push(
      "  → point `tracks:` at where that definition lives now, or write `tracks: none` if this file stopped being a copy",
    );
    return lines;
  }
  if (finding.code === "agent_override_stale") {
    lines.push(`agent_override_stale:${finding.name}:${finding.field}${where}`);
    lines.push(
      `  → remove \`${finding.field}\` from that file's \`override:\` line: the exception outlived its reason`,
    );
    return lines;
  }
  lines.push(`agent_override_undeclared:${finding.name}:${finding.field}${where}`);
  if (finding.shadow) {
    lines.push(`  → the definition it shadows is ${finding.trackedPath}`);
    lines.push(
      "  → add `tracks: <that path>` if this file is meant to be a copy of it, or `tracks: none` if it is a different agent wearing the same name",
    );
    return lines;
  }
  if (finding.bodyDifference) {
    const { line, user, tracked } = finding.bodyDifference;
    lines.push(`  body line ${line} differs:`);
    lines.push(`    user    : ${JSON.stringify(user)}`);
    lines.push(`    tracked : ${JSON.stringify(tracked)}`);
  } else {
    lines.push(`    user    : ${quote(finding.userValue)}`);
    lines.push(`    tracked : ${quote(finding.trackedValue)}`);
  }
  lines.push(
    `  → update ${finding.path}: take the tracked value from ${finding.trackedPath}, or declare \`override: ${finding.field}\` if the difference is intended`,
  );
  return lines;
}

function settingsScanDirs(settingsPath) {
  if (!(settingsPath && existsSync(settingsPath))) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dirs = parsed?.subagents?.agentScanDirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((dir) => typeof dir === "string" && dir.trim().length > 0);
}

function readCommaList(raw) {
  return String(raw ?? "")
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((argument) => argument.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

function unresolved(detail) {
  console.error(`check-agent-overrides: user_agent_dir_unresolved — ${detail}`);
  console.error("check-agent-overrides: the user layer is not measured, so nothing about it was verified.");
  return 2;
}

/**
 * The user-level directories, or the reason the layer cannot be resolved at all.
 *
 * `PI_SUBAGENT_EXTRA_AGENT_DIRS` and the settings' `agentScanDirs` are loader inputs this gate re-reads rather than
 * re-invents: one entry it cannot expand is reported by name, never skipped into a smaller population.
 */
function resolveLayers({ home, agentDir, agentDirFromEnv }) {
  const extraDirs = readCommaList(process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS ?? "").map((dir) => expandHome(dir, home));
  const scanDirs = [];
  for (const entry of settingsScanDirs(join(agentDir, "settings.json"))) {
    if (entry.includes("*")) {
      return {
        unresolved: `subagents.agentScanDirs names the wildcard pattern ${entry}, which this gate does not expand`,
      };
    }
    scanDirs.push(expandHome(entry, home));
  }
  return { userDirs: resolveUserAgentDirs({ home, agentDir, agentDirFromEnv, extraDirs, scanDirs }) };
}

function packageCandidates(home, agentDir) {
  return [
    join(agentDir, "npm", "node_modules", "pi-subagents", "agents"),
    join(home, ".pi", "agent", "npm", "node_modules", "pi-subagents", "agents"),
  ];
}

/**
 * Every user-level definition, each tagged with whether the loader scans the directory it sits in.
 *
 * The tag is printed per directory, including for a directory that is absent: its absence is what made a fix written
 * into the wrong directory unreportable.
 */
function collectUserFiles(userDirs) {
  const files = [];
  for (const dir of userDirs) {
    const definitions = indexDefinitions(dir.path);
    const tag = dir.scanned ? "" : ", loader-scanned no";
    const state = isDirectory(dir.path) ? `${definitions.size} definition(s)` : "absent";
    console.log(`check-agent-overrides: user dir ${dir.path} (${dir.sources.join(", ")}${tag}) — ${state}`);
    for (const definition of definitions.values()) files.push({ ...definition, loaderScanned: dir.scanned });
  }
  return files;
}

function indexProject(projectDirs) {
  const index = new Map();
  for (const dir of projectDirs) {
    for (const [name, definition] of indexDefinitions(dir)) if (!index.has(name)) index.set(name, definition);
  }
  return index;
}

function summaryOf(verdicts) {
  const count = (kind) => verdicts.filter((verdict) => verdict.kind === kind).length;
  const drifted = verdicts.filter((verdict) => verdict.findings.length > 0).length;
  return [
    `overrides examined ${verdicts.length}`,
    `shadowing a project file ${count("project")}`,
    `shadowing a package file ${count("package")}`,
    `tracking an explicit path ${count("explicit")}`,
    `not-a-copy ${count("not-a-copy")}`,
    `no-upstream ${count("no-upstream")}`,
    `drifted ${drifted}`,
  ].join(" · ");
}

/**
 * The verdict: 0 when every user-level file explains its relation to the definition it shadows, 1 when one does not,
 * 2 when the population or a layer could not be measured at all.
 */
export function main(argv = process.argv.slice(2)) {
  const repoRoot = resolve(flag(argv, "repo-root") ?? REPO_ROOT);
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const configuredAgentDir = (process.env.PI_CODING_AGENT_DIR ?? "").trim();
  const agentDir = resolve(configuredAgentDir ? expandHome(configuredAgentDir, home) : join(home, ".pi", "agent"));
  if (configuredAgentDir && !existsSync(agentDir)) {
    return unresolved(
      `PI_CODING_AGENT_DIR=${configuredAgentDir} does not exist (resolved ${agentDir}); the loader would find no user-level agent at all`,
    );
  }

  const layers = resolveLayers({ home, agentDir, agentDirFromEnv: configuredAgentDir.length > 0 });
  if (layers.unresolved) return unresolved(layers.unresolved);

  const candidates = packageCandidates(home, agentDir);
  const packageDir = candidates.find((candidate) => isDirectory(candidate));
  if (!packageDir) {
    console.error("check-agent-overrides: the package layer's agent directory was not found; tried");
    for (const candidate of candidates) console.error(`  ${candidate}`);
    console.error("check-agent-overrides: without it no shadowed definition can be resolved, so nothing was verified.");
    return 2;
  }

  const packageIndex = indexDefinitions(packageDir);
  const projectDirs = [join(repoRoot, ".pi", "agents"), join(repoRoot, ".agents")];
  const projectIndex = indexProject(projectDirs);
  const userFiles = collectUserFiles(layers.userDirs);
  console.log(`check-agent-overrides: package dir ${packageDir} — ${packageIndex.size} definition(s)`);
  console.log(`check-agent-overrides: project dirs ${projectDirs.join(", ")} — ${projectIndex.size} definition(s)`);

  if (userFiles.length === 0) {
    console.error("check-agent-overrides: examined 0 user-level agent definition, so no drift was verified");
    return 2;
  }

  const verdicts = userFiles.map((file) =>
    judgeUserFile(file, { project: projectIndex, packageIndex, packageDir, repoRoot }),
  );
  const findings = verdicts.flatMap((verdict) => verdict.findings);
  if (findings.length > 0) {
    console.error("check-agent-overrides: a user-level agent file disagrees with the definition it shadows:");
    for (const finding of findings) for (const line of describeFinding(finding)) console.error(line);
  }
  console.log(`check-agent-overrides: ${summaryOf(verdicts)}`);
  return findings.length > 0 ? 1 : 0;
}

await runWhenEntry(import.meta.url, main);
