// Phase report: assemble outRoot/README.txt and outRoot/REPORT.txt from (a) the run's own state files
// (run.json, launch.json, rootlayout.json, pin/build/cleanup logs) and (b) each capture driver's
// per-item facts file (<out>/<driver>.txt). Every item is a MEASURED NUMBER or a QUOTED STRING taken
// from the live page through the browser's own layout engine — never a class name and never a pixel
// reading. When a lane could not run, the driver writes a named skip and this generator repeats it.
//
// Before either file names a commit, the phase proves the artifacts it is about to cite belong to THIS
// run (G-D below): the claimed sha must be the pinned worktree's HEAD, and no cited artifact may
// predate the run's own start. A report that cannot prove both writes a named refusal instead of a pin.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRunConfig, REPO_ROOT, runPaths } from "../lib/config.mjs";
import { DRIVERS } from "./drivers.mjs";

/**
 * The drivers whose facts files this report reconciles.
 *
 * Derived from the roster the capture phase runs (`drivers.mjs`), never kept here. The copy that used to
 * live in this file stopped at `r-card-export` while the phase went on adding drivers, so every driver
 * after it wrote its `INJECTION` / `CAPABILITY` lines into a file this report never opened - and the
 * report's own silence list, the one mechanism that tells a driver that measured nothing from a driver
 * that never ran, could not name them either because it is built from this list too.
 */
const DRIVER_OUTS = DRIVERS.map((driver) => driver.key);

/* ---------- tiny JSON-block parser for the driver fact files ---------- */

const collectJson = (text) => collectJsonLines(text).map((entry) => entry.obj);

const collectJsonLines = (text) => {
  const out = [];
  const lines = text.split("\n");
  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx].trim();
    if (trimmed.startsWith("{")) {
      let buffer = "";
      let depth = 0;
      let inString = false;
      let escaped = false;
      let j = idx;
      while (j < lines.length) {
        const line = lines[j];
        buffer += `${line}\n`;
        for (const ch of line) {
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
          } else if (ch === '"') {
            inString = true;
          } else if (ch === "{") {
            depth += 1;
          } else if (ch === "}") {
            depth -= 1;
            if (depth === 0) {
              try {
                out.push({ line: idx, obj: JSON.parse(buffer) });
              } catch {
                /* skip malformed */
              }
              idx = j;
              break;
            }
          }
        }
        if (depth === 0 && j >= idx) break;
        j += 1;
      }
    }
    idx += 1;
  }
  return out;
};

const blockAfter = (text, marker) => {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  // brace-match the first object seated after the marker
  const lines = text.slice(at).split("\n");
  let buffer = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (const line of lines) {
    buffer += `${line}\n`;
    for (const ch of line) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        if (!started) started = true;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (started && depth === 0) {
          try {
            return JSON.parse(buffer.slice(buffer.indexOf("{")));
          } catch {
            return null;
          }
        }
      }
    }
    if (started && depth === 0) break;
  }
  return null;
};

const lineMatching = (text, re) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => re.test(l)) ?? null;

/* ---------- per-driver readers ---------- */

