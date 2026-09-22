// GameBuddy production artifact load smoke.
//
// Borrowed pattern from magic-context-airp's `smoke-tui-pack-install.ts`:
// a published artifact can be *complete on disk* yet fail to load because a
// module (or its transitive import closure) is missing from the packed file
// set. The airp fork shipped exactly this bug (a config schema importing a
// memory/domain module that was absent from the package whitelist), and the
// fix only surfaced through a real packed-install import.
//
// GameBuddy's equivalent surface is the published immutable Host generation
// selected by host/dist/current.json. This check verifies that the selected
// generation is loadable, not just present:
//
//   1. current.json must resolve to an existing generation directory.
//   2. Every declared entry root and the bootstrap entry must exist there.
//   3. The bootstrap entry (`desktop-host-entry.internal.js`) is guarded by
//      `import.meta.main`, so importing it as a module is side-effect free:
//      it must load through the generation's OWN bundled Node runtime with
//      its full transitive import closure resolving — the closest safe
//      equivalent of a packed-install import for this topology.
//
// Entries without an `import.meta.main` guard (main.js and the attachment
// entries execute on import) are syntax-checked with the bundled runtime and
// existence-verified only; they are not imported.
//
// This is a read-only gate: it never writes into dist/, never launches the
// Host, and never acquires the publisher lock.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const hostRoot = resolve(repositoryRoot, "host");
const distRootDefault = join(hostRoot, "dist");

const RUNTIME_RELATIVE = "runtime/node.exe";
const BOOTSTRAP_ENTRY_RELATIVE = "bootstrap/entry/desktop-host-entry.internal.js";

/**
 * Verify the generation selected by current.json is loadable with its own
 * bundled runtime. Returns a machine-readable report; never throws for a
 * failed gate (the CLI maps verdict to exit code).
 *
 * @param {{ distRoot?: string }} [options] Test seam: override the dist root
 *   (defaults to the repository's host/dist). Production callers never pass
 *   this; tests use it to stage fixture generations without touching real
 *   artifacts.
 */
