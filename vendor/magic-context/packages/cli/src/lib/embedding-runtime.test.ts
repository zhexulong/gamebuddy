import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __setEmbeddingRuntimeTestHooks,
    checkLocalEmbeddingRuntime,
    checkLocalEmbeddingRuntimeAt,
    checkLocalEmbeddingRuntimeByResolution,
    formatLocalEmbeddingRuntimeDoctorWarning,
    formatLocalEmbeddingRuntimeWasmFallback,
} from "./embedding-runtime";

afterEach(() => {
    __setEmbeddingRuntimeTestHooks({});
});

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "mc-embruntime-"));
}

function installWasmPackage(root: string): void {
    const pkgDir = join(root, "node_modules", "onnxruntime-web");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "onnxruntime-web", main: "index.js" }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
}

function installPackage(root: string, withBinary: boolean): void {
    const pkgDir = join(root, "node_modules", "onnxruntime-node");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "onnxruntime-node", main: "index.js" }),
    );
    writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
    if (withBinary) {
        const binDir = join(pkgDir, "bin", "napi-v6", "win32", "x64");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "onnxruntime_binding.node"), "stub");
    }
}

describe("checkLocalEmbeddingRuntimeAt", () => {
    test("package + matching binary present → ok", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("ok");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("native package missing and WASM missing → both-broken", () => {
        const root = makeRoot();
        try {
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("both-broken");
            if (status.state === "both-broken") {
                expect(status.nativeFailure.state).toBe("package-missing");
                expect(status.wasmReason).toContain("onnxruntime-web");
                expect(formatLocalEmbeddingRuntimeDoctorWarning(status)).toContain(
                    "native runtime and WASM fallback both unavailable",
                );
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("native binary missing but WASM present → wasm-fallback", () => {
        const root = makeRoot();
        try {
            installPackage(root, false); // no .node binary
            installWasmPackage(root);
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("wasm-fallback");
            if (status.state === "wasm-fallback") {
                expect(status.nativeFailure.state).toBe("binary-missing");
                expect(status.wasmPath).toContain("onnxruntime-web");
                expect(formatLocalEmbeddingRuntimeWasmFallback(status)).toContain(
                    "WASM inference is slower than native",
                );
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("unknown platform/arch with package present → ok (don't false-alarm)", () => {
        const root = makeRoot();
        try {
            installPackage(root, false);
            const status = checkLocalEmbeddingRuntimeAt(
                root,
                "freebsd" as NodeJS.Platform,
                "ppc64",
            );
            expect(status.state).toBe("ok");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("child probe parses JSON load failures without requiring onnxruntime in-process", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            installWasmPackage(root);
            __setEmbeddingRuntimeTestHooks({
                runOnnxRuntimeNodeLoadProbeChild: (packageDir) =>
                    packageDir.endsWith("onnxruntime-web")
                        ? {
                              stdout: JSON.stringify({ ok: true }),
                              stderr: "",
                              status: 0,
                              signal: null,
                          }
                        : {
                              stdout: JSON.stringify({
                                  ok: false,
                                  reason: "ERR_DLOPEN_FAILED: native binding failed",
                              }),
                              stderr: "",
                              status: 0,
                              signal: null,
                          },
            });

            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");

            expect(status.state).toBe("wasm-fallback");
            if (status.state === "wasm-fallback") {
                expect(status.nativeFailure.state).toBe("load-failed");
                expect(status.nativeFailure.reason).toContain("ERR_DLOPEN_FAILED");
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("child probe treats nonzero exits and stderr as load failures", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            __setEmbeddingRuntimeTestHooks({
                runOnnxRuntimeNodeLoadProbeChild: () => ({
                    stdout: "",
                    stderr: "dyld: abort loading onnxruntime_binding.node",
                    status: 134,
                    signal: null,
                }),
            });

            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");

            expect(status.state).toBe("both-broken");
            if (status.state === "both-broken") {
                expect(status.nativeFailure.state).toBe("load-failed");
                if (status.nativeFailure.state === "load-failed") {
                    expect(status.nativeFailure.reason).toContain("134");
                    expect(status.nativeFailure.reason).toContain("dyld: abort");
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("child probe treats timeouts as load failures with captured stderr", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            const timeout = Object.assign(new Error("spawnSync node ETIMEDOUT"), {
                code: "ETIMEDOUT",
            });
            __setEmbeddingRuntimeTestHooks({
                runOnnxRuntimeNodeLoadProbeChild: () => ({
                    stdout: "",
                    stderr: "probe hung while loading native addon",
                    status: null,
                    signal: "SIGTERM",
                    error: timeout,
                }),
            });

            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");

            expect(status.state).toBe("both-broken");
            if (status.state === "both-broken") {
                expect(status.nativeFailure.state).toBe("load-failed");
                if (status.nativeFailure.state === "load-failed") {
                    expect(status.nativeFailure.reason).toContain("timed out");
                    expect(status.nativeFailure.reason).toContain("probe hung");
                }
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("checkLocalEmbeddingRuntime (multi-root)", () => {
    test("no candidate root exists → unknown (stay silent)", () => {
        const status = checkLocalEmbeddingRuntime([
            join(tmpdir(), "does-not-exist-mc-1"),
            join(tmpdir(), "does-not-exist-mc-2"),
        ]);
        expect(status.state).toBe("unknown");
    });

    test("first root broken, second ok → returns ok", () => {
        const broken = makeRoot();
        const good = makeRoot();
        try {
            // broken: exists but no package
            installPackage(good, true);
            const status = checkLocalEmbeddingRuntime([broken, good], "win32", "x64");
            expect(status.state).toBe("ok");
        } finally {
            rmSync(broken, { recursive: true, force: true });
            rmSync(good, { recursive: true, force: true });
        }
    });

    test("existing root with neither runtime → both-broken", () => {
        const root = makeRoot();
        try {
            const status = checkLocalEmbeddingRuntime([root], "win32", "x64");
            expect(status.state).toBe("both-broken");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

// Build a plugin tree where `require.resolve("onnxruntime-node")` actually
// succeeds from the plugin dir — mirrors the real on-disk dev-path / hoisted
// layout (a nested node_modules the package manager populated), which a
// hardcoded path check would get wrong across layouts.
function installResolvablePlugin(
    withPackage: boolean,
    withBinary: boolean,
    indexSource = "module.exports = {};\n",
): string {
    const pluginDir = mkdtempSync(join(tmpdir(), "mc-pi-plugin-"));
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@cortexkit/pi-magic-context", version: "0.0.0" }),
    );
    if (withPackage) {
        const pkgDir = join(pluginDir, "node_modules", "onnxruntime-node");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: "onnxruntime-node", main: "index.js" }),
        );
        writeFileSync(join(pkgDir, "index.js"), indexSource);
        if (withBinary) {
            const binDir = join(pkgDir, "bin", "napi-v6", "win32", "x64");
            mkdirSync(binDir, { recursive: true });
            writeFileSync(join(binDir, "onnxruntime_binding.node"), "stub");
        }
    }
    return pluginDir;
}

describe("checkLocalEmbeddingRuntimeByResolution", () => {
    test("resolvable package + matching binary → ok (dev-path/hoisted layout)", () => {
        const dir = installResolvablePlugin(true, true);
        try {
            expect(checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64").state).toBe("ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolvable native load failure + WASM → wasm-fallback", () => {
        const dir = installResolvablePlugin(
            true,
            true,
            "const err = new Error('onnxruntime_binding.node failed to load');\n" +
                "err.code = 'ERR_DLOPEN_FAILED';\n" +
                "throw err;\n",
        );
        try {
            installWasmPackage(dir);
            const status = checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64");
            expect(status.state).toBe("wasm-fallback");
            if (status.state === "wasm-fallback") {
                expect(status.nativeFailure.state).toBe("load-failed");
                if (status.nativeFailure.state === "load-failed") {
                    expect(status.nativeFailure.reason).toContain("ERR_DLOPEN_FAILED");
                }
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("resolvable package with binary missing but WASM present → wasm-fallback", () => {
        const dir = installResolvablePlugin(true, false);
        try {
            installWasmPackage(dir);
            expect(checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64").state).toBe(
                "wasm-fallback",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("plugin without a native package but with WASM → wasm-fallback", () => {
        const dir = installResolvablePlugin(false, false);
        try {
            installWasmPackage(dir);
            expect(checkLocalEmbeddingRuntimeByResolution(dir, "win32", "x64").state).toBe(
                "wasm-fallback",
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("plugin dir does not exist → unknown (stay silent, never false-alarm)", () => {
        expect(
            checkLocalEmbeddingRuntimeByResolution(
                join(tmpdir(), "mc-pi-plugin-nonexistent-xyz"),
                "win32",
                "x64",
            ).state,
        ).toBe("unknown");
    });

    test("unknown platform/arch with package resolvable → ok (don't guess a binary)", () => {
        const dir = installResolvablePlugin(true, false);
        try {
            expect(
                checkLocalEmbeddingRuntimeByResolution(dir, "freebsd" as NodeJS.Platform, "ppc64")
                    .state,
            ).toBe("ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