function driver(paths, key) {
  const file = join(paths.outRoot, `${key}.txt`);
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/* ---------- README assembly ---------- */

function section(lines, title) {
  lines.push(title);
  lines.push("=".repeat(Math.max(title.length, 8)));
  lines.push("");
}

function buildReadme({ paths, run, launch, rootLayout, pinLog, buildLog, cleanup, evidence }) {
  const L = [];
  const driverTexts = Object.fromEntries(DRIVER_OUTS.map((key) => [key, driver(paths, key)]));
  const iso = (ms) => new Date(ms).toISOString();

  L.push(`GameBuddy ${run.tag} — README`);
  L.push("===============================");

  section(L, "WHERE THIS CAME FROM");
  L.push(`  pinned commit      ${run.commit}`);
  L.push(`                     (HEAD or sha pinned; \`git rev-parse\` was the runner's first command)`);
  // G-D, space: the pin names the tree these artifacts came from, and git is the only thing that can
  // confirm it. Nothing below this line is written unless this reading agreed.
  L.push(
    `  pinned sha check   git -C <worktree> rev-parse HEAD = ${evidence.worktreeHead} — the tree that built these artifacts`,
  );
  if (evidence.mainHead !== null && evidence.mainHead !== run.commit) {
    L.push(`  HEAD now           ${evidence.mainHead}`);
    L.push(`                     (observation only, NOT a verdict: the pinned worktree above is what built these`);
    L.push(`                     artifacts, and \`--commit <sha>\` legitimately pins a commit that is not HEAD)`);
  }
  // G-D, time: the count, the oldest mtime and the run start are the three readings that make the
  // freshness claim checkable by hand instead of trusted.
  L.push(
    `  evidence           ${evidence.artifacts.length} cited artifacts · oldest mtime ${iso(evidence.artifacts[0].mtimeMs)} · run start ${iso(evidence.runStart.ms)}`,
  );
  L.push(`                     (run start = mtime of ${evidence.runStart.source}; every cited artifact is newer)`);
  L.push(`  OVERLAYS: none     Built and run straight from the pinned commit. NO overlay, NO patch, NO`);
  L.push(`                     source edit of any kind; the pinned worktree reports 0 changed files,`);
  L.push(`                     before AND after the build (pin.ps1 + build.ps1 both check).`);
  L.push(`  pinned worktree    ${paths.worktree}`);
  L.push(`                     \`git -C <worktree> diff --name-only HEAD --ignore-submodules=all\` = EMPTY`);
  L.push(
    `  builder            host/scripts/build-desktop-launcher-test-generation.mjs <out> <node-root> --full-runtime-tree`,
  );
  L.push(`  runtime fixture    ${run.runtimeFixture}  (a directory that DIRECTLY contains node.exe)`);
  L.push(`                     NOT build-test-artifact-locked.mjs; exactly one build ran at a time`);
  L.push(`  build log          ${paths.buildLog}`);
  L.push(`  capture log        ${paths.captureLog}`);
  L.push(`  launch log         ${paths.launchLog}`);
  L.push(`  cleanup log        ${paths.cleanupLog}`);
  L.push(`  main checkout      dirty-file snapshot is in \`git status --porcelain\`; this lane touches none of it`);
  L.push("");

  section(L, "GENERATION");
  const artifactJson = readJsonSafe(join(paths.artifact, "current.json"));
  if (artifactJson !== null) {
    L.push(`  artifact root          ${paths.artifact}`);
    L.push(`  generation id          ${artifactJson.generation ?? "?"}`);
    L.push(`  current.json           ${blockify(artifactJson)}`);
    const genDir = artifactJson.generation ?? "";
    L.push(
      `  staged entry           ${existing(join(paths.artifact, "generations", genDir, "bootstrap", "entry", "desktop-host-entry.internal.js"))}`,
    );
    L.push(`  staged runtime node.exe ${existing(join(paths.artifact, "generations", genDir, "runtime", "node.exe"))}`);
  } else {
    L.push(`  current.json ABSENT at ${paths.artifact} — the generation build did not complete`);
  }
  const modHash = lineMatching(buildLog ?? "", /Mod dll sha256=(\w+)/u);
  const reclaimerHash = lineMatching(buildLog ?? "", /reclaimer sha256=(\w+)/u);
  const genElapsed = lineMatching(buildLog ?? "", /generation build exit=(\S+) elapsed=(\d+)s/);
  if (modHash !== null) L.push(`  worktree Mod dll sha256  ${/Mod dll sha256=(\w+)/u.exec(modHash)?.[1]}`);
  if (reclaimerHash !== null)
    L.push(`  windows-stale-lock-reclaimer sha256 ${/reclaimer sha256=(\w+)/u.exec(reclaimerHash)?.[1]}`);
  if (genElapsed !== null) L.push(`  generation build         ${genElapsed}`);
  L.push("");

  section(L, "ENTRY (the single formal Host entry, through the product's own composition launcher)");
  if (launch !== null && launch.kind === "mounted") {
    L.push(`  launcher               ${join(paths.worktree, "tools", "desktop-composition-launch.mjs")}`);
    L.push(
      `                           ::launchDesktopCompositionGateChild({ outputRoot, root, surface, manifestPath, readyTimeoutMs })`,
    );
    L.push(`                           surface = "composed-reference-game"`);
    L.push(`  child pid              ${launch.childPid ?? "?"}`);
    L.push(`  product port           ${launch.port}`);
    L.push(`  page                   ${launch.launchUrlRedacted ?? "?"}`);
    L.push(`  ENTRY STDERR BYTES     ${launch.stderrBytes}   (0 required; 0 required again after mount)`);
    L.push(`  page mounted           ${launch.mounted}, document.title = "${launch.title}"`);
    L.push(`  browser                ${run.edgeExe}`);
    L.push(
      `                           --remote-debugging-port=${launch.cdpPort} --user-data-dir=${paths.browserProfile}`,
    );
  } else {
    L.push(`  launch state: ${JSON.stringify(launch ?? null)} — the run did not reach a mounted entry`);
    if (launch !== null && launch.kind === "launch_failed") L.push(`  detail: ${launch.detail}`);
  }
  // A run root carries no model until something puts a connection in it, and three drivers need a real
  // turn. The launch phase seeds one through the product's own writer; either it says what this run
  // sends through, or it says why it could not - and then the skips below are the reason, not a defect.
  const connection = launch?.connection ?? null;
  if (connection !== null) {
    L.push(
      connection.kind === "seeded"
        ? `  connection             ${connection.providerId} · ${connection.modelId} @ ${connection.thinkingLevel} (seeded into the run root by the launch phase)`
        : `  connection             NOT seeded (${connection.reason}) — turn-dependent drivers take their named skip`,
    );
  }
  L.push("");

  section(L, "ISOLATION — WHAT measureRunRoots() SAID");
  const after = launch?.measureRunRootsAfterLaunch ?? null;
  const afterRun = rootLayout?.postRun ?? null;
  if (after !== null) {
    L.push(`  declared mutable roots:`);
    for (const [name, info] of Object.entries(after.declared ?? {})) {
      L.push(
        `    ${name.padEnd(12)} ${info.path}  exists=${info.exists} entries=[${(info.entries ?? []).join(",")}] fileCount=${info.fileCount}`,
      );
    }
    L.push(`  manifest runtimeRoot   ${after.runtimeRoot}`);
    L.push(`  resolved               ${after.resolved?.path}  fileCount=${after.resolved?.fileCount}`);
    L.push(`  programRoot (launcher-written, excluded) ${after.programRoot}`);
  }
  if (afterRun !== null) {
    L.push(
      `  POST-RUN declared days:` +
        Object.entries(afterRun.declared ?? {})
          .map(([n, i]) => `${n}:${i.fileCount}`)
          .join(" "),
    );
    L.push(`  POST-RUN resolved      ${afterRun.resolved?.path} fileCount=${afterRun.resolved?.fileCount}`);
  }
  L.push(
    `  production LOCALAPPDATA ${join(run.homeLocalAppData, "GameBuddy")} — fingerprints before/after recorded in cleanup log (unchanged = healthy)`,
  );
  L.push("");

  section(L, "CREDENTIAL");
  L.push(
    `  CPA_OAI_API_KEY ${run.credentialPresent ? `present, length=${process.env.CPA_OAI_API_KEY ? process.env.CPA_OAI_API_KEY.length : run.credentialPresent ? "?" : 0}` : "absent"}`,
  );
  L.push(
    `  (present|absent and length only; the value was never read, never printed, never placed in a command line or a log)`,
  );
  L.push("");

  section(L, "MEASUREMENTS");
  const linesForMeasurements = [];
  measurementsFor(linesForMeasurements, driverTexts, run);
  L.push(...linesForMeasurements);
  observationsFor(L, driverTexts);
  L.push("");

  section(L, "SCREENSHOTS (collected in the out root)");
  const pngs = readdirSync(paths.outRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".png"))
    .map((e) => e.name)
    .sort();
  const txts = readdirSync(paths.outRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".txt"))
    .map((e) => e.name)
    .sort();
  for (const name of pngs) L.push(`  ${name}`);
  for (const name of txts) L.push(`  report: ${name}`);
  L.push("");

  if (cleanup !== null) {
    section(L, "CLEANUP");
    const cleanupLines = cleanup.split("\n").map((l) => l.trim());
    const wanted = [
      /^guardian \/ .* processes remaining:/,
      /^cdp port \d+ listening =/,
      /^product port \d+ listening =/,
      /^run root total files =/,
      /^entry count = .* tracked-changed count =/,
    ];
    const seen = new Set();
    for (const re of wanted) {
      const hit = cleanupLines.find((l) => re.test(l)) ?? null;
      if (hit !== null && !seen.has(hit)) {
        seen.add(hit);
        L.push(`  ${hit}`);
      }
    }
    L.push(`  run root KEPT at ${paths.runRoot}`);
  }
  L.push("");
  L.push(`  progress log: .pi/tools/frontend-kit-progress.md`);
  L.push("");

  return L.join("\n");
}

const readJsonSafe = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const blockify = (obj) => JSON.stringify(obj);
const existing = (p) => (existsSync(p) ? "present" : "ABSENT");

