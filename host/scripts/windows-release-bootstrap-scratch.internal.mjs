import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildFreshWindowsReleaseBootstrapInspector, canonicalManifest, helperFileName, manifestFileName } from "./build-windows-reparse-inspector.mjs";

const outputLimitBytes = 64 * 1024;
const timeoutMs = 3_000;
const hex64 = /^[a-f0-9]{16}$/;
const hex128 = /^[a-f0-9]{32}$/;
const releaseScratchMarker = ".gamebuddy-release-owned-scratch-v1";
const releaseScratchParent = resolve(fileURLToPath(new URL("..", import.meta.url)), ".release-owned-scratch");
const decimal = /^(?:[1-9]\d*)$/;

function unavailable() { return new Error("runtime_acquisition_windows_reparse_inspection_unavailable"); }
function validIdentity(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 4 && value.objectKind === "directory"
    && value.isReparsePoint === false && typeof value.volumeIdentity === "string" && hex64.test(value.volumeIdentity)
    && typeof value.fileId === "string" && hex128.test(value.fileId);
}
function expectedCount(path) { return path.length === 3 ? 1 : path.slice(3).split("\\").length + 1; }
async function inspectChain(executable, path) {
  if (!/^[A-Za-z]:\\(?:[^\\/:*?<>"|\0]+\\)*[^\\/:*?<>"|\0]*$/.test(path)) throw unavailable();
  const request = Buffer.from(JSON.stringify({ schemaVersion: 2, operation: "inspect_path_chain_v2", path }), "utf8");
  return await new Promise((resolveInspection, reject) => {
    let child; let output = []; let stderrBytes = 0; let outputBytes = 0; let failed = false;
    const fail = () => { if (!failed) { failed = true; try { child?.kill(); } catch {} } };
    try { child = spawn(executable, [], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { reject(unavailable()); return; }
    const timer = setTimeout(fail, timeoutMs);
    const collect = (chunk) => { outputBytes += chunk.length; if (outputBytes > outputLimitBytes) fail(); else output.push(Buffer.from(chunk)); };
    const collectStderr = (chunk) => { stderrBytes += chunk.length; outputBytes += chunk.length; if (outputBytes > outputLimitBytes) fail(); };
    child.stdout.on("data", collect); child.stderr.on("data", collectStderr);
    child.once("error", fail);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || stderrBytes !== 0 || code !== 0 || signal !== null) { reject(unavailable()); return; }
      const raw = Buffer.concat(output);
      let parsed;
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
        if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.charCodeAt(0) === 0xfeff) throw new Error();
        parsed = JSON.parse(text.slice(0, -1));
        if (JSON.stringify(parsed) !== text.slice(0, -1)) throw new Error();
      } catch { reject(unavailable()); return; }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["components", "operation", "schemaVersion", "status"])
        || parsed.schemaVersion !== 2 || parsed.operation !== "inspect_path_chain_v2" || parsed.status !== "ok" || !Array.isArray(parsed.components)
        || parsed.components.length !== expectedCount(path) || !parsed.components.every(validIdentity)) { reject(unavailable()); return; }
      const volume = parsed.components[0]?.volumeIdentity;
      if (!parsed.components.every((item) => item.volumeIdentity === volume)) { reject(unavailable()); return; }
      resolveInspection(Object.freeze(parsed.components.map((item) => Object.freeze({ ...item }))));
    });
    child.stdin.end(request);
  });
}

async function withFreshInspector(callback) {
  const pair = await buildFreshWindowsReleaseBootstrapInspector();
  try {
    const files = (await readdir(pair.pairRoot)).sort();
    const binary = await readFile(pair.helperPath);
    if (JSON.stringify(files) !== JSON.stringify([helperFileName, manifestFileName].sort())
      || (await readFile(pair.manifestPath, "utf8")) !== canonicalManifest(createHash("sha256").update(binary).digest("hex"))) throw unavailable();
    return await callback(pair.helperPath);
  } finally {
    await rm(pair.pairRoot, { recursive: true, force: false }).catch(() => { throw new Error("runtime_acquisition_cleanup_failed"); });
  }
}
function releaseRunIdentity(env = process.env) {
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  if (!decimal.test(runId ?? "") || !decimal.test(attempt ?? "")) throw unavailable();
  return Object.freeze({ runId, attempt, marker: `${runId}:${attempt}\n` });
}
function exactReleaseScratchRoot(identity) { return win32.resolve(releaseScratchParent, `${identity.runId}-${identity.attempt}`); }
async function verifyOwnedScratch(executable, root, identity) {
  const chain = await inspectChain(executable, root);
  const leaf = chain.at(-1);
  if (leaf === undefined || leaf.objectKind !== "directory" || leaf.isReparsePoint
    || (await readFile(win32.join(root, releaseScratchMarker), "utf8")) !== identity.marker) throw unavailable();
}

/** Release-only composition. It creates one deterministic, run-owned root. */
export async function createWindowsReleaseBootstrapScratch({ env = process.env } = {}) {
  if (process.platform !== "win32") throw unavailable();
  const identity = releaseRunIdentity(env);
  const scratch = exactReleaseScratchRoot(identity);
  await withFreshInspector(async (executable) => {
    await mkdir(releaseScratchParent, { recursive: true });
    await mkdir(scratch, { recursive: false });
    try {
      await writeFile(win32.join(scratch, releaseScratchMarker), identity.marker, { flag: "wx" });
      await verifyOwnedScratch(executable, scratch, identity);
    } catch (error) {
      await rm(scratch, { recursive: true, force: false }).catch(() => { throw new Error("runtime_acquisition_cleanup_failed"); });
      throw error;
    }
  });
  let closed = false;
  return Object.freeze({ root: scratch, async close() { if (closed) return; closed = true; await cleanupWindowsReleaseOwnedScratch({ env }); } });
}

/** No path input: removes only the current protected workflow run's exact root. */
export async function cleanupWindowsReleaseOwnedScratch({ env = process.env } = {}) {
  if (process.platform !== "win32") throw unavailable();
  const identity = releaseRunIdentity(env);
  const scratch = exactReleaseScratchRoot(identity);
  try { await lstat(scratch); } catch (error) { if (error?.code === "ENOENT") return; throw unavailable(); }
  await withFreshInspector(async (executable) => {
    await verifyOwnedScratch(executable, scratch, identity);
    await rm(scratch, { recursive: true, force: false });
    try { await lstat(scratch); throw unavailable(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  });
}
