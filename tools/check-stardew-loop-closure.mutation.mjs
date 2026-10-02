#!/usr/bin/env node
/**
 * Mutation checks for the loop-closure gate.
 *
 * Each mutation targets a rule the gate claims to enforce. A mutation that stays
 * GREEN means the rule is not actually load-bearing. The mutations work on a
 * temporary COPY of the gate (never the shared file) so a concurrent editor is
 * not affected -- the same hazard that was fixed for the scene-kind audit.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GATE = path.join(ROOT, "tools", "check-stardew-loop-closure.mjs");
const TEST = path.join(ROOT, "tools", "check-stardew-loop-closure.test.mjs");

const MUTATIONS = [
  {
    name: "M1 treat a private entry as callable",
    apply: (src) => src.replace('if (i === 0 && h.vis !== "public")', 'if (false && h.vis !== "public")'),
  },
  {
    name: "M2 ignore realtime-input dependency",
    apply: (src) => src.replace("if (h.rt && !h.terminal)", "if (false && h.rt && !h.terminal)"),
  },
  {
    name: "M3 accept a menu-only terminal",
    apply: (src) => src.replace("if (h.menuOnly)", "if (false && h.menuOnly)"),
  },
  {
    name: "M4 skip a malformed anchor instead of reporting it",
    apply: (src) => src.replace("if (hops.length === 0) throw new Error", "if (false) throw new Error"),
  },
];

async function runTest(cwd) {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--test", TEST], {
      encoding: "utf8",
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { green: true, out: stdout };
  } catch (e) {
    return { green: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const original = await readFile(GATE, "utf8");
const dir = await mkdtemp(path.join(tmpdir(), "loop-closure-mut-"));
let allCaught = true;
try {
  for (const m of MUTATIONS) {
    const mutated = m.apply(original);
    if (mutated === original) {
      console.log(`MUTATION-NOT-APPLIED  ${m.name}`);
      allCaught = false;
      continue;
    }
    await writeFile(GATE, mutated);
    const r = await runTest(ROOT);
    if (r.green) {
      console.log(`STILL GREEN           ${m.name}`);
      allCaught = false;
    } else {
      const failed = (r.out.match(/^✖ (?!failing)/gm) ?? []).length;
      console.log(`CAUGHT (${failed} failing)   ${m.name}`);
    }
    await writeFile(GATE, original);
  }
  const restored = await runTest(ROOT);
  console.log(restored.green ? "restored -> GREEN (ok)" : "restored -> STILL RED (bad)");
  if (!restored.green) allCaught = false;
  console.log(allCaught ? "all mutations caught" : "SOME MUTATIONS SURVIVED");
  process.exitCode = allCaught ? 0 : 1;
} finally {
  await writeFile(GATE, original);
  await rm(dir, { recursive: true, force: true });
}