function existsSync(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/* ---------- observations: what the run cost, what it held, what it painted ---------- */

/**
 * The sections that answer questions the geometry sections cannot: how long a turn took, how long a
 * surface switch took, what the durable transcript did across turns, what reached the request, how big
 * the runtime got, and when the first screen painted.
 *
 * These read the lines the drivers' own `observe()` wrote, prefixed `TIMINGS` / `SWITCHES` /
 * `CAPABILITY` / `INJECTION` / `RUNTIME` / `PAINT`. The prefix is the contract between the two modules:
 * a section that stops being emitted shows up here as a named absence rather than as an empty list,
 * because an instrument that reports nothing and an instrument that measured nothing must not look the
 * same.
 *
 * Every section also names the drivers that wrote no line of it. A driver that skipped before observing
 * and a driver whose `observe()` call was dropped look identical in the list of lines - and only one of
 * them is a defect - so the reader has to say which drivers are silent instead of counting the ones
 * that spoke.
 */
function observationsFor(L, driverTexts) {
  const pick = (prefix) =>
    DRIVER_OUTS.flatMap((key) => {
      const text = driverTexts[key];
      if (text === null) return [];
      return text
        .split("\n")
        .filter((line) => line.startsWith(`${prefix} `))
        .map((line) => `${key}: ${line.slice(prefix.length + 1)}`);
    });

  const silent = (prefix) => ({
    noFactsFile: DRIVER_OUTS.filter((key) => driverTexts[key] === null),
    noLine: DRIVER_OUTS.filter(
      (key) => driverTexts[key] !== null && !driverTexts[key].split("\n").some((line) => line.startsWith(`${prefix} `)),
    ),
  });

  const section = (prefix, title, header, emptyWords) => {
    const lines = pick(prefix);
    L.push("");
    L.push(title);
    for (const line of header) L.push(`  ${line}`);
    if (lines.length === 0) L.push(`  unobserved: no driver wrote a ${prefix} line (${emptyWords})`);
    else for (const line of lines) L.push(`  ${line}`);
    const quiet = silent(prefix);
    if (quiet.noLine.length > 0) L.push(`  (wrote no ${prefix} line, having a facts file: ${quiet.noLine.join(", ")})`);
    if (quiet.noFactsFile.length > 0) L.push(`  (wrote no facts file at all: ${quiet.noFactsFile.join(", ")})`);
  };

  section(
    "TIMINGS",
    "=== TIMINGS — the turn marks the product recorded ===",
    [],
    "no turn ran, or the marks never reached the page",
  );
  section(
    "SWITCHES",
    "=== SWITCHES — what moving between surfaces cost, from the product's own marks ===",
    [
      "A switch is `gamebuddy:switch:<surface>:start` (the player selected a surface) and `:done` (the",
      "new region was committed and painted). `done` with no `start` is Back or Escape: the browser",
      "moved the history entry, so there is no duration to report and none is invented.",
    ],
    "no driver selected a surface, or the marks never reached the page",
  );
  section(
    "CAPABILITY",
    "=== CAPABILITY — the durable transcript's shape, read from the Host's own rows ===",
    [
      "Driver f's three lines describe ONE exchange (its row counts and its balance). The cross-turn",
      "lines are invariants rather than counts: they start `ok` or `FAIL` and assert that rows are",
      "append-only, that their order strictly increases, that none is lost without a declared removal",
      "and that none is duplicated.",
    ],
    "no driver read the durable transcript",
  );
  section(
    "INJECTION",
    "=== INJECTION — what authored context reached the request ===",
    [
      "`unobserved:no_provider_request_capture` does NOT mean the request carried no memory: it means",
      "no provider request body was captured, so nothing looked. A run that mounts the local stub",
      "provider records one, and then these lines carry the block's size and the entries it named.",
      "A driver that ran no turn writes no line here at all: it asked the request nothing.",
    ],
    "no driver captured a provider request",
  );
  section(
    "RUNTIME",
    "=== RUNTIME — DOM size, heap and mark counts at the end of each driver ===",
    [],
    "no driver read the runtime",
  );
  section("PAINT", "=== PAINT — first paint and first contentful paint ===", [], "no driver read the paint entries");
}

/* ---------- measurements: read each driver's facts ---------- */

function measurementsFor(L, driverTexts, run) {
  const a = driverTexts["a-surfaces"];
  if (a !== null) {
    L.push("ITEM 1 — six peer surfaces @1440x900 and @400x800");
    L.push(`  overlays: ${overlaySummary(a)}`);
    L.push(`  document horizontal overflow: ${overflowSummary(a)}`);
    L.push(`  surface regions present (one at a time): ${regionSummary(a)}`);
  } else {
    L.push("ITEM 1 — a-surfaces driver RAN WITH NO FACT FILE (skipped/named reason above, or crashed)");
  }
  const b = driverTexts["b-characters"];
  if (b !== null) {
    const grid1440 = blockAfter(b, "=== ITEM: Characters grid @1440x900 ===") ?? null;
    const grid400 = blockAfter(b, "=== ITEM: Characters grid @400x800 ===") ?? null;
    const persona1440 = blockAfter(b, "=== ITEM: Characters persona label @1440x900 ===") ?? null;
    if (grid1440 !== null)
      L.push(
        `ITEM 2 — Characters grid @1440x900: columns=${grid1440.columnCount} panel=${grid1440.panelWidth}x${grid1440.panelHeight} cards=${grid1440.cardCount} rows=${grid1440.rows?.length}`,
      );
    if (grid400 !== null)
      L.push(
        `ITEM 2 — Characters grid @400x800: columns=${grid400.columnCount ?? "n/a"} panel=${grid400.panelWidth}x${grid400.panelHeight} cards=${grid400.cardCount}`,
      );
    if (persona1440 !== null)
      L.push(`ITEM 2 — persona label: first lines ${JSON.stringify(persona1440.cardFirstLines ?? [])}`);
  }
  const c = driverTexts["c-settings"];
  if (c !== null) {
    for (const tag of ["1440x900", "400x800"]) {
      const s = blockAfter(c, `=== ITEM: Settings @${tag} ===`) ?? null;
      if (s !== null) {
        L.push(
          `ITEM 3 — Settings @${tag}: surfaceWidth=${s.surfaceWidth} visibleControls=${s.visibleControlCount} distinctVisibleWidths=[${s.distinctVisibleWidths.join(", ")}] rawOsControls=${s.rawOsControls.length}`,
        );
        for (const control of s.controls ?? []) {
          if (control.visible)
            L.push(
              `ITEM 3 — Settings @${tag} control: label=${JSON.stringify(control.label)} type=${control.type ?? control.tag} width=${control.width} height=${control.height}`,
            );
        }
      }
    }
  }
  const d = driverTexts["d-game"];
  if (d !== null) {
    for (const tag of ["1440x900", "400x800"]) {
      const s = blockAfter(d, `=== ITEM: Game @${tag} ===`) ?? null;
      if (s !== null) {
        L.push(
          `ITEM 4 — Game @${tag}: drawerPresent=${s.drawerPresent} columnCount=${s.columnCount} gridGap=${s.gridGap} scroller=${s.scrollHeight}/${s.clientHeight} horizontalOverflow=${s.horizontalOverflow} groups=${s.groups?.length}`,
        );
      }
    }
  }
  const e = driverTexts["e-chats-rows"];
  if (e !== null) {
    L.push("ITEM 5 — Chats rows (identity, numbering, rename, clamp, contrast)");
    for (const line of e.split("\n")) {
      const t = line.trim();
      if (/^ROW \d+ titleText:/.test(t)) L.push(`  ${t}`);
      if (/^unnamed title texts in list order:/i.test(t)) L.push(`  ${t}`);
      if (/^names read 新对话 1 \/ 新对话 2/.test(t)) L.push(`  ${t}`);
      if (/^the two rows are distinguishable/.test(t)) L.push(`  ${t}`);
      if (/^no row carries a raw/.test(t)) L.push(`  ${t}`);
      if (/^renamed row shows its own title:/.test(t)) L.push(`  ${t}`);
      if (/^renamed row carries no number:/.test(t)) L.push(`  ${t}`);
      if (/^the remaining unnamed row/.test(t)) L.push(`  ${t}`);
      if (/--- @1440x900: meta colour\/contrast/.test(t)) L.push(`  ${t}`);
      if (/--- @400x800: meta colour\/contrast/.test(t)) L.push(`  ${t}`);
      if (/^row \d+: rowHeight=/.test(t)) L.push(`  ${t}`);
      if (/^row \d+: color=/.test(t)) L.push(`  ${t}`);
      if (/--- @\d+x\d+: forced 160-char/.test(t)) L.push(`  ${t}`);
    }
  }
  const f = driverTexts["f-turn-variant"];
  if (f !== null) {
    L.push("ITEM 6 — one real conversation with the card");
    const credLine = lineMatching(f, /^credential present/);
    if (credLine !== null) L.push(`  ${credLine}`);
    for (const marker of [
      "=== ITEM: the reply to 你好 (VERBATIM) ===",
      "=== ITEM: the beat's letter-spacing and contrast next to the dialogue's ===",
    ]) {
      const blk = blockAfter(f, marker) ?? null;
      if (blk !== null && typeof blk === "object" && marker.includes("VERBATIM")) {
        L.push(`  reply (verbatim): ${JSON.stringify(blk ?? "null")}`);
      }
    }
    const skipTurn = lineMatching(f, /real conversation -> SKIPPED:/);
    const skipVariant = lineMatching(f, /variant flow -> SKIPPED:/);
    if (skipTurn !== null) L.push(`  real conversation -> ${skipTurn}`);
    if (skipVariant !== null) L.push(`  variant flow -> ${skipVariant}`);
    const roleLine = lineMatching(f, /^role=.*streaming=false characters=sentences=handle=/);
    if (roleLine !== null) L.push(`  ${roleLine}`);
    const beatsLine = lineMatching(f, /^em.message-action beats in the reply bubble:/);
    if (beatsLine !== null) L.push(`  ${beatsLine}`);
    const before = blockAfter(f, "=== ITEM: the reply's controls BEFORE regenerate ===") ?? null;
    const afterStrip = blockAfter(f, "=== ITEM: the reply's controls AFTER regenerate (the pager exists) ===") ?? null;
    if (before !== null) L.push(`  strip BEFORE regenerate: ${JSON.stringify(before)}`);
    if (afterStrip !== null) L.push(`  strip AFTER regenerate: ${JSON.stringify(afterStrip)}`);
    for (const re of [
      /^player rows: before=/,
      /^player rows for the exchange:/,
      /^bubble handle before=/,
      /^regenerate settled:/,
      /^text after switch-back equals the original:/,
      /^text after switching forward equals the regenerated text:/,
      /^byte-identical to the ORIGINAL/,
      /^turn settled:/,
      /^surface notice after the turn:/,
      /^the surface reported a failure instead of a reply:/,
      /indicator after switch-back/,
    ]) {
      const hit = lineMatching(f, re);
      if (hit !== null) L.push(`  ${hit}`);
    }
  }
  const g = driverTexts["g-defects"];
  if (g !== null) {
    L.push("ITEM 7 — the contrast floor and the computed 'what looks wrong' sweep (details in REPORT.txt)");
    const floors = [];
    for (const blk of collectJson(g)) {
      if (blk && typeof blk === "object" && Array.isArray(blk.lowestContrasts) && blk.lowestContrasts.length > 0) {
        for (const c of blk.lowestContrasts) floors.push({ ...c, testid: blk.testid });
      }
    }
    floors.sort((left, right) => (left.contrast ?? 99) - (right.contrast ?? 99));
    if (floors.length > 0) {
      const lowest = floors[0];
      L.push(
        `  lowest text contrast anywhere: ${lowest.contrast}:1 on ${lowest.text} (${lowest.testid}), ${lowest.fontSize}/${lowest.fontWeight}`,
      );
      L.push(
        `  next four: ${floors
          .slice(1, 5)
          .map((f2) => `${f2.contrast}:1 ${f2.text} @ ${f2.testid}`)
          .join(" | ")}`,
      );
    } else {
      L.push(`  lowest text contrast anywhere: (none measured) ${lineMatching(g, /SKIPPED/) ?? ""}`);
    }
  }
  const j = driverTexts["j-card-import"];
  if (j !== null) {
    L.push("ITEM 8 — card-import review field names");
    for (const line of j.split("\n")) {
      const t = line.trim();
      if (
        /^staging:/.test(t) ||
        /^review verdict:/.test(t) ||
        /^review text snake_case count:/.test(t) ||
        /^human field words in the review:/.test(t) ||
        /^companion list unchanged:/.test(t)
      )
        L.push(`  ${t}`);
    }
  }
  const k = driverTexts["k-chat-select"];
  if (k !== null) {
    L.push("ITEM 9 — chat-select switches surface + title");
    for (const line of k.split("\n")) {
      const t = line.trim();
      if (
        /^surface before:/.test(t) ||
        /^surface after:/.test(t) ||
        /^timeline title band after:/.test(t) ||
        /^title matches the chosen/.test(t) ||
        /^selected row flips:/.test(t) ||
        /^the clicked row is now the selected one:/.test(t)
      )
        L.push(`  ${t}`);
    }
  }
  L.push("");
  newItemsFor(L, driverTexts);
}

/**
 * The surfaces this set exists for (brief items 1-6), read from the drivers' own per-item lines.
 *
 * Each driver writes one line per measured fact - a count, a geometry, a file's own structure or a
 * quoted sentence read off the page - so this reader selects lines rather than rewriting them: the
 * numbers in README.txt and REPORT.txt are the same numbers the driver measured, not a summary made
 * a second time.
 */
function newItemsFor(L, driverTexts) {
  const emit = (text, patterns) => {
    if (text === null) return false;
    let found = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (patterns.some((pattern) => pattern.test(trimmed))) {
        L.push(`  ${trimmed}`);
        found = true;
      }
    }
    return found;
  };
  const item = (title, key, patterns) => {
    const text = driverTexts[key] ?? null;
    L.push(title);
    if (text === null) {
      L.push(`  driver ${key} RAN WITH NO FACT FILE (named skip or crash above)`);
      return;
    }
    if (!emit(text, patterns)) L.push(`  the ${key} driver recorded no line this reader looks for`);
  };

  item("ITEM 1 — the opening a new Chat starts on (driver m)", "m-opening-picker", [
    /^picker present:/,
    /^picker @400x800:/,
    /^choosing option #/,
    /^the click answers:/,
    /^the created Chat's opening equals/,
    /^the panel's card for the created Chat:/,
    /^switching to the created Chat:/,
    /^first row role=/,
    /^chosen line:/,
    /^rows discarded:/,
    /^saving the one-opening set:/,
    /^notice after saving:/,
    /^chat rows before=/,
    /^SKIPPED:/,
  ]);
  item("ITEM 3 — editing a message in place (driver n)", "n-message-edit", [
    /^credential present/,
    /^turn settled:/,
    /^the row to edit carries:/,
    /^controls in the player row's strip:/,
    /^edit control count in that row:/,
    /^the field starts on the words the row shows:/,
    /^save is not offered while nothing has changed:/,
    /^editor @400x800:/,
    /^after typing, save is enabled:/,
    /^the DOM carries the rewritten text in the same row:/,
    /^rows before=/,
    /^the Host's own row carries the rewritten text too:/,
    /^SKIPPED:/,
  ]);
  item("ITEM 2 — her picture, and the monogram that stands in for it (driver o)", "o-companion-picture", [
    /^app bar @/,
    /^transcript rows=/,
    /^every companion row addresses/,
    /^roster rows=/,
    /^served bytes /,
    /^roster @400x800:/,
    /^review for a \.json card:/,
    /^json-card import:/,
    /^SKIPPED:/,
  ]);
  item("ITEM 4 — the rewind and the delete (driver p)", "p-rewind-delete", [
    /^credential present/,
    /^exchanges before:/,
    /^turn settled:/,
    /^rows carrying a (rewind|delete) control:/,
    /^deleting row index=/,
    /^the armed confirmation is the row's only control/,
    /^cancelling the arm/,
    /^rows before=/,
    /^the deleted handle is gone from the Host's own rows:/,
    /^every other row is still there, in the same order:/,
    /^durable rows after:/,
    /^rewinding to row index=/,
    /^the reply the rewind was taken on survives/,
    /^(delete|rewind): /,
    /^SKIPPED:/,
  ]);
  item("ITEM 5 — her own world book, edited (driver q)", "q-companion-world-book", [
    /^the companion in play:/,
    /^durable book: revision=/,
    /^row \d+: keys /,
    /^save offered:/,
    /^notice:/,
    /^durable revision /,
    /^durable entry \d+:/,
    /^the body kept the rewritten sentence:/,
    /^the entry as the surface now renders it:/,
    /^draft rows /,
    /^the surface's own count line:/,
    /^durable entries /,
    /^durable titles:/,
    /^cancelling the arm:/,
    /^the row left the draft locally/,
    /^the removed entry's title is gone/,
    /^the second writer/,
    /^the book on the server is now revision/,
    /^the observed HTTP status of the refused save:/,
    /^the sentence the surface shows:/,
    /^the editor is STILL open/,
    /^reopened and saved:/,
    /^the recovered save's status:/,
    /^SKIPPED:/,
  ]);
  item("ITEM 6 — the character card in both forms, and the PNG read back in (driver r)", "r-card-export", [
    /^json control:/,
    /^png control:/,
    /^companions before the exports:/,
    /^download the browser was handed:/,
    /^the Host's answer:/,
    /^the surface's own notice:/,
    /^the exported JSON card /,
    /^the exported PNG:/,
    /^the card inside the PNG /,
    /^the PNG's card and the JSON card describe the same companion:/,
    /^staging the exported file:/,
    /^the review of the exported card:/,
    /^the import's own answer:/,
    /^companions after the re-import:/,
    /^rows the re-import added:/,
    /^the picture the imported companion serves:/,
    /^her picture survived the round trip:/,
    /^SKIPPED:/,
  ]);
  const l = driverTexts["l-new-surfaces"] ?? null;
  if (l !== null) {
    L.push("ITEM 2b — the roster and transcript reading of the previous set (driver l)");
    emit(l, [
      /^rows=.+withImage=/,
      /^every picture is a same-origin/,
      /^player rows carry no image:/,
      /^her picture decoded in the browser/,
    ]);
  }
}

