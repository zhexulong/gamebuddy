// Bundle-path smoke test for the smart-note QuickJS sandbox.
//
// `bun test` runs sandbox-runner.ts from SRC, where Bun resolves the QuickJS
// wasm through the real node_modules package path — so it CANNOT catch the
// bundling failure that actually shipped: the default wasmfile variant loads a
// sibling `emscripten-module.wasm` via `new URL(..., import.meta.url)`, which in
// the bundled dist/index.js resolves to a `dist/emscripten-module.wasm` the
// build never emits → every real sandbox run failed with ENOENT.
//
// This script BUNDLES sandbox-runner.ts exactly like the production build
// (esm, node target) into a temp file, then imports that bundle and runs a real
// check. If the wasm isn't embedded in the bundle (singlefile variant), the
// import/run throws — failing the smoke. Run: bun packages/plugin/scripts/smoke-smartnote-wasm.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/features/magic-context/smart-notes/sandbox-runner.ts");
const outDir = mkdtempSync(join(tmpdir(), "mc-smartnote-wasm-smoke-"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

try {
    // Bundle with the SAME flags the package build uses (esm, node target), so
    // the QuickJS variant goes through the identical bundling transform.
    const result = await Bun.build({
        entrypoints: [entry],
        outdir: outDir,
        target: "node",
        format: "esm",
    });
    check("sandbox-runner bundles cleanly", result.success, result.logs.map(String).join("; "));
    if (!result.success) throw new Error("bundle failed");

    const bundlePath = result.outputs.find((o) => o.path.endsWith(".js"))?.path;
    check("bundle emitted a js file", Boolean(bundlePath));
    if (!bundlePath) throw new Error("no bundle output");

    // The whole point: importing + running the BUNDLE must not ENOENT on a
    // sibling .wasm. A singlefile (inlined) variant loads from the bundle itself.
    const mod = (await import(bundlePath)) as {
        runCompiledSmartNoteCheck: (opts: unknown) => Promise<{ ok: boolean; result?: unknown }>;
    };
    check("runCompiledSmartNoteCheck is exported from bundle", typeof mod.runCompiledSmartNoteCheck === "function");

    const fakeCap = {
        readFile: async (path: string) => (path === "ready.txt" ? "ready" : null),
        gitHeadSha: async () => "abc123",
        gitTag: async () => "v1.2.3",
        gitLog: async () => [],
        httpGet: async () => ({ status: 200, body: "ok" }),
    };
    const res = await mod.runCompiledSmartNoteCheck({
        compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`,
        capabilities: fakeCap,
    });
    check(
        "bundled sandbox runs a check (wasm loads from the bundle, no ENOENT)",
        res.ok === true && JSON.stringify(res.result) === JSON.stringify({ met: true }),
        JSON.stringify(res),
    );
} catch (error) {
    failures++;
    console.log(`FAIL  bundle-path smoke threw — ${error instanceof Error ? error.message : String(error)}`);
} finally {
    rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    process.exit(1);
}
console.log("\nAll smart-note wasm bundle-path smoke checks passed.");