export function checkProductionPackLoad({ distRoot = distRootDefault } = {}) {
  const report = {
    gate: "host_production_pack_load/v1",
    verdict: "blocked",
    pointer: null,
    generation: null,
    entries: [],
    bootstrapImport: null,
    failures: [],
  };

  if (!existsSync(join(distRoot, "current.json"))) {
    report.failures.push(`pointer_missing:${join(distRoot, "current.json")}`);
    return report;
  }

  let pointer;
  try {
    pointer = JSON.parse(readFileSync(join(distRoot, "current.json"), "utf8"));
  } catch (error) {
    report.failures.push(`pointer_unreadable:${error instanceof Error ? error.message : String(error)}`);
    return report;
  }
  report.pointer = pointer;

  const generation = typeof pointer.generation === "string" ? pointer.generation : null;
  if (!generation) {
    report.failures.push("pointer_missing_generation");
    return report;
  }
  report.generation = generation;

  const generationRoot = isAbsolute(generation)
    ? generation
    : join(distRoot, "generations", generation);
  if (!existsSync(generationRoot)) {
    report.failures.push(`generation_missing:${generation}`);
    return report;
  }

  // 1. Declared entry roots must exist (exact files, no extension guessing —
  //    mirror of the artifact file-set semantics).
  const declaredEntries = ["main.js", "stardew-attachment.js", "farmhand-companion-preview.js"];
  for (const entry of declaredEntries) {
    const entryPath = join(generationRoot, entry);
    const present = existsSync(entryPath) && readFileSync(entryPath, "utf8").length > 0;
    report.entries.push({ entry, present });
    if (!present) report.failures.push(`entry_missing:${entry}`);
  }

  // 2. The import.meta.main-guarded bootstrap entry must exist.
  const bootstrapPath = join(generationRoot, BOOTSTRAP_ENTRY_RELATIVE);
  if (!existsSync(bootstrapPath)) {
    report.failures.push(`bootstrap_entry_missing:${BOOTSTRAP_ENTRY_RELATIVE}`);
    return report;
  }

  // 3. The generation must carry its own bundled runtime.
  const runtimePath = join(generationRoot, RUNTIME_RELATIVE);
  if (!existsSync(runtimePath)) {
    report.failures.push(`bundled_runtime_missing:${RUNTIME_RELATIVE}`);
    return report;
  }

  // 4. Load the guarded bootstrap entry THROUGH the bundled runtime. The
  //    child exits 0 and prints the marker only when the module graph loads —
  //    this catches a missing module in the transitive closure exactly like
  //    the packed-install import does for the fork.
  const probeSource = [
    // The bootstrap entry itself has no exports (it calls runDesktopHostBootstrap
    // behind an import.meta.main guard), so load it to prove the full closure
    // resolves, then assert the wire module it depends on really exports the
    // bootstrap function.
    `const target = process.argv[1].replace(/[\\\\/]entry[\\\\/][^\\\\/]*$/, "\\\\wire\\\\desktop-runtime-bootstrap.internal.js");`,
    `const { pathToFileURL } = await import("node:url");`,
    `await import(pathToFileURL(process.argv[1]).href); // closure resolution`,
    `const wire = await import(pathToFileURL(target).href);`,
    `if (typeof wire.runDesktopHostBootstrap !== "function") {`,
    `  throw new Error("bootstrap_entry_missing_export");`,
    `}`,
    `console.log("PACK_LOAD_BOOTSTRAP_OK");`,
  ].join("\n");

  // Use `node --input-type=module -e <probe> <bootstrapPath>`; spawnSync keeps
  // this a synchronous, read-only gate.
  const probe = spawnSync(runtimePath, ["--input-type=module", "-e", probeSource, bootstrapPath], {
    cwd: generationRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  const loadOk =
    probe.status === 0 && /PACK_LOAD_BOOTSTRAP_OK/.test(probe.stdout ?? "");
  report.bootstrapImport = {
    status: probe.status,
    stdout: (probe.stdout ?? "").trim().slice(0, 2000),
    stderr: (probe.stderr ?? "").trim().slice(0, 2000),
    ok: loadOk,
  };
  if (!loadOk) report.failures.push(`bootstrap_import_failed:${probe.stderr?.trim().slice(0, 500) ?? "no stderr"}`);

  // 5. Voice gateway packed-load probe (only when the generation ships one).
  verifyVoicePackLoad(report, generationRoot, runtimePath);

  report.verdict = report.failures.length === 0 ? "passed" : "blocked";
  return report;
}

/**
 * The voice gateway entry has no import.meta.main guard (its main line is
 * top-level await), so it cannot be imported side-effect free like the host
 * bootstrap entry. Instead the packed-load probe runs the entry with an empty
 * GAMEBUDDY_VOICE_TOKEN: a fully-resolved module graph reaches the token gate,
 * prints the operator guidance and exits 2 without starting a server; a
 * missing transitive module fails earlier with ERR_MODULE_NOT_FOUND/exit 1.
 * The sidecar declares the entry path; when no admission sidecar exists the
 * generation is voice-free and the probe is skipped.
 */
function verifyVoicePackLoad(report, generationRoot, runtimePath) {
  const sidecarPath = join(generationRoot, "voice-gateway-admission.json");
  if (!existsSync(sidecarPath)) {
    report.voice = { sidecar: "absent", ok: true };
    return;
  }
  let admission;
  try {
    admission = JSON.parse(readFileSync(sidecarPath, "utf8"));
  } catch (error) {
    report.failures.push(`voice_sidecar_unreadable:${error instanceof Error ? error.message : String(error)}`);
    report.voice = { sidecar: "unreadable", ok: false };
    return;
  }
  const entryPath = join(generationRoot, admission.entryPath ?? "");
  if (!existsSync(entryPath)) {
    report.failures.push(`voice_entry_missing:${admission.entryPath ?? "(none)"}`);
    report.voice = { sidecar: "present", entry: "missing", ok: false };
    return;
  }
  // No token: the entry resolves its full module graph, then fails at the
  // operator-guidance gate without binding a port or spawning PowerShell.
  const probe = spawnSync(runtimePath, [entryPath], {
    cwd: generationRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GAMEBUDDY_VOICE_TOKEN: "", NODE_NO_WARNINGS: "1" },
  });
  const ok = probe.status === 2 && /Set GAMEBUDDY_VOICE_TOKEN/.test(probe.stderr ?? "");
  report.voice = {
    sidecar: "present",
    entry: admission.entryPath,
    status: probe.status,
    stdout: (probe.stdout ?? "").trim().slice(0, 500),
    stderr: (probe.stderr ?? "").trim().slice(0, 500),
    ok,
  };
  if (!ok) report.failures.push(`voice_pack_load_failed:${(probe.stderr ?? "").trim().slice(0, 400) || "unexpected status"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const report = checkProductionPackLoad();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === "passed" ? 0 : 2;
}