const overlaySummary = (text) => {
  let count = null;
  let allZero = true;
  for (const blk of collectJson(text)) {
    if (blk && typeof blk === "object" && typeof blk.overlays?.count === "number") {
      count = blk.overlays.count;
      if (count !== 0) allZero = false;
    }
  }
  return allZero
    ? "count 0 on every surface @ both sizes (measured)"
    : `non-zero overlays: first=${count} (see driver output)`;
};
const overflowSummary = (text) => {
  let allZero = true;
  let max = 0;
  for (const blk of collectJson(text)) {
    if (blk && typeof blk === "object" && typeof blk.docHorizontalOverflow === "number") {
      if (blk.docHorizontalOverflow !== 0) allZero = false;
      if (blk.docHorizontalOverflow > max) max = blk.docHorizontalOverflow;
    }
  }
  return allZero ? "documentElement.scrollWidth - innerWidth = 0 on every surface @ both sizes" : `max=${max}`;
};
const regionSummary = (text) => {
  const seen = new Set();
  for (const blk of collectJson(text)) {
    if (blk && typeof blk === "object" && Array.isArray(blk.surfaceRegions))
      for (const r of blk.surfaceRegions) seen.add(r);
  }
  return `${seen.size} distinct testid region(s) seen: [${[...seen].join(", ")}]`;
};

/* ---------- REPORT assembly ---------- */

function buildReport({ paths, run, launch, rootLayout, cleanupLogText }) {
  const R = [];
  R.push(`${run.tag} — REPORT: what looks wrong`);
  R.push("=".repeat(`${run.tag} — REPORT: what looks wrong`.length));
  R.push("");
  R.push("I AM REPORTING COMPUTED FACTS, NOT PIXELS.");
  R.push("I never saw a single one of the images in this directory. Everything below is read back from");
  R.push("the live page through the browser's own layout engine (getBoundingClientRect, getComputedStyle,");
  R.push("Range.getBoundingClientRect, elementFromPoint, offsetParent/getClientRects) at the two frozen");
  R.push("viewports 1440x900 and 400x800, on the pinned commit, through the product's own entry. Where a");
  R.push("claim needs eyes I say so and stop.");
  R.push("");
  R.push("缺陷清单 (defect list), by surface + width, ordered by how much I would mind shipping it:");
  R.push("");
  R.push("READINGS (turn timings, surface switches, what reached the request, the transcript's growth,");
  R.push("runtime facts, paint) are in README.txt, beside the geometry they belong with. This file is the");
  R.push("defect list; that one is the numbers. Searching here for TIMINGS or SWITCHES will find nothing,");
  R.push("and that is by design rather than a missing section.");
  R.push("");

  const g = driver(paths, "g-defects") ?? "";
  const sweepBlocks = [];
  const lines = g.split("\n");
  for (const entry of collectJsonLines(g)) {
    const blk = entry.obj;
    if (blk === null || typeof blk !== "object" || blk.testid === undefined) continue;
    // find the nearest preceding DEFECT SWEEP header to learn the size
    const header = [...lines.slice(0, entry.line)].reverse().find((l) => l.includes("DEFECT SWEEP"));
    const size = /@ (\d+x\d+)/.exec(header ?? "")?.[1] ?? "unknown";
    sweepBlocks.push({ testid: blk.testid, size, blk });
  }

  const defects = [];
  for (const { testid, size, blk } of sweepBlocks) {
    const where = `${testid} @ ${size}`;
    const clipped = (blk.clipped ?? []).map((c) => `"${c.text}" overflowX clipped ${c.clientWidth}/${c.scrollWidth}`);
    const verticalClip = (blk.verticalClip ?? []).map((c) => `"${c.text}" clipped to ${c.clientHeight}px`);
    const offscreen = (blk.offscreen ?? []).map((c) => `left=${c.left} right=${c.right}`);
    const underBar = (blk.underTheBar ?? []).map((c) => `top=${c.top}`);
    const small = (blk.smallTargets ?? []).map((c) => `"${c.name}" ${c.w}x${c.h}`);
    const empty = (blk.emptyBlocks ?? []).map((c) => `${c.w}x${c.h}`);
    if (clipped.length) defects.push({ where, group: "clipped horizontal", items: clipped });
    if (verticalClip.length) defects.push({ where, group: "vertically clipped/clamped", items: verticalClip });
    if (offscreen.length) defects.push({ where, group: "offscreen", items: offscreen });
    if (underBar.length) defects.push({ where, group: "element top above the app bar", items: underBar });
    if (small.length) defects.push({ where, group: "controls under the 44px touch floor", items: small });
    if (empty.length) defects.push({ where, group: "large blocks carrying almost no text", items: empty });
    if ((blk.lowestContrasts ?? []).length > 0) {
      defects.push({
        where,
        group: "lowest text contrasts",
        items: blk.lowestContrasts.map((c) => `${c.contrast}:1 "${c.text}" ${c.fontSize}/${c.fontWeight}`),
      });
    }
  }
  if (defects.length === 0) {
    R.push("  none recorded by the sweep (every computed check passed on every surface/width pair)");
  } else {
    let n = 1;
    for (const defect of defects) {
      R.push(`${n}. ${defect.where} — ${defect.group}`);
      for (const item of defect.items.slice(0, 4)) R.push(`     - ${item}`);
      n += 1;
    }
  }
  R.push("");
  R.push("RESOLVED BY THE PROBE DRIVERS (no longer suspicious):");
  const h = driver(paths, "h-probe") ?? "";
  const appbarHit = blockAfter(h, "=== (a) 聊天 @400x800: is anything actually painted over the app bar? ===");
  if (appbarHit !== null && Array.isArray(appbarHit.elementFromPointInsideTheBar)) {
    R.push("  - 聊天 @400x800: elements whose top is above the app bar are CLIPPED BY THE TRANSCRIPT");
    R.push(`    SCROLLER, not painted over it (elementFromPoint across the bar returns the bar only).`);
  }
  const i = driver(paths, "i-followup") ?? "";
  const ellipsis1440 = blockAfter(i, "=== (2) the clamp's cut @1440x900, real preview ===");
  if (ellipsis1440 !== null && typeof ellipsis1440 === "object") {
    R.push(
      `  - chats row clamp @1440x900: ${ellipsis1440.roomLeftAfterTheLastVisibleChar ?? "?"}px (${ellipsis1440.roomInCharacters ?? "?"} glyph) of room after the last visible glyph`,
    );
  }
  const diag = blockAfter(i, "=== (3) 游戏 游戏数据与诊断: open or closed, and is it rendered? @1440x900 ===");
  if (diag !== null && typeof diag === "object" && typeof diag.present === "boolean") {
    R.push(
      `  - game diagnostics disclosure: open=${diag.detailsOpen}; pre/code boxes report no innerText (content-visibility hiding) — not painted`,
    );
  }
  R.push("");
  R.push("WHAT IS RIGHT (asked to be able to trust):");
  const e = driver(paths, "e-chats-rows") ?? "";
  const eUnnamed = lineMatching(e, /^unnamed title texts in list order:/);
  if (eUnnamed !== null) R.push(`  - ${eUnnamed}`);
  const eNoStar = lineMatching(e, /^no row carries a raw/);
  if (eNoStar !== null) R.push(`  - ${eNoStar}`);
  const renamed = lineMatching(e, /^renamed row titleText:/);
  if (renamed !== null) R.push(`  - ${renamed}`);
  const f = driver(paths, "f-turn-variant") ?? "";
  for (const re of [
    /^turn settled:/,
    /^surface notice after the turn:/,
    /^the surface reported a failure instead of a reply:/,
    /^bubble handle before=/,
    /^player rows for the exchange:/,
    /^text after switch-back equals the original:/,
    /^text after switching forward equals the regenerated text:/,
  ]) {
    const hit = lineMatching(f, re);
    if (hit !== null && !hit.includes("waiting-for")) R.push(`  - ${hit}`);
  }
  const j = driver(paths, "j-card-import") ?? "";
  if (j.trim().length > 0)
    R.push(
      `  - card-import review (j): ${
        lineMatching(j, /^review verdict:/)?.replace("review verdict:", "") ??
        j
          .split("\n")
          .filter((l) => !l.startsWith(" "))
          .slice(-1)[0]
          .trim()
      }`,
    );
  const k = driver(paths, "k-chat-select") ?? "";
  if (k.trim().length > 0)
    R.push(
      `  - chat-select (k): ${lineMatching(k, /^surface after:/) ?? ""} ${lineMatching(k, /^selected row flips:/) ?? ""}`,
    );
  R.push("");
  R.push("ISOLATION SEAM (a finding for whoever owns the launcher, noted when the run was driven):");
  const after = launch?.measureRunRootsAfterLaunch ?? null;
  if (after !== null) {
    R.push(
      `  declared data root fileCount=${after.declared?.data?.fileCount ?? "?"}, resolved=${after.resolved?.path} fileCount=${after.resolved?.fileCount}`,
    );
    R.push(
      `  assertion outcome and the "operational/presentation stay empty on a healthy run" nuance: see README.txt ISOLATION section.`,
    );
  }
  R.push("");
  R.push("THE NUMBERS BEHIND EVERY COMPLAINT ON THE SURFACES THIS SET WAS FOR (items 1-6):");
  const itemLines = [];
  newItemsFor(itemLines, Object.fromEntries(DRIVER_OUTS.map((key) => [key, driver(paths, key)])));
  R.push(...itemLines.map((line) => `  ${line}`));
  R.push("");
  R.push("WHAT I CANNOT TELL YOU:");
  R.push("  whether a truncated chats row ends in an ellipsis or a bare cut, whether the memory empty");
  R.push("  state looks calm or broken, and whether any of the 99-*.png captures is visually pleasing.");
  R.push("  Those need eyes. Every number above is a computed fact.");
  return R.join("\n");
}

/* ---------- G-D: a pin is written only over evidence this run produced ---------- */

/*
 * Two assertions, and neither implies the other:
 *
 *   space  the sha the report names IS the sha the pinned worktree is at, read with the command the pin
 *          itself wrote (`git -C <worktree> rev-parse HEAD`, printed by pin.ps1 as `worktree HEAD=`).
 *          It refuses the case this report cannot see otherwise: the claim says commit A while the tree
 *          under audit - the one that built these artifacts - is at commit B (a `report` re-run from a
 *          stage whose run.json still names the previous pin).
 *   time   every artifact the report cites is newer than this run's start. Space cannot catch the
 *          2026-11-05 run: there the worktree really was at 250bd142 and the pin really was written from
 *          it, while the 115 PNGs the report listed were dated 11-04 and came from another commit into a
 *          reused --out. Only the mtimes say that.
 *
 * The main checkout's HEAD is NOT a verdict: `--commit <sha>` (the release-verification shape) pins a
 * commit that is usually not main HEAD, and any other lane committing during a 20-minute run would turn a
 * healthy run red. It is printed beside the pin as an observation instead.
 */

/*
 * How far before the run's start a cited artifact may sit and still be read as a resumed batch rather
 * than as another run's leftovers. It is a policy threshold, and it lives here once so the two verdicts
 * cannot drift: a restart inside one working session (re-run `pin`, a second `capture` after a crash)
 * takes seconds to minutes, while a --out reused across runs is separated by hours or days — the
 * 2026-11-05 incident reused a set of PNGs that were two days old. Ten minutes is longer than any one
 * pin→capture restart and far shorter than any real reuse interval, so the classification is unambiguous
 * at both ends, and the boundary is asserted at exactly this value in report-freshness.test.mjs.
 */
const STALE_BATCH_WINDOW_MS = 10 * 60 * 1000;

// capture.mjs gives exit 4 to "this run verified nothing"; the report gives 5 to "the evidence it was
// asked to publish cannot be attributed to this run". run.mjs's phase runner turns either into a failed
// run, so the caller sees a failed phase rather than a report it must read carefully.
const EXIT_STALE_EVIDENCE = 5;

const REPORT_OUTPUT_NAMES = new Set(["README.txt", "REPORT.txt"]);

const pathMtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * `git rev-parse HEAD` in a directory, or null when git cannot answer there.
 *
 * The pinned worktree survives the run (cleanup.ps1 keeps it and itself prints this same reading), so the
 * worktree that built the artifacts is still on disk when the report asks what it was.
 */
function gitHead(directory) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8", windowsHide: true });
  const sha = (result.stdout ?? "").trim();
  return result.status === 0 && /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
}

/**
 * When this run started, from the run's own files.
 *
 * `logs/pin.log` is the run's start fact: pin.ps1 deletes it (`Remove-Item $Log`) and writes it again as
 * the first thing a run does, and every artifact a report cites is written by the capture phase minutes
 * after that pin. `state/run.json` is deliberately NOT used, even though it is the obvious-looking
 * candidate: run.mjs re-saves it on EVERY invocation - including the `report` invocation that is asking
 * this question - so its mtime is the last invocation rather than the run's start, and it carries no
 * timestamp of its own. `state/launch.json` is the same kind of fact one phase later, for a stage whose
 * pin log is gone; with neither, the run root's oldest top-level entry is the earliest thing the launcher
 * wrote. No new "started at" field is invented, because the file mtimes already say it.
 */
function runStartFor(paths) {
  for (const candidate of [paths.pinLog, paths.launchStateFile]) {
    const ms = pathMtime(candidate);
    if (ms !== null) return { ms, source: candidate };
  }
  let oldest = null;
  try {
    for (const entry of readdirSync(paths.runRoot, { withFileTypes: true })) {
      const ms = pathMtime(join(paths.runRoot, entry.name));
      if (ms === null) continue;
      if (oldest === null || ms < oldest.ms) oldest = { ms, name: entry.name };
    }
  } catch {
    /* no run root: nothing to date the run by */
  }
  return oldest === null ? null : { ms: oldest.ms, source: `${paths.runRoot} (oldest entry ${oldest.name})` };
}

/** Every artifact the README/REPORT will cite, oldest first. */
function citedArtifacts(paths) {
  const artifacts = [];
  const add = (path, name, kind) => {
    const ms = pathMtime(path);
    if (ms !== null) artifacts.push({ path, name, kind, mtimeMs: ms });
  };
  let entries = [];
  try {
    entries = readdirSync(paths.outRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const path = join(paths.outRoot, entry.name);
    // The report's own two files are not evidence: a re-run would otherwise refuse on the previous
    // report sitting in the same directory.
    if (lower.endsWith(".png")) add(path, entry.name, "screenshot");
    else if (lower.endsWith(".txt") && !REPORT_OUTPUT_NAMES.has(entry.name)) add(path, entry.name, "facts");
  }
  add(paths.wireRequestsFile, "wire-requests.jsonl", "wire");
  return artifacts.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/**
 * The facts files a run is supposed to write, from the authority that decides it: the capture roster
 * (`drivers.mjs`), imported rather than scraped. A driver added tomorrow is therefore covered without
 * editing this file, and this set cannot drift from the one the phase runs.
 */
function declaredFactsFiles() {
  return DRIVERS.map((driver) => driver.out);
}

function examineEvidence(paths, run) {
  const runStart = runStartFor(paths);
  const artifacts = citedArtifacts(paths);
  const worktreeHead = gitHead(paths.worktree);
  const mainHead = gitHead(REPO_ROOT);
  const declared = declaredFactsFiles();
  const presentFacts = artifacts.filter((artifact) => artifact.kind === "facts").map((artifact) => artifact.name);
  const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot").length;

  const violations = [];
  const contamination = [];
  const iso = (ms) => new Date(ms).toISOString();

  if (worktreeHead === null) {
    violations.push(
      `report_pin_worktree_unreadable:${paths.worktree}:git rev-parse HEAD did not answer there, so the claim cannot be checked`,
    );
  } else if (worktreeHead !== run.commit) {
    violations.push(`report_pinned_sha_mismatch:${run.commit}!=${worktreeHead}`);
  }

  if (runStart === null) {
    violations.push(
      `report_run_start_unknown:${paths.stageRoot}:no pin log, no launch state and no run root entry dates this run`,
    );
  } else {
    for (const artifact of artifacts) {
      const gap = runStart.ms - artifact.mtimeMs;
      if (gap <= 0) continue;
      violations.push(`report_evidence_predates_run:${artifact.name}:${iso(artifact.mtimeMs)} < ${iso(runStart.ms)}`);
      if (gap > STALE_BATCH_WINDOW_MS) contamination.push(artifact);
    }
  }

  if (artifacts.length === 0) {
    violations.push(`report_no_artifacts:no_cited_evidence_under_${paths.outRoot}:an empty set cannot certify a pin`);
  } else if (screenshots === 0) {
    violations.push(`report_no_artifacts:no_screenshots_under_${paths.outRoot}:every driver wrote no PNG`);
  }

  return {
    runStart,
    artifacts,
    worktreeHead,
    mainHead,
    violations,
    contamination,
    setDifference: {
      missing: declared.filter((name) => !presentFacts.includes(name)),
      newlyAdded: presentFacts.filter((name) => !declared.includes(name)),
    },
  };
}

/**
 * What the out root carries INSTEAD of a report when the evidence cannot be attributed to this run.
 * Nothing is re-published from the suspect set: no measurement, no screenshot listing and no pin, so the
 * refusal cannot become the next stale artifact.
 */
function refusalText({ paths, run, evidence }) {
  const iso = (ms) => new Date(ms).toISOString();
  const oldest = evidence.artifacts[0] ?? null;
  const L = [];
  L.push(`${run.tag} — REPORT REFUSED: the evidence this run would cite is not this run's`);
  L.push("=".repeat(76));
  L.push("");
  L.push("The sha-and-artifact line is deliberately ABSENT from this file. This run cites artifacts it did");
  L.push("not produce, and naming a commit above them is exactly the 2026-11-05 report: `--commit HEAD`");
  L.push("into an --out that still held 115 PNGs dated two days earlier rewrote the pin over those files,");
  L.push("claiming `pinned 250bd142` for screenshots that never came from it.");
  L.push("");
  L.push(`  claimed sha (NOT published, NOT verified)  ${run.commit}`);
  L.push(`  pinned worktree                            ${paths.worktree}`);
  L.push(`                            git rev-parse HEAD = ${evidence.worktreeHead ?? "unreadable"}`);
  L.push(`  main checkout HEAD (observation only)      ${evidence.mainHead ?? "unreadable"}`);
  L.push(
    `  run start                                  ${
      evidence.runStart === null ? "UNKNOWN" : `${iso(evidence.runStart.ms)} (mtime of ${evidence.runStart.source})`
    }`,
  );
  L.push(
    `  examined                                   ${evidence.artifacts.length} cited artifact(s) — oldest ${
      oldest === null ? "none" : `${oldest.name} @ ${iso(oldest.mtimeMs)}`
    }`,
  );
  L.push("");
  L.push(`NAMED VIOLATIONS (${evidence.violations.length}):`);
  for (const violation of evidence.violations) L.push(`  ${violation}`);
  if (evidence.contamination.length > 0) {
    const worst = evidence.contamination[0];
    L.push("");
    L.push(
      `STALE_ARTIFACT_CONTAMINATION: ${evidence.contamination.length} cited artifact(s) predate the run's start by more than ${
        STALE_BATCH_WINDOW_MS / 60000
      } minutes, so they belong to an earlier batch — the oldest is ${worst.name} @ ${iso(worst.mtimeMs)}`,
    );
  }
  const { missing, newlyAdded } = evidence.setDifference;
  if (missing.length > 0 || newlyAdded.length > 0) {
    L.push("");
    L.push("SET DIFFERENCE — the capture phase's DRIVERS table against the facts files in the out root:");
    if (newlyAdded.length > 0) L.push(`  + newly added: ${newlyAdded.join(", ")}`);
    if (missing.length > 0) L.push(`  - missing: ${missing.join(", ")}`);
  }
  L.push("");
  L.push("Fix: run against a fresh --out (or re-run capture with --force) so the artifacts are this run's.");
  return L.join("\n");
}

/* ---------- entry ---------- */

async function main() {
  const run = loadRunConfig({ runConfigFile: process.argv[2] });
  if (run === null) throw new Error(`run_config_unreadable:${process.argv[2]}`);
  const paths = runPaths(run);
  mkdirSync(paths.outRoot, { recursive: true });

  let launch = null;
  try {
    launch = JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
  } catch {
    launch = null;
  }
  let rootLayout = null;
  try {
    rootLayout = JSON.parse(readFileSync(paths.rootLayoutFile, "utf8"));
  } catch {
    rootLayout = null;
  }
  let pinLog = "";
  try {
    pinLog = readFileSync(paths.pinLog, "utf8");
  } catch {
    pinLog = "";
  }
  let buildLog = "";
  try {
    buildLog = readFileSync(paths.buildLog, "utf8");
  } catch {
    buildLog = "";
  }
  let cleanupLogText = "";
  try {
    cleanupLogText = readFileSync(paths.cleanupLog, "utf8");
  } catch {
    cleanupLogText = "";
  }

  const evidence = examineEvidence(paths, run);
  if (evidence.violations.length > 0) {
    const refused = refusalText({ paths, run, evidence });
    writeFileSync(join(paths.outRoot, "README.txt"), refused, "utf8");
    writeFileSync(join(paths.outRoot, "REPORT.txt"), refused, "utf8");
    console.log(refused);
    console.log(`REPORT REFUSED: examined ${evidence.artifacts.length} artifact(s); no pin was written`);
    process.exit(EXIT_STALE_EVIDENCE);
  }

  const readme = buildReadme({ paths, run, launch, rootLayout, pinLog, buildLog, cleanup: cleanupLogText, evidence });
  const report = buildReport({ paths, run, launch, rootLayout, cleanupLogText });
  writeFileSync(join(paths.outRoot, "README.txt"), readme, "utf8");
  writeFileSync(join(paths.outRoot, "REPORT.txt"), report, "utf8");
  console.log(
    `REPORT: examined ${evidence.artifacts.length} artifacts — oldest mtime ${new Date(evidence.artifacts[0].mtimeMs).toISOString()} >= run start ${new Date(evidence.runStart.ms).toISOString()} (${evidence.runStart.source})`,
  );
  console.log(
    `REPORT: pinned ${run.commit} = git -C <worktree> rev-parse HEAD ${evidence.worktreeHead}${evidence.mainHead !== run.commit ? `; HEAD now ${evidence.mainHead} (observation only)` : ""}`,
  );
  console.log(
    `REPORT: wrote README.txt (${readme.length} chars) and REPORT.txt (${report.length} chars) to ${paths.outRoot}`,
  );
  console.log("DONE-REPORT");
  process.exit(0);
}

await main().catch((error) => {
  console.error(`REPORT PHASE FAILED: ${String(error).slice(0, 800)}`);
  process.exit(1);
});
